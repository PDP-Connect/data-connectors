// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Layers 4 and 5: the real connector runtime in a subprocess, fed the synthetic fixtures by
 * protocol-runtime-fixture.ts, and every record it ships checked against Zod and the manifest.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { EmittedMessage } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import {
	type ConnectorSubprocessResult,
	runConnectorProtocolSubprocess,
} from "../../packages/polyfill-connectors/src/test-harness.ts";
import { TIME_RANGE_FIELD } from "./index.ts";
import { STREAMS, type Stream, validateRecord } from "./schemas.ts";

type RecordMessage = Extract<EmittedMessage, { type: "RECORD" }>;
type StateMessage = Extract<EmittedMessage, { type: "STATE" }>;
type Scope = { name: string; time_range?: { since?: string; until?: string } };

const text = (name: string): string =>
	readFileSync(new URL(`./${name}`, import.meta.url), "utf8");

// ── The fixtures, as the runtime fixture serves them ───────────────────────
/** protocol-runtime-fixture.ts's clock; its source is checked against this below. */
const NOW = "2026-09-20T13:30:00.000Z";
/** The account's zone is Pacific/Auckland: at NOW the owner's day is the 21st, so a first run reads 24 June to 21 September. */
const FULL = { next_day: "2026-09-22", floor: "2026-06-24" };
const IDS: Record<Stream, string[]> = {
	daily_summaries: ["2026-09-16"],
	// Nights by the day the owner woke: the first began at 12:40Z on the 14th, the second at 11:55Z on the 15th.
	sleep: ["2026-09-15", "2026-09-16"],
	hrv: ["2026-09-14", "2026-09-15", "2026-09-16"],
	training_status: ["2026-09-16"],
	// The run at 06:30Z on the 14th, then the ride at 19:15Z on the 15th (the 16th locally).
	activities: ["41000101", "41000102"],
};
const RECORDS = Object.values(IDS).flat().length;

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
const full = (): Promise<ConnectorSubprocessResult> => {
	firstRun ??= start(everyStream());
	return firstRun;
};

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

/** One STATE per stream named, in that order, each holding its own cursor. */
function assertCursors(
	run: ConnectorSubprocessResult,
	cursors: Partial<Record<Stream, object>>,
): void {
	const states = statesOf(run);
	assert.deepEqual(
		states.map((m) => m.stream),
		Object.keys(cursors),
	);
	for (const m of states)
		assert.deepEqual(m.cursor, cursors[m.stream as Stream], m.stream);
}

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
test("garmin_browser: the runtime fixture's clock is the one these tests assume", () => {
	assert.match(
		text("protocol-runtime-fixture.ts"),
		new RegExp(`new Date\\("${NOW.replaceAll(".", "\\.")}"\\)`, "u"),
	);
});

test(
	"garmin_browser: every stream ships its fixture records, keyed by id, and DONE counts them",
	SUBPROCESS,
	async () => {
		const run = await full();
		assertSucceeded(run);
		const records = recordsOf(run);
		assert.deepEqual(new Set(records.map((m) => m.stream)), new Set(STREAMS));
		assert.equal(records.length, RECORDS);
		for (const stream of STREAMS)
			assert.deepEqual(idsIn(run, stream), IDS[stream], stream);
		for (const m of records) {
			assert.equal(m.key, m.data.id, `${m.stream}: key is data.id`);
			assert.equal(typeof m.data.id, "string");
			assert.equal(m.op, undefined, "no tombstones");
		}
	},
);

test(
	"garmin_browser: a clean run reports nothing unreadable and skips nothing",
	SUBPROCESS,
	async () => {
		assert.deepEqual(noiseOf(await full()), []);
	},
);

test(
	"garmin_browser: one STATE per stream, after that stream's last RECORD, from ninety days back to the owner's today",
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
		assertCursors(
			run,
			Object.fromEntries(STREAMS.map((stream) => [stream, FULL])),
		);
	},
);

