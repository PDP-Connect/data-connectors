// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Layer 2: collectGarminBrowser through its seams. A fake page answers each in-page read with a
 * scripted PageFetch chosen by its path, by default from fake-garmin.ts over the fixtures; pacing
 * is zero and the clock fixed. Records go through makeRecordingEmit(validateRecord), as the
 * runtime's would.
 *
 * The fixture account's time zone is Pacific/Auckland: at NOW the owner's day is 21 September,
 * while it is still the 20th in UTC and in Sydney, the two zones these tests run under.
 */

import assert from "node:assert/strict";
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
	fixtureData,
	garminApi,
	type Answer as SiteAnswer,
	type SiteData,
} from "./fake-garmin.ts";
import {
	APP_URL,
	collectGarminBrowser,
	type GarminCollectContext,
	MAX_RETRY_DAYS,
	ORIGIN,
	type Pacing,
	type PageFetch,
	PROBE_PATH,
	STREAMS,
} from "./index.ts";
import { type Stream, validateRecord } from "./schemas.ts";

const NOW = new Date("2026-09-20T13:30:00.000Z");
/** The owner's day at NOW, in Pacific/Auckland. */
const TODAY = "2026-09-21";
/** Ninety days back to and including TODAY: where a first run starts. */
const FLOOR = "2026-06-24";
/** A first run's cursor in every stream. */
const FULL = { next_day: "2026-09-22", floor: FLOOR };
/** A first run's windows: 28 days each, the last cut at TODAY. */
const WINDOWS = [
	["2026-06-24", "2026-07-21"],
	["2026-07-22", "2026-08-18"],
	["2026-08-19", "2026-09-15"],
	["2026-09-16", "2026-09-21"],
];
/**
 * The windows a range stream re-reads on a run from FULL the same day: from four weeks before the
 * last run's day, TODAY, to TODAY.
 */
const AGAIN = [
	["2026-08-24", "2026-09-20"],
	[TODAY, TODAY],
] as const;
const IDS: Record<Stream, string[]> = {
	daily_summaries: ["2026-09-16"],
	sleep: ["2026-09-15", "2026-09-16"],
	hrv: ["2026-09-14", "2026-09-15", "2026-09-16"],
	training_status: ["2026-09-16"],
	activities: ["41000101", "41000102"],
};
const COUNTS = Object.fromEntries(
	STREAMS.map((stream) => [stream, IDS[stream].length]),
);

const SIGN_IN = { action: "refresh_credentials", retryable: false };
const RETRY = { action: "retry_by_runtime", retryable: true };
const UPGRADE = { action: "retry_on_connector_upgrade", retryable: false };

/** A retry span; one day when `to` is left out. */
const span = (from: string, to = from) => ({ from, to });

const addDays = (day: string, n: number): string =>
	new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000)
		.toISOString()
		.slice(0, 10);
/** Every day from `from` to `to`, both included. */
function daysFrom(from: string, to: string): string[] {
	const days: string[] = [];
	for (let day = from; day <= to; day = addDays(day, 1)) days.push(day);
	return days;
}

// ── Garmin's answers ───────────────────────────────────────────────────────
type Answer = (path: string) => PageFetch;
const respond = ({ status, contentType, body }: SiteAnswer): PageFetch => ({
	kind: "response",
	status,
	contentType,
	retryAfter: null,
	body,
});
/** The fake account: by default, the fixtures. `change` edits it before each answer (garminApi). */
function site(
	edit: (data: SiteData) => void = () => {},
	change?: (data: SiteData, path: string) => void,
): Answer {
	const data = fixtureData();
	edit(data);
	const api = garminApi(data, change);
	return (path) => respond(api(path));
}
const response = (
	status: number,
	body = "",
	contentType = "text/plain",
	retryAfter: string | null = null,
): PageFetch => ({ kind: "response", status, contentType, retryAfter, body });
const json = (value: unknown): PageFetch =>
	response(200, JSON.stringify(value), "application/json");

/** `base`, except that paths `when` matches answer `answer`, the first `times` times they are read. */
function except(
	base: Answer,
	when: (path: string) => boolean,
	answer: PageFetch | ((path: string) => PageFetch),
	times = Number.POSITIVE_INFINITY,
): Answer {
	let used = 0;
	return (path) => {
		if (!when(path) || used >= times) return base(path);
		used += 1;
		return typeof answer === "function" ? answer(path) : answer;
	};
}

const DAILY = "/gc-api/usersummary-service/usersummary/daily?calendarDate=";
const TRAINING = "/gc-api/metrics-service/metrics/trainingstatus/daily/";
const SLEEP = "/gc-api/sleep-service/stats/sleep/daily/";
const HRV = "/gc-api/hrv-service/hrv/daily/";
const ACTIVITIES = "/gc-api/activitylist-service/activities/search/activities?";
/** AGAIN's sleep and HRV reads. */
const SLEEP_AGAIN = AGAIN.map(([from, to]) => `${SLEEP}${from}/${to}`);
const HRV_AGAIN = AGAIN.map(([from, to]) => `${HRV}${from}/${to}`);
const PREFIX: Record<Stream, string> = {
	daily_summaries: DAILY,
	sleep: SLEEP,
	hrv: HRV,
	training_status: TRAINING,
	activities: ACTIVITIES,
};
const streamOf = (path: string): string =>
	path === PROBE_PATH
		? "settings"
		: (STREAMS.find((stream) => path.startsWith(PREFIX[stream])) ?? "unknown");
const isStream =
	(stream: Stream) =>
	(path: string): boolean =>
		path.startsWith(PREFIX[stream]);
const isPath =
	(wanted: string) =>
	(path: string): boolean =>
		path === wanted;
/** The day a daily read asks for. */
const dayOf = (path: string): string => path.slice(path.length - 10);
/** The window a range read asks for, and for activities its offset and page size. */
function windowOf(path: string): {
	from: string;
	to: string;
	start?: number;
	limit?: number;
} {
	if (path.startsWith(ACTIVITIES)) {
		const query = new URLSearchParams(path.slice(ACTIVITIES.length));
		return {
			from: query.get("startDate") ?? "",
			to: query.get("endDate") ?? "",
			start: Number(query.get("start")),
			limit: Number(query.get("limit")),
		};
	}
	const [from = "", to = ""] = path.split("/").slice(-2);
	return { from, to };
}
/** A range read of `stream` whose window starts on `from`. */
const windowFrom =
	(stream: Stream, from: string) =>
	(path: string): boolean =>
		isStream(stream)(path) && windowOf(path).from === from;

// ── The fake page ──────────────────────────────────────────────────────────
interface Fake {
	page: GarminCollectContext["page"];
	/** Every in-page read's path, in order. */
	paths: string[];
	/** Every navigation. */
	visits: string[];
	/** Reads (by stream) and pauses, interleaved. */
	log: string[];
	/** Every evaluate argument, to check what crosses into the page. */
	args: Array<Record<string, unknown>>;
	sleep: (ms: number) => Promise<void>;
}

/**
 * connect.garmin.com, signed in. Off the app's origin (`startsOn`), every read answers
 * wrong_origin, as the in-page check does, until a goto lands on `landsOn` (by default the app).
 */
