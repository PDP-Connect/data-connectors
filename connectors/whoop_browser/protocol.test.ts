// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Layers 4 and 5: the real connector runtime in a subprocess, fed the synthetic fixtures by
 * protocol-runtime-fixture.ts, and every record it ships checked against Zod and the manifest.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { EmittedMessage } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import {
	type ConnectorSubprocessResult,
	runConnectorProtocolSubprocess,
} from "../../packages/polyfill-connectors/src/test-harness.ts";
import { STREAMS, type Stream, validateRecord } from "./schemas.ts";

type RecordMessage = Extract<EmittedMessage, { type: "RECORD" }>;
type StateMessage = Extract<EmittedMessage, { type: "STATE" }>;
type Scope = {
	name: string;
	time_range?: { since?: string; until?: string };
};

const text = (name: string): string =>
	readFileSync(new URL(`./${name}`, import.meta.url), "utf8");

// ── The fixtures, as the runtime fixture serves them ───────────────────────
/** protocol-runtime-fixture.ts's clock; its source is checked against this below. */
const NOW = "2026-09-20T12:00:00.000Z";
/** bootstrap.json's account start, less the day planWindows allows for the time zone. */
const HISTORY_START = "2026-07-31T09:30:00.000Z";
const CYCLE = {
	scored: "1000000101", // 2026-09-14T12:40Z, with the recovery, the main sleep, the nap and the run
	quiet: "1000000102", // 2026-09-15T13:05Z, nothing nested
	open: "1000000103", // 2026-09-16T12:50Z, under way; its recovery is unscored
};
const SLEEP = {
	main: "00000000-0000-4000-8000-000000000101", // 2026-09-14T12:40Z, opens the scored cycle
	nap: "00000000-0000-4000-8000-000000000102", // 2026-09-15T05:10Z, inside the scored cycle
	open: "00000000-0000-4000-8000-000000000103", // 2026-09-16T12:50Z, opens the open cycle
};
const RUN = "00000000-0000-4000-8000-000000000201"; // 2026-09-14T22:00Z, inside the scored cycle
/** The open cycle's start: a walk that keeps it writes it to the cursor as open_since. */
const OPEN_SINCE = "2026-09-16T12:50:00.000Z";
/** The cursor of an unbounded walk over the fixtures: account start, now, the open cycle. */
const FULL_CURSOR = {
	floor: HISTORY_START,
	through: NOW,
	open_since: OPEN_SINCE,
};
const COUNTS: Record<Stream, number> = {
	cycles: 3,
	recoveries: 1,
	sleeps: 3,
	workouts: 1,
};

// ── Driving the runtime ────────────────────────────────────────────────────
const PACKAGE_DIR = new URL(
	"../../packages/polyfill-connectors/",
	import.meta.url,
).pathname;
const ENTRYPOINT = new URL("./protocol-runtime-fixture.ts", import.meta.url)
	.pathname;
const SUBPROCESS = { timeout: 30_000 };

function start(
	streams: Scope[],
	extra: { state?: Record<string, unknown> } = {},
): Promise<ConnectorSubprocessResult> {
	return runConnectorProtocolSubprocess({
		cwd: PACKAGE_DIR,
		entrypoint: ENTRYPOINT,
		start: { type: "START", scope: { streams }, ...extra },
		timeoutMs: 30_000,
	});
}

const everyStream = (): Scope[] => STREAMS.map((name) => ({ name }));
let firstRun: Promise<ConnectorSubprocessResult> | undefined;
/** One unbounded run of every stream, shared by the tests that only read it. */
const full = (): Promise<ConnectorSubprocessResult> =>
	(firstRun ??= start(everyStream()));

const recordsOf = (run: ConnectorSubprocessResult): RecordMessage[] =>
	run.messages.filter((m): m is RecordMessage => m.type === "RECORD");
const statesOf = (run: ConnectorSubprocessResult): StateMessage[] =>
	run.messages.filter((m): m is StateMessage => m.type === "STATE");