test(
	"garmin_browser: a START scoped to sleep and hrv emits only those two",
	SUBPROCESS,
	async () => {
		const run = await start([{ name: "sleep" }, { name: "hrv" }]);
		assertSucceeded(run);
		assert.deepEqual(countsOf(run), { sleep: 2, hrv: 3 });
		assertCursors(run, { sleep: FULL, hrv: FULL });
		for (const m of run.messages) {
			const stream = streamOf(m);
			if (stream !== undefined)
				assert.ok(
					stream === "sleep" || stream === "hrv",
					`${m.type} for ${stream}`,
				);
		}
	},
);

test(
	"garmin_browser: a START time_range holds each stream to its own grant: by day for daily streams, to the instant for sleep and activities",
	SUBPROCESS,
	async () => {
		// The runtime drops a record when its field is before since's day or on or after until's day.
		// The run (06:30Z on the 14th) is on since's day for activities, so the runtime would keep it:
		// the connector drops it, starting before since's instant. The first night began at 12:40Z on
		// the 14th, before sleep's since. The daily summary of the 16th falls on until's day.
		const run = await start([
			{
				name: "daily_summaries",
				time_range: { until: "2026-09-16T00:00:00.000Z" },
			},
			{ name: "sleep", time_range: { since: "2026-09-15T00:00:00.000Z" } },
			{ name: "hrv", time_range: { since: "2026-09-15T00:00:00.000Z" } },
			{ name: "training_status" },
			{ name: "activities", time_range: { since: "2026-09-14T12:00:00.000Z" } },
		]);
		assertSucceeded(run);
		assert.deepEqual(idsIn(run, "daily_summaries"), []);
		assert.deepEqual(idsIn(run, "sleep"), ["2026-09-16"]);
		assert.deepEqual(idsIn(run, "hrv"), ["2026-09-15", "2026-09-16"]);
		assert.deepEqual(idsIn(run, "training_status"), IDS.training_status);
		assert.deepEqual(idsIn(run, "activities"), ["41000102"]);
		// A record outside its grant is dropped, not counted unreadable.
		assert.deepEqual(noiseOf(run), []);
		// Each cursor covers only what its grant let it read; sleep and activities read a day early.
		assertCursors(run, {
			daily_summaries: { next_day: "2026-09-16", floor: "2026-06-24" },
			sleep: { next_day: "2026-09-22", floor: "2026-09-14" },
			hrv: { next_day: "2026-09-22", floor: "2026-09-15" },
			training_status: FULL,
			activities: { next_day: "2026-09-22", floor: "2026-09-13" },
		});
	},
);

test(
	"garmin_browser: a run seeded with the first run's STATE succeeds, re-reads a week of each daily stream and each range stream from four weeks before the last run's day, and keeps the cursor",
	SUBPROCESS,
	async () => {
		const first = await full();
		const state = Object.fromEntries(
			statesOf(first).map((m) => [m.stream, m.cursor]),
		);
		assert.deepEqual(Object.keys(state), [...STREAMS]);
		const run = await start(everyStream(), { state });
		assertSucceeded(run);
		// The daily streams re-read from the 15th, the range streams from 24 August: between them they
		// hold every fixture record again.
		assert.deepEqual(countsOf(run), {
			daily_summaries: 1,
			sleep: 2,
			hrv: 3,
			training_status: 1,
			activities: 2,
		});
		assertCursors(
			run,
			Object.fromEntries(STREAMS.map((stream) => [stream, FULL])),
		);
	},
);

