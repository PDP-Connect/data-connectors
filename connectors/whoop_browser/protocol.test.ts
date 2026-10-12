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
import {
	consentTimeFieldResolver,
	type EmittedMessage,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
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
/** The cursor of an unbounded walk over the fixtures: from the account's start to now. */
const FULL_CURSOR = { v: 2, floor: HISTORY_START, through: NOW };
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

/** A STATE's cursor without its hint for the next run's walk, which the collector tests check. */
const withoutHint = (m: StateMessage): Record<string, unknown> => {
	const { under_way: _, ...cursor } = m.cursor as Record<string, unknown>;
	return cursor;
};

/** One STATE per stream named, in that order, each holding exactly this cursor. */
function assertCursors(
	run: ConnectorSubprocessResult,
	streams: readonly Stream[],
	cursor: Record<string, unknown>,
): void {
	const states = statesOf(run);
	assert.deepEqual(
		states.map((m) => m.stream),
		[...streams],
	);
	for (const m of states) assert.deepEqual(withoutHint(m), cursor, m.stream);
}

/** One STATE per stream named, in stream order, each holding that stream's own cursor. */
function assertEachCursor(
	run: ConnectorSubprocessResult,
	cursors: Partial<Record<Stream, Record<string, unknown>>>,
): void {
	const states = statesOf(run);
	assert.deepEqual(
		states.map((m) => m.stream),
		Object.keys(cursors),
	);
	for (const m of states) {
		assert.deepEqual(withoutHint(m), cursors[m.stream as Stream], m.stream);
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
	"whoop_browser: one STATE per stream, after that stream's last RECORD, from the account's start to now",
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
		// The spec's floor (account start less a day) and the walk's end (now), in every stream.
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
		// The runtime, from the manifest's consent_time_field, and the connector both hold each
		// record to its stream's grant at the instant. Recoveries and workouts carry no range, so
		// the walk is the unbounded one.
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
		// Each cursor covers only what its own grant delivered: cycles stop at until, and sleeps
		// start at their since.
		assertEachCursor(run, {
			cycles: { ...FULL_CURSOR, through: "2026-09-16T00:00:00.000Z" },
			recoveries: FULL_CURSOR,
			sleeps: cursorFrom("2026-09-15T00:00:00.000Z"),
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
	"whoop_browser: a seeded cursor resumes with its floor narrowed to the account's start, dropping fields it does not hold",
	SUBPROCESS,
	async () => {
		// A floor before the account's start is no reason to start afresh, so the run resumes these
		// cursors, each floor narrowed to the account's start. A field a cursor does not hold, an
		// instant or not, is dropped and does not make the cursor unreadable.
		const seeded = { v: 2, floor: "2026-01-01T00:00:00.000Z", through: NOW };
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
		assertCursors(run, STREAMS, FULL_CURSOR);
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
		// Both bounds hold the nap (2026-09-15T05:10Z) and the run (2026-09-14T22:00Z). Both sit in
		// the scored cycle, which began at 2026-09-14T12:40Z, before either bound: the walk reaches
		// two days before the earliest since to read it, and each stream's floor records its own since.
		const run = await start([
			{ name: "sleeps", time_range: { since: "2026-09-15T00:00:00.000Z" } },
			{ name: "workouts", time_range: { since: "2026-09-14T18:00:00.000Z" } },
		]);
		assertSucceeded(run);
		assert.deepEqual(idsIn(run, "sleeps"), [SLEEP.nap, SLEEP.open]);
		assert.deepEqual(idsIn(run, "workouts"), [RUN]);
		assert.deepEqual(noiseOf(run), []);
		assertEachCursor(run, {
			sleeps: cursorFrom("2026-09-15T00:00:00.000Z"),
			workouts: cursorFrom("2026-09-14T18:00:00.000Z"),
		});
	},
);

test(
	"whoop_browser: a since inside a day holds at its instant, not the day's start",
	SUBPROCESS,
	async () => {
		// Cycles carry no range, so the walk is unbounded and the nap (2026-09-15T05:10Z) is built.
		// It starts before since's instant but on since's day, so it is held out at the instant.
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
		// for the run inside it. The scored cycle, its recovery and its main sleep, all starting at
		// 12:40Z on since's day, are held out at the instant.
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
		assertCursors(run, STREAMS, cursorFrom(since));
	},
);

test(
	"whoop_browser: each stream is held to its own grant's since, inclusive, from one walk over the widest",
	SUBPROCESS,
	async () => {
		// One walk serves the earliest since; each stream then keeps what starts at or after its
		// own. Where a since falls later on a record's day, the record is held out at the instant.
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
		// Each floor is its own since, though the walk reached two days before the earliest.
		assertEachCursor(run, {
			cycles: cursorFrom("2026-09-15T18:00:00.000Z"),
			recoveries: cursorFrom("2026-08-01T00:00:00.000Z"),
			sleeps: cursorFrom("2026-09-14T18:00:00.000Z"),
			workouts: cursorFrom("2026-09-14T22:00:00.000Z"),
		});
	},
);

test(
	"whoop_browser: a grant that ends at the open cycle's start ends the walk, and the cursor, at until",
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
		assertCursors(run, STREAMS, { ...FULL_CURSOR, through: until });
	},
);

test(
	"whoop_browser: the shipped entry starts, and answers a date-only since with scope_not_supported",
	SUBPROCESS,
	async () => {
		// The runtime refuses a day-precision bound on an instant before it opens a browser, so this
		// runs index.ts itself, through every check runConnector makes before collecting.
		const run = await runConnectorProtocolSubprocess({
			cwd: PACKAGE_DIR,
			entrypoint: new URL("./index.ts", import.meta.url).pathname,
			start: {
				type: "START",
				scope: {
					streams: [{ name: "cycles", time_range: { since: "2026-09-01" } }],
				},
			},
			timeoutMs: 30_000,
		});
		assertSucceeded(run);
		assert.deepEqual(
			run.messages
				.filter(
					(m): m is Extract<EmittedMessage, { type: "SKIP_RESULT" }> =>
						m.type === "SKIP_RESULT",
				)
				.map((m) => [m.stream, m.reason]),
			[["cycles", "scope_not_supported"]],
		);
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
		// Never nullable: the runtime does not emit a record whose consent field is missing.
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
	// The runtime takes each stream's consent field from the manifest, through the generated
	// table, and refuses to start a shipped connector that also names a timeRangeField.
	const consentField = consentTimeFieldResolver("whoop_browser");
	for (const stream of STREAMS)
		assert.deepEqual(
			consentField(stream),
			{ field: "start_at", format: "date-time" },
			stream,
		);
	for (const file of ["index.ts", "protocol-runtime-fixture.ts"])
		assert.doesNotMatch(text(file), /timeRangeField/u, file);
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