const idsIn = (run: ConnectorSubprocessResult, stream: Stream): string[] =>
	recordsOf(run)
		.filter((m) => m.stream === stream)
		.map((m) => String(m.data.id));
const countsOf = (run: ConnectorSubprocessResult): Record<string, number> => {
	const counts: Record<string, number> = {};
	for (const { stream } of recordsOf(run))
		counts[stream] = (counts[stream] ?? 0) + 1;
	return counts;
};
const streamOf = (m: EmittedMessage): string | undefined =>
	"stream" in m && typeof m.stream === "string" ? m.stream : undefined;
/** PROGRESS and SKIP_RESULT: what a run that read everything cleanly never sends. */
const noiseOf = (run: ConnectorSubprocessResult): EmittedMessage[] =>
	run.messages.filter((m) => m.type === "PROGRESS" || m.type === "SKIP_RESULT");

/** One STATE per stream named, in that order, each holding exactly this cursor. */
function assertCursors(
	run: ConnectorSubprocessResult,
	streams: readonly Stream[],
	cursor: Record<string, string>,
): void {
	const states = statesOf(run);
	assert.deepEqual(
		states.map((m) => m.stream),
		[...streams],
	);
	for (const m of states) assert.deepEqual(m.cursor, cursor, m.stream);
}

/** One STATE per stream named, in stream order, each holding that stream's own cursor. */
function assertEachCursor(
	run: ConnectorSubprocessResult,
	cursors: Partial<Record<Stream, Record<string, string>>>,
): void {
	const states = statesOf(run);
	assert.deepEqual(
		states.map((m) => m.stream),
		Object.keys(cursors),
	);
	for (const m of states) {
		assert.deepEqual(m.cursor, cursors[m.stream as Stream], m.stream);
	}
}
/** The fixtures' cursor for a stream whose grant reaches back to `floor`. */
const cursorFrom = (floor: string) => ({ ...FULL_CURSOR, floor });

/** Exit 0 and DONE last, succeeded, counting exactly the RECORDs before it. */
function assertSucceeded(run: ConnectorSubprocessResult): void {
	assert.equal(run.code, 0, run.stderr);
	const done = run.messages.at(-1);
	assert.equal(done?.type, "DONE");
	assert.equal(run.messages.filter((m) => m.type === "DONE").length, 1);
	if (done?.type === "DONE") {
		assert.equal(done.status, "succeeded");
		assert.equal(done.records_emitted, recordsOf(run).length);
	}
}

// ── Layer 4: the protocol, end to end ──────────────────────────────────────
test("whoop_browser: the runtime fixture's clock is the one these tests assume", () => {
	assert.match(
		text("protocol-runtime-fixture.ts"),
		new RegExp(`new Date\\("${NOW.replaceAll(".", "\\.")}"\\)`, "u"),
	);
});

test(
	"whoop_browser: every stream ships its fixture records, keyed by id, and DONE counts them",
	SUBPROCESS,
	async () => {
		const run = await full();
		assertSucceeded(run);
		const records = recordsOf(run);
		assert.deepEqual(new Set(records.map((m) => m.stream)), new Set(STREAMS));
		assert.deepEqual(countsOf(run), COUNTS);
		assert.equal(records.length, 8);
		for (const m of records) {
			assert.equal(m.key, m.data.id, `${m.stream}: key is data.id`);
			assert.equal(typeof m.data.id, "string");
			assert.equal(m.op, undefined, "no tombstones");
		}
		assert.deepEqual(idsIn(run, "cycles"), [
			CYCLE.scored,
			CYCLE.quiet,
			CYCLE.open,
		]);
		// The open cycle's recovery is not scored yet, so only the scored cycle has one.
		assert.deepEqual(idsIn(run, "recoveries"), [CYCLE.scored]);
		assert.deepEqual(idsIn(run, "sleeps"), [SLEEP.main, SLEEP.nap, SLEEP.open]);
		assert.deepEqual(idsIn(run, "workouts"), [RUN]);
	},
);