function fakeGarmin(
	answer: Answer = site(),
	options: { startsOn?: string; landsOn?: string } = {},
): Fake {
	const paths: string[] = [];
	const visits: string[] = [];
	const log: string[] = [];
	const args: Array<Record<string, unknown>> = [];
	let origin = options.startsOn ?? ORIGIN;
	const page = {
		goto: (url: string) => {
			visits.push(url);
			origin = options.landsOn ?? ORIGIN;
			return Promise.resolve(null);
		},
		evaluate: (
			_fn: unknown,
			arg: { path: string } & Record<string, unknown>,
		) => {
			args.push(arg);
			paths.push(arg.path);
			log.push(`read ${streamOf(arg.path)}`);
			if (origin !== ORIGIN)
				return Promise.resolve({ kind: "wrong_origin", origin });
			return Promise.resolve(answer(arg.path));
		},
	} as unknown as GarminCollectContext["page"];
	const sleep = (ms: number): Promise<void> => {
		log.push(`sleep ${ms}`);
		return Promise.resolve();
	};
	return { args, log, page, paths, sleep, visits };
}
const pathsOf = (fake: Fake, stream: Stream): string[] =>
	fake.paths.filter(isStream(stream));
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
	await collectGarminBrowser(
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
const idsOf = (h: RecordingEmit, stream: Stream): unknown[] =>
	h.emitted
		.filter((record) => record.stream === stream)
		.map((record) => record.data.id);
const countsOf = (h: RecordingEmit): Record<string, number> =>
	Object.fromEntries(
		STREAMS.map((stream) => [stream, idsOf(h, stream).length]),
	);
const progressOf = (h: RecordingEmit) =>
	messagesOf(h, "PROGRESS").map(({ stream, count }) => ({ stream, count }));
/** Each PROGRESS line's stream, count and words. */
const progressLines = (h: RecordingEmit) =>
	messagesOf(h, "PROGRESS").map(({ stream, count, message }) => ({
		stream,
		count,
		message,
	}));
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

/** One SKIP_RESULT per stream named, in stream order, each with this reason and hint. */
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
		if (state < 0) continue;
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
test("collect: a first run emits every fixture record once, then one STATE per stream from ninety days back to the owner's today", async () => {
	const fake = fakeGarmin();
	const h = await collect(fake);
	assert.deepEqual(h.skipped, []);
	assert.deepEqual(countsOf(h), COUNTS);
	for (const stream of STREAMS)
		assert.deepEqual(idsOf(h, stream), IDS[stream], stream);
	assert.deepEqual(messagesOf(h, "SKIP_RESULT"), []);
	assert.deepEqual(messagesOf(h, "PROGRESS"), []);
	assert.deepEqual(statesOf(h), everyStream(FULL));
	assert.deepEqual(
		messagesOf(h, "STATE").map(({ stream }) => stream),
		[...STREAMS],
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

test("collect: reads settings once, then each day of the daily streams and 28-day windows of the range streams, every path a handle-free GET under /gc-api", async () => {
	const fake = fakeGarmin();
	await collect(fake);
	assert.equal(fake.paths[0], PROBE_PATH);
	assert.equal(fake.paths.filter((path) => path === PROBE_PATH).length, 1);
	assert.deepEqual(fake.visits, [], "on the app already: no navigation");
	const days = daysFrom(FLOOR, TODAY);
	assert.equal(days.length, 90);
	assert.deepEqual(
		pathsOf(fake, "daily_summaries"),
		days.map((day) => `${DAILY}${day}`),
	);
	assert.deepEqual(
		pathsOf(fake, "training_status"),
		days.map((day) => `${TRAINING}${day}`),
	);
	assert.deepEqual(
		pathsOf(fake, "sleep"),
		WINDOWS.map(([from, to]) => `${SLEEP}${from}/${to}`),
	);
	assert.deepEqual(
		pathsOf(fake, "hrv"),
		WINDOWS.map(([from, to]) => `${HRV}${from}/${to}`),
	);
	assert.deepEqual(
		pathsOf(fake, "activities"),
		WINDOWS.map(
			([from, to]) =>
				`${ACTIVITIES}startDate=${from}&endDate=${to}&start=0&limit=100`,
		),
	);
	assert.equal(fake.paths.length, 1 + 90 + 4 + 4 + 90 + 4);
	// Streams one after another, in manifest order.
	const order = fake.paths
		.map(streamOf)
		.filter((name, i, all) => name !== all[i - 1]);
	assert.deepEqual(order, ["settings", ...STREAMS]);
	for (const path of fake.paths) {
		assert.match(path, /^\/gc-api\//);
		assert.doesNotMatch(path, /fixture-owner|displayName|epoch\/request/i);
	}
	for (const arg of fake.args) {
		assert.deepEqual(Object.keys(arg).toSorted(), ["origin", "path"]);
		assert.equal(arg.origin, ORIGIN);
	}
	for (const [from, to] of WINDOWS) {
		const span =
			(Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
				86_400_000 +
			1;
		assert.ok(span <= 28, `${from}..${to}`);
	}
});

test("collect: pauses before each read after the first, never after the last", async () => {
	const fake = fakeGarmin();
	await collect(fake, { pacing: { requestDelayMs: 5 } });
	assert.equal(fake.log[0], "read settings");
	assert.equal(fake.log.at(-1), "read activities");
	for (let i = 1; i < fake.log.length; i += 1) {
		const pair = [fake.log[i - 1], fake.log[i]];
		assert.ok(
			pair[0]?.startsWith("read") !== pair[1]?.startsWith("read"),
			`reads and pauses alternate at ${i}: ${pair.join(", ")}`,
		);
	}
	assert.ok(sleepsOf(fake).every((entry) => entry === "sleep 5"));
	assert.equal(sleepsOf(fake).length, fake.paths.length - 1);
});

// ── Scope ──────────────────────────────────────────────────────────────────
test("collect: only the requested stream is read, emitted and checkpointed", async () => {
	const fake = fakeGarmin();
	const h = await collect(fake, { streams: ["sleep"] });
	assert.deepEqual(
		new Set(fake.paths.map(streamOf)),
		new Set(["settings", "sleep"]),
	);
	assert.deepEqual(
		new Set(h.emitted.map((record) => record.stream)),
		new Set(["sleep"]),
	);
	assert.deepEqual(idsOf(h, "sleep"), IDS.sleep);
	assert.deepEqual(statesOf(h), { sleep: FULL });
	for (const message of h.protocolMessages) {
		assert.equal("stream" in message ? message.stream : "sleep", "sleep");
	}
});

test("collect: with no stream requested, reads, pauses and emits nothing", async () => {
	const fake = fakeGarmin();
	const h = await collect(fake, { streams: [] });
	assert.deepEqual(fake.log, []);
	assert.deepEqual(fake.visits, []);
	assert.deepEqual(h.events, []);
});

// ── The owner's today ──────────────────────────────────────────────────────
/** Still the 20th in UTC; already the 21st in Sydney and in Kiritimati. */
const LATE = new Date("2026-09-20T23:30:00.000Z");

test("collect: the last day read is the owner's today in the site's time zone, whatever the process's zone", async () => {
	const cases: Array<[string, unknown, Date, string]> = [
		// UTC and Sydney still on the 20th, Auckland on the 21st.
		["Auckland", "Pacific/Auckland", NOW, "2026-09-21"],
		["Sydney", "Australia/Sydney", NOW, "2026-09-20"],
		// Sydney on the 21st, Los Angeles still on the 20th.
		["Los Angeles", "America/Los_Angeles", LATE, "2026-09-20"],
		["Sydney, late", "Australia/Sydney", LATE, "2026-09-21"],
	];
	for (const [label, timeZone, now, today] of cases) {
		const fake = fakeGarmin(
			site((data) => {
				data.settings = { displayName: "fixture-owner", timeZone };
			}),
		);
		const h = await collect(fake, { now, streams: ["daily_summaries"] });
		const days = pathsOf(fake, "daily_summaries").map(dayOf);
		assert.equal(days.at(-1), today, label);
		assert.equal(days[0], addDays(today, -89), label);
		assert.deepEqual(
			statesOf(h),
			{
				daily_summaries: {
					next_day: addDays(today, 1),
					floor: addDays(today, -89),
				},
			},
			label,
		);
	}
});

test("collect: with no zone, or one Intl does not know, the owner's today is the UTC day, not the process's", async () => {
	// A process a day ahead of UTC at LATE, whatever zone the suite runs under; Node applies it at once.
	const saved = process.env.TZ;
	process.env.TZ = "Pacific/Kiritimati";
	try {
		const zones = [undefined, "Mars/Olympus_Mons"];
		const runs = await Promise.all(
			zones.map(async (timeZone) => {
				const fake = fakeGarmin(
					site((data) => {
						data.settings = { displayName: "fixture-owner", timeZone };
					}),
				);
				const h = await collect(fake, {
					now: LATE,
					streams: ["daily_summaries"],
				});
				return { days: pathsOf(fake, "daily_summaries").map(dayOf), h };
			}),
		);
		for (const [i, { days, h }] of runs.entries()) {
			const label = String(zones[i]);
			assert.equal(days.at(-1), "2026-09-20", label);
			assert.deepEqual(
				statesOf(h),
				{ daily_summaries: { next_day: "2026-09-21", floor: "2026-06-23" } },
				label,
			);
		}
	} finally {
		if (saved === undefined) Reflect.deleteProperty(process.env, "TZ");
		else process.env.TZ = saved;
	}
});

// ── Fail closed: the settings read ─────────────────────────────────────────
interface Failure {
	answer: PageFetch;
	hint: object;
	label: string;
	reason: string;
	/** Reads of settings, the refresh's included. */
	reads?: number;
}
const SETTINGS_FAILURES: Failure[] = [
	{
		label: "401",
		answer: response(401),
		reason: "sign_in_required",
		hint: SIGN_IN,
	},
	{
		label: "403, even after reloading the app",
		answer: response(403),
		reason: "sign_in_required",
		hint: SIGN_IN,
		reads: 2,
	},
	{
		label: "500",
		answer: response(500, "<html></html>", "text/html"),
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
		label: "a 404 page",
		answer: response(404, "<html></html>", "text/html"),
		reason: "source_unreadable",
		hint: UPGRADE,
	},
	{
		label: "a 400",
		answer: response(
			400,
			'{"message":"bad","error":"BadRequest"}',
			"application/json",
		),
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
		answer: response(200, "{not json", "application/json"),
		reason: "source_unreadable",
		hint: UPGRADE,
	},
];

for (const failure of SETTINGS_FAILURES) {
	test(`collect: settings answering ${failure.label} skips every stream (${failure.reason}) and saves no cursor`, async () => {
		const fake = fakeGarmin((path) =>
			path === PROBE_PATH ? failure.answer : assert.fail(`read ${path}`),
		);
		const h = await collect(fake);
		assert.deepEqual(
			fake.paths,
			Array(failure.reads ?? 1).fill(PROBE_PATH),
			"no stream read",
		);
		assert.deepEqual(fake.visits, failure.reads === 2 ? [APP_URL] : []);
		assertSkips(h, failure.reason, failure.hint);
		assert.deepEqual(h.emitted, []);
		assert.deepEqual(messagesOf(h, "STATE"), []);
		assert.deepEqual(messagesOf(h, "PROGRESS"), []);
	});
}

test("collect: settings still rate limited after two 30 s waits skips every stream and saves no cursor", async () => {
	const fake = fakeGarmin(() => response(429));
	const h = await collect(fake);
	assert.deepEqual(fake.paths, [PROBE_PATH, PROBE_PATH, PROBE_PATH]);
	assert.deepEqual(sleepsOf(fake), ["sleep 30000", "sleep 30000"]);
	assertSkips(h, "collection_interrupted", RETRY);
	assert.deepEqual(messagesOf(h, "STATE"), []);
});

test("collect: off the app, the settings read goes to the app once and reads again; nothing else navigates", async () => {
	const fake = fakeGarmin(site(), { startsOn: "null" });
	const h = await collect(fake);
	assert.deepEqual(fake.paths.slice(0, 2), [PROBE_PATH, PROBE_PATH]);
	assert.deepEqual(fake.visits, [APP_URL]);
	assert.deepEqual(countsOf(h), COUNTS);
	assert.deepEqual(messagesOf(h, "SKIP_RESULT"), []);
});

for (const [label, startsOn] of [
	["Garmin's sign-in host", "https://sso.garmin.com"],
	["about:blank", "null"],
] as const) {
	test(`collect: a settings read still on ${label} after one navigation skips every stream`, async () => {
		const fake = fakeGarmin(site(), { startsOn, landsOn: startsOn });
		const h = await collect(fake);
		assert.deepEqual(fake.visits, [APP_URL]);
		assert.deepEqual(fake.paths, [PROBE_PATH, PROBE_PATH]);
		const sso = startsOn.startsWith("https://sso.");
		assertSkips(
			h,
			sso ? "sign_in_required" : "collection_interrupted",
			sso ? SIGN_IN : RETRY,
		);
		assert.deepEqual(messagesOf(h, "STATE"), []);
	});
}

test("collect: an app page with no token, even after one navigation, asks the owner to sign in", async () => {
	const fake = fakeGarmin(() => ({ kind: "no_token" }));
	const h = await collect(fake);
	assert.deepEqual(fake.visits, [APP_URL]);
	assertSkips(h, "sign_in_required", SIGN_IN);
});

// ── Fail closed: during a stream ───────────────────────────────────────────
const STREAM_FAILURES: Array<{
	label: string;
	answer: PageFetch;
	reason: string;
	hint: object;
}> = [
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
		label: "another origin",
		answer: { kind: "wrong_origin", origin: "https://www.garmin.com" },
		reason: "collection_interrupted",
		hint: RETRY,
	},
	{
		label: "a 404 page",
		answer: response(404, "<html></html>", "text/html"),
		reason: "source_unreadable",
		hint: UPGRADE,
	},
	{
		label: "a 200 HTML page",
		answer: response(200, "<html></html>", "text/html"),
		reason: "source_unreadable",
		hint: UPGRADE,
	},
];

for (const failure of STREAM_FAILURES) {
	test(`collect: a later day answering ${failure.label} skips that stream alone, its cursor at the day before`, async () => {
		const fake = fakeGarmin(
			except(site(), isPath(`${DAILY}2026-09-18`), failure.answer),
		);
		const h = await collect(fake);
		assertSkips(h, failure.reason, failure.hint, ["daily_summaries"]);
		assert.deepEqual(
			idsOf(h, "daily_summaries"),
			IDS.daily_summaries,
			"the day before the failure kept",
		);
		assert.equal(
			pathsOf(fake, "daily_summaries").at(-1),
			`${DAILY}2026-09-18`,
			"no day read after it",
		);
		assert.deepEqual(statesOf(h), {
			...everyStream(FULL),
			daily_summaries: { next_day: "2026-09-18", floor: FLOOR },
		});
		for (const stream of STREAMS.slice(1))
			assert.deepEqual(idsOf(h, stream), IDS[stream], stream);
		assertStateLast(h);
	});
}

test("collect: a stream whose first read fails saves no cursor, and the next stream goes on", async () => {
	const fake = fakeGarmin(except(site(), isStream("hrv"), response(503)));
	const h = await collect(fake);
	assertSkips(h, "collection_interrupted", RETRY, ["hrv"]);
	assert.equal(pathsOf(fake, "hrv").length, 1);
	const states = statesOf(h);
	assert.equal(Object.hasOwn(states, "hrv"), false);
	assert.deepEqual(
		states,
		everyStream(FULL, [
			"daily_summaries",
			"sleep",
			"training_status",
			"activities",
		]),
	);
});

test("collect: sign-in lost partway skips that stream and every later one with refresh_credentials, reading nothing more", async () => {
	const fake = fakeGarmin(
		except(site(), isPath(`${TRAINING}2026-09-17`), response(401)),
	);
	const h = await collect(fake);
	assertSkips(h, "sign_in_required", SIGN_IN, [
		"training_status",
		"activities",
	]);
	assert.deepEqual(
		pathsOf(fake, "activities"),
		[],
		"nothing read after the sign-in was lost",
	);
	assert.equal(fake.paths.at(-1), `${TRAINING}2026-09-17`);
	assert.deepEqual(idsOf(h, "training_status"), IDS.training_status);
	assert.deepEqual(statesOf(h), {
		daily_summaries: FULL,
		sleep: FULL,
		hrv: FULL,
		training_status: { next_day: "2026-09-17", floor: FLOOR },
	});
	assert.deepEqual(countsOf(h), { ...COUNTS, activities: 0 });
});

test("collect: a range read that lands on Garmin's sign-in host skips it and every later stream", async () => {
	const fake = fakeGarmin(
		except(site(), windowFrom("sleep", "2026-07-22"), {
			kind: "wrong_origin",
			origin: "https://sso.garmin.com",
		}),
	);
	const h = await collect(fake);
	assertSkips(h, "sign_in_required", SIGN_IN, [
		"sleep",
		"hrv",
		"training_status",
		"activities",
	]);
	assert.deepEqual(statesOf(h), {
		daily_summaries: FULL,
		sleep: { next_day: "2026-07-22", floor: FLOOR },
	});
	assert.equal(fake.paths.at(-1), `${SLEEP}2026-07-22/2026-08-18`);
});

// ── The 403 refresh ────────────────────────────────────────────────────────
test("collect: a 403 reloads the app once and repeats the same read, which then succeeds: nothing skipped", async () => {
	const failing = isPath(`${DAILY}2026-09-16`);
	const fake = fakeGarmin(except(site(), failing, response(403), 1));
	const h = await collect(fake);
	assert.deepEqual(fake.visits, [APP_URL]);
	assert.deepEqual(
		fake.paths.filter(failing).length,
		2,
		"the same read, repeated",
	);
	assert.deepEqual(messagesOf(h, "SKIP_RESULT"), []);
	assert.deepEqual(countsOf(h), COUNTS);
	assert.deepEqual(statesOf(h), everyStream(FULL));
	// The reload comes between the two reads of that day.
	const at = fake.paths.findIndex(failing);
	assert.equal(fake.paths[at + 1], `${DAILY}2026-09-16`);
});

test("collect: a 403 that the reload does not cure asks the owner to sign in, without a second reload", async () => {
	const failing = isPath(`${DAILY}2026-09-16`);
	const fake = fakeGarmin(except(site(), failing, response(403)));
	const h = await collect(fake);
	assert.deepEqual(fake.visits, [APP_URL]);
	assert.equal(fake.paths.filter(failing).length, 2);
	assertSkips(h, "sign_in_required", SIGN_IN);
	assert.deepEqual(statesOf(h), {
		daily_summaries: { next_day: "2026-09-16", floor: FLOOR },
	});
});

test("collect: the reload is spent once per run: a second 403 later asks for sign-in at once", async () => {
	const fake = fakeGarmin(
		except(
			except(site(), isPath(`${DAILY}2026-09-16`), response(403), 1),
			windowFrom("hrv", "2026-07-22"),
			response(403),
		),
	);
	const h = await collect(fake);
	assert.deepEqual(fake.visits, [APP_URL], "one reload in the run");
	assert.equal(
		fake.paths.filter(windowFrom("hrv", "2026-07-22")).length,
		1,
		"not repeated",
	);
	assertSkips(h, "sign_in_required", SIGN_IN, [
		"hrv",
		"training_status",
		"activities",
	]);
	assert.deepEqual(statesOf(h), {
		daily_summaries: FULL,
		sleep: FULL,
		hrv: { next_day: "2026-07-22", floor: FLOOR },
	});
});

// ── Rate limits ────────────────────────────────────────────────────────────
test("collect: a 429 that clears on retry costs one wait and no skip", async () => {
	const fake = fakeGarmin(
		except(site(), isPath(`${DAILY}2026-09-16`), response(429), 1),
	);
	const h = await collect(fake);
	assert.deepEqual(
		sleepsOf(fake).filter((entry) => entry !== "sleep 0"),
		["sleep 30000"],
	);
	assert.deepEqual(messagesOf(h, "SKIP_RESULT"), []);
	assert.deepEqual(countsOf(h), COUNTS);
});

test("collect: a 429 waits the Retry-After it carries", async () => {
	// HTTP dates are read against the wall clock at the 429: classify's own tests cover them.
	const fake = fakeGarmin(
		except(
			site(),
			isPath(`${DAILY}2026-09-16`),
			response(429, "", "text/plain", "7"),
			1,
		),
	);
	await collect(fake, { streams: ["daily_summaries"] });
	assert.deepEqual(
		sleepsOf(fake).filter((entry) => entry !== "sleep 0"),
		["sleep 7000"],
	);
});

test("collect: a 429 whose Retry-After passes maxRetryAfterMs skips at once, without waiting, the cursor at the day before", async () => {
	const fake = fakeGarmin(
		except(
			site(),
			isPath(`${DAILY}2026-09-16`),
			response(429, "", "text/plain", "120"),
		),
	);
	const h = await collect(fake, { streams: ["daily_summaries"] });
	assert.deepEqual(
		sleepsOf(fake).filter((entry) => entry !== "sleep 0"),
		[],
	);
	assertSkips(h, "collection_interrupted", RETRY, ["daily_summaries"]);
	assert.deepEqual(statesOf(h), {
		daily_summaries: { next_day: "2026-09-16", floor: FLOOR },
	});
});

test("collect: a day still rate limited after two waits skips its stream, and the next stream goes on", async () => {
	const fake = fakeGarmin(
		except(site(), isPath(`${DAILY}2026-09-16`), response(429)),
	);
	const h = await collect(fake);
	assert.deepEqual(
		sleepsOf(fake).filter((entry) => entry !== "sleep 0"),
		["sleep 30000", "sleep 30000"],
	);
	assertSkips(h, "collection_interrupted", RETRY, ["daily_summaries"]);
	assert.deepEqual(idsOf(h, "sleep"), IDS.sleep);
});

// ── Drift: counted, never emitted, never a skip ────────────────────────────
test("collect: a retyped metric costs that day alone, counted in PROGRESS; the cursor moves past it, and the day is kept to read again", async () => {
	const fake = fakeGarmin(
		site((data) => {
			(data.daily["2026-09-16"] as Record<string, unknown>).totalSteps = "8432";
		}),
	);
	const h = await collect(fake);
	assert.deepEqual(progressOf(h), [{ stream: "daily_summaries", count: 1 }]);
	assert.deepEqual(idsOf(h, "daily_summaries"), []);
	assert.deepEqual(messagesOf(h, "SKIP_RESULT"), []);
	assert.deepEqual(statesOf(h), {
		...everyStream(FULL),
		daily_summaries: { ...FULL, retry: [span("2026-09-16")] },
	});
	assertStateLast(h);
});

test("collect: a day that does not read, then a later day that fails: the record is still counted, the stream skips, and the cursor stops before the failure with the day kept", async () => {
	const fake = fakeGarmin(
		except(
			site((data) => summaryOn(data, "2026-09-16", "8432")),
			isPath(`${DAILY}2026-09-18`),
			response(500),
		),
	);
	const h = await collect(fake, { streams: ["daily_summaries"] });
	assert.deepEqual(progressOf(h), [{ stream: "daily_summaries", count: 1 }]);
	assertSkips(h, "collection_interrupted", RETRY, ["daily_summaries"]);
	assert.deepEqual(idsOf(h, "daily_summaries"), []);
	assert.deepEqual(statesOf(h), {
		daily_summaries: {
			next_day: "2026-09-18",
			floor: FLOOR,
			retry: [span("2026-09-16")],
		},
	});
	assertStateLast(h);
});

test("collect: a value outside its unit guard is counted unreadable and never reaches emitRecord", async () => {
	const fake = fakeGarmin(
		site((data) => {
			(data.daily["2026-09-16"] as Record<string, unknown>).restingHeartRate =
				400;
			(data.hrv[1] as Record<string, unknown>).lastNightAvg = 47_000;
		}),
	);
	const h = await collect(fake);
	assert.deepEqual(h.skipped, [], "validated before emitRecord");
	assert.deepEqual(progressOf(h), [
		{ stream: "daily_summaries", count: 1 },
		{ stream: "hrv", count: 1 },
	]);
	assert.deepEqual(idsOf(h, "hrv"), ["2026-09-14", "2026-09-16"]);
});

test("collect: a summary dated another day is counted; an all-null day and a 204 day are not", async () => {
	const fake = fakeGarmin(
		except(
			site((data) => {
				(data.daily["2026-09-16"] as Record<string, unknown>).calendarDate =
					"2026-09-15";
			}),
			isPath(`${DAILY}2026-09-10`),
			response(204, "", ""),
		),
	);
	const h = await collect(fake, { streams: ["daily_summaries"] });
	assert.deepEqual(progressOf(h), [{ stream: "daily_summaries", count: 1 }]);
	assert.deepEqual(statesOf(h), {
		daily_summaries: { ...FULL, retry: [span("2026-09-16")] },
	});
});

test("collect: a night of the wrong shape, or dated outside its window, is counted; the other night ships", async () => {
	const fake = fakeGarmin(
		except(
			site((data) => {
				(
					(data.sleep[0] as Record<string, unknown>).values as Record<
						string,
						unknown
					>
				).deepTime = "5400";
			}),
			windowFrom("sleep", "2026-09-16"),
			(path) => {
				const real = site()(path);
				const body = JSON.parse(
					real.kind === "response" ? real.body : "{}",
				) as { individualStats: unknown[] };
				return json({
					overallStats: {},
					individualStats: [
						...body.individualStats,
						{
							...(body.individualStats[0] as object),
							calendarDate: "2026-09-30",
						},
					],
				});
			},
		),
	);
	const h = await collect(fake, { streams: ["sleep"] });
	assert.deepEqual(idsOf(h, "sleep"), ["2026-09-16"]);
	assert.deepEqual(progressOf(h), [{ stream: "sleep", count: 2 }]);
	// Both windows with an unreadable night are kept whole to read again; they touch, so they merge.
	assert.deepEqual(statesOf(h), {
		sleep: { ...FULL, retry: [span("2026-08-19", TODAY)] },
	});
});

test("collect: a night or an activity whose start does not parse is counted unreadable, with or without a grant", async () => {
	// No start to hold against the grant, so it is counted rather than taken for outside it.
	const drifted = (): Answer =>
		site((data) => {
			(
				(data.sleep[0] as Record<string, unknown>).values as Record<
					string,
					unknown
				>
			).gmtSleepStartTimeInMillis = "1789389600000";
			(data.activities[0] as Record<string, unknown>).startTimeGMT =
				"2026-09-15T19:15:00Z";
		});
	const streams = ["sleep", "activities"] as const;
	const since = "2026-09-01T00:00:00.000Z";
	const runs = await Promise.all([
		collect(fakeGarmin(drifted()), { streams }),
		collect(fakeGarmin(drifted()), {
			streams,
			ranges: { sleep: { since }, activities: { since } },
		}),
	]);
	for (const h of runs) {
		assert.deepEqual(progressOf(h), [
			{ stream: "sleep", count: 1 },
			{ stream: "activities", count: 1 },
		]);
		assert.deepEqual(idsOf(h, "sleep"), ["2026-09-16"]);
		assert.deepEqual(idsOf(h, "activities"), ["41000101"]);
	}
});

for (const [stream, envelope] of [
	["sleep", { overallStats: {}, individualStats: {} }],
	["hrv", { hrvSummaries: null }],
	["activities", { activities: [] }],
] as const) {
	test(`collect: a ${stream} window whose envelope is not Garmin's skips the stream as unreadable, the cursor at the window before`, async () => {
		const fake = fakeGarmin(
			except(site(), windowFrom(stream, "2026-08-19"), json(envelope)),
		);
		const h = await collect(fake);
		assertSkips(h, "source_unreadable", UPGRADE, [stream]);
		assert.deepEqual(statesOf(h)[stream], {
			next_day: "2026-08-19",
			floor: FLOOR,
		});
		assert.equal(pathsOf(fake, stream).length, 3, "no window read after it");
		for (const other of STREAMS.filter((name) => name !== stream)) {
			assert.deepEqual(idsOf(h, other), IDS[other], other);
		}
	});
}

test("collect: HRV answering 204 for every window is no nights: no record, no count, and the cursor moves", async () => {
	const fake = fakeGarmin(
		site((data) => {
			data.hrv = [];
		}),
	);
	const h = await collect(fake, { streams: ["hrv"] });
	assert.deepEqual(h.emitted, []);
	assert.deepEqual(messagesOf(h, "PROGRESS"), []);
	assert.deepEqual(statesOf(h), { hrv: FULL });
});

// ── Activities: one request a piece, halved while an answer is full ───────
/**
 * `count` activities (at most 360) on local `day`, newest first, a minute apart from 06:00, their
 * ids `first` up; the account is in Pacific/Auckland, so each started the UTC day before.
 */
function manyActivities(
	count: number,
	day = "2026-09-17",
	first = 41_200_000,
): Array<Record<string, unknown>> {
	const base =
		(fixtureData().activities as Array<Record<string, unknown>>)[0] ?? {};
	return Array.from({ length: count }, (_, i) => {
		const minute = count - 1 - i;
		const hh = 6 + Math.floor(minute / 60);
		const mm = String(minute % 60).padStart(2, "0");
		return {
			...base,
			activityId: first + minute,
			startTimeLocal: `${day} ${String(hh).padStart(2, "0")}:${mm}:00`,
			startTimeGMT: `${addDays(day, -1)} ${hh + 12}:${mm}:00`,
		};
	});
}
/**
 * `count` activities dealt one to each of the `days` local days from `from` in turn, so the first
 * `count % days` days hold one more; newest first, each day's ids from `first` + 1000 × its index.
 */
function spread(
	count: number,
	from: string,
	days: number,
	first = 41_300_000,
): Array<Record<string, unknown>> {
	return Array.from({ length: days }, (_, i) => days - 1 - i).flatMap((d) =>
		manyActivities(
			Math.floor(count / days) + (d < count % days ? 1 : 0),
			addDays(from, d),
			first + d * 1000,
		),
	);
}
const idOf = (row: Record<string, unknown>): string => String(row.activityId);
/** The ids of the `rows` whose local day lies from `from` to `to`, in Garmin's order, newest first. */
const idsIn = (
	rows: ReadonlyArray<Record<string, unknown>>,
	from: string,
	to: string,
): string[] =>
	rows
		.filter((row) => {
			const day = String(row.startTimeLocal).slice(0, 10);
			return day >= from && day <= to;
		})
		.map(idOf);
/** A copy of `rows` whose newest activity on local `day` has a start that does not parse, and its id. */
function unreadableOn(
	rows: ReadonlyArray<Record<string, unknown>>,
	day: string,
): { rows: Array<Record<string, unknown>>; bad: string } {
	const copy = structuredClone(rows) as Array<Record<string, unknown>>;
	const row = copy.find((r) => String(r.startTimeLocal).startsWith(day));
	assert.ok(row, `an activity on ${day}`);
	row.startTimeGMT = `${day}T19:15:00Z`;
	return { rows: copy, bad: idOf(row) };
}
/** Garmin's list as it holds it, newest first. */
const newestFirst = (
	rows: ReadonlyArray<Record<string, unknown>>,
): Array<Record<string, unknown>> =>
	rows.toSorted((a, b) =>
		String(b.startTimeLocal).localeCompare(String(a.startTimeLocal)),
	);
/** The newest activity on local `day`: one a watch syncs late. */
const syncedOn = (day: string, id = 41_299_999): Record<string, unknown> => ({
	...(manyActivities(1, day)[0] as Record<string, unknown>),
	activityId: id,
	startTimeLocal: `${day} 21:00:00`,
	startTimeGMT: `${day} 09:00:00`,
});
/** Edits the account, once, just before the first read `when` matches. */
function once(
	when: (path: string) => boolean,
	edit: (data: SiteData) => void,
): (data: SiteData, path: string) => void {
	let done = false;
	return (data, path) => {
		if (done || !when(path)) return;
		done = true;
		edit(data);
	};
}

/** Each activities read as [from, to], in order, asserting that every one asks from the first row for 100. */
function piecesOf(fake: Fake): Array<[string, string]> {
	return pathsOf(fake, "activities").map((path) => {
		const { from, to } = windowOf(path);
		assert.equal(
			path,
			`${ACTIVITIES}startDate=${from}&endDate=${to}&start=0&limit=100`,
		);
		return [from, to];
	});
}
/** The pieces read that hold no other piece read: those whose answer was complete. */
const leavesOf = (
	pieces: ReadonlyArray<readonly [string, string]>,
): Array<readonly [string, string]> =>
	pieces.filter(
		([from, to]) =>
			!pieces.some(
				([f, t]) => f >= from && t <= to && (f !== from || t !== to),
			),
	);

/** A cursor whose next window is 9 to 21 September: thirteen days, an odd number. */
const ODD = { next_day: "2026-09-09", floor: "2026-09-09" };
const ODD_DONE = { next_day: "2026-09-22", floor: "2026-09-09" };
const WHOLE = ["2026-09-09", TODAY] as const;
const OLDER = ["2026-09-09", "2026-09-14"] as const;
const NEWER = ["2026-09-15", TODAY] as const;

for (const [count, pieces] of [
	[99, [WHOLE]],
	[100, [WHOLE, OLDER, NEWER]],
	[101, [WHOLE, OLDER, NEWER]],
	// The older six days hold 94, the newer seven 105.
	[
		199,
		[WHOLE, OLDER, NEWER, ["2026-09-15", "2026-09-17"], ["2026-09-18", TODAY]],
	],
	// The older six days hold 117, the newer seven 133.
	[
		250,
		[
			WHOLE,
			OLDER,
			["2026-09-09", "2026-09-11"],
			["2026-09-12", "2026-09-14"],
			NEWER,
			["2026-09-15", "2026-09-17"],
			["2026-09-18", TODAY],
		],
	],
] as const) {
	test(`collect: ${count} activities over thirteen days: one request a piece from the first row, halved by day while an answer is full, the older half first, nothing of a full answer shipped, and every activity once`, async () => {
		const rows = spread(count, WHOLE[0], 13);
		const fake = fakeGarmin(
			site((data) => {
				data.activities = rows;
			}),
		);
		const h = await collect(fake, {
			state: { activities: ODD },
			streams: ["activities"],
		});
		assert.deepEqual(piecesOf(fake), pieces);
		// The oldest piece first, each newest first, as Garmin answered it.
		assert.deepEqual(
			idsOf(h, "activities"),
			leavesOf(pieces).flatMap(([from, to]) => idsIn(rows, from, to)),
		);
		assert.equal(new Set(idsOf(h, "activities")).size, count);
		assert.deepEqual(messagesOf(h, "PROGRESS"), []);
		assert.deepEqual(messagesOf(h, "SKIP_RESULT"), []);
		assert.deepEqual(statesOf(h), { activities: ODD_DONE });
	});
}

test("collect: every request of a halved window, its full answers included, comes after its own pause", async () => {
	const fake = fakeGarmin(
		site((data) => {
			data.activities = spread(250, WHOLE[0], 13);
		}),
	);
	await collect(fake, {
		state: { activities: ODD },
		streams: ["activities"],
		pacing: { requestDelayMs: 5 },
	});
	assert.deepEqual(fake.log, [
		"read settings",
		...Array.from({ length: 7 }, () => ["sleep 5", "read activities"]).flat(),
	]);
});

test("collect: an activity synced and another deleted between two requests of one window, its count unchanged: each piece ships as its own answer held it, nothing of the full answer ships, and the next run's four-week re-read ships what the first missed", async () => {
	// Six a day from 25 August to 15 September: 132, more than one request returns.
	const rows = spread(132, "2026-08-25", 22);
	const window = ["2026-08-19", "2026-09-15"] as const;
	const older = ["2026-08-19", "2026-09-01"] as const;
	const newer = ["2026-09-02", "2026-09-15"] as const;
	// Synced into the older half once it has been read; deleted from the newer before it is.
	const synced = syncedOn("2026-08-28");
	const gone = rows.find((row) =>
		String(row.startTimeLocal).startsWith("2026-09-14"),
	) as Record<string, unknown>;
	assert.ok(
		idsIn(rows, ...window)
			.slice(0, 100)
			.includes(idOf(gone)),
		"the deleted activity is in the window's full answer",
	);
	const after = newestFirst([...rows.filter((row) => row !== gone), synced]);
	const fake = fakeGarmin(
		site(
			(data) => {
				data.activities = structuredClone(rows);
			},
			once(windowFrom("activities", newer[0]), (data) => {
				data.activities = structuredClone(after);
			}),
		),
	);
	const first = await collect(fake, { streams: ["activities"] });
	assert.deepEqual(piecesOf(fake), [
		[FLOOR, "2026-07-21"],
		["2026-07-22", "2026-08-18"],
		window,
		older,
		newer,
		["2026-09-16", TODAY],
	]);
	assert.deepEqual(idsOf(first, "activities"), [
		...idsIn(rows, ...older),
		...idsIn(after, ...newer),
	]);
	assert.equal(idsOf(first, "activities").includes(idOf(gone)), false);
	assert.equal(idsOf(first, "activities").includes(idOf(synced)), false);
	assert.deepEqual(messagesOf(first, "PROGRESS"), []);
	assert.deepEqual(messagesOf(first, "SKIP_RESULT"), []);
	assert.deepEqual(statesOf(first), { activities: FULL });
	// The list holds still now; the window lies inside the next run's re-read, from four weeks
	// before the first run's day.
	const fake2 = fakeGarmin(
		site((data) => {
			data.activities = structuredClone(after);
		}),
	);
	const second = await collect(fake2, {
		state: statesOf(first),
		streams: ["activities"],
	});
	assert.deepEqual(piecesOf(fake2), [
		["2026-08-24", "2026-09-20"],
		["2026-08-24", "2026-09-06"],
		["2026-09-07", "2026-09-20"],
		[TODAY, TODAY],
	]);
	assert.ok(idsOf(second, "activities").includes(idOf(synced)));
	assert.deepEqual(messagesOf(second, "SKIP_RESULT"), []);
	assert.deepEqual(statesOf(second), { activities: FULL });
	const shipped = new Set([
		...idsOf(first, "activities"),
		...idsOf(second, "activities"),
	]);
	for (const row of after) assert.ok(shipped.has(idOf(row)), idOf(row));
});

test("collect: a single day whose answer is full cannot be halved: activities skip as unreadable, the cursor before its window, and what its earlier pieces read still ships or is counted", async () => {
	// Of three activities on 25 July, the newest does not read.
	const early = unreadableOn(
		manyActivities(3, "2026-07-25", 41_100_000),
		"2026-07-25",
	);
	const fake = fakeGarmin(
		site((data) => {
			data.activities = [...manyActivities(100, "2026-08-01"), ...early.rows];
		}),
	);
	const h = await collect(fake, { streams: ["activities"] });
	assert.deepEqual(piecesOf(fake), [
		[FLOOR, "2026-07-21"],
		["2026-07-22", "2026-08-18"],
		["2026-07-22", "2026-08-04"],
		["2026-07-22", "2026-07-28"],
		["2026-07-29", "2026-08-04"],
		["2026-07-29", "2026-07-31"],
		["2026-08-01", "2026-08-04"],
		["2026-08-01", "2026-08-02"],
		["2026-08-01", "2026-08-01"],
	]);
	assertSkips(h, "source_unreadable", UPGRADE, ["activities"]);
	assert.deepEqual(
		messagesOf(h, "SKIP_RESULT").map(({ message }) => message),
		["One day held more activities than one request returns."],
	);
	assert.deepEqual(
		idsOf(h, "activities"),
		early.rows.map(idOf).filter((id) => id !== early.bad),
	);
	assert.deepEqual(progressOf(h), [{ stream: "activities", count: 1 }]);
	assert.deepEqual(statesOf(h), {
		activities: { next_day: "2026-07-22", floor: FLOOR },
	});
});

test("collect: a window that needs more than maxRequestsPerWindow requests skips activities as unreadable and is not passed, what its completed pieces could not read counted; one that needs exactly that many is read in full", async () => {
	// A 10 September activity that does not read: in the full answer of 9 to 14 September, then in
	// the complete one of 9 to 11 September, which alone counts it.
	const { rows, bad } = unreadableOn(spread(250, WHOLE[0], 13), "2026-09-10");
	const [over, exact] = await Promise.all(
		[6, 7].map(async (max) => {
			const fake = fakeGarmin(
				site((data) => {
					data.activities = structuredClone(rows);
				}),
			);
			const h = await collect(fake, {
				state: { activities: ODD },
				streams: ["activities"],
				pacing: { maxRequestsPerWindow: max },
			});
			return { fake, h };
		}),
	);
	assert.ok(over && exact);
	const shipped = (h: RecordingEmit, leaves: ReadonlyArray<[string, string]>) =>
		assert.deepEqual(
			idsOf(h, "activities"),
			leaves
				.flatMap(([from, to]) => idsIn(rows, from, to))
				.filter((id) => id !== bad),
		);
	assert.deepEqual(piecesOf(over.fake), [
		WHOLE,
		OLDER,
		["2026-09-09", "2026-09-11"],
		["2026-09-12", "2026-09-14"],
		NEWER,
		["2026-09-15", "2026-09-17"],
	]);
	assertSkips(over.h, "source_unreadable", UPGRADE, ["activities"]);
	shipped(over.h, [
		["2026-09-09", "2026-09-11"],
		["2026-09-12", "2026-09-14"],
		["2026-09-15", "2026-09-17"],
	]);
	assert.deepEqual(progressOf(over.h), [{ stream: "activities", count: 1 }]);
	assert.deepEqual(
		messagesOf(over.h, "STATE"),
		[],
		"the window never completed",
	);
	assert.equal(pathsOf(exact.fake, "activities").length, 7);
	assert.deepEqual(messagesOf(exact.h, "SKIP_RESULT"), []);
	assert.equal(idsOf(exact.h, "activities").length, 249);
	assert.deepEqual(progressOf(exact.h), [{ stream: "activities", count: 1 }]);
	assert.deepEqual(statesOf(exact.h), {
		activities: { ...ODD_DONE, retry: [span(...WHOLE)] },
	});
});

test("collect: a row a piece's answer holds from outside that piece is counted unreadable and keeps the window, while its own piece ships it once", async () => {
	const rows = spread(150, WHOLE[0], 13);
	const stray = rows.find((row) =>
		String(row.startTimeLocal).startsWith("2026-09-20"),
	);
	const answer = site((data) => {
		data.activities = rows;
	});
	const fake = fakeGarmin(
		except(
			answer,
			(path) =>
				isStream("activities")(path) &&
				windowOf(path).from === OLDER[0] &&
				windowOf(path).to === OLDER[1],
			(path) => {
				const real = answer(path);
				const held = JSON.parse(
					real.kind === "response" ? real.body : "[]",
				) as unknown[];
				return json([stray, ...held]);
			},
		),
	);
	const h = await collect(fake, {
		state: { activities: ODD },
		streams: ["activities"],
	});
	assert.deepEqual(piecesOf(fake), [WHOLE, OLDER, NEWER]);
	assert.deepEqual(idsOf(h, "activities"), [
		...idsIn(rows, ...OLDER),
		...idsIn(rows, ...NEWER),
	]);
	assert.deepEqual(progressOf(h), [{ stream: "activities", count: 1 }]);
	assert.deepEqual(messagesOf(h, "SKIP_RESULT"), []);
	assert.deepEqual(statesOf(h), {
		activities: { ...ODD_DONE, retry: [span(...WHOLE)] },
	});
});

test("collect: an activity that does not read inside a full answer is counted once, by the piece that ships its day, not again for each answer halving read it in", async () => {
	// 20 September lies in the full answer of the whole window, then in the newer half's.
	const { rows, bad } = unreadableOn(spread(150, WHOLE[0], 13), "2026-09-20");
	const fake = fakeGarmin(
		site((data) => {
			data.activities = rows;
		}),
	);
	const h = await collect(fake, {
		state: { activities: ODD },
		streams: ["activities"],
	});
	assert.deepEqual(piecesOf(fake), [WHOLE, OLDER, NEWER]);
	assert.deepEqual(
		idsOf(h, "activities"),
		[...idsIn(rows, ...OLDER), ...idsIn(rows, ...NEWER)].filter(
			(id) => id !== bad,
		),
	);
	assert.deepEqual(progressOf(h), [{ stream: "activities", count: 1 }]);
	assert.deepEqual(messagesOf(h, "SKIP_RESULT"), []);
	assert.deepEqual(statesOf(h), {
		activities: { ...ODD_DONE, retry: [span(...WHOLE)] },
	});
});

test("collect: two records that do not read in one window, one answer, are counted as two, not as one window", async () => {
	const fake = fakeGarmin(
		site((data) => {
			for (const night of data.sleep as Array<Record<string, unknown>>)
				(night.values as Record<string, unknown>).deepTime = "5400";
			for (const row of data.activities as Array<Record<string, unknown>>)
				row.startTimeGMT = "2026-09-15T19:15:00Z";
		}),
	);
	const streams = ["sleep", "activities"] as const;
	const h = await collect(fake, {
		state: everyStream(ODD, streams),
		streams,
	});
	assert.deepEqual(pathsOf(fake, "sleep"), [`${SLEEP}${WHOLE[0]}/${TODAY}`]);
	assert.deepEqual(piecesOf(fake), [WHOLE]);
	assert.deepEqual(countsOf(h), everyStream(0));
	assert.deepEqual(progressLines(h), [
		{ stream: "sleep", count: 2, message: "2 record(s) unreadable." },
		{ stream: "activities", count: 2, message: "2 record(s) unreadable." },
	]);
	assert.deepEqual(messagesOf(h, "SKIP_RESULT"), []);
	assert.deepEqual(
		statesOf(h),
		everyStream({ ...ODD_DONE, retry: [span(...WHOLE)] }, streams),
	);
});

test("collect: a kept activities window is read again with the same halving, and let go once every piece reads cleanly", async () => {
	const kept = span("2026-07-01", "2026-07-28");
	const rows = spread(150, kept.from, 28);
	const fake = fakeGarmin(
		site((data) => {
			data.activities = rows;
		}),
	);
	const h = await collect(fake, {
		state: { activities: { ...FULL, retry: [kept] } },
		streams: ["activities"],
	});
	assert.deepEqual(piecesOf(fake), [
		...AGAIN,
		[kept.from, kept.to],
		["2026-07-01", "2026-07-14"],
		["2026-07-15", "2026-07-28"],
	]);
	assert.deepEqual(idsOf(h, "activities"), [
		...idsIn(rows, "2026-07-01", "2026-07-14"),
		...idsIn(rows, "2026-07-15", "2026-07-28"),
	]);
	assert.equal(new Set(idsOf(h, "activities")).size, 150);
	assert.deepEqual(messagesOf(h, "PROGRESS"), []);
	assert.deepEqual(messagesOf(h, "SKIP_RESULT"), []);
	assert.deepEqual(statesOf(h), { activities: FULL });
});

/**
 * The last run's day was 19 August, so the re-read starts four weeks before it, on 22 July. The
 * window after that, 19 August to 15 September, holds 150 activities, so it halves once, into
 * 19 August to 1 September and 2 to 15 September; a kept span waits after the forward read.
 */
const AHEAD = {
	next_day: "2026-08-20",
	floor: FLOOR,
	retry: [span("2026-07-01", "2026-07-05")],
};
const AHEAD_ROWS = spread(150, "2026-08-19", 28);
const AHEAD_NEWER = windowFrom("activities", "2026-09-02");
const ahead = (rows = AHEAD_ROWS): Answer =>
	site((data) => {
		data.activities = structuredClone(rows);
	});
/** AHEAD_ROWS with a 20 August activity, in the older half, that does not read. */
const AHEAD_DRIFT = unreadableOn(AHEAD_ROWS, "2026-08-20");

for (const failure of [
	{
		label: "a 403 the reload does not cure",
		answer: response(403),
		reason: "sign_in_required",
		hint: SIGN_IN,
		reads: 2,
		visits: [APP_URL],
	},
	{
		label: "a 429 still there after two waits",
		answer: response(429),
		reason: "collection_interrupted",
		hint: RETRY,
		reads: 3,
		visits: [],
	},
	{
		label: "a 500",
		answer: response(500),
		reason: "collection_interrupted",
		hint: RETRY,
		reads: 1,
		visits: [],
	},
	{
		label: "a network error",
		answer: { kind: "network_error", message: "AbortError" } as PageFetch,
		reason: "collection_interrupted",
		hint: RETRY,
		reads: 1,
		visits: [],
	},
]) {
	test(`collect: the newer half of a halved window answering ${failure.label} skips activities, the window not passed and the kept days intact, though the older half has shipped and what it could not read is counted`, async () => {
		const fake = fakeGarmin(
			except(ahead(AHEAD_DRIFT.rows), AHEAD_NEWER, failure.answer),
		);
		const h = await collect(fake, {
			state: { activities: AHEAD },
			streams: ["activities"],
		});
		const reads = pathsOf(fake, "activities");
		assert.equal(reads.filter(AHEAD_NEWER).length, failure.reads);
		assert.ok(AHEAD_NEWER(fake.paths.at(-1) ?? ""), "nothing read after it");
		assert.deepEqual(fake.visits, failure.visits);
		assertSkips(h, failure.reason, failure.hint, ["activities"]);
		assert.deepEqual(
			idsOf(h, "activities"),
			idsIn(AHEAD_DRIFT.rows, "2026-08-19", "2026-09-01").filter(
				(id) => id !== AHEAD_DRIFT.bad,
			),
		);
		assert.deepEqual(progressOf(h), [{ stream: "activities", count: 1 }]);
		assert.deepEqual(statesOf(h), { activities: AHEAD });
	});
}

for (const [label, answer, visits, waits] of [
	["a 403 that one reload of the app cures", response(403), [APP_URL], []],
	["a 429 that clears after one wait", response(429), [], ["sleep 30000"]],
] as const) {
	test(`collect: the newer half of a halved window answering ${label} is read again, the same request, and the run goes on to the kept days`, async () => {
		const fake = fakeGarmin(except(ahead(), AHEAD_NEWER, answer, 1));
		const h = await collect(fake, {
			state: { activities: AHEAD },
			streams: ["activities"],
		});
		assert.deepEqual(piecesOf(fake), [
			["2026-07-22", "2026-08-18"],
			["2026-08-19", "2026-09-15"],
			["2026-08-19", "2026-09-01"],
			["2026-09-02", "2026-09-15"],
			["2026-09-02", "2026-09-15"],
			["2026-09-16", TODAY],
			["2026-07-01", "2026-07-05"],
		]);
		assert.deepEqual(fake.visits, visits);
		assert.deepEqual(
			sleepsOf(fake).filter((entry) => entry !== "sleep 0"),
			waits,
		);
		assert.deepEqual(messagesOf(h, "SKIP_RESULT"), []);
		assert.deepEqual(
			idsOf(h, "activities").toSorted(),
			AHEAD_ROWS.map(idOf).toSorted(),
		);
		assert.deepEqual(statesOf(h), { activities: FULL });
	});
}

// ── Cursors ────────────────────────────────────────────────────────────────
const LATER = new Date(NOW.getTime() + 2 * 86_400_000);

/**
 * What a run two days after a first run reads: each daily stream from a week before its cursor,
 * each range stream from four weeks before the first run's day, 21 September; then on to its today.
 */
const REREAD = {
	days: daysFrom("2026-09-15", "2026-09-23"),
	windows: [
		["2026-08-24", "2026-09-20"],
		["2026-09-21", "2026-09-23"],
	],
};
/** The days and windows each stream read, by stream. */
function readsOf(fake: Fake): Record<Stream, unknown> {
	return {
		daily_summaries: pathsOf(fake, "daily_summaries").map(dayOf),
		sleep: pathsOf(fake, "sleep").map((path) => {
			const { from, to } = windowOf(path);
			return [from, to];
		}),
		hrv: pathsOf(fake, "hrv").map((path) => {
			const { from, to } = windowOf(path);
			return [from, to];
		}),
		training_status: pathsOf(fake, "training_status").map(dayOf),
		activities: piecesOf(fake),
	};
}

test("collect: a run from the last STATE re-reads the last week of each daily stream and each range stream from four weeks before the last run's day, then reads on to the owner's today", async () => {
	const first = await collect(fakeGarmin());
	const fake = fakeGarmin();
	const h = await collect(fake, { state: statesOf(first), now: LATER });
	assert.deepEqual(readsOf(fake), {
		daily_summaries: REREAD.days,
		sleep: REREAD.windows,
		hrv: REREAD.windows,
		training_status: REREAD.days,
		activities: REREAD.windows,
	});
	assert.deepEqual(
		statesOf(h),
		everyStream({ next_day: "2026-09-24", floor: FLOOR }),
	);
	// What the overlap holds comes again; mutable_state replaces it by id.
	assert.deepEqual(idsOf(h, "daily_summaries"), IDS.daily_summaries);
	assert.deepEqual(idsOf(h, "sleep"), IDS.sleep);
	assert.deepEqual(idsOf(h, "hrv"), IDS.hrv);
	// One window: the ride, then the run, newest first.
	assert.deepEqual(idsOf(h, "activities"), ["41000102", "41000101"]);
});

test("collect: a night, an HRV night and an activity that reach Garmin 20 days late are read by the next run's four-week re-read; a daily summary 20 days late is not, past the week its stream re-reads", async () => {
	/** Twenty days before the owner's day at LATER, 23 September. */
	const late = "2026-09-03";
	const first = await collect(fakeGarmin());
	const fake = fakeGarmin(
		site((data) => {
			nightOn(data, late);
			data.hrv.unshift({ ...(data.hrv[0] as object), calendarDate: late });
			data.activities.push(syncedOn(late, 41_000_050));
			summaryOn(data, late);
		}),
	);
	const h = await collect(fake, { state: statesOf(first), now: LATER });
	assert.deepEqual(readsOf(fake), {
		daily_summaries: REREAD.days,
		sleep: REREAD.windows,
		hrv: REREAD.windows,
		training_status: REREAD.days,
		activities: REREAD.windows,
	});
	assert.deepEqual(idsOf(h, "sleep"), [late, ...IDS.sleep]);
	assert.deepEqual(idsOf(h, "hrv"), [late, ...IDS.hrv]);
	assert.deepEqual(idsOf(h, "activities"), [
		"41000102",
		"41000101",
		"41000050",
	]);
	// The documented limit: a daily stream looks back a week, so the late summary is never read.
	assert.deepEqual(idsOf(h, "daily_summaries"), IDS.daily_summaries);
	assert.deepEqual(messagesOf(h, "PROGRESS"), []);
	assert.deepEqual(messagesOf(h, "SKIP_RESULT"), []);
	assert.deepEqual(
		statesOf(h),
		everyStream({ next_day: "2026-09-24", floor: FLOOR }),
	);
});

test("collect: a night, an HRV night and an activity that reach Garmin four weeks after their day, just after a run, are read by the next run, which re-reads from four weeks before the last run's day; those a day older are not", async () => {
	/** Four weeks before the first run's day, 21 September; and the day before. */
	const late = "2026-08-24";
	const older = "2026-08-23";
	const first = await collect(fakeGarmin());
	assert.deepEqual(statesOf(first), everyStream(FULL));
	// Synced after the first run; the next run comes the day after it.
	const fake = fakeGarmin(
		site((data) => {
			for (const day of [late, older]) {
				nightOn(data, day);
				data.hrv.unshift({ ...(data.hrv[0] as object), calendarDate: day });
			}
			data.activities.push(
				syncedOn(late, 41_000_050),
				syncedOn(older, 41_000_049),
			);
		}),
	);
	const h = await collect(fake, {
		state: statesOf(first),
		now: new Date(NOW.getTime() + 86_400_000),
	});
	const days = daysFrom("2026-09-15", "2026-09-22");
	const windows = [
		[late, "2026-09-20"],
		["2026-09-21", "2026-09-22"],
	];
	assert.deepEqual(readsOf(fake), {
		daily_summaries: days,
		sleep: windows,
		hrv: windows,
		training_status: days,
		activities: windows,
	});
	assert.deepEqual(idsOf(h, "sleep"), [late, ...IDS.sleep]);
	assert.deepEqual(idsOf(h, "hrv"), [late, ...IDS.hrv]);
	assert.deepEqual(idsOf(h, "activities"), [
		"41000102",
		"41000101",
		"41000050",
	]);
	assert.deepEqual(messagesOf(h, "PROGRESS"), []);
	assert.deepEqual(messagesOf(h, "SKIP_RESULT"), []);
	assert.deepEqual(
		statesOf(h),
		everyStream({ next_day: "2026-09-23", floor: FLOOR }),
	);
});

test("collect: full_refresh ignores the saved cursor and reads ninety days again", async () => {
	const fake = fakeGarmin();
	const h = await collect(fake, {
		state: everyStream(FULL),
		now: LATER,
		mode: "full_refresh",
	});
	assert.deepEqual(
		pathsOf(fake, "daily_summaries").map(dayOf),
		daysFrom("2026-06-26", "2026-09-23"),
	);
	assert.deepEqual(
		statesOf(h),
		everyStream({ next_day: "2026-09-24", floor: "2026-06-26" }),
	);
	assert.deepEqual(countsOf(h), COUNTS);
});

for (const [label, cursor] of [
	["no days", {}],
	["days that do not parse", { next_day: "soon", floor: "2026-06-24" }],
	[
		"a floor after the next day",
		{ next_day: "2026-06-24", floor: "2026-09-22" },
	],
	["a string", "2026-09-22"],
	["null", null],
] as const) {
	test(`collect: a saved cursor with ${label} starts afresh instead of failing`, async () => {
		const fake = fakeGarmin();
		const h = await collect(fake, {
			state: everyStream(cursor),
			streams: ["daily_summaries", "sleep"],
		});
		assert.equal(pathsOf(fake, "daily_summaries").length, 90);
		assert.deepEqual(
			statesOf(h),
			everyStream(FULL, ["daily_summaries", "sleep"]),
		);
	});
}

test("collect: a grant reaching back past the floor reads that history on its own cursor, after the overlap", async () => {
	const fake = fakeGarmin();
	const h = await collect(fake, {
		state: { daily_summaries: FULL },
		streams: ["daily_summaries"],
		ranges: { daily_summaries: { since: "2026-05-01T00:00:00.000Z" } },
	});
	assert.deepEqual(pathsOf(fake, "daily_summaries").map(dayOf), [
		...daysFrom("2026-09-15", TODAY),
		...daysFrom("2026-05-01", "2026-06-23"),
	]);
	assert.deepEqual(statesOf(h), {
		daily_summaries: { next_day: "2026-09-22", floor: "2026-05-01" },
	});
});

test("collect: history cut short by maxDaysPerRun keeps its place, and the next run carries on from it", async () => {
	const grant = { daily_summaries: { since: "2026-05-01T00:00:00.000Z" } };
	const first = await collect(fakeGarmin(), {
		state: { daily_summaries: FULL },
		streams: ["daily_summaries"],
		ranges: grant,
		pacing: { maxDaysPerRun: 20 },
	});
	const cut = {
		next_day: "2026-09-22",
		floor: FLOOR,
		backfill: { since: "2026-05-01", next_day: "2026-05-14" },
	};
	assert.deepEqual(statesOf(first), { daily_summaries: cut });
	assertSkips(first, "source_limit_reached", RETRY, ["daily_summaries"]);
	const fake = fakeGarmin();
	const h = await collect(fake, {
		state: { daily_summaries: cut },
		streams: ["daily_summaries"],
		ranges: grant,
		pacing: { maxDaysPerRun: 20 },
	});
	assert.deepEqual(pathsOf(fake, "daily_summaries").map(dayOf), [
		...daysFrom("2026-09-15", TODAY),
		...daysFrom("2026-05-14", "2026-05-26"),
	]);
	assert.deepEqual(statesOf(h), {
		daily_summaries: {
			...cut,
			backfill: { since: "2026-05-01", next_day: "2026-05-27" },
		},
	});
});

test("collect: a grant starting past the cursor restarts it there", async () => {
	const fake = fakeGarmin();
	const h = await collect(fake, {
		state: { daily_summaries: { next_day: "2026-08-01", floor: "2026-06-01" } },
		streams: ["daily_summaries"],
		ranges: { daily_summaries: { since: "2026-09-01T00:00:00.000Z" } },
	});
	assert.deepEqual(
		pathsOf(fake, "daily_summaries").map(dayOf),
		daysFrom("2026-09-01", TODAY),
	);
	assert.deepEqual(statesOf(h), {
		daily_summaries: { next_day: "2026-09-22", floor: "2026-09-01" },
	});
});

test("collect: a range stream's history before its floor is read in its own windows", async () => {
	const fake = fakeGarmin();
	const h = await collect(fake, {
		state: { hrv: FULL },
		streams: ["hrv"],
		ranges: { hrv: { since: "2026-03-01T00:00:00.000Z" } },
	});
	assert.deepEqual(pathsOf(fake, "hrv"), [
		...HRV_AGAIN,
		`${HRV}2026-03-01/2026-03-28`,
		`${HRV}2026-03-29/2026-04-25`,
		`${HRV}2026-04-26/2026-05-23`,
		`${HRV}2026-05-24/2026-06-20`,
		`${HRV}2026-06-21/2026-06-23`,
	]);
	assert.deepEqual(statesOf(h), {
		hrv: { next_day: "2026-09-22", floor: "2026-03-01" },
	});
});

test("collect: range history of four weeks and a day ends on a one-day window, and the floor moves to the grant's start", async () => {
	const fake = fakeGarmin();
	const h = await collect(fake, {
		state: { hrv: FULL },
		streams: ["hrv"],
		ranges: { hrv: { since: "2026-05-26T00:00:00.000Z" } },
	});
	assert.deepEqual(pathsOf(fake, "hrv"), [
		...HRV_AGAIN,
		`${HRV}2026-05-26/2026-06-22`,
		`${HRV}2026-06-23/2026-06-23`,
	]);
	assert.deepEqual(messagesOf(h, "SKIP_RESULT"), []);
	assert.deepEqual(statesOf(h), {
		hrv: { next_day: "2026-09-22", floor: "2026-05-26" },
	});
});

// ── Per-run caps ───────────────────────────────────────────────────────────
test("collect: a daily stream past maxDaysPerRun stops there, defers the rest to the next run, and that run continues", async () => {
	const first = await collect(fakeGarmin(), {
		streams: ["daily_summaries"],
		pacing: { maxDaysPerRun: 10 },
	});
	assertSkips(first, "source_limit_reached", RETRY, ["daily_summaries"]);
	assert.deepEqual(statesOf(first), {
		daily_summaries: { next_day: "2026-07-04", floor: FLOOR },
	});
	const fake = fakeGarmin();
	await collect(fake, {
		state: statesOf(first),
		streams: ["daily_summaries"],
		pacing: { maxDaysPerRun: 10 },
	});
	assert.deepEqual(
		pathsOf(fake, "daily_summaries").map(dayOf),
		daysFrom("2026-06-27", "2026-07-06"),
	);
});

test("collect: a range stream past maxWindowsPerRun stops after that many windows and defers the rest", async () => {
	const fake = fakeGarmin();
	const h = await collect(fake, {
		streams: ["sleep"],
		pacing: { maxWindowsPerRun: 2 },
	});
	assert.equal(pathsOf(fake, "sleep").length, 2);
	assertSkips(h, "source_limit_reached", RETRY, ["sleep"]);
	assert.deepEqual(statesOf(h), {
		sleep: { next_day: "2026-08-19", floor: FLOOR },
	});
});

test("collect: a run that fits the caps exactly is not deferred", async () => {
	const h = await collect(fakeGarmin(), {
		pacing: { maxDaysPerRun: 90, maxWindowsPerRun: 4 },
	});
	assert.deepEqual(messagesOf(h, "SKIP_RESULT"), []);
	assert.deepEqual(statesOf(h), everyStream(FULL));
});

// ── Grants ─────────────────────────────────────────────────────────────────
test("collect: a stream consented by day reads only its grant's days, until exclusive", async () => {
	const fake = fakeGarmin();
	const h = await collect(fake, {
		streams: ["daily_summaries", "hrv"],
		ranges: {
			daily_summaries: {
				since: "2026-09-15T00:00:00.000Z",
				until: "2026-09-17T00:00:00.000Z",
			},
			hrv: { since: "2026-09-15T00:00:00.000Z" },
		},
	});
	assert.deepEqual(pathsOf(fake, "daily_summaries").map(dayOf), [
		"2026-09-15",
		"2026-09-16",
	]);
	assert.deepEqual(pathsOf(fake, "hrv"), [`${HRV}2026-09-15/2026-09-21`]);
	assert.deepEqual(idsOf(h, "hrv"), ["2026-09-15", "2026-09-16"]);
	assert.deepEqual(statesOf(h), {
		daily_summaries: { next_day: "2026-09-17", floor: "2026-09-15" },
		hrv: { next_day: "2026-09-22", floor: "2026-09-15" },
	});
});

const BY_DAY = ["daily_summaries", "hrv"] as const;
/** The same grant for both streams consented by day. */
const byDay = (range: Range): Partial<Record<Stream, Range>> => ({
	daily_summaries: range,
	hrv: range,
});

test("collect: a one-day grant reads that day and no other", async () => {
	const fake = fakeGarmin();
	const h = await collect(fake, {
		streams: BY_DAY,
		ranges: byDay({
			since: "2026-09-16T00:00:00.000Z",
			until: "2026-09-17T00:00:00.000Z",
		}),
	});
	assert.deepEqual(pathsOf(fake, "daily_summaries"), [`${DAILY}2026-09-16`]);
	assert.deepEqual(pathsOf(fake, "hrv"), [`${HRV}2026-09-16/2026-09-16`]);
	assert.deepEqual(idsOf(h, "daily_summaries"), ["2026-09-16"]);
	assert.deepEqual(idsOf(h, "hrv"), ["2026-09-16"]);
	assert.deepEqual(
		statesOf(h),
		everyStream({ next_day: "2026-09-17", floor: "2026-09-16" }, BY_DAY),
	);
});

test("collect: a grant ending at the owner's today reads up to the day before it, never today", async () => {
	const fake = fakeGarmin();
	const h = await collect(fake, {
		streams: BY_DAY,
		ranges: byDay({
			since: "2026-09-15T00:00:00.000Z",
			until: `${TODAY}T00:00:00.000Z`,
		}),
	});
	assert.deepEqual(
		pathsOf(fake, "daily_summaries").map(dayOf),
		daysFrom("2026-09-15", "2026-09-20"),
	);
	assert.deepEqual(pathsOf(fake, "hrv"), [`${HRV}2026-09-15/2026-09-20`]);
	assert.deepEqual(
		statesOf(h),
		everyStream({ next_day: TODAY, floor: "2026-09-15" }, BY_DAY),
	);
});

test("collect: history whose grant ends before the floor is read up to the grant's last day, never on to the floor", async () => {
	const fake = fakeGarmin();
	const h = await collect(fake, {
		state: everyStream(FULL, BY_DAY),
		streams: BY_DAY,
		ranges: byDay({
			since: "2026-05-01T00:00:00.000Z",
			until: "2026-06-01T00:00:00.000Z",
		}),
	});
	// Nothing forward: the overlap week lies after the grant.
	assert.deepEqual(
		pathsOf(fake, "daily_summaries").map(dayOf),
		daysFrom("2026-05-01", "2026-05-31"),
	);
	assert.deepEqual(pathsOf(fake, "hrv"), [
		`${HRV}2026-05-01/2026-05-28`,
		`${HRV}2026-05-29/2026-05-31`,
	]);
	// The history before the floor stays open past the grant, for a wider grant to finish.
	assert.deepEqual(
		statesOf(h),
		everyStream(
			{ ...FULL, backfill: { since: "2026-05-01", next_day: "2026-06-01" } },
			BY_DAY,
		),
	);
});

test("collect: a saved history cursor resuming before its own start is dropped, and the history restarts at the grant's start", async () => {
	const fake = fakeGarmin();
	const h = await collect(fake, {
		state: {
			daily_summaries: {
				...FULL,
				backfill: { since: "2026-06-10", next_day: "2026-06-01" },
			},
		},
		streams: ["daily_summaries"],
		ranges: { daily_summaries: { since: "2026-06-10T00:00:00.000Z" } },
	});
	assert.deepEqual(pathsOf(fake, "daily_summaries").map(dayOf), [
		...daysFrom("2026-09-15", TODAY),
		...daysFrom("2026-06-10", "2026-06-23"),
	]);
	assert.deepEqual(statesOf(h), {
		daily_summaries: { next_day: "2026-09-22", floor: "2026-06-10" },
	});
});

test("collect: a saved history cursor resuming past the floor is dropped, and the history restarts at the grant's start", async () => {
	const fake = fakeGarmin();
	const h = await collect(fake, {
		state: {
			daily_summaries: {
				...FULL,
				backfill: { since: "2026-06-10", next_day: "2026-07-01" },
			},
		},
		streams: ["daily_summaries"],
		ranges: { daily_summaries: { since: "2026-06-10T00:00:00.000Z" } },
	});
	assert.deepEqual(pathsOf(fake, "daily_summaries").map(dayOf), [
		...daysFrom("2026-09-15", TODAY),
		...daysFrom("2026-06-10", "2026-06-23"),
	]);
	assert.deepEqual(statesOf(h), {
		daily_summaries: { next_day: "2026-09-22", floor: "2026-06-10" },
	});
});

test("collect: a saved cursor whose re-read reaches back past its grant's start reads from that start, never before it", async () => {
	// Each grant starts after the floor and inside its stream's re-read: the week before the cursor
	// for a daily stream, from four weeks before the last run's day (24 August) for a range stream.
	const fake = fakeGarmin();
	const h = await collect(fake, {
		state: everyStream(FULL),
		ranges: {
			daily_summaries: { since: "2026-09-17T00:00:00.000Z" },
			sleep: { since: "2026-09-10T00:00:00.000Z" },
			hrv: { since: "2026-09-10T00:00:00.000Z" },
			training_status: { since: "2026-09-17T00:00:00.000Z" },
			activities: { since: "2026-09-10T00:00:00.000Z" },
		},
	});
	assert.deepEqual(
		pathsOf(fake, "daily_summaries").map(dayOf),
		daysFrom("2026-09-17", TODAY),
	);
	assert.deepEqual(
		pathsOf(fake, "training_status").map(dayOf),
		daysFrom("2026-09-17", TODAY),
	);
	// Consented by day: from the grant's first day.
	assert.deepEqual(pathsOf(fake, "hrv"), [`${HRV}2026-09-10/${TODAY}`]);
	// Consented by instant: from the local day before the grant's first UTC day.
	assert.deepEqual(pathsOf(fake, "sleep"), [`${SLEEP}2026-09-09/${TODAY}`]);
	assert.deepEqual(piecesOf(fake), [["2026-09-09", TODAY]]);
	// The 16 September summary and training status lie before their grants; the rest inside.
	assert.deepEqual(countsOf(h), {
		...COUNTS,
		daily_summaries: 0,
		training_status: 0,
	});
	assert.deepEqual(messagesOf(h, "PROGRESS"), []);
	assert.deepEqual(messagesOf(h, "SKIP_RESULT"), []);
	assert.deepEqual(statesOf(h), everyStream(FULL));
});

test("collect: sleep reads a day past each edge of its grant and keeps only the nights that start inside it, to the instant", async () => {
	const fake = fakeGarmin();
	const h = await collect(fake, {
		streams: ["sleep"],
		ranges: {
			sleep: {
				since: "2026-09-14T18:00:00.000Z",
				until: "2026-09-16T00:00:00.000Z",
			},
		},
	});
	assert.deepEqual(pathsOf(fake, "sleep"), [`${SLEEP}2026-09-13/2026-09-16`]);
	// The first night starts at 12:40Z on the 14th, before since; the second inside.
	assert.deepEqual(idsOf(h, "sleep"), ["2026-09-16"]);
	assert.deepEqual(
		messagesOf(h, "PROGRESS"),
		[],
		"outside the grant is not unreadable",
	);
	assert.deepEqual(statesOf(h), {
		sleep: { next_day: "2026-09-17", floor: "2026-09-13" },
	});
});

test("collect: a night or an activity starting exactly at its grant's since is kept, and one a millisecond before it is not", async () => {
	// The first night starts at 12:40Z on the 14th, the run at 06:30Z on the 14th.
	const streams = ["sleep", "activities"] as const;
	const [at, after] = await Promise.all([
		collect(fakeGarmin(), {
			streams,
			ranges: {
				sleep: { since: "2026-09-14T12:40:00.000Z" },
				activities: { since: "2026-09-14T06:30:00.000Z" },
			},
		}),
		collect(fakeGarmin(), {
			streams,
			ranges: {
				sleep: { since: "2026-09-14T12:40:00.001Z" },
				activities: { since: "2026-09-14T06:30:00.001Z" },
			},
		}),
	]);
	assert.deepEqual(idsOf(at, "sleep"), ["2026-09-15", "2026-09-16"]);
	// One window: the answer lists the ride, then the run, newest first.
	assert.deepEqual(idsOf(at, "activities"), ["41000102", "41000101"]);
	assert.deepEqual(idsOf(after, "sleep"), ["2026-09-16"]);
	assert.deepEqual(idsOf(after, "activities"), ["41000102"]);
	for (const h of [at, after]) assert.deepEqual(messagesOf(h, "PROGRESS"), []);
});

test("collect: an activity on the local day after its grant's last UTC day is read when it starts before until", async () => {
	// The ride starts at 19:15Z on the 15th, on the 16th locally.
	for (const [until, ids] of [
		["2026-09-15T19:15:00.000Z", ["41000101"]],
		// One window: the answer lists the ride, then the run, newest first.
		["2026-09-15T19:15:00.001Z", ["41000102", "41000101"]],
	] as const) {
		const fake = fakeGarmin();
		const h = await collect(fake, {
			streams: ["activities"],
			ranges: { activities: { since: "2026-09-14T00:00:00.000Z", until } },
		});
		assert.deepEqual(pathsOf(fake, "activities").map(windowOf), [
			{ from: "2026-09-13", to: "2026-09-16", start: 0, limit: 100 },
		]);
		assert.deepEqual(idsOf(h, "activities"), [...ids], until);
		assert.deepEqual(messagesOf(h, "PROGRESS"), []);
	}
});

test("collect: an activity starting before since is neither emitted nor counted, even unreadable; one inside is counted", async () => {
	const fake = fakeGarmin(
		site((data) => {
			for (const row of data.activities as Array<Record<string, unknown>>)
				row.distance = "far";
		}),
	);
	const h = await collect(fake, {
		streams: ["activities"],
		ranges: { activities: { since: "2026-09-15T00:00:00.000Z" } },
	});
	assert.deepEqual(
		pathsOf(fake, "activities").map((path) => windowOf(path).from),
		["2026-09-14"],
	);
	assert.deepEqual(idsOf(h, "activities"), []);
	// The run (06:30Z on the 14th) is outside the grant; the ride is inside.
	assert.deepEqual(progressOf(h), [{ stream: "activities", count: 1 }]);
});

// ── Days kept to read again ────────────────────────────────────────────────
/** Older than the overlap week of every run here. */
const HISTORY = "2026-08-01";

/** The fixture's daily summary, moved to `day`; with `steps` retyped it does not read. */
function summaryOn(data: SiteData, day: string, steps: unknown = 8432): void {
	data.daily[day] = {
		...(data.daily["2026-09-16"] as object),
		calendarDate: day,
		totalSteps: steps,
	};
}

/** The fixture's first night, moved to the morning of `day`; with `deep` retyped it does not read. */
function nightOn(data: SiteData, day: string, deep: unknown = 5400): void {
	const [night] = data.sleep as Array<{ values: Record<string, number> }>;
	const values = night?.values ?? {};
	const shift =
		Date.parse(`${day}T00:00:00Z`) - Date.parse("2026-09-15T00:00:00Z");
	data.sleep.unshift({
		calendarDate: day,
		values: {
			...values,
			deepTime: deep,
			gmtSleepStartTimeInMillis:
				(values.gmtSleepStartTimeInMillis ?? 0) + shift,
			gmtSleepEndTimeInMillis: (values.gmtSleepEndTimeInMillis ?? 0) + shift,
		},
	});
}

test("collect: a past day whose summary did not read is kept in STATE; the next run reads it again, ships it and lets it go", async () => {
	const first = await collect(
		fakeGarmin(site((data) => summaryOn(data, HISTORY, "8432"))),
		{ streams: ["daily_summaries"] },
	);
	assert.deepEqual(progressOf(first), [
		{ stream: "daily_summaries", count: 1 },
	]);
	assert.deepEqual(messagesOf(first, "SKIP_RESULT"), []);
	assert.deepEqual(statesOf(first), {
		daily_summaries: { ...FULL, retry: [span(HISTORY)] },
	});
	// Garmin answers the day cleanly now.
	const fake = fakeGarmin(site((data) => summaryOn(data, HISTORY)));
	const h = await collect(fake, {
		state: statesOf(first),
		streams: ["daily_summaries"],
		now: LATER,
	});
	assert.deepEqual(pathsOf(fake, "daily_summaries").map(dayOf), [
		...daysFrom("2026-09-15", "2026-09-23"),
		HISTORY,
	]);
	assert.deepEqual(idsOf(h, "daily_summaries"), ["2026-09-16", HISTORY]);
	assert.deepEqual(h.skipped, []);
	assert.deepEqual(messagesOf(h, "PROGRESS"), []);
	assert.deepEqual(messagesOf(h, "SKIP_RESULT"), []);
	const { daily_summaries: cursor } = statesOf(h);
	assert.deepEqual(cursor, { next_day: "2026-09-24", floor: FLOOR });
	assert.equal(Object.hasOwn(cursor as object, "retry"), false);
});

test("collect: a past night that did not read keeps its whole window in STATE; the next run reads that window again and ships the night", async () => {
	const first = await collect(
		fakeGarmin(site((data) => nightOn(data, "2026-07-25", "5400"))),
		{ streams: ["sleep"] },
	);
	assert.deepEqual(progressOf(first), [{ stream: "sleep", count: 1 }]);
	assert.deepEqual(idsOf(first, "sleep"), IDS.sleep);
	assert.deepEqual(statesOf(first), {
		sleep: { ...FULL, retry: [span("2026-07-22", "2026-08-18")] },
	});
	const fake = fakeGarmin(site((data) => nightOn(data, "2026-07-25")));
	const h = await collect(fake, {
		state: statesOf(first),
		streams: ["sleep"],
		now: LATER,
	});
	assert.deepEqual(pathsOf(fake, "sleep"), [
		`${SLEEP}2026-08-24/2026-09-20`,
		`${SLEEP}2026-09-21/2026-09-23`,
		`${SLEEP}2026-07-22/2026-08-18`,
	]);
	assert.deepEqual(idsOf(h, "sleep"), [...IDS.sleep, "2026-07-25"]);
	assert.deepEqual(messagesOf(h, "PROGRESS"), []);
	assert.deepEqual(messagesOf(h, "SKIP_RESULT"), []);
	assert.deepEqual(statesOf(h), {
		sleep: { next_day: "2026-09-24", floor: FLOOR },
	});
});

test("collect: a day still unreadable on the next run is counted again and stays kept", async () => {
	const broken = (): Answer => site((data) => summaryOn(data, HISTORY, "8432"));
	const first = await collect(fakeGarmin(broken()), {
		streams: ["daily_summaries"],
	});
	const fake = fakeGarmin(broken());
	const h = await collect(fake, {
		state: statesOf(first),
		streams: ["daily_summaries"],
		now: LATER,
	});
	assert.equal(pathsOf(fake, "daily_summaries").map(dayOf).at(-1), HISTORY);
	assert.deepEqual(idsOf(h, "daily_summaries"), ["2026-09-16"]);
	assert.deepEqual(progressOf(h), [{ stream: "daily_summaries", count: 1 }]);
	assert.deepEqual(messagesOf(h, "SKIP_RESULT"), []);
	assert.deepEqual(statesOf(h), {
		daily_summaries: {
			next_day: "2026-09-24",
			floor: FLOOR,
			retry: [span(HISTORY)],
		},
	});
});

test("collect: kept days inside the overlap week are read once, by the overlap, which lets them go when they read cleanly", async () => {
	const fake = fakeGarmin();
	const h = await collect(fake, {
		state: {
			daily_summaries: { ...FULL, retry: [span("2026-09-10", "2026-09-17")] },
		},
		streams: ["daily_summaries"],
	});
	const days = pathsOf(fake, "daily_summaries").map(dayOf);
	assert.deepEqual(days, [
		...daysFrom("2026-09-15", TODAY),
		...daysFrom("2026-09-10", "2026-09-14"),
	]);
	assert.equal(new Set(days).size, days.length, "no day read twice");
	assert.deepEqual(statesOf(h), { daily_summaries: FULL });
});

test("collect: a clean overlap window lets a kept night go, reading it once", async () => {
	const fake = fakeGarmin();
	const h = await collect(fake, {
		state: { sleep: { ...FULL, retry: [span("2026-09-16")] } },
		streams: ["sleep"],
	});
	assert.deepEqual(pathsOf(fake, "sleep"), SLEEP_AGAIN);
	assert.deepEqual(statesOf(h), { sleep: FULL });
});

test("collect: a history day that does not read is kept, though the floor moves past it", async () => {
	const fake = fakeGarmin(
		site((data) => summaryOn(data, "2026-06-15", "8432")),
	);
	const h = await collect(fake, {
		state: { daily_summaries: FULL },
		streams: ["daily_summaries"],
		ranges: { daily_summaries: { since: "2026-06-10T00:00:00.000Z" } },
	});
	assert.deepEqual(pathsOf(fake, "daily_summaries").map(dayOf), [
		...daysFrom("2026-09-15", TODAY),
		...daysFrom("2026-06-10", "2026-06-23"),
	]);
	assert.deepEqual(progressOf(h), [{ stream: "daily_summaries", count: 1 }]);
	assert.deepEqual(messagesOf(h, "SKIP_RESULT"), []);
	assert.deepEqual(statesOf(h), {
		daily_summaries: {
			next_day: "2026-09-22",
			floor: "2026-06-10",
			retry: [span("2026-06-15")],
		},
	});
});

test("collect: a history window with a night that does not read is kept whole, though the floor moves past it", async () => {
	const fake = fakeGarmin(site((data) => nightOn(data, "2026-06-15", "5400")));
	const h = await collect(fake, {
		state: { sleep: FULL },
		streams: ["sleep"],
		ranges: { sleep: { since: "2026-06-10T00:00:00.000Z" } },
	});
	// A stream consented by instant reads a day before the grant's first.
	assert.deepEqual(pathsOf(fake, "sleep"), [
		...SLEEP_AGAIN,
		`${SLEEP}2026-06-09/2026-06-23`,
	]);
	assert.deepEqual(progressOf(h), [{ stream: "sleep", count: 1 }]);
	assert.deepEqual(messagesOf(h, "SKIP_RESULT"), []);
	assert.deepEqual(statesOf(h), {
		sleep: {
			next_day: "2026-09-22",
			floor: "2026-06-09",
			retry: [span("2026-06-09", "2026-06-23")],
		},
	});
});

test("collect: when the overlap lets the last kept day go and a later read then fails, where reading again stopped goes with the list", async () => {
	const fake = fakeGarmin(
		except(site(), isPath(`${DAILY}2026-09-18`), response(503)),
	);
	const h = await collect(fake, {
		state: {
			daily_summaries: {
				...FULL,
				retry: [span("2026-09-16")],
				retry_next: "2026-09-17",
			},
		},
		streams: ["daily_summaries"],
	});
	assert.deepEqual(idsOf(h, "daily_summaries"), ["2026-09-16"]);
	assertSkips(h, "collection_interrupted", RETRY, ["daily_summaries"]);
	assert.deepEqual(statesOf(h), { daily_summaries: FULL });
});

test("collect: a kept day outside the grant is not read but stays kept; a span the grant cuts is read only inside it", async () => {
	const fake = fakeGarmin();
	const h = await collect(fake, {
		state: {
			daily_summaries: {
				...FULL,
				retry: [
					span("2026-07-01"),
					span("2026-08-30", "2026-09-02"),
					span("2026-09-18", "2026-09-20"),
				],
			},
		},
		streams: ["daily_summaries"],
		ranges: {
			daily_summaries: {
				since: "2026-09-01T00:00:00.000Z",
				until: "2026-09-19T00:00:00.000Z",
			},
		},
	});
	assert.deepEqual(pathsOf(fake, "daily_summaries").map(dayOf), [
		...daysFrom("2026-09-15", "2026-09-18"),
		"2026-09-01",
		"2026-09-02",
	]);
	assert.deepEqual(messagesOf(h, "SKIP_RESULT"), []);
	assert.deepEqual(statesOf(h), {
		daily_summaries: {
			...FULL,
			retry: [
				span("2026-07-01"),
				span("2026-08-30", "2026-08-31"),
				span("2026-09-19", "2026-09-20"),
			],
		},
	});
});

test("collect: kept days are read after the forward days and the history, from the same maxDaysPerRun; those it leaves stay kept with no skip, and the next run reads them first", async () => {
	const grant = { daily_summaries: { since: "2026-06-20T00:00:00.000Z" } };
	const fake = fakeGarmin();
	const h = await collect(fake, {
		state: {
			daily_summaries: { ...FULL, retry: [span("2026-07-01", "2026-07-10")] },
		},
		streams: ["daily_summaries"],
		ranges: grant,
		pacing: { maxDaysPerRun: 14 },
	});
	assert.deepEqual(pathsOf(fake, "daily_summaries").map(dayOf), [
		...daysFrom("2026-09-15", TODAY),
		...daysFrom("2026-06-20", "2026-06-23"),
		...daysFrom("2026-07-01", "2026-07-03"),
	]);
	assert.deepEqual(messagesOf(h, "SKIP_RESULT"), []);
	assert.deepEqual(statesOf(h), {
		daily_summaries: {
			next_day: "2026-09-22",
			floor: "2026-06-20",
			retry: [span("2026-07-04", "2026-07-10")],
			retry_next: "2026-07-04",
		},
	});
	const next = fakeGarmin();
	const after = await collect(next, {
		state: statesOf(h),
		streams: ["daily_summaries"],
		ranges: grant,
		pacing: { maxDaysPerRun: 14 },
	});
	assert.deepEqual(pathsOf(next, "daily_summaries").map(dayOf), [
		...daysFrom("2026-09-15", TODAY),
		...daysFrom("2026-07-04", "2026-07-10"),
	]);
	assert.deepEqual(messagesOf(after, "SKIP_RESULT"), []);
	assert.deepEqual(statesOf(after), {
		daily_summaries: { next_day: "2026-09-22", floor: "2026-06-20" },
	});
});

test("collect: kept windows are read after the forward ones, from the same maxWindowsPerRun; those it leaves stay kept with no skip, and the next run reads them first", async () => {
	const fake = fakeGarmin();
	const h = await collect(fake, {
		state: { sleep: { ...FULL, retry: [span("2026-07-01", "2026-08-15")] } },
		streams: ["sleep"],
		// Two for the re-read, one for a kept window.
		pacing: { maxWindowsPerRun: 3, maxRetryWindowsPerRun: 5 },
	});
	assert.deepEqual(pathsOf(fake, "sleep"), [
		...SLEEP_AGAIN,
		`${SLEEP}2026-07-01/2026-07-28`,
	]);
	assert.deepEqual(messagesOf(h, "SKIP_RESULT"), []);
	assert.deepEqual(statesOf(h), {
		sleep: {
			...FULL,
			retry: [span("2026-07-29", "2026-08-15")],
			retry_next: "2026-07-29",
		},
	});
	const next = fakeGarmin();
	const after = await collect(next, { state: statesOf(h), streams: ["sleep"] });
	assert.deepEqual(pathsOf(next, "sleep"), [
		...SLEEP_AGAIN,
		`${SLEEP}2026-07-29/2026-08-15`,
	]);
	assert.deepEqual(messagesOf(after, "SKIP_RESULT"), []);
	assert.deepEqual(statesOf(after), { sleep: FULL });
});

test("collect: a run reads at most maxRetryDaysPerRun kept days again: with every summary retyped, each later run costs a week more than the overlap, and never a skip", async () => {
	const retyped = (): Answer =>
		site((data) => {
			for (const day of daysFrom(FLOOR, "2026-09-23")) {
				summaryOn(data, day, "8432");
			}
		});
	const first = await collect(fakeGarmin(retyped()), {
		streams: ["daily_summaries"],
	});
	assert.deepEqual(progressOf(first), [
		{ stream: "daily_summaries", count: 90 },
	]);
	assert.deepEqual(messagesOf(first, "SKIP_RESULT"), []);
	assert.deepEqual(statesOf(first), {
		daily_summaries: { ...FULL, retry: [span(FLOOR, TODAY)] },
	});
	const fake = fakeGarmin(retyped());
	const h = await collect(fake, {
		state: statesOf(first),
		streams: ["daily_summaries"],
		now: LATER,
	});
	assert.deepEqual(pathsOf(fake, "daily_summaries").map(dayOf), [
		...daysFrom("2026-09-15", "2026-09-23"),
		...daysFrom(FLOOR, "2026-06-30"),
	]);
	assert.deepEqual(progressOf(h), [{ stream: "daily_summaries", count: 16 }]);
	assert.deepEqual(messagesOf(h, "SKIP_RESULT"), []);
	assert.deepEqual(statesOf(h), {
		daily_summaries: {
			next_day: "2026-09-24",
			floor: FLOOR,
			retry: [span(FLOOR, "2026-09-23")],
			retry_next: "2026-07-01",
		},
	});
});

test("collect: kept days that now read cost only maxDaysPerRun; reading them again stops once maxRetryDaysPerRun of them still do not, with no skip", async () => {
	/** Kept days that still do not read. */
	const still = ["05", "10", "15", "20", "25", "28", "30", "31"].map(
		(day) => `2026-07-${day}`,
	);
	const fake = fakeGarmin(
		site((data) => {
			summaryOn(data, "2026-07-02");
			for (const day of still) summaryOn(data, day, "8432");
		}),
	);
	const h = await collect(fake, {
		state: {
			daily_summaries: { ...FULL, retry: [span("2026-07-01", "2026-07-31")] },
		},
		streams: ["daily_summaries"],
	});
	// Clean kept days do not count: the seventh still unreadable, the 30th, is the last read.
	assert.deepEqual(pathsOf(fake, "daily_summaries").map(dayOf), [
		...daysFrom("2026-09-15", TODAY),
		...daysFrom("2026-07-01", "2026-07-30"),
	]);
	assert.deepEqual(idsOf(h, "daily_summaries"), ["2026-09-16", "2026-07-02"]);
	assert.deepEqual(progressOf(h), [{ stream: "daily_summaries", count: 7 }]);
	assert.deepEqual(messagesOf(h, "SKIP_RESULT"), []);
	assert.deepEqual(statesOf(h), {
		daily_summaries: {
			...FULL,
			retry: [
				...still.slice(0, 6).map((day) => span(day)),
				span("2026-07-30", "2026-07-31"),
			],
			retry_next: "2026-07-31",
		},
	});
});

test("collect: kept windows that now read cost only maxWindowsPerRun: a backlog that reads cleanly is read again whole in one run", async () => {
	const fake = fakeGarmin();
	const h = await collect(fake, {
		state: { sleep: { ...FULL, retry: [span("2026-02-01", "2026-07-30")] } },
		streams: ["sleep"],
	});
	assert.deepEqual(pathsOf(fake, "sleep"), [
		...SLEEP_AGAIN,
		`${SLEEP}2026-02-01/2026-02-28`,
		`${SLEEP}2026-03-01/2026-03-28`,
		`${SLEEP}2026-03-29/2026-04-25`,
		`${SLEEP}2026-04-26/2026-05-23`,
		`${SLEEP}2026-05-24/2026-06-20`,
		`${SLEEP}2026-06-21/2026-07-18`,
		`${SLEEP}2026-07-19/2026-07-30`,
	]);
	assert.deepEqual(messagesOf(h, "PROGRESS"), []);
	assert.deepEqual(messagesOf(h, "SKIP_RESULT"), []);
	assert.deepEqual(statesOf(h), { sleep: FULL });
});

test("collect: with production pacing a range stream stops reading kept windows again once one still does not read", async () => {
	const fake = fakeGarmin(site((data) => nightOn(data, "2026-07-05", "5400")));
	const h = await collect(fake, {
		state: { sleep: { ...FULL, retry: [span("2026-07-01", "2026-08-15")] } },
		streams: ["sleep"],
	});
	assert.deepEqual(pathsOf(fake, "sleep"), [
		...SLEEP_AGAIN,
		`${SLEEP}2026-07-01/2026-07-28`,
	]);
	assert.deepEqual(progressOf(h), [{ stream: "sleep", count: 1 }]);
	assert.deepEqual(messagesOf(h, "SKIP_RESULT"), []);
	assert.deepEqual(statesOf(h), {
		sleep: {
			...FULL,
			retry: [span("2026-07-01", "2026-08-15")],
			retry_next: "2026-07-29",
		},
	});
});

test("collect: kept days that never read do not starve the rest: each run reads again from where the last stopped, so a newer kept day that now reads ships within one round", async () => {
	const answer = site((data) => {
		for (const day of daysFrom("2026-07-01", "2026-07-20")) {
			summaryOn(data, day, "8432");
		}
		summaryOn(data, "2026-08-10");
	});
	const run = async (state: Record<string, unknown>) => {
		const fake = fakeGarmin(answer);
		const h = await collect(fake, { state, streams: ["daily_summaries"] });
		assert.deepEqual(messagesOf(h, "SKIP_RESULT"), []);
		return {
			again: pathsOf(fake, "daily_summaries").map(dayOf).slice(7),
			h,
		};
	};
	const bad = span("2026-07-01", "2026-07-20");
	const one = await run({
		daily_summaries: { ...FULL, retry: [bad, span("2026-08-10")] },
	});
	assert.deepEqual(one.again, daysFrom("2026-07-01", "2026-07-07"));
	assert.deepEqual(progressOf(one.h), [
		{ stream: "daily_summaries", count: 7 },
	]);
	assert.deepEqual(statesOf(one.h), {
		daily_summaries: {
			...FULL,
			retry: [bad, span("2026-08-10")],
			retry_next: "2026-07-08",
		},
	});
	const two = await run(statesOf(one.h));
	assert.deepEqual(two.again, daysFrom("2026-07-08", "2026-07-14"));
	// The 10th of August reads, so it does not count: round to the oldest, the seventh still unreadable.
	const three = await run(statesOf(two.h));
	assert.deepEqual(three.again, [
		...daysFrom("2026-07-15", "2026-07-20"),
		"2026-08-10",
		"2026-07-01",
	]);
	assert.deepEqual(idsOf(three.h, "daily_summaries"), [
		"2026-09-16",
		"2026-08-10",
	]);
	assert.deepEqual(progressOf(three.h), [
		{ stream: "daily_summaries", count: 7 },
	]);
	assert.deepEqual(statesOf(three.h), {
		daily_summaries: { ...FULL, retry: [bad], retry_next: "2026-07-02" },
	});
});

test("collect: a run whose history maxDaysPerRun cuts short defers as before, the kept days waiting unread beside the history cursor", async () => {
	const saved = {
		next_day: "2026-09-22",
		floor: FLOOR,
		backfill: { since: "2026-05-01", next_day: "2026-05-14" },
		retry: [span("2026-07-01", "2026-07-10")],
	};
	const fake = fakeGarmin();
	const h = await collect(fake, {
		state: { daily_summaries: saved },
		streams: ["daily_summaries"],
		ranges: { daily_summaries: { since: "2026-05-01T00:00:00.000Z" } },
		pacing: { maxDaysPerRun: 10 },
	});
	assert.deepEqual(pathsOf(fake, "daily_summaries").map(dayOf), [
		...daysFrom("2026-09-15", TODAY),
		...daysFrom("2026-05-14", "2026-05-16"),
	]);
	assertSkips(h, "source_limit_reached", RETRY, ["daily_summaries"]);
	assert.deepEqual(statesOf(h), {
		daily_summaries: {
			...saved,
			backfill: { since: "2026-05-01", next_day: "2026-05-17" },
		},
	});
});

test("collect: past MAX_RETRY_DAYS the oldest kept days are let go, and a second PROGRESS line counts the days, with no date", async () => {
	assert.equal(MAX_RETRY_DAYS, 366);
	const fake = fakeGarmin(
		site((data) => {
			for (const day of daysFrom("2026-09-16", "2026-09-18")) {
				summaryOn(data, day, "8432");
			}
		}),
	);
	const h = await collect(fake, {
		// Two days short of a full list, outside the grant: kept, never read.
		state: {
			daily_summaries: { ...FULL, retry: [span("2025-06-03", "2026-06-01")] },
		},
		streams: ["daily_summaries"],
		ranges: { daily_summaries: { since: `${FLOOR}T00:00:00.000Z` } },
	});
	assert.deepEqual(
		pathsOf(fake, "daily_summaries").map(dayOf),
		daysFrom("2026-09-15", TODAY),
	);
	assert.deepEqual(progressLines(h), [
		{
			stream: "daily_summaries",
			count: 3,
			message: "3 record(s) unreadable.",
		},
		{
			stream: "daily_summaries",
			count: 1,
			message:
				"1 day(s) of unreadable records could not be kept for another try.",
		},
	]);
	assert.deepEqual(messagesOf(h, "SKIP_RESULT"), []);
	assert.deepEqual(statesOf(h), {
		daily_summaries: {
			...FULL,
			retry: [
				span("2025-06-04", "2026-06-01"),
				span("2026-09-16", "2026-09-18"),
			],
		},
	});
	assertStateLast(h);
});

test("collect: a range stream past MAX_RETRY_DAYS lets the oldest kept days go as well: its window joins whole, so the days let go outnumber the nights", async () => {
	const fake = fakeGarmin(site((data) => nightOn(data, "2026-09-18", "5400")));
	const h = await collect(fake, {
		// A full list, outside the grant (whose first day is the floor): kept, never read.
		state: { sleep: { ...FULL, retry: [span("2025-06-01", "2026-06-01")] } },
		streams: ["sleep"],
		ranges: { sleep: { since: "2026-06-25T00:00:00.000Z" } },
	});
	assert.deepEqual(pathsOf(fake, "sleep"), SLEEP_AGAIN);
	assert.deepEqual(idsOf(h, "sleep"), IDS.sleep);
	assert.deepEqual(progressLines(h), [
		{ stream: "sleep", count: 1, message: "1 record(s) unreadable." },
		{
			stream: "sleep",
			count: 28,
			message:
				"28 day(s) of unreadable records could not be kept for another try.",
		},
	]);
	assert.deepEqual(messagesOf(h, "SKIP_RESULT"), []);
	assert.deepEqual(statesOf(h), {
		sleep: {
			...FULL,
			retry: [
				span("2025-06-29", "2026-06-01"),
				span("2026-08-24", "2026-09-20"),
			],
		},
	});
	assertStateLast(h);
});

test("collect: at the cap, the list is cut once after the run: a kept day read again and still unreadable is let go once, and counted once", async () => {
	const kept = span("2025-09-01", "2026-09-01");
	const fake = fakeGarmin(
		site((data) => {
			for (const day of [
				...daysFrom(kept.from, kept.to),
				...daysFrom("2026-09-15", TODAY),
			]) {
				summaryOn(data, day, "8432");
			}
		}),
	);
	const h = await collect(fake, {
		state: { daily_summaries: { ...FULL, retry: [kept] } },
		streams: ["daily_summaries"],
	});
	assert.deepEqual(pathsOf(fake, "daily_summaries").map(dayOf), [
		...daysFrom("2026-09-15", TODAY),
		...daysFrom("2025-09-01", "2025-09-07"),
	]);
	assert.deepEqual(progressLines(h), [
		{
			stream: "daily_summaries",
			count: 14,
			message: "14 record(s) unreadable.",
		},
		{
			stream: "daily_summaries",
			count: 7,
			message:
				"7 day(s) of unreadable records could not be kept for another try.",
		},
	]);
	assert.deepEqual(messagesOf(h, "SKIP_RESULT"), []);
	assert.deepEqual(statesOf(h), {
		daily_summaries: {
			...FULL,
			retry: [span("2025-09-08", "2026-09-01"), span("2026-09-15", TODAY)],
			retry_next: "2025-09-08",
		},
	});
});

test("collect: full_refresh keeps the days still to read again, and reads them after its ninety days", async () => {
	const fake = fakeGarmin(
		site((data) => summaryOn(data, "2026-01-10", "8432")),
	);
	const h = await collect(fake, {
		state: { daily_summaries: { ...FULL, retry: [span("2026-01-10")] } },
		streams: ["daily_summaries"],
		now: LATER,
		mode: "full_refresh",
		// Ninety days fill the default cap; one more lets the kept day in.
		pacing: { maxDaysPerRun: 91 },
	});
	assert.deepEqual(pathsOf(fake, "daily_summaries").map(dayOf), [
		...daysFrom("2026-06-26", "2026-09-23"),
		"2026-01-10",
	]);
	assert.deepEqual(progressOf(h), [{ stream: "daily_summaries", count: 1 }]);
	assert.deepEqual(statesOf(h), {
		daily_summaries: {
			next_day: "2026-09-24",
			floor: "2026-06-26",
			retry: [span("2026-01-10")],
		},
	});
});

test("collect: a kept day whose read fails stays kept, and the stream skips as any failed read does", async () => {
	const fake = fakeGarmin(
		except(site(), isPath(`${DAILY}${HISTORY}`), response(503)),
	);
	const h = await collect(fake, {
		state: { daily_summaries: { ...FULL, retry: [span(HISTORY)] } },
		streams: ["daily_summaries"],
	});
	assert.equal(pathsOf(fake, "daily_summaries").at(-1), `${DAILY}${HISTORY}`);
	assertSkips(h, "collection_interrupted", RETRY, ["daily_summaries"]);
	assert.deepEqual(statesOf(h), {
		daily_summaries: { ...FULL, retry: [span(HISTORY)] },
	});
});

test("collect: a kept window whose read fails stays kept, and the stream skips as any failed read does", async () => {
	const kept = span("2026-07-22", "2026-08-18");
	const fake = fakeGarmin(
		except(site(), windowFrom("sleep", kept.from), response(503)),
	);
	const h = await collect(fake, {
		state: { sleep: { ...FULL, retry: [kept] } },
		streams: ["sleep"],
	});
	assert.deepEqual(pathsOf(fake, "sleep"), [
		...SLEEP_AGAIN,
		`${SLEEP}${kept.from}/${kept.to}`,
	]);
	assertSkips(h, "collection_interrupted", RETRY, ["sleep"]);
	assert.deepEqual(statesOf(h), { sleep: { ...FULL, retry: [kept] } });
});

test("collect: of a kept span two windows long, the window still unreadable is counted again and stays kept, and the one that now reads is let go", async () => {
	const fake = fakeGarmin(site((data) => nightOn(data, "2026-08-10", "5400")));
	const h = await collect(fake, {
		state: { sleep: { ...FULL, retry: [span("2026-07-01", "2026-08-15")] } },
		streams: ["sleep"],
		pacing: { maxRetryWindowsPerRun: 2 },
	});
	assert.deepEqual(pathsOf(fake, "sleep"), [
		...SLEEP_AGAIN,
		`${SLEEP}2026-07-01/2026-07-28`,
		`${SLEEP}2026-07-29/2026-08-15`,
	]);
	assert.deepEqual(idsOf(h, "sleep"), IDS.sleep);
	assert.deepEqual(progressOf(h), [{ stream: "sleep", count: 1 }]);
	assert.deepEqual(messagesOf(h, "SKIP_RESULT"), []);
	assert.deepEqual(statesOf(h), {
		sleep: { ...FULL, retry: [span("2026-07-29", "2026-08-15")] },
	});
});

// ── Messages ───────────────────────────────────────────────────────────────
test("collect: PROGRESS and SKIP messages carry counts and statuses, never an id, a date, a value or the handle", async () => {
	const drifted = site((data) => {
		(data.daily["2026-09-16"] as Record<string, unknown>).totalSteps = "8432";
		(data.activities[0] as Record<string, unknown>).distance = "25012.4";
		(
			(data.sleep[0] as Record<string, unknown>).values as Record<
				string,
				unknown
			>
		).sleepScore = "81";
	});
	const scenarios: Array<{ answer: Answer; pacing?: Partial<Pacing> }> = [
		{ answer: drifted },
		{ answer: () => response(401) },
		{ answer: () => response(403) },
		{ answer: () => ({ kind: "no_token" }) },
		{ answer: except(site(), isPath(`${DAILY}2026-09-18`), response(429)) },
		{
			answer: except(
				site(),
				isPath(`${DAILY}2026-09-18`),
				response(200, "<html>fixture-owner</html>", "text/html"),
			),
		},
		{
			answer: except(
				site(),
				isStream("sleep"),
				json({ individualStats: "fixture-owner" }),
			),
		},
		{
			answer: except(site(), isStream("hrv"), {
				kind: "network_error",
				message: "AbortError",
			}),
		},
		{
			answer: except(site(), isStream("activities"), {
				kind: "wrong_origin",
				origin: "https://sso.garmin.com",
			}),
		},
		{ answer: site(), pacing: { maxDaysPerRun: 3, maxWindowsPerRun: 1 } },
		{
			answer: site((data) => {
				data.activities = manyActivities(100);
			}),
		},
		{
			answer: site((data) => {
				data.activities = manyActivities(150);
			}),
			pacing: { maxRequestsPerWindow: 1 },
		},
	];
	const runs = await Promise.all(
		scenarios.map(({ answer, pacing }) =>
			collect(fakeGarmin(answer), pacing ? { pacing } : {}),
		),
	);
	assert.ok(
		runs.every(
			(h) =>
				messagesOf(h, "PROGRESS").length + messagesOf(h, "SKIP_RESULT").length >
				0,
		),
		"every scenario says something",
	);
	for (const h of runs) {
		for (const text of [
			...messagesOf(h, "PROGRESS").map((m) => m.message),
			...messagesOf(h, "SKIP_RESULT").map((m) => m.message),
		]) {
			assert.doesNotMatch(String(text), /\d{4}-\d{2}-\d{2}/, String(text));
			assert.doesNotMatch(String(text), /\d{5,}/, String(text));
			assert.doesNotMatch(
				String(text),
				/fixture|garmin\.com|8432|25012|csrf/i,
				String(text),
			);
		}
	}
});