test(
	"garmin_browser: days kept to read again survive the runtime: the next run reads them in its overlap or after it, ships what they hold, and keeps what it could not read or did not reach",
	SUBPROCESS,
	async () => {
		// The 14th lies inside the four weeks hrv and activities re-read: the overlap reads it once and
		// lets it go. August lies outside hrv's grant, so it is kept unread. daily_summaries reads its
		// kept days after its week, empty and so clean, from where the saved run stopped until the
		// run's ninety days are spent, and saves where it stopped.
		const run = await start(
			[
				{ name: "daily_summaries" },
				{ name: "hrv", time_range: { since: "2026-09-01T00:00:00.000Z" } },
				{ name: "activities" },
			],
			{
				state: {
					daily_summaries: {
						...FULL,
						retry: [{ from: "2026-01-01", to: "2026-06-01" }],
						retry_next: "2026-03-01",
					},
					hrv: {
						...FULL,
						retry: [
							{ from: "2026-08-01", to: "2026-08-01" },
							{ from: "2026-09-14", to: "2026-09-14" },
						],
					},
					activities: {
						...FULL,
						retry: [{ from: "2026-09-14", to: "2026-09-14" }],
					},
				},
			},
		);
		assertSucceeded(run);
		assert.deepEqual(idsIn(run, "hrv"), IDS.hrv);
		assert.deepEqual(idsIn(run, "activities"), ["41000102", "41000101"]);
		assert.deepEqual(noiseOf(run), []);
		assertCursors(run, {
			// After the overlap week, 83 kept days: 1 March to 22 May, each read cleanly and let go.
			daily_summaries: {
				...FULL,
				retry: [
					{ from: "2026-01-01", to: "2026-02-28" },
					{ from: "2026-05-23", to: "2026-06-01" },
				],
				retry_next: "2026-05-23",
			},
			hrv: { ...FULL, retry: [{ from: "2026-08-01", to: "2026-08-01" }] },
			activities: FULL,
		});
	},
);

test(
	"garmin_browser: a run seeded with unreadable state starts afresh instead of failing",
	SUBPROCESS,
	async () => {
		const run = await start(everyStream(), {
			state: {
				daily_summaries: "2026-09-01",
				sleep: { next_day: "soon", floor: "2026-06-24" },
				hrv: { next_day: "2026-06-24", floor: "2026-09-22" },
				training_status: null,
				activities: { floor: "2026-06-24" },
			},
		});
		assertSucceeded(run);
		assert.deepEqual(
			countsOf(run),
			Object.fromEntries(STREAMS.map((stream) => [stream, IDS[stream].length])),
		);
		assertCursors(
			run,
			Object.fromEntries(STREAMS.map((stream) => [stream, FULL])),
		);
	},
);