test(
	"whoop_browser: each record ships once, oldest first, joined to its cycle",
	SUBPROCESS,
	async () => {
		const run = await full();
		for (const stream of STREAMS) {
			const records = recordsOf(run).filter((m) => m.stream === stream);
			const keys = records.map((m) => m.key);
			assert.equal(new Set(keys).size, keys.length, `${stream}: no repeats`);
			const starts = records.map((m) => String(m.data.start_at));
			assert.deepEqual(starts, starts.toSorted(), `${stream}: oldest first`);
		}
		const cycles = new Set(idsIn(run, "cycles"));
		const sleeps = new Set(idsIn(run, "sleeps"));
		for (const m of recordsOf(run)) {
			if (m.stream === "sleeps" || m.stream === "workouts")
				assert.ok(cycles.has(String(m.data.cycle_id)), `${m.stream} cycle_id`);
			if (m.stream === "recoveries") {
				assert.ok(cycles.has(String(m.data.id)), "recovery id is its cycle's");
				assert.ok(sleeps.has(String(m.data.sleep_id)), "recovery sleep_id");
			}
		}
	},
);

test(
	"whoop_browser: a clean run reports nothing unreadable and skips nothing",
	SUBPROCESS,
	async () => {
		assert.deepEqual(noiseOf(await full()), []);
	},
);

test(
	"whoop_browser: one STATE per stream, after that stream's last RECORD, from the account's start to now, marking the open cycle",
	SUBPROCESS,
	async () => {
		const run = await full();
		for (const stream of STREAMS) {
			const lastRecord = run.messages.findLastIndex(
				(m) => m.type === "RECORD" && m.stream === stream,
			);
			const state = run.messages.findIndex(
				(m) => m.type === "STATE" && m.stream === stream,
			);
			assert.ok(lastRecord >= 0, `${stream}: has records`);
			assert.ok(state > lastRecord, `${stream}: STATE after its records`);
		}
		// The spec's floor (account start less a day), the walk's end (now) and the start of the
		// cycle still under way, which the next run re-reads, in every stream.
		assertCursors(run, STREAMS, FULL_CURSOR);
	},
);

test(
	"whoop_browser: a START scoped to sleeps and recoveries emits only those two",
	SUBPROCESS,
	async () => {
		const run = await start([{ name: "sleeps" }, { name: "recoveries" }]);
		assertSucceeded(run);
		assert.deepEqual(countsOf(run), { recoveries: 1, sleeps: 3 });
		assert.deepEqual(
			new Set(statesOf(run).map((m) => m.stream)),
			new Set(["sleeps", "recoveries"]),
		);
		assert.equal(statesOf(run).length, 2);
		for (const m of run.messages) {
			const stream = streamOf(m);
			if (stream !== undefined)
				assert.ok(
					stream === "sleeps" || stream === "recoveries",
					`${m.type} for ${stream}, which was not requested`,
				);
		}
	},
);

test(
	"whoop_browser: a START time_range drops each stream's records outside its own range",
	SUBPROCESS,
	async () => {
		// The runtime drops a record when `start_at < since.slice(0, 10)` or `start_at >=
		// until.slice(0, 10)`, comparing strings at day precision. Both bounds sit on UTC midnight,
		// so that filter and the connector's own, at the grant's exact instants, agree on every
		// fixture record. Recoveries and workouts carry no range, so the walk is the unbounded one.
		const run = await start([
			{ name: "cycles", time_range: { until: "2026-09-16T00:00:00.000Z" } },
			{ name: "recoveries" },
			{ name: "sleeps", time_range: { since: "2026-09-15T00:00:00.000Z" } },
			{ name: "workouts" },
		]);
		assertSucceeded(run);
		// The main sleep (2026-09-14T12:40Z) falls before since; the nap and the open sleep do not.
		assert.deepEqual(idsIn(run, "sleeps"), [SLEEP.nap, SLEEP.open]);
		// The open cycle (2026-09-16T12:50Z) falls on or after until.
		assert.deepEqual(idsIn(run, "cycles"), [CYCLE.scored, CYCLE.quiet]);
		assert.deepEqual(idsIn(run, "recoveries"), [CYCLE.scored]);
		assert.deepEqual(idsIn(run, "workouts"), [RUN]);
		assert.equal(recordsOf(run).length, 6);
		// A record outside its grant is dropped, not counted unreadable.
		assert.deepEqual(noiseOf(run), []);
		// Each cursor covers only what its own grant let the walk read: cycles stop at until, and
		// sleeps start two days before their since.
		assertEachCursor(run, {
			cycles: { ...FULL_CURSOR, through: "2026-09-16T00:00:00.000Z" },
			recoveries: FULL_CURSOR,
			sleeps: cursorFrom("2026-09-13T00:00:00.000Z"),
			workouts: FULL_CURSOR,
		});
	},
);

