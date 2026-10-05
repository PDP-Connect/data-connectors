// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Layer 2: collectWhoopBrowser through its seams. A fake page answers each in-page read with a
 * scripted PageFetch chosen by its path; pacing is zero and the clock fixed. Records go through
 * makeRecordingEmit(validateRecord), as the runtime's would.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type {
	EmittedMessage,
	StreamScope,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import {
	makeRecordingEmit,
	type RecordingEmit,
} from "../../packages/polyfill-connectors/src/test-harness.ts";
import {
	API_BASE,
	collectWhoopBrowser,
	HISTORY_FALLBACK,
	ORIGIN,
	OVERLAP_DAYS,
	type Pacing,
	type PageFetch,
	PROBE_PATH,
	STREAMS,
	type WhoopCollectContext,
	WINDOW_DAYS,
} from "./index.ts";
import { type Stream, validateRecord } from "./schemas.ts";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const NOW = new Date("2026-09-20T12:00:00.000Z");
const fixture = (name: string): string =>
	readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const BOOTSTRAP = fixture("bootstrap.json");
const CYCLES = fixture("cycles-details.json");
/** The fixture account's created_at less a day for its time zone: where a first walk starts. */
const FLOOR = Date.parse("2026-08-01T09:30:00.000Z") - DAY;
/** Where a first walk's first window ends. */
const W1_END = FLOOR + WINDOW_DAYS * DAY;
const FIXTURE_CYCLE_IDS = ["1000000101", "1000000102", "1000000103"];
/** The fixture's third cycle has no end yet: a walk that keeps it saves its start as open_since. */
const FIXTURE_OPEN = Date.parse("2026-09-16T12:50:00.000Z");
const uuid = (n: number): string =>
	`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const iso = (ms: number): string => new Date(ms).toISOString();
const cursorAt = (
	floor: number,
	through: number | Date,
	openSince?: number,
) => ({
	floor: iso(floor),
	through: iso(typeof through === "number" ? through : through.getTime()),
	...(openSince === undefined ? {} : { open_since: iso(openSince) }),
});

const SIGN_IN = { action: "refresh_credentials", retryable: false };
const RETRY = { action: "retry_by_runtime", retryable: true };
const UPGRADE = { action: "retry_on_connector_upgrade", retryable: false };

// ── WHOOP's answers ────────────────────────────────────────────────────────
const response = (
	status: number,
	body = "",
	contentType = "application/json; charset=utf-8",
	retryAfter: string | null = null,
): PageFetch => ({
	kind: "response",
	status,
	url: `${API_BASE}/`,
	contentType,
	retryAfter,
	body,
});
const ok = (body: string): PageFetch => response(200, body);
const json = (value: unknown): PageFetch => ok(JSON.stringify(value));

const CYCLES_PATH = "/core-details-bff/v0/cycles/details";
const isCycles = (path: string): boolean => path.startsWith(`${CYCLES_PATH}?`);

interface CyclesRequest {
	end: number;
	limit: number;
	params: URLSearchParams;
	start: number;
}
function requestOf(path: string): CyclesRequest {
	const url = new URL(path, API_BASE);
	assert.equal(url.pathname, CYCLES_PATH);
	return {
		start: Date.parse(url.searchParams.get("startTime") ?? ""),
		end: Date.parse(url.searchParams.get("endTime") ?? ""),
		limit: Number(url.searchParams.get("limit")),
		params: url.searchParams,
	};
}

/** Answers one read; `cyclesBefore` counts the cycles reads already made. */
type Answer = (path: string, cyclesBefore: number) => PageFetch;

/** Every read answers its fixture, whatever the window, as WHOOP does for a window it holds nothing for. */
const fixtures =
	(cycles = CYCLES, bootstrap = BOOTSTRAP): Answer =>
	(path) =>
		ok(path === PROBE_PATH ? bootstrap : cycles);

interface Held {
	element: unknown;
	start: number;
}
/** WHOOP as D found it: the cycles that start in the requested range, oldest first, cut at the limit. */
const serve =
	(held: Held[], bootstrap = BOOTSTRAP): Answer =>
	(path) => {
		if (path === PROBE_PATH) {
			return ok(bootstrap);
		}
		const { start, end, limit } = requestOf(path);
		const records = held
			.filter((h) => h.start >= start && h.start < end)
			.sort((a, b) => a.start - b.start)
			.slice(0, limit)
			.map((h) => h.element);
		return json({ records });
	};

/** A scored cycle with no recovery, sleep or workout. */
function cycleAt(
	id: number,
	start: number,
	cycle: Record<string, unknown> = {},
): Held {
	return {
		start,
		element: {
			cycle: {
				id,
				user_id: 41001,
				during: `['${iso(start)}','${iso(start + 20 * HOUR)}')`,
				days: `['${iso(start).slice(0, 10)}','${iso(start + DAY).slice(0, 10)}')`,
				timezone_offset: "+1000",
				scaled_strain: 8.5,
				day_kilojoules: 8000,
				day_avg_heart_rate: 60,
				day_max_heart_rate: 140,
				updated_at: "2026-09-19T00:00:00.000+0000",
				...cycle,
			},
			recovery: null,
			sleeps: [],
		},
	};
}

type Obj = Record<string, unknown>;
interface Element {
	cycle: Obj;
	recovery: Obj | null;
	sleeps: Obj[];
	workouts?: Obj[];
}
/** A fresh, editable copy of the fixture's elements. */
const elements = (): Element[] =>
	(JSON.parse(CYCLES) as { records: Element[] }).records;
const startOf = (element: Element): number =>
	Date.parse(/^\['([^']+)'/.exec(String(element.cycle.during))?.[1] ?? "");
const nth = <T>(items: readonly T[], index: number): T => {
	const item = items[index];
	assert.ok(item !== undefined, `item ${index}`);
	return item;
};

const MINUTE = 60_000;
const span = (start: number, minutes: number): string =>
	`['${iso(start)}','${iso(start + minutes * MINUTE)}')`;
/** The fixture's first sleep (or its nap), as activity `n`, half an hour from `start`. */
const sleepAt = (n: number, start: number, nap = false): Obj => ({
	...nth(nth(elements(), 0).sleeps, nap ? 1 : 0),
	activity_id: uuid(n),
	during: span(start, 30),
});
/** The fixture's workout, as activity `n`, three quarters of an hour from `start`. */
const workoutAt = (n: number, start: number): Obj => ({
	...nth(nth(elements(), 0).workouts ?? [], 0),
	activity_id: uuid(n),
	during: span(start, 45),
});
/** A held cycle with these parts (sleeps, workouts, recovery) in place of its own. */
const holding = (held: Held, parts: Partial<Element>): Held => ({
	...held,
	element: { ...(held.element as Element), ...parts },
});

interface Bootstrap {
	account: Obj;
	profile: Obj;
	user: Obj;
}
function bootstrapWith(edit: (bootstrap: Bootstrap) => void): string {
	const bootstrap = JSON.parse(BOOTSTRAP) as Bootstrap;
	edit(bootstrap);
	return JSON.stringify(bootstrap);
}

// ── The fake page ──────────────────────────────────────────────────────────
interface Fake {
	/** Reads and pauses, interleaved. */
	log: string[];
	page: WhoopCollectContext["page"];
	/** Every in-page read's path, in order. */
	paths: string[];
	sleep: (ms: number) => Promise<void>;
	/** Every navigation. */
	visits: string[];
	/** Every evaluate argument, to check what crosses into the page. */
	args: Array<Record<string, unknown>>;
}

/**
 * app.whoop.com, signed in. With `landsOn`, the page starts on about:blank and `goto` takes it to
 * that origin; off the app's origin, every read answers wrong_origin, as the in-page check does.
 */
function fakeWhoop(answer: Answer, landsOn?: string): Fake {
	const paths: string[] = [];
	const visits: string[] = [];
	const log: string[] = [];
	const args: Array<Record<string, unknown>> = [];
	let origin = landsOn === undefined ? ORIGIN : "null";
	const page = {
		goto: (url: string) => {
			visits.push(url);
			if (landsOn !== undefined) {
				origin = landsOn;
			}
			return Promise.resolve(null);
		},
		evaluate: (
			_fn: unknown,
			arg: { path: string } & Record<string, unknown>,
		) => {
			const before = paths.filter(isCycles).length;
			args.push(arg);
			paths.push(arg.path);
			log.push(arg.path === PROBE_PATH ? "read bootstrap" : "read cycles");
			if (origin !== ORIGIN) {
				return Promise.resolve({ kind: "wrong_origin", origin });
			}
			return Promise.resolve(answer(arg.path, before));
		},
	} as unknown as WhoopCollectContext["page"];
	const sleep = (ms: number): Promise<void> => {
		log.push(`sleep ${ms}`);
		return Promise.resolve();
	};
	return { args, log, page, paths, sleep, visits };
}
const cyclesRequests = (fake: Fake): CyclesRequest[] =>
	fake.paths.filter(isCycles).map(requestOf);
const sleepsOf = (fake: Fake): string[] =>
	fake.log.filter((entry) => entry.startsWith("sleep"));

// ── Running and reading a collection ───────────────────────────────────────
type Range = { since?: string; until?: string };
interface RunOptions {
	mode?: "full_refresh" | "incremental";
	now?: Date;
	pacing?: Partial<Pacing>;
	ranges?: Partial<Record<Stream, Range>>;
	state?: Record<string, unknown>;
	streams?: readonly Stream[];
}
async function collect(
	fake: Fake,
	options: RunOptions = {},
): Promise<RecordingEmit> {
	const h = makeRecordingEmit(validateRecord);
	const requested = new Map<string, StreamScope>();
	for (const name of options.streams ?? STREAMS) {
		const range = options.ranges?.[name];
		requested.set(name, range ? { name, time_range: range } : { name });
	}
	await collectWhoopBrowser(
		{
			collectionMode: options.mode ?? "incremental",
			emit: h.emit,
			emitRecord: h.emitRecord,
			page: fake.page,
			requested,
			state: options.state ?? {},
		},
		{ requestDelayMs: 0, sleep: fake.sleep, ...options.pacing },
		options.now ?? NOW,
	);
	return h;
}

type Message<T extends EmittedMessage["type"]> = Extract<
	EmittedMessage,
	{ type: T }
>;
const messagesOf = <T extends EmittedMessage["type"]>(
	h: RecordingEmit,
	type: T,
): Array<Message<T>> =>
	h.protocolMessages.filter(
		(message): message is Message<T> => message.type === type,
	);
const recordsOf = (h: RecordingEmit, stream: Stream) =>
	h.emitted
		.filter((record) => record.stream === stream)
		.map((record) => record.data);
const idsOf = (h: RecordingEmit, stream: Stream): unknown[] =>
	recordsOf(h, stream).map((record) => record.id);
const countsOf = (h: RecordingEmit): Record<string, number> =>
	Object.fromEntries(
		STREAMS.map((stream) => [stream, recordsOf(h, stream).length]),
	);
const progressOf = (h: RecordingEmit) =>
	messagesOf(h, "PROGRESS").map(({ stream, count }) => ({ stream, count }));
const everyStream = <T>(
	value: T,
	streams: readonly Stream[] = STREAMS,
): Record<string, T> =>
	Object.fromEntries(streams.map((stream) => [stream, value]));

/** Each stream's STATE cursor, asserting there is at most one per stream. */
function statesOf(h: RecordingEmit): Record<string, unknown> {
	const states: Record<string, unknown> = {};
	for (const message of messagesOf(h, "STATE")) {
		assert.equal(
			Object.hasOwn(states, message.stream),
			false,
			`${message.stream}: one STATE`,
		);
		states[message.stream] = message.cursor;
	}
	return states;
}

/** One SKIP_RESULT per stream, in stream order, each with this reason and hint. */
function assertSkips(
	h: RecordingEmit,
	reason: string,
	hint: object,
	streams: readonly Stream[] = STREAMS,
): void {
	const skips = messagesOf(h, "SKIP_RESULT");
	assert.deepEqual(
		skips.map((skip) => skip.stream),
		[...streams],
	);
	for (const skip of skips) {
		assert.equal(skip.reason, reason, skip.stream);
		assert.deepEqual(skip.recovery_hint, hint, skip.stream);
	}
}

/** No stream emits a record, a PROGRESS or a SKIP after its STATE. */
function assertStateLast(h: RecordingEmit): void {
	for (const stream of STREAMS) {
		const state = h.events.findIndex(
			(event) =>
				event.kind === "message" &&
				event.message.type === "STATE" &&
				event.message.stream === stream,
		);
		if (state < 0) {
			continue;
		}
		const last = h.events.findLastIndex((event) =>
			event.kind === "message"
				? event.message.type !== "STATE" &&
					"stream" in event.message &&
					event.message.stream === stream
				: event.stream === stream,
		);
		assert.ok(
			last < state,
			`${stream}: records, PROGRESS and SKIP before STATE`,
		);
	}
}

// ── First run ──────────────────────────────────────────────────────────────
test("collect: a first run emits each fixture record once, though every window answers the whole fixture", async () => {
	const fake = fakeWhoop(fixtures());
	const h = await collect(fake);

	assert.deepEqual(h.skipped, []);
	assert.equal(
		cyclesRequests(fake).length,
		2,
		"two windows, each answered with all three cycles",
	);
	assert.deepEqual(countsOf(h), {
		cycles: 3,
		recoveries: 1,
		sleeps: 3,
		workouts: 1,
	});
	assert.deepEqual(idsOf(h, "cycles"), FIXTURE_CYCLE_IDS);
	assert.deepEqual(idsOf(h, "recoveries"), ["1000000101"]);
	assert.deepEqual(idsOf(h, "sleeps"), [uuid(101), uuid(102), uuid(103)]);
	assert.deepEqual(idsOf(h, "workouts"), [uuid(201)]);
	assert.deepEqual(messagesOf(h, "SKIP_RESULT"), []);
	assert.deepEqual(messagesOf(h, "PROGRESS"), []);
	assert.deepEqual(
		statesOf(h),
		everyStream(cursorAt(FLOOR, NOW, FIXTURE_OPEN)),
	);
	assertStateLast(h);
	for (const stream of STREAMS) {
		const last = h.events.findLastIndex(
			(event) => event.kind === "record" && event.stream === stream,
		);
		const state = h.events.findIndex(
			(event) =>
				event.kind === "message" &&
				event.message.type === "STATE" &&
				event.message.stream === stream,
		);
		assert.ok(last >= 0 && state > last, `${stream}: records, then STATE`);
	}
});

test("collect: reads the app's bootstrap once, then cycles windows that tile the walk with a day's padding", async () => {
	const fake = fakeWhoop(fixtures());
	await collect(fake);

	assert.equal(fake.paths[0], PROBE_PATH);
	assert.equal(fake.paths.filter((path) => path === PROBE_PATH).length, 1);
	assert.ok(
		fake.paths.slice(1).every(isCycles),
		"every later read is a cycles window",
	);
	assert.deepEqual(fake.visits, [], "on the app already: no navigation");
	for (const arg of fake.args) {
		assert.deepEqual(Object.keys(arg).sort(), ["apiBase", "origin", "path"]);
		assert.equal(arg.origin, ORIGIN);
		assert.equal(arg.apiBase, API_BASE);
	}

	const requests = cyclesRequests(fake);
	const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
	for (const { params, start, end, limit } of requests) {
		assert.deepEqual(
			[...params.keys()],
			["apiVersion", "id", "startTime", "endTime", "limit"],
		);
		assert.equal(params.get("apiVersion"), "7");
		assert.equal(params.get("id"), "41001");
		assert.match(params.get("startTime") ?? "", instant);
		assert.match(params.get("endTime") ?? "", instant);
		assert.ok(
			Number.isInteger(limit) && limit > 0 && limit <= 200,
			`limit ${limit}`,
		);
		// Twice the days requested, padding included (spec §4, step 3).
		assert.equal(limit, Math.min(200, 2 * Math.ceil((end - start) / DAY)));
		assert.ok(
			end - start <= (WINDOW_DAYS + 2) * DAY,
			"at most thirty days plus a day each side",
		);
	}
	assert.equal(
		nth(requests, 0).start,
		FLOOR - DAY,
		"the account's start, less the day's pad",
	);
	for (let i = 1; i < requests.length; i += 1) {
		assert.equal(
			nth(requests, i).start + DAY,
			nth(requests, i - 1).end - DAY,
			`window ${i} starts where ${i - 1} ended`,
		);
	}
	assert.equal(
		nth(requests, requests.length - 1).end,
		NOW.getTime() + DAY,
		"the last window ends at now",
	);
	for (const path of fake.paths) {
		assert.doesNotMatch(path, /token|bearer|authori[sz]ation/i);
	}
});

test("collect: pauses before each window read, never before the bootstrap or after the last read", async () => {
	const fake = fakeWhoop(fixtures());
	await collect(fake, { pacing: { requestDelayMs: 5 } });
	assert.deepEqual(fake.log, [
		"read bootstrap",
		"sleep 5",
		"read cycles",
		"sleep 5",
		"read cycles",
	]);
});

test("collect: an account summary without created_at walks from WHOOP's earliest history", async () => {
	const bootstrap = bootstrapWith((b) => {
		b.account.created_at = undefined;
		b.user.created_at = undefined;
	});
	const fake = fakeWhoop(fixtures(CYCLES, bootstrap));
	const h = await collect(fake);
	const requests = cyclesRequests(fake);
	const fallback = Date.parse(HISTORY_FALLBACK);
	assert.equal(nth(requests, 0).start, fallback - DAY);
	assert.equal(
		requests.length,
		Math.ceil((NOW.getTime() - fallback) / (WINDOW_DAYS * DAY)),
	);
	assert.deepEqual(messagesOf(h, "SKIP_RESULT"), [], "fits one run");
	assert.deepEqual(
		statesOf(h),
		everyStream(cursorAt(fallback, NOW, FIXTURE_OPEN)),
	);
	assert.deepEqual(idsOf(h, "cycles"), FIXTURE_CYCLE_IDS);
});

test("collect: takes the account's start from user.created_at and the user id from account.user_id when the first choices are absent", async () => {
	const bootstrap = bootstrapWith((b) => {
		b.account.created_at = undefined;
		b.user.created_at = "2026-08-11T00:00:00.000Z";
		b.user.id = undefined;
	});
	const fake = fakeWhoop(fixtures(CYCLES, bootstrap));
	const h = await collect(fake);
	const first = nth(cyclesRequests(fake), 0);
	assert.equal(first.start, Date.parse("2026-08-11T00:00:00.000Z") - 2 * DAY);
	assert.equal(first.params.get("id"), "41001");
	assert.deepEqual(countsOf(h), {
		cycles: 3,
		recoveries: 1,
		sleeps: 3,
		workouts: 1,
	});
});

// ── Scope ──────────────────────────────────────────────────────────────────
test("collect: only the requested stream is emitted and checkpointed", async () => {
	const fake = fakeWhoop(fixtures());
	const h = await collect(fake, { streams: ["sleeps"] });
	assert.deepEqual(h.skipped, []);
	assert.deepEqual(
		new Set(h.emitted.map((record) => record.stream)),
		new Set(["sleeps"]),
	);
	assert.deepEqual(idsOf(h, "sleeps"), [uuid(101), uuid(102), uuid(103)]);
	assert.deepEqual(statesOf(h), { sleeps: cursorAt(FLOOR, NOW, FIXTURE_OPEN) });
	assert.deepEqual(messagesOf(h, "SKIP_RESULT"), []);
	assert.deepEqual(messagesOf(h, "PROGRESS"), []);
});

test("collect: with no stream requested, reads, pauses and emits nothing", async () => {
	const fake = fakeWhoop(fixtures());
	const h = await collect(fake, { streams: [] });
	assert.deepEqual(fake.log, []);
	assert.deepEqual(fake.visits, []);
	assert.deepEqual(h.events, []);
});

// ── Fail closed ────────────────────────────────────────────────────────────
interface Failure {
	answer: PageFetch;
	hint: object;
	label: string;
	reason: string;
}

const BOOTSTRAP_FAILURES: Failure[] = [
	{
		label: "401 with WHOOP's plain-text body under a JSON type",
		answer: response(401, "Authorization was not valid"),
		reason: "sign_in_required",
		hint: SIGN_IN,
	},
	{
		label: "403",
		answer: response(403, "<html></html>", "text/html"),
		reason: "sign_in_required",
		hint: SIGN_IN,
	},
	{
		label: "500",
		answer: response(500, "{}"),
		reason: "collection_interrupted",
		hint: RETRY,
	},
	{
		label: "a network error",
		answer: { kind: "network_error", message: "TypeError" },
		reason: "collection_interrupted",
		hint: RETRY,
	},
	{
		label: "404",
		answer: response(404, "{}"),
		reason: "source_unreadable",
		hint: UPGRADE,
	},
	{
		label: "a 200 HTML page",
		answer: response(200, "<!doctype html>", "text/html; charset=utf-8"),
		reason: "source_unreadable",
		hint: UPGRADE,
	},
	{
		label: "a 200 that does not parse",
		answer: ok("{not json"),
		reason: "source_unreadable",
		hint: UPGRADE,
	},
	{
		label: "a 200 of the wrong shape",
		answer: json({ foo: 1 }),
		reason: "source_unreadable",
		hint: UPGRADE,
	},
	{
		label: "user ids that disagree",
		answer: ok(
			bootstrapWith((b) => {
				b.profile.user_id = 41_002;
			}),
		),
		reason: "source_unreadable",
		hint: UPGRADE,
	},
	{
		label: "a user id sent as a string",
		answer: ok(
			bootstrapWith((b) => {
				b.user.id = "41001";
			}),
		),
		reason: "source_unreadable",
		hint: UPGRADE,
	},
];

for (const failure of BOOTSTRAP_FAILURES) {
	test(`collect: a bootstrap answering ${failure.label} skips every stream (${failure.reason}) and saves no cursor`, async () => {
		const fake = fakeWhoop((path) =>
			path === PROBE_PATH ? failure.answer : assert.fail(`read ${path}`),
		);
		const h = await collect(fake);
		assert.deepEqual(fake.paths, [PROBE_PATH], "no cycles read");
		assert.deepEqual(fake.visits, []);
		assertSkips(h, failure.reason, failure.hint);
		assert.deepEqual(h.emitted, []);
		assert.deepEqual(messagesOf(h, "STATE"), []);
		assert.deepEqual(messagesOf(h, "PROGRESS"), []);
	});
}

test("collect: a bootstrap still rate limited after two 60 s waits skips every stream and saves no cursor", async () => {
	const fake = fakeWhoop(() => response(429));
	const h = await collect(fake);
	assert.deepEqual(fake.paths, [PROBE_PATH, PROBE_PATH, PROBE_PATH]);
	assert.deepEqual(sleepsOf(fake), ["sleep 60000", "sleep 60000"]);
	assertSkips(h, "collection_interrupted", RETRY);
	assert.deepEqual(messagesOf(h, "STATE"), []);
});

/** Two cycles in the first window and one in the second. */
const TWO_WINDOWS = [
	cycleAt(1_000_000_201, FLOOR + 2 * DAY),
	cycleAt(1_000_000_202, FLOOR + 10 * DAY),
	cycleAt(1_000_000_203, W1_END + 10 * DAY),
];
/** Serves TWO_WINDOWS, but answers every read of the second window with `answer`. */
const failingSecondWindow = (answer: PageFetch): Answer => {
	const good = serve(TWO_WINDOWS);
	return (path, before) =>
		isCycles(path) && requestOf(path).start >= W1_END - DAY
			? answer
			: good(path, before);
};

test("collect: a window still rate limited after two 60 s waits skips every stream, the cursor at the last whole window", async () => {
	const fake = fakeWhoop(failingSecondWindow(response(429)));
	const h = await collect(fake);
	assert.deepEqual(
		cyclesRequests(fake).map((request) => request.start),
		[FLOOR - DAY, W1_END - DAY, W1_END - DAY, W1_END - DAY],
		"one read and two retries of the second window",
	);
	assert.deepEqual(sleepsOf(fake), [
		"sleep 0",
		"sleep 0",
		"sleep 60000",
		"sleep 60000",
	]);
	assert.deepEqual(idsOf(h, "cycles"), ["1000000201", "1000000202"]);
	assertSkips(h, "collection_interrupted", RETRY);
	assert.deepEqual(
		statesOf(h),
		everyStream(cursorAt(FLOOR, W1_END)),
		"not now",
	);
	assertStateLast(h);
});

const WINDOW_FAILURES: Failure[] = [
	{
		label: "401",
		answer: response(401, "Authorization was not valid"),
		reason: "sign_in_required",
		hint: SIGN_IN,
	},
	{
		label: "500",
		answer: response(500),
		reason: "collection_interrupted",
		hint: RETRY,
	},
	{
		label: "a network error",
		answer: { kind: "network_error", message: "AbortError" },
		reason: "collection_interrupted",
		hint: RETRY,
	},
	{
		label: "a page gone to WHOOP's sign-in host",
		answer: { kind: "wrong_origin", origin: "https://id.whoop.com" },
		reason: "sign_in_required",
		hint: SIGN_IN,
	},
	{
		label: "a page gone off the app elsewhere",
		answer: { kind: "wrong_origin", origin: "https://www.whoop.com" },
		reason: "collection_interrupted",
		hint: RETRY,
	},
	{
		label: "a 200 HTML page",
		answer: response(200, "<!doctype html>", "text/html; charset=utf-8"),
		reason: "source_unreadable",
		hint: UPGRADE,
	},
	{
		label: "a 200 JSON object with no records",
		answer: json({ foo: 1 }),
		reason: "source_unreadable",
		hint: UPGRADE,
	},
	{
		label: "records that are not a list",
		answer: json({ records: {} }),
		reason: "source_unreadable",
		hint: UPGRADE,
	},
];

for (const failure of WINDOW_FAILURES) {
	test(`collect: a later window answering ${failure.label} skips every stream (${failure.reason}), the cursor at the last whole window`, async () => {
		const fake = fakeWhoop(failingSecondWindow(failure.answer));
		const h = await collect(fake);
		assert.equal(cyclesRequests(fake).length, 2, "no retry");
		assert.deepEqual(fake.visits, [], "only the bootstrap may navigate");
		assert.deepEqual(idsOf(h, "cycles"), ["1000000201", "1000000202"]);
		assertSkips(h, failure.reason, failure.hint);
		assert.deepEqual(statesOf(h), everyStream(cursorAt(FLOOR, W1_END)));
		assertStateLast(h);
	});
}

test("collect: a first window that fails saves no cursor", async () => {
	const fake = fakeWhoop((path) =>
		path === PROBE_PATH ? ok(BOOTSTRAP) : response(503),
	);
	const h = await collect(fake);
	assert.equal(cyclesRequests(fake).length, 1);
	assertSkips(h, "collection_interrupted", RETRY);
	assert.deepEqual(h.emitted, []);
	assert.deepEqual(messagesOf(h, "STATE"), []);
});

test("collect: a 429 that clears on retry costs one 60 s wait and no skip", async () => {
	const fake = fakeWhoop((path, before) =>
		isCycles(path) && before === 0 ? response(429) : fixtures()(path, before),
	);
	const h = await collect(fake);
	assert.deepEqual(
		sleepsOf(fake).filter((entry) => entry !== "sleep 0"),
		["sleep 60000"],
	);
	assert.deepEqual(messagesOf(h, "SKIP_RESULT"), []);
	assert.deepEqual(countsOf(h), {
		cycles: 3,
		recoveries: 1,
		sleeps: 3,
		workouts: 1,
	});
	assert.deepEqual(
		statesOf(h),
		everyStream(cursorAt(FLOOR, NOW, FIXTURE_OPEN)),
	);
});

test("collect: a 429 waits the Retry-After seconds it carries", async () => {
	const fake = fakeWhoop((path, before) =>
		isCycles(path) && before === 0
			? response(429, "", "", "5")
			: fixtures()(path, before),
	);
	const h = await collect(fake);
	assert.deepEqual(
		sleepsOf(fake).filter((entry) => entry !== "sleep 0"),
		["sleep 5000"],
	);
	assert.deepEqual(messagesOf(h, "SKIP_RESULT"), []);
});

test("collect: a 429 whose Retry-After passes maxRetryAfterMs skips at once, without waiting", async () => {
	const fake = fakeWhoop((path, before) =>
		isCycles(path) ? response(429, "", "", "120") : fixtures()(path, before),
	);
	const h = await collect(fake);
	assert.equal(cyclesRequests(fake).length, 1);
	assert.deepEqual(
		sleepsOf(fake).filter((entry) => entry !== "sleep 0"),
		[],
	);
	assertSkips(h, "collection_interrupted", RETRY);
	assert.deepEqual(messagesOf(h, "STATE"), []);
});

test("collect: off the app, the bootstrap navigates to it once and reads again", async () => {
	const fake = fakeWhoop(fixtures(), ORIGIN);
	const h = await collect(fake);
	assert.deepEqual(fake.visits, [`${ORIGIN}/`]);
	assert.deepEqual(fake.paths.slice(0, 2), [PROBE_PATH, PROBE_PATH]);
	assert.deepEqual(countsOf(h), {
		cycles: 3,
		recoveries: 1,
		sleeps: 3,
		workouts: 1,
	});
	assert.deepEqual(
		statesOf(h),
		everyStream(cursorAt(FLOOR, NOW, FIXTURE_OPEN)),
	);
});

test("collect: a bootstrap still off the app after one navigation skips every stream and saves no cursor", async () => {
	const fake = fakeWhoop(fixtures(), "https://www.whoop.com");
	const h = await collect(fake);
	assert.deepEqual(fake.visits, [`${ORIGIN}/`]);
	assert.deepEqual(fake.paths, [PROBE_PATH, PROBE_PATH]);
	assertSkips(h, "collection_interrupted", RETRY);
	assert.deepEqual(messagesOf(h, "STATE"), []);
});

test("collect: a bootstrap that lands on WHOOP's sign-in host asks the owner to sign in", async () => {
	const fake = fakeWhoop(fixtures(), "https://id.whoop.com");
	const h = await collect(fake);
	assert.deepEqual(fake.visits, [`${ORIGIN}/`]);
	assert.deepEqual(fake.paths, [PROBE_PATH, PROBE_PATH], "no cycles read");
	assertSkips(h, "sign_in_required", SIGN_IN);
	assert.deepEqual(h.emitted, []);
	assert.deepEqual(messagesOf(h, "STATE"), []);
});

// ── Drift ──────────────────────────────────────────────────────────────────
test("collect: a retyped strain or an unreadable sleep range costs that record alone, counted in PROGRESS", async () => {
	const records = elements();
	const first = nth(records, 0);
	first.cycle.scaled_strain = "12.4";
	nth(first.sleeps, 1).during = "2026-09-15 05:10 to 05:40";
	const fake = fakeWhoop(fixtures(JSON.stringify({ records })));
	const h = await collect(fake);

	assert.deepEqual(h.skipped, []);
	assert.deepEqual(idsOf(h, "cycles"), ["1000000102", "1000000103"]);
	assert.deepEqual(idsOf(h, "sleeps"), [uuid(101), uuid(103)]);
	assert.deepEqual(countsOf(h), {
		cycles: 2,
		recoveries: 1,
		sleeps: 2,
		workouts: 1,
	});
	assert.deepEqual(progressOf(h), [
		{ stream: "cycles", count: 1 },
		{ stream: "sleeps", count: 1 },
	]);
	assert.deepEqual(messagesOf(h, "SKIP_RESULT"), []);
	assert.deepEqual(
		statesOf(h),
		everyStream(cursorAt(FLOOR, NOW, FIXTURE_OPEN)),
		"the cursor still advances",
	);
	assertStateLast(h);
});

test("collect: a value outside its unit guard is counted unreadable and never reaches emitRecord", async () => {
	const records = elements();
	const first = nth(records, 0);
	first.cycle.scaled_strain = 25;
	const recovery = first.recovery;
	assert.ok(recovery);
	recovery.hrv_rmssd = 61.2; // milliseconds where WHOOP sends seconds
	const fake = fakeWhoop(fixtures(JSON.stringify({ records })));
	const h = await collect(fake);

	assert.deepEqual(
		h.skipped,
		[],
		"the runtime would skip the whole stream for one invalid record",
	);
	assert.deepEqual(countsOf(h), {
		cycles: 2,
		recoveries: 0,
		sleeps: 3,
		workouts: 1,
	});
	assert.deepEqual(progressOf(h), [
		{ stream: "cycles", count: 1 },
		{ stream: "recoveries", count: 1 },
	]);
	assert.deepEqual(messagesOf(h, "SKIP_RESULT"), []);
	assert.deepEqual(
		statesOf(h),
		everyStream(cursorAt(FLOOR, NOW, FIXTURE_OPEN)),
	);
});

test("collect: an element whose cycle does not parse costs every record it holds", async () => {
	const records = elements();
	nth(records, 0).cycle.id = "1000000101"; // a string where WHOOP sends an integer
	const fake = fakeWhoop(
		serve(records.map((element) => ({ element, start: startOf(element) }))),
	);
	const h = await collect(fake);

	assert.deepEqual(idsOf(h, "cycles"), ["1000000102", "1000000103"]);
	assert.deepEqual(countsOf(h), {
		cycles: 2,
		recoveries: 0,
		sleeps: 1,
		workouts: 0,
	});
	assert.deepEqual(progressOf(h), [
		{ stream: "cycles", count: 1 },
		{ stream: "recoveries", count: 1 },
		{ stream: "sleeps", count: 2 },
		{ stream: "workouts", count: 1 },
	]);
	assert.deepEqual(messagesOf(h, "SKIP_RESULT"), []);
	assert.deepEqual(
		statesOf(h),
		everyStream(cursorAt(FLOOR, NOW, FIXTURE_OPEN)),
	);
});

test("collect: an unreadable element that two padded windows both return is counted once", async () => {
	// Six hours before the first window's end: inside both windows' padded requests. Each window
	// also holds a readable cycle, so neither reads as a change of shape.
	const fake = fakeWhoop(
		serve([
			cycleAt(1_000_000_310, FLOOR + DAY),
			cycleAt(1_000_000_301, W1_END - 6 * HOUR, { during: "garbled" }),
			cycleAt(1_000_000_311, W1_END + 2 * DAY),
		]),
	);
	const h = await collect(fake);
	assert.equal(cyclesRequests(fake).length, 2, "both windows returned it");
	assert.deepEqual(progressOf(h), [{ stream: "cycles", count: 1 }]);
});

test("collect: two different unreadable elements are each counted, though one window returns both", async () => {
	const fake = fakeWhoop(
		serve([
			cycleAt(1_000_000_312, FLOOR + DAY),
			cycleAt(1_000_000_302, FLOOR + 2 * DAY, { during: "garbled" }),
			cycleAt(1_000_000_303, FLOOR + 3 * DAY, { during: "garbled" }),
		]),
	);
	const h = await collect(fake);
	assert.deepEqual(progressOf(h), [{ stream: "cycles", count: 2 }]);
});

test("collect: a window whose every cycle is unreadable stops the walk there, every stream skipped and no cursor moved", async () => {
	// WHOOP changing the shape of every cycle (here, ids sent as strings) must not move the cursor
	// past history the connector could not read.
	const fake = fakeWhoop(
		serve([
			cycleAt(1_000_000_320, FLOOR + DAY, { id: "1000000320" }),
			cycleAt(1_000_000_321, FLOOR + 2 * DAY, { id: "1000000321" }),
		]),
	);
	const h = await collect(fake);
	assert.equal(
		cyclesRequests(fake).length,
		1,
		"the walk stopped at the first window",
	);
	assert.deepEqual(h.emitted, []);
	assertSkips(h, "source_unreadable", UPGRADE);
	assert.deepEqual(
		statesOf(h),
		{},
		"a first window that fails saves no cursor",
	);
});

test("collect: a later window whose every cycle is unreadable keeps each cursor at the last whole window", async () => {
	const fake = fakeWhoop(
		serve([
			cycleAt(1_000_000_322, FLOOR + DAY),
			cycleAt(1_000_000_323, W1_END + DAY, { during: "garbled" }),
		]),
	);
	const h = await collect(fake);
	assert.deepEqual(idsOf(h, "cycles"), ["1000000322"]);
	assertSkips(h, "source_unreadable", UPGRADE);
	assert.deepEqual(statesOf(h), everyStream(cursorAt(FLOOR, W1_END)));
});

test("collect: a requested stream whose records were all readable gets no PROGRESS", async () => {
	const records = elements();
	nth(nth(records, 0).sleeps, 0).during = "garbled";
	const h = await collect(fakeWhoop(fixtures(JSON.stringify({ records }))), {
		streams: ["cycles", "sleeps"],
	});
	assert.deepEqual(progressOf(h), [{ stream: "sleeps", count: 1 }]);
});

// ── Messages ───────────────────────────────────────────────────────────────
test("collect: PROGRESS and SKIP messages carry counts and statuses, never an id, a value or a date", async () => {
	const drifted = elements();
	nth(drifted, 0).cycle.scaled_strain = "12.4";
	nth(nth(drifted, 0).sleeps, 1).during = "['2026-09-15T05:10:00.000Z'";
	const alwaysFull: Answer = (path) => {
		if (path === PROBE_PATH) {
			return ok(BOOTSTRAP);
		}
		const { start, limit } = requestOf(path);
		return json({
			records: Array.from(
				{ length: limit },
				(_, i) => cycleAt(1_000_000_600 + i, start + DAY + i * 60_000).element,
			),
		});
	};
	const scenarios: Array<{ answer: Answer; pacing?: Partial<Pacing> }> = [
		{ answer: fixtures(JSON.stringify({ records: drifted })) },
		{ answer: () => response(401, "Authorization was not valid") },
		{
			answer: () =>
				ok(bootstrapWith((b) => Object.assign(b.profile, { user_id: 41_002 }))),
		},
		{ answer: failingSecondWindow(response(429)) },
		{
			answer: failingSecondWindow(
				response(200, "<!doctype html>", "text/html; charset=utf-8"),
			),
		},
		{ answer: failingSecondWindow(json({ foo: 1 })) },
		{
			answer: failingSecondWindow({
				kind: "network_error",
				message: "AbortError",
			}),
		},
		{
			answer: failingSecondWindow({
				kind: "wrong_origin",
				origin: "https://id.whoop.com",
			}),
		},
		{ answer: alwaysFull },
		{ answer: fixtures(), pacing: { maxWindowsPerRun: 1 } },
	];
	const runs = await Promise.all(
		scenarios.map(({ answer, pacing }) =>
			collect(fakeWhoop(answer), pacing ? { pacing } : {}),
		),
	);
	const texts = runs.flatMap((h) => [
		...messagesOf(h, "PROGRESS").map((m) => m.message),
		...messagesOf(h, "SKIP_RESULT").map((m) => m.message),
	]);
	assert.ok(
		runs.every(
			(h) =>
				messagesOf(h, "PROGRESS").length + messagesOf(h, "SKIP_RESULT").length >
				0,
		),
		"every scenario says something",
	);
	for (const text of texts) {
		assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}/, text);
		assert.doesNotMatch(text, /\d{5,}/, text);
		assert.doesNotMatch(text, /[0-9a-f]{8}-[0-9a-f]{4}-/i, text);
		assert.doesNotMatch(text, /fixture|token|whoop\.com/i, text);
	}
});

// ── Cursors ────────────────────────────────────────────────────────────────
const LATER = new Date(NOW.getTime() + 2 * DAY);

test("collect: a run from the last STATE re-reads the overlap week, then moves through to now", async () => {
	const first = await collect(fakeWhoop(fixtures()));
	const fake = fakeWhoop(fixtures());
	const h = await collect(fake, { state: statesOf(first), now: LATER });
	const requests = cyclesRequests(fake);
	assert.equal(requests.length, 1);
	assert.equal(
		nth(requests, 0).start,
		NOW.getTime() - OVERLAP_DAYS * DAY - DAY,
		"through, less the week and the pad",
	);
	assert.equal(nth(requests, 0).end, LATER.getTime() + DAY);
	assert.deepEqual(
		statesOf(h),
		everyStream(cursorAt(FLOOR, LATER, FIXTURE_OPEN)),
		"floor kept, through moved",
	);
	assert.deepEqual(
		idsOf(h, "cycles"),
		FIXTURE_CYCLE_IDS,
		"the week's cycles, re-read for late scoring",
	);
});

/** A strap left off for ten days: the cycle stays open until the next sleep it records. */
const ABANDONED = NOW.getTime() - 10 * DAY;
const OPEN_CYCLE = cycleAt(1_000_000_801, ABANDONED, {
	during: `['${iso(ABANDONED)}',)`,
	days: `['${iso(ABANDONED).slice(0, 10)}',)`,
	scaled_strain: null,
});
const CLOSED_CYCLE = cycleAt(1_000_000_801, ABANDONED, {
	during: `['${iso(ABANDONED)}','${iso(NOW.getTime() + DAY)}')`,
	updated_at: "2026-09-21T13:00:00.000+0000",
});

test("collect: a cycle still open at the last run is re-read once it closes, though it began before the overlap week", async () => {
	const first = await collect(fakeWhoop(serve([OPEN_CYCLE])));
	assert.equal(nth(recordsOf(first, "cycles"), 0).end_at, null);
	assert.deepEqual(
		statesOf(first),
		everyStream(cursorAt(FLOOR, NOW, ABANDONED)),
	);

	const fake = fakeWhoop(serve([CLOSED_CYCLE]));
	const h = await collect(fake, { state: statesOf(first), now: LATER });
	assert.equal(
		nth(cyclesRequests(fake), 0).start,
		ABANDONED - DAY,
		"from the open cycle's start, not through less the week",
	);
	assert.deepEqual(
		recordsOf(h, "cycles").map((record) => record.end_at),
		[iso(NOW.getTime() + DAY)],
	);
});

test("collect: open_since holds while the cycle stays open, clears once it closes, and the overlap returns to the week", async () => {
	const runs: Array<{ held: Held; now: Date; start: number }> = [
		{ held: OPEN_CYCLE, now: LATER, start: ABANDONED },
		{
			held: CLOSED_CYCLE,
			now: new Date(LATER.getTime() + DAY),
			start: ABANDONED,
		},
		{
			held: CLOSED_CYCLE,
			now: new Date(LATER.getTime() + 2 * DAY),
			start: LATER.getTime() + DAY - OVERLAP_DAYS * DAY,
		},
	];
	let state = statesOf(await collect(fakeWhoop(serve([OPEN_CYCLE]))));
	for (const [i, run] of runs.entries()) {
		const fake = fakeWhoop(serve([run.held]));
		const h = await collect(fake, { state, now: run.now });
		assert.equal(
			nth(cyclesRequests(fake), 0).start,
			run.start - DAY,
			`run ${i}`,
		);
		state = statesOf(h);
		assert.deepEqual(
			state,
			everyStream(
				cursorAt(
					FLOOR,
					run.now,
					run.held === OPEN_CYCLE ? ABANDONED : undefined,
				),
			),
			`run ${i}`,
		);
	}
});

test("collect: a run that reads no window keeps the open cycle an earlier run saw", async () => {
	const open = NOW.getTime() - 10 * DAY;
	const fake = fakeWhoop(fixtures());
	// The grant ends before the replay would start, so this run reads nothing.
	const h = await collect(fake, {
		now: LATER,
		state: everyStream(cursorAt(FLOOR, NOW, open)),
		ranges: everyStream({ until: iso(NOW.getTime() - 20 * DAY) }),
	});
	assert.deepEqual(cyclesRequests(fake), []);
	assert.deepEqual(statesOf(h), everyStream(cursorAt(FLOOR, NOW, open)));
});

test("collect: open_since is the earliest cycle still open in the windows read", async () => {
	const later = cycleAt(1_000_000_802, NOW.getTime() - 2 * DAY, {
		during: `['${iso(NOW.getTime() - 2 * DAY)}',)`,
	});
	const h = await collect(fakeWhoop(serve([later, OPEN_CYCLE])));
	assert.deepEqual(statesOf(h), everyStream(cursorAt(FLOOR, NOW, ABANDONED)));
});

for (const { label, open, start } of [
	{
		label: "within the week re-reads the week",
		open: NOW.getTime() - 3 * DAY,
		start: NOW.getTime() - OVERLAP_DAYS * DAY,
	},
	{
		label: "twenty days back re-reads from it",
		open: NOW.getTime() - 20 * DAY,
		start: NOW.getTime() - 20 * DAY,
	},
	{
		label: "forty days back re-reads only thirty",
		open: NOW.getTime() - 40 * DAY,
		start: NOW.getTime() - 30 * DAY,
	},
]) {
	test(`collect: a saved open_since ${label}`, async () => {
		const fake = fakeWhoop(fixtures());
		const h = await collect(fake, {
			state: everyStream(cursorAt(FLOOR, NOW, open)),
			now: LATER,
		});
		assert.equal(nth(cyclesRequests(fake), 0).start, start - DAY);
		assert.deepEqual(
			statesOf(h),
			everyStream(cursorAt(FLOOR, LATER, FIXTURE_OPEN)),
			"this run's open cycle, not the saved one",
		);
	});
}

test("collect: full_refresh ignores the saved cursor and walks from the account's start", async () => {
	const first = await collect(fakeWhoop(fixtures()));
	const fake = fakeWhoop(fixtures());
	const h = await collect(fake, {
		state: statesOf(first),
		now: LATER,
		mode: "full_refresh",
	});
	const requests = cyclesRequests(fake);
	assert.equal(nth(requests, 0).start, FLOOR - DAY);
	assert.equal(requests.length, 2);
	assert.deepEqual(
		statesOf(h),
		everyStream(cursorAt(FLOOR, LATER, FIXTURE_OPEN)),
	);
});

test("collect: a stream with no cursor of its own sends the walk back to the account's start", async () => {
	const first = await collect(fakeWhoop(fixtures()));
	const fake = fakeWhoop(fixtures());
	const h = await collect(fake, {
		streams: ["cycles", "workouts"],
		state: { cycles: statesOf(first).cycles },
	});
	assert.equal(nth(cyclesRequests(fake), 0).start, FLOOR - DAY);
	assert.deepEqual(
		statesOf(h),
		everyStream(cursorAt(FLOOR, NOW, FIXTURE_OPEN), ["cycles", "workouts"]),
	);
	assert.deepEqual(idsOf(h, "workouts"), [uuid(201)]);
});

for (const [label, cursor] of [
	["through before floor", cursorAt(NOW.getTime(), FLOOR)],
	["through not an instant", { floor: iso(FLOOR), through: "yesterday" }],
	["no object at all", "2026-09-20"],
] as const) {
	test(`collect: a saved cursor with ${label} counts as none`, async () => {
		const fake = fakeWhoop(fixtures());
		const h = await collect(fake, { state: everyStream(cursor) });
		assert.equal(nth(cyclesRequests(fake), 0).start, FLOOR - DAY);
		assert.deepEqual(
			statesOf(h),
			everyStream(cursorAt(FLOOR, NOW, FIXTURE_OPEN)),
		);
	});
}

test("collect: the least advanced stream's cursor sets where the overlap starts", async () => {
	const behind = NOW.getTime() - 20 * DAY;
	const fake = fakeWhoop(fixtures());
	const h = await collect(fake, {
		state: {
			...everyStream(cursorAt(FLOOR, NOW)),
			sleeps: cursorAt(FLOOR, behind),
		},
		now: LATER,
	});
	assert.equal(
		nth(cyclesRequests(fake), 0).start,
		behind - OVERLAP_DAYS * DAY - DAY,
	);
	assert.deepEqual(
		statesOf(h),
		everyStream(cursorAt(FLOOR, LATER, FIXTURE_OPEN)),
	);
});

const SINCE = "2026-09-01T00:00:00.000Z";
/** How far before a grant's start the walk reaches, for a cycle that began before it and holds sleeps after it. */
const REACH = 30 * DAY;

test("collect: a grant starting after the account starts the walk, and the cursor's floor, thirty days before it", async () => {
	const fake = fakeWhoop(fixtures());
	const h = await collect(fake, { ranges: everyStream({ since: SINCE }) });
	const requests = cyclesRequests(fake);
	assert.equal(requests.length, 2, "the reach adds a window");
	assert.equal(
		nth(requests, 0).start,
		Date.parse(SINCE) - REACH - DAY,
		"the reach, less the day's pad",
	);
	assert.deepEqual(
		statesOf(h),
		everyStream(cursorAt(Date.parse(SINCE) - REACH, NOW, FIXTURE_OPEN)),
	);
	assert.deepEqual(idsOf(h, "cycles"), FIXTURE_CYCLE_IDS);
});

test("collect: a grant starting within thirty days of the account's start walks from the account's start", async () => {
	const since = FLOOR + DAY; // the account's created_at
	const fake = fakeWhoop(fixtures());
	const h = await collect(fake, { ranges: everyStream({ since: iso(since) }) });
	assert.equal(nth(cyclesRequests(fake), 0).start, FLOOR - DAY);
	assert.deepEqual(
		statesOf(h),
		everyStream(cursorAt(FLOOR, NOW, FIXTURE_OPEN)),
	);
});

test("collect: a cycle that began a day before the grant gives the nap and workout it holds inside it, and nothing before", async () => {
	const since = Date.parse(SINCE);
	const began = since - DAY;
	const recovery = nth(elements(), 0).recovery;
	assert.ok(recovery);
	const fake = fakeWhoop(
		serve([
			holding(cycleAt(1_000_000_901, began, { during: span(began, 32 * 60) }), {
				recovery: { ...recovery, activity_id: uuid(931) },
				sleeps: [sleepAt(931, began), sleepAt(932, since + 2 * HOUR, true)],
				workouts: [workoutAt(933, since + 4 * HOUR)],
			}),
		]),
	);
	const h = await collect(fake, { ranges: everyStream({ since: SINCE }) });
	assert.equal(nth(cyclesRequests(fake), 0).start, since - REACH - DAY);
	assert.deepEqual(h.skipped, []);
	assert.deepEqual(countsOf(h), {
		cycles: 0,
		recoveries: 0,
		sleeps: 1,
		workouts: 1,
	});
	assert.deepEqual(idsOf(h, "sleeps"), [uuid(932)]);
	assert.deepEqual(idsOf(h, "workouts"), [uuid(933)]);
	assert.deepEqual(messagesOf(h, "PROGRESS"), [], "held out, not unreadable");
	assert.deepEqual(statesOf(h), everyStream(cursorAt(since - REACH, NOW)));
});

test("collect: a workouts grant starting inside a cycle that began ten days earlier keeps the workout, on a first run and on one resumed from a two-day reach", async () => {
	// A strap left off: the cycle runs from ten days before the grant until after it.
	const since = Date.parse(SINCE);
	const began = since - 10 * DAY;
	const held = [
		holding(
			cycleAt(1_000_000_921, began, {
				during: `['${iso(began)}','${iso(since + 2 * DAY)}')`,
			}),
			{ workouts: [workoutAt(951, since + HOUR)] },
		),
	];
	const ranges = { workouts: { since: SINCE } };
	const streams = ["workouts"] as const;
	const first = await collect(fakeWhoop(serve(held)), { ranges, streams });
	assert.deepEqual(idsOf(first, "workouts"), [uuid(951)], "first run");
	assert.deepEqual(first.skipped, []);
	// A cursor saved by a run that reached back only two days.
	const fake = fakeWhoop(serve(held));
	const resumed = await collect(fake, {
		ranges,
		streams,
		now: LATER,
		state: { workouts: cursorAt(since - 2 * DAY, NOW) },
	});
	assert.deepEqual(idsOf(resumed, "workouts"), [uuid(951)], "resumed run");
	assert.equal(nth(cyclesRequests(fake), 0).start, since - REACH - DAY);
});

test("collect: each record is held to its own stream's start, to the instant: a sleep an hour before it is neither emitted nor counted, one at it is", async () => {
	const since = Date.parse(SINCE);
	const early = { since: iso(since - 5 * DAY) };
	const began = since - HOUR;
	const fake = fakeWhoop(
		serve([
			holding(cycleAt(1_000_000_911, began), {
				sleeps: [sleepAt(941, began), sleepAt(942, since, true)],
				workouts: [workoutAt(943, since - 30 * MINUTE)],
			}),
		]),
	);
	const h = await collect(fake, {
		ranges: {
			cycles: early,
			recoveries: early,
			sleeps: { since: SINCE },
			workouts: early,
		},
	});
	assert.deepEqual(h.skipped, []);
	assert.deepEqual(idsOf(h, "cycles"), ["1000000911"], "inside its own grant");
	assert.deepEqual(
		idsOf(h, "sleeps"),
		[uuid(942)],
		"at since kept; an hour before held out",
	);
	assert.deepEqual(
		idsOf(h, "workouts"),
		[uuid(943)],
		"before the sleeps' start, inside its own",
	);
	assert.deepEqual(messagesOf(h, "PROGRESS"), []);
	assert.deepEqual(messagesOf(h, "SKIP_RESULT"), []);
});

test("collect: a grant's end is exclusive, to the instant: a nap starting at it is neither emitted nor counted", async () => {
	const until = Date.parse("2026-09-18T00:00:00.000Z");
	const began = until - 2 * HOUR;
	const fake = fakeWhoop(
		serve([
			holding(cycleAt(1_000_000_921, began), {
				sleeps: [sleepAt(951, began), sleepAt(952, until, true)],
				workouts: [workoutAt(953, until - MINUTE)],
			}),
		]),
	);
	const h = await collect(fake, { ranges: everyStream({ until: iso(until) }) });
	assert.deepEqual(h.skipped, []);
	assert.deepEqual(idsOf(h, "cycles"), ["1000000921"]);
	assert.deepEqual(idsOf(h, "sleeps"), [uuid(951)]);
	assert.deepEqual(idsOf(h, "workouts"), [uuid(953)], "a minute before");
	assert.deepEqual(messagesOf(h, "PROGRESS"), []);
	assert.deepEqual(statesOf(h), everyStream(cursorAt(FLOOR, until)));
});

test("collect: one stream granted without a start walks every stream from the account's start; the granted one's cursor starts at its own grant", async () => {
	const fake = fakeWhoop(fixtures());
	const h = await collect(fake, { ranges: { sleeps: { since: SINCE } } });
	assert.equal(nth(cyclesRequests(fake), 0).start, FLOOR - DAY);
	assert.deepEqual(statesOf(h), {
		...everyStream(cursorAt(FLOOR, NOW, FIXTURE_OPEN)),
		sleeps: cursorAt(Date.parse(SINCE) - REACH, NOW, FIXTURE_OPEN),
	});
});

test("collect: a stream whose grant later reaches further back reads that history then, though the other streams' cursors are current", async () => {
	// Run 1 reads every cycle but holds sleeps to the grant; their cursor must not claim the rest.
	const first = await collect(fakeWhoop(fixtures()), {
		ranges: { sleeps: { since: SINCE } },
	});
	const fake = fakeWhoop(fixtures());
	const h = await collect(fake, { state: statesOf(first), now: LATER });
	assert.equal(
		nth(cyclesRequests(fake), 0).start,
		FLOOR - DAY,
		"back to the account's start, for sleeps",
	);
	assert.deepEqual((statesOf(h).sleeps as { floor: string }).floor, iso(FLOOR));
});

test("collect: a stream whose grant's end is later lifted reads on from where that end left its cursor", async () => {
	const until = Date.parse("2026-08-20T00:00:00.000Z");
	const first = await collect(fakeWhoop(fixtures()), {
		ranges: { sleeps: { until: iso(until) }, workouts: { until: iso(until) } },
	});
	assert.equal(
		(statesOf(first).sleeps as { through: string }).through,
		iso(until),
	);
	const fake = fakeWhoop(fixtures());
	const h = await collect(fake, { state: statesOf(first), now: LATER });
	assert.equal(
		nth(cyclesRequests(fake), 0).start,
		until - 7 * DAY - DAY,
		"the week before the sleeps cursor, less the day's pad",
	);
	assert.deepEqual(idsOf(h, "sleeps"), [uuid(101), uuid(102), uuid(103)]);
});

test("collect: an unreadable record before its stream's grant is neither emitted nor counted", async () => {
	const since = Date.parse(SINCE);
	const fake = fakeWhoop(
		serve([
			cycleAt(1_000_000_330, since - DAY, { scaled_strain: "8.5" }),
			cycleAt(1_000_000_331, since + DAY),
		]),
	);
	const h = await collect(fake, { ranges: { cycles: { since: SINCE } } });
	assert.deepEqual(idsOf(h, "cycles"), ["1000000331"]);
	assert.deepEqual(progressOf(h), []);
});

test("collect: a grant starting before the account walks from the account's start", async () => {
	const fake = fakeWhoop(fixtures());
	const h = await collect(fake, {
		ranges: everyStream({ since: "2020-01-01T00:00:00.000Z" }),
	});
	assert.equal(nth(cyclesRequests(fake), 0).start, FLOOR - DAY);
	assert.deepEqual(
		statesOf(h),
		everyStream(cursorAt(FLOOR, NOW, FIXTURE_OPEN)),
	);
});

test("collect: a grant ending in the past ends the walk, and the cursor, there", async () => {
	const until = Date.parse("2026-09-15T00:00:00.000Z");
	const fake = fakeWhoop(fixtures());
	const h = await collect(fake, { ranges: everyStream({ until: iso(until) }) });
	const requests = cyclesRequests(fake);
	assert.equal(nth(requests, requests.length - 1).end, until + DAY);
	assert.deepEqual(
		idsOf(h, "cycles"),
		["1000000101"],
		"only the cycle that starts before until",
	);
	assert.deepEqual(
		idsOf(h, "sleeps"),
		[uuid(101)],
		"that cycle's nap, after until, held out",
	);
	assert.deepEqual(idsOf(h, "workouts"), [uuid(201)]);
	assert.deepEqual(messagesOf(h, "PROGRESS"), []);
	assert.deepEqual(statesOf(h), everyStream(cursorAt(FLOOR, until)));
});

// ── The per-run cap ────────────────────────────────────────────────────────
const LONG_BOOTSTRAP = bootstrapWith((b) => {
	b.account.created_at = "2025-01-01T00:00:00.000Z";
	b.user.created_at = "2025-01-01T00:00:00.000Z";
});
const LONG_FLOOR = Date.parse("2024-12-31T00:00:00.000Z");

test("collect: a walk past maxWindowsPerRun stops after that many windows, and the next run continues", async () => {
	const pacing = { maxWindowsPerRun: 2 };
	const fake = fakeWhoop(fixtures(CYCLES, LONG_BOOTSTRAP));
	const h = await collect(fake, { pacing });
	const through = LONG_FLOOR + 2 * WINDOW_DAYS * DAY;
	assert.deepEqual(
		cyclesRequests(fake).map((request) => request.start),
		[LONG_FLOOR - DAY, LONG_FLOOR + WINDOW_DAYS * DAY - DAY],
	);
	assertSkips(h, "source_limit_reached", RETRY);
	assert.deepEqual(statesOf(h), everyStream(cursorAt(LONG_FLOOR, through)));
	assertStateLast(h);

	const next = fakeWhoop(fixtures(CYCLES, LONG_BOOTSTRAP));
	const h2 = await collect(next, { pacing, state: statesOf(h) });
	const resume = through - OVERLAP_DAYS * DAY;
	assert.deepEqual(
		cyclesRequests(next).map((request) => request.start),
		[resume - DAY, resume + WINDOW_DAYS * DAY - DAY],
	);
	assertSkips(h2, "source_limit_reached", RETRY);
	assert.deepEqual(
		statesOf(h2),
		everyStream(cursorAt(LONG_FLOOR, resume + 2 * WINDOW_DAYS * DAY)),
	);
});

test("collect: a walk that fits maxWindowsPerRun exactly is not deferred", async () => {
	const fake = fakeWhoop(fixtures());
	const h = await collect(fake, { pacing: { maxWindowsPerRun: 2 } });
	assert.equal(cyclesRequests(fake).length, 2);
	assert.deepEqual(messagesOf(h, "SKIP_RESULT"), []);
	assert.deepEqual(
		statesOf(h),
		everyStream(cursorAt(FLOOR, NOW, FIXTURE_OPEN)),
	);
});

// ── Truncation ─────────────────────────────────────────────────────────────
test("collect: a window answered with as many cycles as asked for, some from inside it, halves and reads again", async () => {
	// One cycle inside the first window; 63 just past it, inside its padded request.
	const inside = cycleAt(1_000_000_400, FLOOR + HOUR);
	const past = Array.from({ length: 63 }, (_, i) =>
		cycleAt(1_000_000_401 + i, W1_END + HOUR + i * 60_000),
	);
	const fake = fakeWhoop(serve([inside, ...past]));
	const h = await collect(fake);
	const requests = cyclesRequests(fake);
	const full = nth(requests, 0);
	const half = nth(requests, 1);

	assert.equal(full.limit, 64);
	assert.equal(half.start, full.start, "the same start");
	assert.ok(half.end < full.end, "an earlier end");
	assert.equal(half.end, FLOOR + (WINDOW_DAYS / 2) * DAY + DAY);
	assert.equal(half.limit, 2 * (WINDOW_DAYS / 2 + 2));
	assert.equal(
		nth(requests, 2).start,
		FLOOR + (WINDOW_DAYS / 2) * DAY - DAY,
		"the walk goes on from the halved end",
	);
	assert.equal(requests.length, 4);
	assert.deepEqual(
		fake.log.filter((entry) => entry !== "read cycles" && entry !== "sleep 0"),
		["read bootstrap"],
	);
	assert.equal(sleepsOf(fake).length, 4, "a pause before each cycles read");

	const ids = idsOf(h, "cycles");
	assert.equal(ids.length, 64);
	assert.equal(new Set(ids).size, 64, "each cycle once");
	assert.deepEqual(messagesOf(h, "SKIP_RESULT"), []);
	assert.deepEqual(messagesOf(h, "PROGRESS"), []);
	assert.deepEqual(statesOf(h), everyStream(cursorAt(FLOOR, NOW)));
});

test("collect: a window answered with as many cycles as asked for, none from inside it, is not halved", async () => {
	// WHOOP's reply to a window it holds nothing for: its newest cycles (spec §4, source A).
	const newest = Array.from(
		{ length: 64 },
		(_, i) =>
			cycleAt(1_000_000_500 + i, NOW.getTime() - 3 * DAY + i * 60_000).element,
	);
	const fake = fakeWhoop((path, before) =>
		isCycles(path) && before === 0
			? json({ records: newest })
			: fixtures()(path, before),
	);
	const h = await collect(fake);
	const requests = cyclesRequests(fake);
	assert.equal(
		nth(requests, 0).limit,
		newest.length,
		"the answer fills the limit",
	);
	assert.deepEqual(
		requests.map((request) => request.start),
		[FLOOR - DAY, W1_END - DAY],
	);
	assert.deepEqual(idsOf(h, "cycles"), FIXTURE_CYCLE_IDS);
	assert.deepEqual(
		messagesOf(h, "PROGRESS"),
		[],
		"out-of-window cycles are not unreadable",
	);
	assert.deepEqual(messagesOf(h, "SKIP_RESULT"), []);
});

test("collect: a window still full at a day skips every stream as unreadable and saves no cursor", async () => {
	const fake = fakeWhoop((path) => {
		if (path === PROBE_PATH) {
			return ok(BOOTSTRAP);
		}
		const { start, limit } = requestOf(path);
		return json({
			records: Array.from(
				{ length: limit },
				(_, i) => cycleAt(1_000_000_600 + i, start + DAY + i * 60_000).element,
			),
		});
	});
	const h = await collect(fake);
	const requests = cyclesRequests(fake);
	assert.ok(requests.length > 2);
	for (let i = 1; i < requests.length; i += 1) {
		assert.equal(nth(requests, i).start, FLOOR - DAY);
		assert.ok(
			nth(requests, i).end < nth(requests, i - 1).end,
			"each read shorter than the last",
		);
	}
	const last = nth(requests, requests.length - 1);
	assert.ok(last.end - last.start - 2 * DAY <= DAY, "down to a day");
	assertSkips(h, "source_unreadable", UPGRADE);
	assert.deepEqual(h.emitted, []);
	assert.deepEqual(messagesOf(h, "STATE"), []);
});

// ── Window assignment and dedupe ───────────────────────────────────────────
const REVISED = "2026-09-16T00:00:00.000+0000";
for (const { label, copy, first, strain } of [
	{
		label: "a later updated_at, after",
		copy: { updated_at: REVISED },
		first: false,
		strain: 15.5,
	},
	{
		label: "a later updated_at, before",
		copy: { updated_at: REVISED },
		first: true,
		strain: 15.5,
	},
	{ label: "the same updated_at, after", copy: {}, first: false, strain: 15.5 },
	{
		label: "no updated_at, after",
		copy: { updated_at: undefined },
		first: false,
		strain: 12.4,
	},
]) {
	test(`collect: a cycle answered twice in one window is emitted once (copy with ${label})`, async () => {
		const records = elements();
		const original = nth(records, 0);
		const twin = structuredClone(original);
		Object.assign(twin.cycle, { scaled_strain: 15.5 }, copy);
		records.splice(first ? 0 : 1, 0, twin);
		const h = await collect(fakeWhoop(fixtures(JSON.stringify({ records }))));
		assert.deepEqual(idsOf(h, "cycles"), FIXTURE_CYCLE_IDS);
		assert.equal(nth(recordsOf(h, "cycles"), 0).strain, strain);
		assert.deepEqual(
			countsOf(h),
			{ cycles: 3, recoveries: 1, sleeps: 3, workouts: 1 },
			"the copy's sleeps not doubled",
		);
		assert.deepEqual(messagesOf(h, "PROGRESS"), []);
	});
}

test("collect: a cycle outside a window is dropped there without a count, and one near an edge is kept once", async () => {
	const fake = fakeWhoop(
		serve([
			cycleAt(1_000_000_701, FLOOR - 12 * HOUR), // before the account: only in the first request's pad
			cycleAt(1_000_000_702, W1_END - 6 * HOUR), // first window, and the second request's pad
			cycleAt(1_000_000_703, W1_END + 6 * HOUR), // second window, and the first request's pad
			cycleAt(1_000_000_704, NOW.getTime() + 6 * HOUR), // after now: only in the last request's pad
		]),
	);
	const h = await collect(fake);
	assert.deepEqual(idsOf(h, "cycles"), ["1000000702", "1000000703"]);
	assert.deepEqual(messagesOf(h, "PROGRESS"), []);
	assert.deepEqual(messagesOf(h, "SKIP_RESULT"), []);
	assert.deepEqual(statesOf(h), everyStream(cursorAt(FLOOR, NOW)));
});