// ── Layer 5: manifest agreement ────────────────────────────────────────────
interface Property {
	type?: string | string[];
	format?: string;
	x_pdpp_role?: string;
}
interface ManifestStream {
	name: string;
	required: boolean;
	primary_key: string[];
	cursor_field: string;
	consent_time_field: string;
	schema: { properties: Record<string, Property>; required: string[] };
}
interface Manifest {
	source: { id: string; display: { name: string } };
	display_name: string;
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
const spec = (stream: string): ManifestStream => {
	const found = manifest.streams.find(({ name }) => name === stream);
	assert.ok(found, `${stream} in the manifest`);
	return found;
};

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats.default(ajv);

test(
	"garmin_browser: every shipped record passes Zod cleanly and the manifest's JSON Schema, with exactly its keys",
	SUBPROCESS,
	async () => {
		const run = await full();
		const checks = new Map(
			STREAMS.map((stream) => [stream, ajv.compile(spec(stream).schema)]),
		);
		const records = recordsOf(run);
		assert.equal(records.length, RECORDS);
		for (const { stream, data } of records) {
			const zod = validateRecord(stream, data);
			assert.equal(zod.ok, true, `${stream} ${String(data.id)}: Zod`);
			if (zod.ok)
				assert.deepEqual(zod.anomalies ?? [], [], `${stream}: anomalies`);
			const check = checks.get(stream as Stream);
			assert.ok(check, `${stream} has a manifest schema`);
			assert.equal(
				check(data),
				true,
				`${stream} ${String(data.id)}: ${ajv.errorsText(check.errors)}`,
			);
			assert.deepEqual(
				Object.keys(data).toSorted(),
				Object.keys(spec(stream).schema.properties).toSorted(),
				`${stream}: keys`,
			);
		}
	},
);

test("garmin_browser: every stream keys on id; sleep and activities consent and cursor on start_at, an instant, the rest on date", () => {
	assert.deepEqual(
		manifest.streams.map(({ name }) => name),
		[...STREAMS],
	);
	for (const stream of STREAMS) {
		const { primary_key, cursor_field, consent_time_field, schema, required } =
			spec(stream);
		const field = TIME_RANGE_FIELD[stream];
		assert.deepEqual(primary_key, ["id"], stream);
		assert.equal(cursor_field, field, stream);
		assert.equal(consent_time_field, field, stream);
		assert.equal(
			required,
			false,
			`${stream}: not required, so no coverage-ratchet row`,
		);
		assert.equal(schema.properties.id?.type, "string", `${stream}.id`);
		// Never nullable: the runtime keeps a record whose range field is missing.
		assert.deepEqual(
			schema.properties[field],
			{
				...schema.properties[field],
				type: "string",
				format: field === "date" ? "date" : "date-time",
			},
			`${stream}.${field}`,
		);
		assert.equal(
			schema.properties[field]?.x_pdpp_role,
			"event-time",
			`${stream}.${field}`,
		);
		assert.ok(schema.required.includes(field), `${stream} requires ${field}`);
	}
	assert.deepEqual(TIME_RANGE_FIELD, {
		daily_summaries: "date",
		sleep: "start_at",
		hrv: "date",
		training_status: "date",
		activities: "start_at",
	});
	// The runtime filters a grant on timeRangeField; nothing fails when it is not the consent field.
	for (const file of ["index.ts", "protocol-runtime-fixture.ts"]) {
		assert.match(text(file), /timeRangeField: timeRangeFieldFor,/u, file);
	}
});

test("garmin_browser: every reason the connector can emit has its own copy, and no other reason does", () => {
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
	assert.match(source, /recovery_hint: hintFor\(reason\)/u);
	assert.match(
		source,
		/^function hintFor\(/mu,
		"a function declaration, so the hint scan reads it",
	);
	for (const [, literal] of source.matchAll(/\breason: "([^"]+)"/gu)) {
		assert.ok(
			reasons.includes(literal as string),
			`${literal} is in SKIP_REASON`,
		);
	}
	const copy = manifest.reason_display_messages;
	assert.deepEqual(Object.keys(copy).toSorted(), reasons.toSorted());
	for (const reason of reasons) {
		const message = copy[reason];
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

test("garmin_browser: a manual, development-tier browser profile with no PageShim, mobile, brand or credential surface", () => {
	// No `features`: declaring PageShim's would make this a PageShim target. No filesystem.
	assert.deepEqual(manifest.runtime_requirements.bindings, {
		network: { required: true },
		browser: { required: true },
	});
	assert.equal("mobile" in manifest, false);
	assert.equal("brand" in manifest, false);
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
	// The connector's code reads no secret from the environment and imports no browser value.
	const source = text("index.ts");
	const code = source
		.replace(/\/\*[\s\S]*?\*\//gu, "")
		.replace(/(^|[^:])\/\/.*$/gmu, "$1");
	assert.doesNotMatch(code, /process\.env/u);
	assert.doesNotMatch(
		code,
		/context\.request|\.url\(\)|newPage|method:|epoch\/request/u,
	);
	for (const line of source
		.split("\n")
		.filter((l) => /from "(patchright|playwright)"/u.test(l))) {
		assert.match(line, /^import type /u, line);
	}
});

test("garmin_browser: its own source, named apart from every other profile's", () => {
	assert.deepEqual(manifest.source, {
		id: "https://registry.pdpp.dev/sources/garmin_browser",
		display: { name: "Garmin (Browser Sign-In)" },
	});
	assert.equal(manifest.display_name, "Garmin (Browser Sign-In)");
	const connectors = new URL("../", import.meta.url);
	for (const dir of readdirSync(connectors, { withFileTypes: true })) {
		if (!dir.isDirectory() || dir.name === "garmin_browser") continue;
		let other: { source?: { id?: string } };
		try {
			other = JSON.parse(
				readFileSync(new URL(`${dir.name}/manifest.json`, connectors), "utf8"),
			) as typeof other;
		} catch {
			continue;
		}
		assert.notEqual(other.source?.id, manifest.source.id, dir.name);
	}
});