test(
	"whoop_browser: a run seeded with the first run's STATE succeeds, re-reads the week and keeps the cursor",
	SUBPROCESS,
	async () => {
		const first = await full();
		const state = Object.fromEntries(
			statesOf(first).map((m) => [m.stream, m.cursor]),
		);
		assert.deepEqual(Object.keys(state), [...STREAMS]);
		const run = await start(everyStream(), { state });
		assertSucceeded(run);
		// Every fixture cycle starts inside the week re-read before the cursor, so all return,
		// and the cycle still under way is still under way.
		assert.deepEqual(countsOf(run), COUNTS);
		assertCursors(run, STREAMS, FULL_CURSOR);
	},
);

test(
	"whoop_browser: a seeded cursor's open_since is read, then written afresh from what the walk finds",
	SUBPROCESS,
	async () => {
		// A floor before the account's start is no reason to start afresh, so a run that kept the
		// seeded floor read these cursors. The quiet cycle the seed names has since closed, and one
		// stream's open_since is no instant: neither is carried, and neither makes the cursor unreadable.
		const seeded = { floor: "2026-01-01T00:00:00.000Z", through: NOW };
		const run = await start(everyStream(), {
			state: {
				cycles: { ...seeded, open_since: "soon" },
				recoveries: { ...seeded, open_since: "2026-09-15T13:05:00.000Z" },
				sleeps: { ...seeded, open_since: "2026-09-15T13:05:00.000Z" },
				workouts: { ...seeded, open_since: "2026-09-15T13:05:00.000Z" },
			},
		});
		assertSucceeded(run);
		assert.deepEqual(countsOf(run), COUNTS);
		assertCursors(run, STREAMS, { ...seeded, open_since: OPEN_SINCE });
	},
);

test(
	"whoop_browser: a run seeded with unreadable state starts afresh instead of failing",
	SUBPROCESS,
	async () => {
		const run = await start(everyStream(), {
			state: {
				cycles: "2026-09-01",
				recoveries: { floor: "not a time", through: NOW },
				sleeps: { floor: NOW, through: HISTORY_START }, // through before floor
				workouts: null,
			},
		});
		assertSucceeded(run);
		assert.deepEqual(countsOf(run), COUNTS);
		assertCursors(run, STREAMS, FULL_CURSOR);
	},
);

test(
	"whoop_browser: a bounded grant keeps the naps and workouts of the cycle under way at its start",
	SUBPROCESS,
	async () => {
		// Both bounds hold the nap (2026-09-15T05:10Z) and the run (2026-09-14T22:00Z), at the
		// runtime's day precision and at the grant's exact instants alike. Both sit in the scored
		// cycle, which began at 2026-09-14T12:40Z, before either bound: the walk reaches two days
		// before the earliest since to read it, and each stream's floor records its own reach.
		const run = await start([
			{ name: "sleeps", time_range: { since: "2026-09-15T00:00:00.000Z" } },
			{ name: "workouts", time_range: { since: "2026-09-14T18:00:00.000Z" } },
		]);
		assertSucceeded(run);
		assert.deepEqual(idsIn(run, "sleeps"), [SLEEP.nap, SLEEP.open]);
		assert.deepEqual(idsIn(run, "workouts"), [RUN]);
		assert.deepEqual(noiseOf(run), []);
		assertEachCursor(run, {
			sleeps: cursorFrom("2026-09-13T00:00:00.000Z"),
			workouts: cursorFrom("2026-09-12T18:00:00.000Z"),
		});
	},
);

test(
	"whoop_browser: a since inside a day holds at its instant, not the day's start",
	SUBPROCESS,
	async () => {
		// Cycles carry no range, so the walk is unbounded and the nap (2026-09-15T05:10Z) is built.
		// It starts before since's instant but on since's day, so the runtime's day-precision
		// filter keeps it: a record from outside the grant ships unless the connector drops it.
		const run = await start([
			{ name: "cycles" },
			{ name: "sleeps", time_range: { since: "2026-09-15T12:00:00.000Z" } },
		]);
		assertSucceeded(run);
		assert.deepEqual(idsIn(run, "cycles"), [
			CYCLE.scored,
			CYCLE.quiet,
			CYCLE.open,
		]);
		assert.deepEqual(idsIn(run, "sleeps"), [SLEEP.open]);
		assert.deepEqual(noiseOf(run), []);
	},
);

test(
	"whoop_browser: the cycle a grant reaches back for ships only the records that start inside it",
	SUBPROCESS,
	async () => {
		// Every stream from 2026-09-14T18:00Z: the walk reads the scored cycle (12:40Z that day)
		// for the run inside it. The runtime keeps everything on since's day, so the scored cycle,
		// its recovery and its main sleep, all starting at 12:40Z, are the connector's to drop.
		const since = "2026-09-14T18:00:00.000Z";
		const run = await start(
			STREAMS.map((name) => ({ name, time_range: { since } })),
		);
		assertSucceeded(run);
		assert.deepEqual(idsIn(run, "cycles"), [CYCLE.quiet, CYCLE.open]);
		// The open cycle's recovery is not scored, so none remains.
		assert.deepEqual(idsIn(run, "recoveries"), []);
		assert.deepEqual(idsIn(run, "sleeps"), [SLEEP.nap, SLEEP.open]);
		assert.deepEqual(idsIn(run, "workouts"), [RUN]);
		assert.deepEqual(noiseOf(run), []);
		assertCursors(run, STREAMS, {
			floor: "2026-09-12T18:00:00.000Z",
			through: NOW,
			open_since: OPEN_SINCE,
		});
	},
);

test(
	"whoop_browser: each stream is held to its own grant's since, inclusive, from one walk over the widest",
	SUBPROCESS,
	async () => {
		// One walk serves the earliest since; each stream then keeps what starts at or after its
		// own. Where a since falls later on a record's day, the runtime would keep the record.
		const run = await start([
			{ name: "cycles", time_range: { since: "2026-09-15T18:00:00.000Z" } },
			{ name: "recoveries", time_range: { since: "2026-08-01T00:00:00.000Z" } },
			{ name: "sleeps", time_range: { since: "2026-09-14T18:00:00.000Z" } },
			{ name: "workouts", time_range: { since: "2026-09-14T22:00:00.000Z" } },
		]);
		assertSucceeded(run);
		// The quiet cycle (2026-09-15T13:05Z) is on cycles' since day, before its instant.
		assert.deepEqual(idsIn(run, "cycles"), [CYCLE.open]);
		assert.deepEqual(idsIn(run, "recoveries"), [CYCLE.scored]);
		// The main sleep (2026-09-14T12:40Z) is on sleeps' since day, before its instant.
		assert.deepEqual(idsIn(run, "sleeps"), [SLEEP.nap, SLEEP.open]);
		// The run starts at workouts' since exactly.
		assert.deepEqual(idsIn(run, "workouts"), [RUN]);
		assert.deepEqual(noiseOf(run), []);
		// Each floor is its own since less two days; recoveries' lies within two days of the
		// account's start, so its reach stops there.
		assertEachCursor(run, {
			cycles: cursorFrom("2026-09-13T18:00:00.000Z"),
			recoveries: FULL_CURSOR,
			sleeps: cursorFrom("2026-09-12T18:00:00.000Z"),
			workouts: cursorFrom("2026-09-12T22:00:00.000Z"),
		});
	},
);

test(
	"whoop_browser: a grant that ends before the open cycle closes the walk at until and leaves no open_since",
	SUBPROCESS,
	async () => {
		// Until is the open cycle's start exactly: it begins the next walk, not this one.
		const until = "2026-09-16T12:50:00.000Z";
		const run = await start(
			STREAMS.map((name) => ({ name, time_range: { until } })),
		);
		assertSucceeded(run);
		assert.deepEqual(idsIn(run, "cycles"), [CYCLE.scored, CYCLE.quiet]);
		assert.deepEqual(idsIn(run, "recoveries"), [CYCLE.scored]);
		assert.deepEqual(idsIn(run, "sleeps"), [SLEEP.main, SLEEP.nap]);
		assert.deepEqual(idsIn(run, "workouts"), [RUN]);
		assert.deepEqual(noiseOf(run), []);
		assertCursors(run, STREAMS, { floor: HISTORY_START, through: until });
	},
);

// ── Layer 5: manifest agreement ────────────────────────────────────────────
interface Property {
	type?: string | string[];
	format?: string;
}
interface ManifestStream {
	name: string;
	primary_key: string[];
	cursor_field: string;
	consent_time_field: string;
	schema: {
		properties: Record<string, Property>;
		required: string[];
	};
}
interface Manifest {
	source: { id: string; display: { name: string } };
	runtime_requirements: { bindings: Record<string, unknown> };
	capabilities: Record<string, unknown> & {
		human_interaction: string[];
		refresh_policy: Record<string, unknown>;
		public_listing: Record<string, unknown>;
	};
	streams: ManifestStream[];
	reason_display_messages: Record<string, string>;
	[key: string]: unknown;
}
const manifest = JSON.parse(text("manifest.json")) as Manifest;
const upstreamWhoop = JSON.parse(text("../whoop/manifest.json")) as Manifest;
const spec = (stream: string): ManifestStream => {
	const found = manifest.streams.find(({ name }) => name === stream);
	assert.ok(found, `${stream} in the manifest`);
	return found;
};

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats.default(ajv);

test(
	"whoop_browser: every shipped record passes Zod cleanly and the manifest's JSON Schema",
	SUBPROCESS,
	async () => {
		const run = await full();
		const checks = new Map(
			STREAMS.map((stream) => [stream, ajv.compile(spec(stream).schema)]),
		);
		const records = recordsOf(run);
		assert.equal(records.length, 8);
		for (const { stream, data } of records) {
			const zod = validateRecord(stream, data);
			assert.equal(zod.ok, true, `${stream} ${data.id}: Zod`);
			if (zod.ok)
				assert.deepEqual(zod.anomalies ?? [], [], `${stream}: anomalies`);
			const check = checks.get(stream as Stream);
			assert.ok(check, `${stream} has a manifest schema`);
			assert.equal(
				check(data),
				true,
				`${stream} ${data.id}: ${ajv.errorsText(check.errors)}`,
			);
			// Every key the manifest names arrives, and nothing else.
			assert.deepEqual(
				Object.keys(data).toSorted(),
				Object.keys(spec(stream).schema.properties).toSorted(),
				`${stream}: keys`,
			);
		}
	},
);

test("whoop_browser: every stream keys on id and consents and cursors on start_at, an instant", () => {
	assert.deepEqual(
		manifest.streams.map(({ name }) => name),
		[...STREAMS],
	);
	for (const stream of STREAMS) {
		const { primary_key, cursor_field, consent_time_field, schema } =
			spec(stream);
		assert.deepEqual(primary_key, ["id"], stream);
		assert.equal(cursor_field, "start_at", stream);
		assert.equal(consent_time_field, "start_at", stream);
		assert.equal(schema.properties.id?.type, "string", `${stream}.id`);
		// Never nullable: the runtime keeps a record whose range field is missing.
		assert.deepEqual(
			schema.properties.start_at,
			{ ...schema.properties.start_at, type: "string", format: "date-time" },
			`${stream}.start_at`,
		);
		assert.ok(schema.required.includes("id"), `${stream} requires id`);
		assert.ok(
			schema.required.includes("start_at"),
			`${stream} requires start_at`,
		);
	}
	// The runtime filters a grant on timeRangeField; nothing fails when it is not the consent field.
	for (const file of ["index.ts", "protocol-runtime-fixture.ts"])
		assert.equal(
			/timeRangeField: "([^"]*)"/u.exec(text(file))?.[1],
			"start_at",
			file,
		);
});

test("whoop_browser: every reason the connector can emit has its own copy, and no other reason does", () => {
	const source = text("index.ts");
	const table = /const SKIP_REASON\b[^=]*=\s*\{([^}]*)\}/u.exec(source)?.[1];
	assert.ok(table, "index.ts declares SKIP_REASON as an object literal");
	const reasons = [...table.matchAll(/^\s*(\w+):\s*"([^"]+)",?\s*$/gmu)].map(
		([, key, value]) => {
			assert.equal(value, key, "SKIP_REASON maps each reason to itself");
			return value as string;
		},
	);
	assert.deepEqual(reasons.toSorted(), [
		"collection_interrupted",
		"sign_in_required",
		"source_limit_reached",
		"source_unreadable",
	]);
	// SKIP_RESULT is emitted once, through the table, so the table is the whole vocabulary.
	assert.equal(source.match(/type: "SKIP_RESULT"/gu)?.length, 1);
	assert.match(source, /reason: SKIP_REASON\[reason\]/u);
	for (const [, literal] of source.matchAll(/\breason: "([^"]+)"/gu))
		assert.ok(
			reasons.includes(literal as string),
			`${literal} is in SKIP_REASON`,
		);

	const copy = manifest.reason_display_messages;
	assert.deepEqual(Object.keys(copy).toSorted(), reasons.toSorted());
	for (const reason of reasons) {
		const message = copy[reason];
		assert.equal(typeof message, "string", reason);
		assert.ok(message?.trim(), `${reason} has copy`);
		assert.notEqual(message?.trim(), reason, `${reason}: copy is not the key`);
	}
	// Declaring one of the reference implementation's reserved codes fails the fleet scan.
	const reserved = [
		"rate_limited",
		"upstream_pressure",
		"auth_failure",
		"gone",
		"not_found",
		"permanent_forbidden",
		"quarantined",
		"not_available_in_mode",
		"out_of_scope",
		"user_disabled",
		"retry_exhausted",
		"run_cap_deferred",
		"temporary_unavailable",
	];
	for (const reason of reasons) assert.ok(!reserved.includes(reason), reason);
});

test("whoop_browser: a manual, development-tier browser profile with no PageShim, mobile or credential surface", () => {
	// No `features`: declaring PageShim's would make this a PageShim target. No filesystem.
	assert.deepEqual(manifest.runtime_requirements.bindings, {
		network: { required: true },
		browser: { required: true },
	});
	assert.equal("mobile" in manifest, false);
	const { capabilities } = manifest;
	assert.deepEqual(capabilities.human_interaction, ["manual_action"]);
	assert.equal(capabilities.refresh_policy.recommended_mode, "manual");
	assert.equal(capabilities.refresh_policy.background_safe, false);
	assert.equal(
		capabilities.refresh_policy.interaction_posture,
		"manual_action_likely",
	);
	assert.equal(
		"assisted_after_owner_auth" in capabilities.refresh_policy,
		false,
	);
	assert.deepEqual(capabilities.public_listing, { tier: "development" });
	for (const key of ["auth", "setup", "credential_capture"]) {
		assert.equal(key in manifest, false, key);
		assert.equal(key in capabilities, false, `capabilities.${key}`);
	}
});

test("whoop_browser: its own source, named apart from WHOOP and from the upstream profile", () => {
	assert.equal(
		manifest.source.id,
		"https://registry.pdpp.dev/sources/whoop_browser",
	);
	assert.notEqual(manifest.source.display.name.trim(), "WHOOP");
	assert.notEqual(manifest.source.id, upstreamWhoop.source.id);
	assert.notEqual(
		manifest.source.display.name,
		upstreamWhoop.source.display.name,
	);
});
