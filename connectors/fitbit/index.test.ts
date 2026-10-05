// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end tests for the Fitbit connector, driven through the real
 * connector protocol as a subprocess, so what is asserted is what a reader
 * receives.
 *
 * Every run is also checked for what must hold whatever the export:
 *   - the run succeeds, and no STATE is ever emitted;
 *   - each requested data stream ends with exactly one coverage line, and an
 *     unrequested one with none, in a shape that holds only fixed tokens,
 *     the stream's own field names, counts and dates;
 *   - each coverage line's delivered count, and its PROGRESS count, equal
 *     its stream's records on the wire, which checks the tally against what
 *     the runtime actually kept;
 *   - no coverage line names a field both unavailable (never carried) and
 *     unreadable (a value that may be there could not be read);
 *   - every SKIP_RESULT reason is one of the connector's own, so the
 *     runtime's shape check (whose SKIP carries the whole record) never ran,
 *     and carries that reason's recovery hint;
 *   - neither stdout nor stderr carries a canary, the import path, a member
 *     or upload name, or the scratch folder;
 *   - a run with no window and no resource filter counts nothing as outside
 *     the window.
 *
 * Every export here is synthetic (__fixtures__/synthetic-export.ts). Expected
 * values are written out by hand, never derived from the fixtures.
 */

import assert from "node:assert/strict";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { isDeepStrictEqual } from "node:util";
import { assertUserFacingProgress } from "../../packages/polyfill-connectors/src/connector-diagnostic.ts";
import {
	connectorEntrypoint,
	packageRoot as PACKAGE_ROOT,
} from "../../packages/polyfill-connectors/src/connector-paths.ts";
import { runConnectorProtocolSubprocess } from "../../packages/polyfill-connectors/src/test-harness.ts";
import {
	CANARIES,
	canonicalMembers,
	canonicalParts,
	canonicalRows,
	dailyRow,
	EXPORTED_AT,
	exercise,
	fitbitJson,
	type JsonObject,
	jsonMember,
	legacyMember,
	minute,
	neverReadMembers,
	PROFILE_HEADER,
	PROFILE_ROW,
	partName,
	profileCsv,
	profileMember,
	ROOT,
	restingRow,
	SCORE_HEADER,
	SCORE_ROWS,
	scoreCsv,
	sleepScoreMember,
	truncatedCsv,
	truncatedJson,
	UNJOINED_SCORE_ROW,
	without,
	writeParts,
} from "./__fixtures__/synthetic-export.ts";
import {
	PAST_ZIP64_SWITCH_GAP_BYTES,
	writeGzipLookalike,
	writeSparseOversize,
	writeZip,
	writeZip64LocatorZip,
	writeZip64SentinelZip,
	type ZipMember,
	zipBytes,
} from "./__fixtures__/zip.ts";
import {
	activitiesSchema,
	DATA_STREAMS,
	dailySummariesSchema,
	sleepSchema,
} from "./schemas.ts";

type Message = Record<string, unknown>;
interface TimeRange {
	readonly since?: string;
	readonly until?: string;
}

const ENTRYPOINT = connectorEntrypoint("fitbit");
const TEMP = mkdtempSync(join(tmpdir(), "pdpp-fitbit-index-test-"));
const LARGE_FIXTURE_BASE_DIR =
	process.env.PDPP_TEST_LARGE_FIXTURE_DIR ?? join(homedir(), ".tmp");
const MIB = 1024 * 1024;
const CENTRAL_HEADER_SIGNATURE = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
const IS_ROOT = process.getuid?.() === 0;
const SNAPSHOT = { freshness: "snapshot", exported_at: EXPORTED_AT } as const;
/** An earlier Takeout export's stamp, beside the canonical one. */
const OLDER_STAMP = "20260801T000000Z";

/** The owner can act, with a different or a fresh export. */
const OWNER_HINT = { action: "manual_action_required", retryable: false };
/** Only a new version of this import can help. */
const UPGRADE_HINT = { action: "retry_on_connector_upgrade", retryable: false };

/**
 * The reasons the connector itself puts on a SKIP_RESULT, each with the
 * recovery hints it may carry: only the owner can act on an upload that is
 * missing, unreadable or cut short; the device's failure may pass on a later
 * run; and entries that could not be read never will be. A source too large
 * and a changed layout carry one of two, by cause (#37).
 */
const RECOVERY_HINTS: ReadonlyMap<string, readonly Message[]> = new Map([
	["awaiting_upload", [OWNER_HINT]],
	["source_unreadable", [OWNER_HINT]],
	["source_limit_reached", [OWNER_HINT, UPGRADE_HINT]],
	[
		"device_storage_unavailable",
		[{ action: "retry_by_runtime", retryable: true }],
	],
	["collection_interrupted", [OWNER_HINT]],
	["export_format_changed", [OWNER_HINT, UPGRADE_HINT]],
	["records_unreadable", [{ action: "not_retriable", retryable: false }]],
]);
const SKIP_REASONS: ReadonlySet<string> = new Set(RECOVERY_HINTS.keys());

/** Every reason a coverage line may state: the skip reasons, and the three outcomes that skip nothing. */
const COVERAGE_REASONS: ReadonlySet<string> = new Set([
	...RECOVERY_HINTS.keys(),
	"values_unreadable",
	"covered_in_full",
	"nothing_in_range",
]);

const DAY = String.raw`\d{4}-\d{2}-\d{2}`;
const FIELD_LIST = "none|[a-z_]+(?:,[a-z_]+)*";
/** A coverage line's whole shape: fixed tokens, field names, counts and dates, and nothing else. */
const COVERAGE_LINE_RE = new RegExp(
	`^${[
		"coverage stream=(?<stream>activities|daily_summaries|sleep)",
		"status=(?<status>complete|partial|empty)",
		"reason=(?<reason>[a-z_]+)",
		String.raw`delivered=(?<delivered>\d+)`,
		`fields_unavailable=(?<unavailable>${FIELD_LIST})`,
		`fields_unreadable=(?<unreadable>${FIELD_LIST})`,
		`window_requested_from=(?<requestedFrom>none|unparsed|${DAY})`,
		`window_requested_to=(?<requestedTo>none|unparsed|${DAY})`,
		`window_covered_from=(?<coveredFrom>none|${DAY})`,
		`window_covered_to=(?<coveredTo>none|${DAY})`,
	].join(" ")}$`,
);

/** Text only a member name, the upload's name or a scratch path would put on the wire. */
const PATH_LIKE_RE =
	/\.(?:json|zip|csv)\b|Global Export Data|Sleep Score\/|Your Profile|takeout-\d{8}|pdpp-fitbit-|member-\d/i;

const SCHEMA_KEYS: Readonly<Record<string, readonly string[]>> = {
	activities: Object.keys(activitiesSchema.shape),
	daily_summaries: Object.keys(dailySummariesSchema.shape),
	sleep: Object.keys(sleepSchema.shape),
};

/** Code-unit order, the same on every machine. */
function byText(a: string, b: string): number {
	if (a < b) {
		return -1;
	}
	return a > b ? 1 : 0;
}

// ─── Expected records, by hand ───────────────────────────────────────────

type DayValues = readonly [
	date: string,
	steps: number | null,
	distance_m: number | null,
	lightly: number | null,
	moderately: number | null,
	very: number | null,
	resting_heart_rate_bpm: number | null,
];

function dailyRecords(
	days: readonly DayValues[],
	exportedAt: string = EXPORTED_AT,
): Message[] {
	return days.map(
		([date, steps, distance, lightly, moderately, very, restingHeartRate]) => ({
			id: date,
			date,
			steps,
			distance_m: distance,
			lightly_active_minutes: lightly,
			moderately_active_minutes: moderately,
			very_active_minutes: very,
			resting_heart_rate_bpm: restingHeartRate,
			freshness: "snapshot",
			exported_at: exportedAt,
		}),
	);
}

/**
 * The canonical daily values. Steps and distance are UTC minutes placed on
 * Sydney days across the end of daylight time (5 April has 25 hours):
 * UTC days would give 107 and 140 for the 3rd and 4th, a fixed +11:00 would
 * give 90 and 65 for the 5th and 6th, no dedupe 125 for the 5th,
 * centimetres ÷ 1000 would give 8 m, and the nested copy under `archive/`
 * would add 99999 to the 4th.
 */
const CANONICAL_DAYS: readonly DayValues[] = [
	["2026-04-03", 7, null, 0, 0, 0, null],
	["2026-04-04", 150, 80, 45, 10, 22, 58.432_109_87],
	["2026-04-05", 95, 30.5, 30, 0, 0, 57.9],
	["2026-04-06", 60, 45, 20, 5, 0, null],
];

/** The canonical days with `steps` replaced, day by day. */
function withSteps(steps: readonly (number | null)[]): DayValues[] {
	return CANONICAL_DAYS.map(([date, , ...rest], index) => [
		date,
		steps[index] ?? null,
		...rest,
	]);
}

function activity(
	id: string,
	type: string | null,
	start: string,
	distance: number | null,
	elapsed: number,
): Message {
	return {
		id,
		activity_type: type,
		start_date: start.slice(0, 10),
		start_time: start,
		start_time_basis: "utc",
		distance_m: distance,
		elapsed_time_s: elapsed,
		...SNAPSHOT,
	};
}

function sleepRecord(
	id: string,
	date: string,
	main: boolean,
	score: number | null,
	durations: readonly [
		asleep: number,
		awake: number,
		deep: number | null,
		light: number | null,
		rem: number | null,
	],
): Message {
	const [asleep, awake, deep, light, rem] = durations;
	return {
		id,
		date,
		is_main_sleep: main,
		sleep_score: score,
		asleep_duration_s: asleep,
		awake_duration_s: awake,
		deep_sleep_duration_s: deep,
		light_sleep_duration_s: light,
		rem_sleep_duration_s: rem,
		...SNAPSHOT,
	};
}

const CANONICAL_RECORDS: Readonly<Record<string, readonly Message[]>> = {
	activities: [
		activity("21000000001", "run", "2026-03-13T23:00:00Z", 5200, 1805),
		activity(
			"21000000002",
			"outdoor_bike",
			"2026-03-15T06:10:00Z",
			24_140.16,
			3720,
		),
		activity("21000000003", "weights", "2026-03-16T08:00:00Z", null, 2400),
		activity("21000000004", null, "2026-03-17T21:30:00Z", 3000, 1500),
	],
	daily_summaries: dailyRecords(CANONICAL_DAYS),
	sleep: [
		sleepRecord(
			"31000000001",
			"2026-03-14",
			true,
			81,
			[24_120, 3720, 5220, 14_160, 4740],
		),
		sleepRecord("31000000002", "2026-03-14", false, null, [
			2280,
			60,
			null,
			null,
			null,
		]),
		sleepRecord(
			"31000000003",
			"2026-03-15",
			true,
			77,
			[22_260, 2880, 4200, 13_500, 4560],
		),
	],
};

/** The canonical sleep records with no score joined to any of them. */
const SLEEP_WITHOUT_SCORES: readonly Message[] = (
	CANONICAL_RECORDS.sleep ?? []
).map((r) => ({ ...r, sleep_score: null }));

/** The canonical export's coverage lines, in full. */
const CANONICAL_COVERAGE: Readonly<Record<string, string>> = {
	activities:
		"coverage stream=activities status=complete reason=covered_in_full delivered=4 fields_unavailable=none fields_unreadable=none window_requested_from=none window_requested_to=none window_covered_from=2026-03-13 window_covered_to=2026-03-17",
	daily_summaries:
		"coverage stream=daily_summaries status=complete reason=covered_in_full delivered=4 fields_unavailable=none fields_unreadable=none window_requested_from=none window_requested_to=none window_covered_from=2026-04-03 window_covered_to=2026-04-06",
	sleep:
		"coverage stream=sleep status=complete reason=covered_in_full delivered=3 fields_unavailable=none fields_unreadable=none window_requested_from=none window_requested_to=none window_covered_from=2026-03-14 window_covered_to=2026-03-15",
};

after(() => {
	rmSync(TEMP, { force: true, recursive: true });
});

// ─── Fixtures on disk ────────────────────────────────────────────────────

let folders = 0;

/** A fresh, empty import folder. */
function importFolder(): string {
	folders += 1;
	const dir = join(TEMP, `import-${String(folders)}`);
	mkdirSync(dir);
	return dir;
}

/** An import folder holding one Takeout part with `members`. */
function uploaded(
	members: readonly ZipMember[] = canonicalMembers(),
	name = partName(1),
): string {
	const dir = importFolder();
	writeZip(join(dir, name), members);
	return dir;
}

/** A fresh folder under the large-fixture directory, for sparse archives. */
function largeFolder(label: string): string {
	mkdirSync(LARGE_FIXTURE_BASE_DIR, { recursive: true });
	return mkdtempSync(join(LARGE_FIXTURE_BASE_DIR, `pdpp-fitbit-${label}-`));
}

function setMtime(path: string, when: Date): void {
	utimesSync(path, when, when);
}

// ─── Running the connector ───────────────────────────────────────────────

interface RunOptions {
	readonly streams?: readonly string[];
	/** Per stream, by name. */
	readonly timeRanges?: Readonly<Record<string, TimeRange>>;
	readonly resources?: Readonly<Record<string, readonly string[]>>;
	readonly fullRefresh?: boolean;
	readonly env?: Readonly<Record<string, string>>;
}

/** A `coverage` diagnostic, read back as `coverage key=value ...`. `none` reads as null or []. */
interface CoverageLine {
	readonly text: string;
	readonly count: unknown;
	readonly stream: string;
	readonly status: string;
	readonly reason: string;
	readonly delivered: number;
	readonly fields_unavailable: readonly string[];
	readonly fields_unreadable: readonly string[];
	readonly window_requested_from: string | null;
	readonly window_requested_to: string | null;
	readonly window_covered_from: string | null;
	readonly window_covered_to: string | null;
}

function parseCoverage(line: Message, count: unknown): CoverageLine {
	const text = `coverage ${Object.entries(line)
		.map(([name, value]) => `${name}=${String(value)}`)
		.join(" ")}`;
	const groups = COVERAGE_LINE_RE.exec(text)?.groups;
	assert.ok(groups, `a coverage line in the expected shape: ${text}`);
	const list = (value = ""): string[] =>
		value === "none" ? [] : value.split(",");
	const date = (value = ""): string | null => (value === "none" ? null : value);
	return {
		text,
		count,
		stream: groups.stream ?? "",
		status: groups.status ?? "",
		reason: groups.reason ?? "",
		delivered: Number(groups.delivered),
		fields_unavailable: list(groups.unavailable),
		fields_unreadable: list(groups.unreadable),
		window_requested_from: date(groups.requestedFrom),
		window_requested_to: date(groups.requestedTo),
		window_covered_from: date(groups.coveredFrom),
		window_covered_to: date(groups.coveredTo),
	};
}

/** What one run put on the wire. */
class Outcome {
	readonly messages: readonly Message[];
	readonly rawStdout: string;
	readonly stderr: string;

	constructor(messages: readonly Message[], rawStdout: string, stderr: string) {
		this.messages = messages;
		this.rawStdout = rawStdout;
		this.stderr = stderr;
	}

	ofType(type: string, stream?: string): Message[] {
		return this.messages.filter(
			(m) => m.type === type && (stream === undefined || m.stream === stream),
		);
	}

	records(stream: string): Message[] {
		return this.ofType("RECORD", stream).map((m) => m.data as Message);
	}

	/** Every `[fitbit-diagnostic] <event>` line's fields, in order. */
	diagnostics(event: string): Message[] {
		const head = `[fitbit-diagnostic] ${event} `;
		return this.stderr
			.split("\n")
			.filter((line) => line.startsWith(head))
			.map((line) => JSON.parse(line.slice(head.length)) as Message);
	}

	/**
	 * Every `coverage` diagnostic, parsed, whatever its stream, with the
	 * `count` of the stream's one PROGRESS line that carries a count.
	 */
	coverageLines(): CoverageLine[] {
		return this.diagnostics("coverage").map((line) => {
			const counted = this.ofType("PROGRESS", String(line.stream)).filter(
				(m) => m.count !== undefined,
			);
			assert.equal(
				counted.length,
				1,
				`one counted PROGRESS for ${line.stream}`,
			);
			return parseCoverage(line, counted[0]?.count);
		});
	}

	/** The stream's one coverage line. */
	coverage(stream: string): CoverageLine {
		const found = this.coverageLines().filter((line) => line.stream === stream);
		assert.equal(found.length, 1, `exactly one coverage line for ${stream}`);
		return found[0] as CoverageLine;
	}

	skips(stream: string): Message[] {
		return this.ofType("SKIP_RESULT", stream);
	}

	skipReasons(stream: string): unknown[] {
		return this.skips(stream).map((m) => m.reason);
	}

	/** The one SKIP_RESULT's diagnostics for `stream`. */
	skipDiagnostics(stream: string): Message {
		const skips = this.skips(stream);
		assert.equal(skips.length, 1, `exactly one SKIP_RESULT for ${stream}`);
		return skips[0]?.diagnostics as Message;
	}

	/** The counters of the stream's `done` diagnostic. */
	progressDone(stream: string): Readonly<Record<string, number>> {
		return this.counters("done", { stream });
	}

	/** The counters of one family's `family` diagnostic. */
	progressFamily(
		stream: string,
		family: string,
	): Readonly<Record<string, number>> {
		return this.counters("family", { stream, family });
	}

	/** Every RECORD's stream and data, without `emitted_at`, and every coverage line with its count. */
	outputSet(): string[] {
		return [
			...this.ofType("RECORD").map((m) =>
				JSON.stringify({ stream: m.stream, data: m.data }),
			),
			...this.coverageLines().map((line) =>
				JSON.stringify({ coverage: line.text, count: line.count }),
			),
		].sort(byText);
	}

	private counters(
		event: string,
		keys: Readonly<Record<string, string>>,
	): Readonly<Record<string, number>> {
		const lines = this.diagnostics(event).filter((line) =>
			Object.entries(keys).every(([name, value]) => line[name] === value),
		);
		assert.equal(
			lines.length,
			1,
			`exactly one ${event} diagnostic for ${JSON.stringify(keys)}`,
		);
		const counters: Record<string, number> = {};
		for (const [name, value] of Object.entries(lines[0] ?? {})) {
			if (!(name in keys)) {
				counters[name] = Number(value);
			}
		}
		return counters;
	}
}

async function run(
	importPath: string,
	options: RunOptions = {},
): Promise<Outcome> {
	const streams = options.streams ?? DATA_STREAMS;
	const result = await runConnectorProtocolSubprocess({
		cwd: PACKAGE_ROOT,
		entrypoint: ENTRYPOINT,
		env: {
			PDPP_OWNER_TOKEN: "",
			PDPP_RS_URL: "",
			RS_URL: "",
			FITBIT_EXPORT_DIR: importPath,
			TZ: "UTC",
			...options.env,
		},
		start: {
			type: "START",
			...(options.fullRefresh ? { collection_mode: "full_refresh" } : {}),
			scope: {
				streams: streams.map((name) => {
					const timeRange = options.timeRanges?.[name];
					const resources = options.resources?.[name];
					return {
						name,
						...(timeRange ? { time_range: timeRange } : {}),
						...(resources ? { resources: [...resources] } : {}),
					};
				}),
			},
		},
		timeoutMs: 60_000,
	});
	const outcome = new Outcome(
		result.messages as unknown as Message[],
		result.rawStdout,
		result.stderr,
	);
	checkInvariants(outcome, importPath, options);
	return outcome;
}

function checkInvariants(
	outcome: Outcome,
	importPath: string,
	options: RunOptions,
): void {
	const done = outcome.messages.at(-1);
	assert.equal(done?.type, "DONE");
	assert.equal(done?.status, "succeeded");
	assert.deepEqual(outcome.ofType("STATE"), [], "no STATE, ever");
	assertUserFacingProgress(outcome.messages);
	const requested = options.streams ?? DATA_STREAMS;
	const lines = outcome.coverageLines();
	for (const stream of DATA_STREAMS) {
		assert.equal(
			lines.filter((line) => line.stream === stream).length,
			requested.includes(stream) ? 1 : 0,
			`${stream}: one coverage line when requested, none otherwise`,
		);
	}
	for (const line of lines) {
		const { stream } = line;
		const onWire = outcome.records(stream).length;
		assert.equal(
			line.delivered,
			onWire,
			`${stream}: the coverage line counts what reached the wire`,
		);
		assert.equal(line.count, onWire, `${stream}: count is what was delivered`);
		assert.deepEqual(
			line.fields_unavailable.filter((field) =>
				line.fields_unreadable.includes(field),
			),
			[],
			`${stream}: no field is both unavailable and unreadable`,
		);
		for (const field of [
			...line.fields_unavailable,
			...line.fields_unreadable,
		]) {
			assert.ok(
				SCHEMA_KEYS[stream]?.includes(field),
				`${stream}: ${field} is not one of its fields`,
			);
		}
		assert.ok(COVERAGE_REASONS.has(line.reason), `${stream}: ${line.reason}`);
	}
	for (const skip of outcome.ofType("SKIP_RESULT")) {
		const reason = String(skip.reason);
		assert.ok(
			RECOVERY_HINTS.has(reason),
			`SKIP_RESULT reason ${reason} is not the connector's own`,
		);
		assert.ok(
			expectedHints(skip).some((hint) =>
				isDeepStrictEqual(hint, skip.recovery_hint),
			),
			`${reason}: its recovery hint, not ${JSON.stringify(skip.recovery_hint)}`,
		);
	}
	for (const [channel, text] of [
		["stdout", outcome.rawStdout],
		["stderr", outcome.stderr],
	] as const) {
		for (const canary of CANARIES) {
			assert.ok(!text.includes(canary), `${channel} carries canary ${canary}`);
		}
		assert.ok(!text.includes(importPath), `${channel} carries the import path`);
		assert.doesNotMatch(text, PATH_LIKE_RE, `${channel} carries a name`);
	}
	if (options.timeRanges === undefined && options.resources === undefined) {
		for (const stream of DATA_STREAMS) {
			// Only a stream that was read has counters; a failed upload is not read.
			const read = outcome
				.diagnostics("read")
				.some((line) => line.stream === stream);
			if (read) {
				assert.equal(
					outcome.progressDone(stream).outside_window,
					0,
					`${stream}: nothing is outside an unwindowed run`,
				);
			}
		}
	}
}

/**
 * The hint a SKIP_RESULT must carry. A reason with two hints is the owner's
 * when the upload was refused before any stream was read (its diagnostics
 * name a `failure`) or when the stream is missing a file it needs
 * (`file_missing`), and otherwise needs a new version of this import. #37
 * pins each cause by hand, so this cannot agree with a wrong `file_missing`.
 */
function expectedHints(skip: Message): readonly Message[] {
	const hints = RECOVERY_HINTS.get(String(skip.reason)) ?? [];
	if (hints.length === 1) {
		return hints;
	}
	const diagnostics = skip.diagnostics as Message;
	return Object.hasOwn(diagnostics, "failure") || diagnostics.file_missing === 1
		? [OWNER_HINT]
		: [UPGRADE_HINT];
}

/** Every requested data stream ended with `reason`: a SKIP_RESULT, and a coverage line of nothing covered. */
function assertAllFailed(
	outcome: Outcome,
	reason: string,
	diagnostics?: Message,
): void {
	for (const stream of DATA_STREAMS) {
		assert.deepEqual(outcome.skipReasons(stream), [reason], stream);
		assert.deepEqual(outcome.records(stream), [], stream);
		const coverage = outcome.coverage(stream);
		assert.equal(coverage.reason, reason, stream);
		assert.equal(coverage.status, "empty", stream);
		assert.equal(coverage.delivered, 0, stream);
		assert.deepEqual(coverage.fields_unavailable, [], stream);
		assert.deepEqual(coverage.fields_unreadable, [], stream);
		assert.equal(coverage.window_covered_from, null, stream);
		assert.equal(coverage.window_covered_to, null, stream);
		if (diagnostics !== undefined) {
			assert.deepEqual(outcome.skipDiagnostics(stream), diagnostics, stream);
		}
	}
}

/** The stream's coverage line says `reason` and `status`, and a SKIP_RESULT says it too when it is a skip reason. */
function assertReason(
	outcome: Outcome,
	stream: string,
	reason: string,
	status: string,
): void {
	const coverage = outcome.coverage(stream);
	assert.equal(coverage.reason, reason, `${stream} reason`);
	assert.equal(coverage.status, status, `${stream} status`);
	assert.deepEqual(
		outcome.skipReasons(stream),
		SKIP_REASONS.has(reason) ? [reason] : [],
		`${stream} SKIP_RESULT`,
	);
}

let canonicalRun: Promise<Outcome> | undefined;

/** The canonical export's run, shared by the tests that compare record sets with it. */
function canonicalOutcome(): Promise<Outcome> {
	canonicalRun ??= run(uploaded());
	return canonicalRun;
}

// ─── The normal case ─────────────────────────────────────────────────────

test("#1 the canonical export delivers every stream exactly, covered in full", async () => {
	const outcome = await canonicalOutcome();
	for (const stream of DATA_STREAMS) {
		const expected = CANONICAL_RECORDS[stream] ?? [];
		assert.deepEqual(outcome.records(stream), expected, stream);
		const coverage = outcome.coverage(stream);
		assert.equal(coverage.text, CANONICAL_COVERAGE[stream], stream);
		assert.equal(coverage.count, expected.length, stream);
		assert.deepEqual(outcome.skips(stream), [], stream);
	}
	assert.deepEqual(
		outcome.ofType("PROGRESS").map((m) => m.message),
		[
			"Reading Fitbit activities.",
			"Fitbit activities: 4 imported.",
			"Reading Fitbit daily summaries.",
			"Fitbit daily summaries: 4 imported.",
			"Reading Fitbit sleep logs.",
			"Fitbit sleep logs: 3 imported.",
		],
	);
	assert.equal(outcome.progressDone("daily_summaries").zero_only, 4);
	assert.equal(outcome.progressDone("daily_summaries").duplicates, 1);
	assert.equal(
		outcome.progressFamily("daily_summaries", "steps").duplicates,
		1,
	);
	assert.equal(outcome.progressDone("activities").withheld_types, 1);
	assert.equal(outcome.progressDone("sleep").scores, 3);
});

test("#2 excluded keys, member names and identities never reach stdout or stderr", async () => {
	const outcome = await canonicalOutcome();
	assert.ok(outcome.records("activities").length > 0, "the run read data");
	for (const canary of CANARIES) {
		assert.ok(!outcome.rawStdout.includes(canary), `stdout: ${canary}`);
		assert.ok(!outcome.stderr.includes(canary), `stderr: ${canary}`);
	}
	for (const message of outcome.ofType("RECORD")) {
		const stream = String(message.stream);
		assert.deepEqual(
			Object.keys(message.data as Message).sort(byText),
			[...(SCHEMA_KEYS[stream] ?? [])].sort(byText),
			`${stream}: a record carries its schema's keys and no others`,
		);
	}
});

test("#3 an exercise is published on one clock only, UTC, and no sleep time of day is", async () => {
	const outcome = await canonicalOutcome();
	assert.ok(outcome.rawStdout.includes('"2026-03-13T23:00:00Z"'));
	// The same start on the owner's Sydney clock.
	assert.ok(!outcome.rawStdout.includes("2026-03-14T10:00:00"));
	// Sleep starts and ends are local wall-clock.
	for (const localTime of ["2026-03-13T22:47:30", "2026-03-14T06:31:30"]) {
		assert.ok(!outcome.rawStdout.includes(localTime), localTime);
	}
});

test("#4 records and coverage lines do not depend on the zone the import runs in", async () => {
	const dir = uploaded();
	const utc = await run(dir);
	const chicago = await run(dir, { env: { TZ: "America/Chicago" } });
	const sydney = await run(dir, { env: { TZ: "Australia/Sydney" } });
	assert.deepEqual(
		utc.records("daily_summaries"),
		CANONICAL_RECORDS.daily_summaries,
	);
	assert.deepEqual(chicago.outputSet(), utc.outputSet());
	assert.deepEqual(sydney.outputSet(), utc.outputSet());
});

// ─── No upload, or not an upload this import can read ────────────────────

test("#5 a missing import folder is awaiting an upload, with a coverage line per stream", async () => {
	const outcome = await run(join(TEMP, "no-such-folder"));
	assertAllFailed(outcome, "awaiting_upload", {
		code: null,
		failure: null,
	});
	// The line states the window asked for, as the runtime applies it, even
	// when nothing could be read.
	const windowed = await run(join(TEMP, "no-such-folder"), {
		timeRanges: {
			sleep: { since: "2026-03-01T09:00:00+10:00", until: "2026-04-01" },
		},
	});
	assertAllFailed(windowed, "awaiting_upload");
	assert.equal(
		windowed.coverage("sleep").text,
		"coverage stream=sleep status=empty reason=awaiting_upload delivered=0 fields_unavailable=none fields_unreadable=none window_requested_from=2026-03-01 window_requested_to=2026-04-01 window_covered_from=none window_covered_to=none",
	);
	assert.equal(windowed.coverage("activities").window_requested_from, null);
});

test("#6 an empty folder awaits an upload; anything that is not an export ZIP is unreadable", async () => {
	assertAllFailed(await run(importFolder()), "awaiting_upload");

	const hiddenOnly = importFolder();
	writeFileSync(join(hiddenOnly, ".DS_Store"), "");
	assertAllFailed(await run(hiddenOnly), "awaiting_upload");

	const noZip = { code: null, failure: "no_zip" };
	const csvOnly = importFolder();
	writeFileSync(join(csvOnly, "export.csv"), "date,steps\n2026-04-04,150\n");
	assertAllFailed(await run(csvOnly), "source_unreadable", noZip);

	const unzipped = importFolder();
	mkdirSync(join(unzipped, "Takeout", "Fitbit", "Global Export Data"), {
		recursive: true,
	});
	writeFileSync(
		join(unzipped, "Takeout", "Fitbit", "Global Export Data", "steps.json"),
		fitbitJson([minute("04/04/26 13:00:00", "20")]),
	);
	assertAllFailed(await run(unzipped), "source_unreadable", noZip);

	// The import path names the ZIP itself rather than its folder.
	const zipPath = join(uploaded(), partName(1));
	assertAllFailed(await run(zipPath), "source_unreadable", {
		code: null,
		failure: "file",
	});
});

test("#7 a part that is not a zip, a damaged listing, and a .tgz export are unreadable", async () => {
	const text = importFolder();
	writeFileSync(join(text, partName(1)), "This is not a zip, only text.\n");
	assertAllFailed(await run(text), "source_unreadable", {
		code: null,
		failure: "not_zip",
	});

	// The third central-directory record's signature is damaged, so a listing
	// stops before it: the members after it must not read as absent.
	const bytes = zipBytes(canonicalMembers());
	let record = -1;
	for (let n = 0; n < 3; n += 1) {
		record = bytes.indexOf(CENTRAL_HEADER_SIGNATURE, record + 1);
	}
	assert.ok(record > 0);
	bytes[record + 3] = 0x00;
	const damaged = importFolder();
	writeFileSync(join(damaged, partName(1)), bytes);
	assertAllFailed(await run(damaged), "source_unreadable", {
		code: null,
		failure: "unreadable_listing",
	});

	const tgz = importFolder();
	writeGzipLookalike(join(tgz, "takeout-20260920T081500Z-001.tgz"));
	assertAllFailed(await run(tgz), "source_unreadable", {
		code: null,
		failure: "gzip",
	});

	const renamed = importFolder();
	writeGzipLookalike(join(renamed, partName(1)));
	assertAllFailed(await run(renamed), "source_unreadable", {
		code: null,
		failure: "gzip",
	});
});

test("#8 a zip with no Fitbit layout, or two, is unreadable; one with only the Google-era layout has changed format", async () => {
	const neither = uploaded(
		neverReadMembers()
			.filter((m) => !m.name.includes("GoogleData"))
			.filter((m) => !m.name.includes("Global Export Data")),
	);
	assertAllFailed(await run(neither), "source_unreadable", {
		code: null,
		failure: "not_fitbit",
	});

	const rows = canonicalRows();
	const twoRoots = uploaded([
		...canonicalMembers(),
		jsonMember(
			"steps-2026-04-05.json",
			rows.stepsSecond,
			"Copy/Takeout/Fitbit/",
		),
	]);
	assertAllFailed(await run(twoRoots), "source_unreadable", {
		code: null,
		failure: "ambiguous_root",
	});

	const googleEra = uploaded(
		neverReadMembers().filter((m) =>
			m.name.includes("Physical Activity_GoogleData/"),
		),
	);
	assertAllFailed(await run(googleEra), "export_format_changed", {
		code: null,
		failure: "google_era_only",
	});
});

test("#9 a part that needs ZIP64, or declares more than the zip policy allows, is past this import's limit, never read as empty", async () => {
	const sentinel = importFolder();
	writeZip64SentinelZip(join(sentinel, partName(1)), canonicalMembers());
	assertAllFailed(await run(sentinel), "source_limit_reached", {
		code: null,
		failure: "zip64",
	});

	const declared = uploaded([
		...canonicalMembers(),
		{
			name: `${ROOT}Physical Activity_GoogleData/huge.csv`,
			data: Buffer.alloc(0),
			method: "store",
			declaredSize: 0xff_ff_ff_ff,
		},
	]);
	assertAllFailed(await run(declared), "source_limit_reached", {
		code: "entry_too_large",
		failure: "policy",
	});

	// Past 4 GiB: a sparse file, so only a few bytes reach the disk.
	const large = largeFolder("sparse");
	try {
		writeSparseOversize(join(large, partName(1)));
		assertAllFailed(await run(large), "source_limit_reached", {
			code: null,
			failure: "zip64",
		});
	} finally {
		rmSync(large, { force: true, recursive: true });
	}

	// A writer that switches to ZIP64 part-way, past 2 GiB: the part lists,
	// and a member past the switch is over the limit, not cut short.
	const switched = largeFolder("switched");
	try {
		const rows = canonicalRows();
		writeZip64LocatorZip(
			join(switched, partName(1)),
			canonicalMembers({
				sleep: [
					{
						...jsonMember("sleep-2026-03-14.json", rows.sleep),
						offsetSentinel: true,
					},
				],
			}),
			PAST_ZIP64_SWITCH_GAP_BYTES,
		);
		const outcome = await run(switched);
		assertReason(outcome, "sleep", "source_limit_reached", "empty");
		assert.equal(outcome.skipDiagnostics("sleep").oversized_files, 1);
		for (const stream of ["activities", "daily_summaries"]) {
			assertReason(outcome, stream, "covered_in_full", "complete");
		}
	} finally {
		rmSync(switched, { force: true, recursive: true });
	}
});

// ─── One stream's members ────────────────────────────────────────────────

test("#10 a member declaring more than its limit is not extracted, and a score file not read in full flags every unjoined score", async () => {
	const rows = canonicalRows();
	const outcome = await run(
		uploaded(
			canonicalMembers({
				sleep: [
					{
						...jsonMember("sleep-2026-03-14.json", rows.sleep),
						declaredSize: 300 * MIB,
					},
				],
			}),
		),
	);
	assert.deepEqual(outcome.records("sleep"), []);
	assertReason(outcome, "sleep", "source_limit_reached", "empty");
	assert.deepEqual(outcome.skipDiagnostics("sleep"), {
		files: 2,
		unreadable: 0,
		shape_mismatch: 0,
		schema_rejected: 0,
		interrupted_files: 0,
		oversized_files: 1,
		duplicate_members: 0,
		zone_unusable: 0,
		file_missing: 0,
		device_code: null,
	});
	assert.equal(outcome.progressFamily("sleep", "sleep").rows, 0);
	for (const stream of ["activities", "daily_summaries"]) {
		assertReason(outcome, stream, "covered_in_full", "complete");
	}

	const scores = await run(
		uploaded(
			canonicalMembers({
				sleep_score: [
					{
						name: sleepScoreMember(),
						data: scoreCsv(),
						declaredSize: 9 * MIB,
					},
				],
			}),
		),
	);
	assertReason(scores, "sleep", "source_limit_reached", "partial");
	assert.deepEqual(scores.records("sleep"), SLEEP_WITHOUT_SCORES);
	assert.deepEqual(scores.coverage("sleep").fields_unreadable, ["sleep_score"]);
	assert.deepEqual(scores.coverage("sleep").fields_unavailable, []);
	assert.equal(scores.skipDiagnostics("sleep").oversized_files, 1);

	// A score row whose log id cannot be read may be S2's, so S2's score is
	// blank and named rather than absent.
	const unplacedRow = [
		"not-a-log-id",
		"2026-03-16T06:00:00Z",
		"75",
		"",
		"",
		"",
		"",
		"",
		"",
	];
	const unplaced = await run(
		uploaded(
			canonicalMembers({
				sleep_score: [
					{
						name: sleepScoreMember(),
						data: scoreCsv([...SCORE_ROWS, unplacedRow]),
					},
				],
			}),
		),
	);
	assertReason(unplaced, "sleep", "records_unreadable", "partial");
	assert.deepEqual(unplaced.records("sleep"), CANONICAL_RECORDS.sleep);
	assert.deepEqual(unplaced.coverage("sleep").fields_unreadable, [
		"sleep_score",
	]);

	// With no score joined, every log's score is blank and named, and a field
	// that may hold an unread value is never also called unavailable.
	const unjoined = await run(
		uploaded(
			canonicalMembers({
				sleep_score: [
					{
						name: sleepScoreMember(),
						data: scoreCsv([UNJOINED_SCORE_ROW, unplacedRow]),
					},
				],
			}),
		),
	);
	assertReason(unjoined, "sleep", "records_unreadable", "partial");
	assert.deepEqual(unjoined.records("sleep"), SLEEP_WITHOUT_SCORES);
	assert.deepEqual(unjoined.coverage("sleep").fields_unreadable, [
		"sleep_score",
	]);
	assert.deepEqual(unjoined.coverage("sleep").fields_unavailable, []);
});

test("#11 a device that cannot make scratch space is named, not the export", async () => {
	const dir = uploaded();
	const outcome = await run(dir, {
		// tsx keeps its cache under TMPDIR; without the second variable it would
		// fail before the connector ran.
		env: { TMPDIR: join(dir, "no-such-directory"), TSX_DISABLE_CACHE: "1" },
	});
	assertAllFailed(outcome, "device_storage_unavailable", {
		code: "ENOENT",
		failure: null,
	});
});

test("#12 a member cut short keeps what was read before the cut, and says so", async () => {
	const rows = canonicalRows();
	const sleepCut = await run(
		uploaded(
			canonicalMembers({
				sleep: [
					{
						name: legacyMember("sleep-2026-03-14.json"),
						data: truncatedJson(rows.sleep, 2),
					},
				],
			}),
		),
	);
	assertReason(sleepCut, "sleep", "collection_interrupted", "partial");
	assert.deepEqual(
		sleepCut.records("sleep"),
		(CANONICAL_RECORDS.sleep ?? []).slice(0, 2),
	);
	assert.deepEqual(sleepCut.coverage("sleep").fields_unreadable, []);
	assert.deepEqual(sleepCut.coverage("sleep").fields_unavailable, []);
	assert.equal(sleepCut.skipDiagnostics("sleep").interrupted_files, 1);

	// A quoted cell in S3's row, and the file cut inside it.
	const quoted = Buffer.from(
		scoreCsv()
			.toString("utf8")
			.replace(
				"31000000003,2026-03-15T06:09:00Z",
				'31000000003,"2026-03-15T06:09:00Z"',
			),
		"utf8",
	);
	const scoreCut = await run(
		uploaded(
			canonicalMembers({
				sleep_score: [
					{
						name: sleepScoreMember(),
						data: truncatedCsv(quoted, '31000000003,"2026-03-15T06'),
					},
				],
			}),
		),
	);
	assertReason(scoreCut, "sleep", "collection_interrupted", "partial");
	assert.deepEqual(
		scoreCut.records("sleep").map((r) => [r.id, r.sleep_score]),
		[
			["31000000001", 81],
			["31000000002", null],
			["31000000003", null],
		],
	);
	assert.deepEqual(scoreCut.coverage("sleep").fields_unreadable, [
		"sleep_score",
	]);

	// The cut member placed minutes on 3 and 4 April, and its name places it
	// over 3 to 5 April; 6 April's minutes come only from the next member.
	const stepsCut = await run(
		uploaded(
			canonicalMembers({
				steps: [
					{
						name: legacyMember("steps-2026-04-04.json"),
						data: truncatedJson(rows.stepsFirst, 3),
					},
					jsonMember("steps-2026-04-05.json", rows.stepsSecond),
				],
			}),
		),
	);
	assertReason(
		stepsCut,
		"daily_summaries",
		"collection_interrupted",
		"partial",
	);
	assert.deepEqual(
		stepsCut.records("daily_summaries"),
		dailyRecords(withSteps([null, null, null, 60])),
	);
	assert.deepEqual(stepsCut.coverage("daily_summaries").fields_unreadable, [
		"steps",
	]);
	for (const stream of ["activities", "sleep"]) {
		assertReason(stepsCut, stream, "covered_in_full", "complete");
	}

	// A minute before the cut that strays past the member's span, onto 6
	// April, blanks that day too: the cut may have lost more of its minutes.
	const strayCut = await run(
		uploaded(
			canonicalMembers({
				steps: [
					{
						name: legacyMember("steps-2026-04-04.json"),
						data: truncatedJson(
							[minute("04/05/26 14:01:00", "9"), ...rows.stepsFirst],
							3,
						),
					},
					jsonMember("steps-2026-04-05.json", rows.stepsSecond),
				],
			}),
		),
	);
	assert.deepEqual(
		strayCut.records("daily_summaries"),
		dailyRecords(withSteps([null, null, null, null])),
	);
	assert.deepEqual(strayCut.coverage("daily_summaries").fields_unreadable, [
		"steps",
	]);
});

test("#13 a family in an unknown layout is a changed format; padded days after the export are not records", async () => {
	const rows = canonicalRows();
	const outcome = await run(
		uploaded(
			canonicalMembers({
				// A wrapper key this import does not know, round the page's logs.
				exercise: [
					{
						name: legacyMember("exercise-0.json"),
						data: fitbitJson({ activities: rows.exercise }),
					},
				],
				// Every resting heart rate a string, on one more day after the export.
				resting_heart_rate: [
					jsonMember("resting_heart_rate-2026-04-03.json", [
						...rows.restingHeartRate.map((row) => ({ ...row, value: "58" })),
						{ dateTime: "09/22/26 00:00:00", value: "58" },
					]),
				],
				sleep_score: [
					{
						name: sleepScoreMember(),
						data: scoreCsv(
							SCORE_ROWS,
							SCORE_HEADER.map((cell) =>
								cell === "overall_score" ? "overall" : cell,
							),
						),
					},
				],
			}),
		),
	);
	assert.deepEqual(outcome.records("activities"), []);
	assertReason(outcome, "activities", "export_format_changed", "empty");
	assert.equal(outcome.progressDone("activities").shape_mismatch, 1);

	assertReason(outcome, "daily_summaries", "export_format_changed", "partial");
	assert.deepEqual(
		outcome.records("daily_summaries"),
		dailyRecords([
			["2026-04-03", 7, null, 0, 0, 0, null],
			["2026-04-04", 150, 80, 45, 10, 22, null],
			["2026-04-05", 95, 30.5, 30, 0, 0, null],
			["2026-04-06", 60, 45, 20, 5, 0, null],
			// Padding days before the export: the value may have been real.
			["2026-04-07", null, null, 0, 0, 0, null],
			["2026-04-08", null, null, 0, 0, 0, null],
			["2026-04-09", null, null, 0, 0, 0, null],
			["2026-04-10", null, null, 0, 0, 0, null],
		]),
	);
	assert.deepEqual(outcome.coverage("daily_summaries").fields_unreadable, [
		"resting_heart_rate_bpm",
	]);
	assert.equal(outcome.progressDone("daily_summaries").zero_only, 1);

	assertReason(outcome, "sleep", "export_format_changed", "partial");
	assert.deepEqual(outcome.records("sleep"), SLEEP_WITHOUT_SCORES);
	assert.deepEqual(outcome.coverage("sleep").fields_unreadable, [
		"sleep_score",
	]);
	for (const stream of DATA_STREAMS) {
		assert.deepEqual(outcome.coverage(stream).fields_unavailable, [], stream);
	}
});

test("#14 rows that cannot be identified or placed are skipped and counted", async () => {
	const rows = canonicalRows();
	const [firstLog] = rows.sleep;
	assert.ok(firstLog);
	const outcome = await run(
		uploaded(
			canonicalMembers({
				exercise: [
					jsonMember("exercise-0.json", [
						...rows.exercise,
						without(
							exercise({
								startTime: "03/14/26 06:00:00",
								originalStartTime: "03/14/26 06:00:00",
							}),
							"logId",
						),
					]),
				],
				sleep: [
					jsonMember("sleep-2026-03-14.json", [
						...rows.sleep,
						{ ...firstLog, logId: 31_000_000_009, dateOfSleep: "03/14/26" },
					]),
				],
				lightly_active_minutes: [
					jsonMember("lightly_active_minutes-2026-04-03.json", [
						...rows.lightly,
						dailyRow("garbage", "5"),
					]),
				],
				steps: [
					jsonMember("steps-2026-04-04.json", [
						...rows.stepsFirst,
						minute("04/31/26 10:00:00", "12"),
					]),
					jsonMember("steps-2026-04-05.json", rows.stepsSecond),
				],
			}),
		),
	);
	const unreadable: Readonly<Record<string, number>> = {
		activities: 1,
		daily_summaries: 2,
		sleep: 1,
	};
	for (const stream of DATA_STREAMS) {
		assertReason(outcome, stream, "records_unreadable", "partial");
		assert.equal(
			outcome.skipDiagnostics(stream).unreadable,
			unreadable[stream],
			stream,
		);
	}
	assert.deepEqual(outcome.records("activities"), CANONICAL_RECORDS.activities);
	assert.deepEqual(outcome.records("sleep"), CANONICAL_RECORDS.sleep);
	// The unplaceable minute's member placed minutes on 3 to 5 April and its
	// name places it over them; the lightly member's every delivered day had
	// its own row read, so no lightly value is lost.
	assert.deepEqual(
		outcome.records("daily_summaries"),
		dailyRecords(withSteps([null, null, null, 60])),
	);
	assert.deepEqual(outcome.coverage("daily_summaries").fields_unreadable, [
		"steps",
	]);
});

test("#15 an unreadable value is blanked and named, and the record still arrives", async () => {
	const rows = canonicalRows();
	const [e1, ...otherExercises] = rows.exercise;
	assert.ok(e1);
	const outcome = await run(
		uploaded(
			canonicalMembers({
				sleep_score: [
					{
						name: sleepScoreMember(),
						data: scoreCsv(
							SCORE_ROWS.map((row, index) =>
								index === 0
									? row.map((cell, column) => (column === 2 ? "n/a" : cell))
									: row,
							),
						),
					},
				],
				steps: [
					jsonMember("steps-2026-04-04.json", rows.stepsFirst),
					jsonMember(
						"steps-2026-04-05.json",
						rows.stepsSecond.map((row) =>
							row.dateTime === "04/05/26 13:59:00"
								? { ...row, value: "x" }
								: row,
						),
					),
				],
				exercise: [
					jsonMember("exercise-0.json", [
						without(e1, "distanceUnit"),
						...otherExercises,
					]),
				],
			}),
		),
	);
	const blanked: Readonly<Record<string, readonly [string, string]>> = {
		activities: ["21000000001", "distance_m"],
		daily_summaries: ["2026-04-05", "steps"],
		sleep: ["31000000001", "sleep_score"],
	};
	for (const [stream, [id, field]] of Object.entries(blanked)) {
		assertReason(outcome, stream, "values_unreadable", "partial");
		assert.deepEqual(outcome.coverage(stream).fields_unreadable, [field]);
		const expected = (CANONICAL_RECORDS[stream] ?? []).map((r) =>
			r.id === id ? { ...r, [field]: null } : r,
		);
		assert.deepEqual(outcome.records(stream), expected, stream);
	}
});

test("#16 a stream with no files is nothing in range; a missing score file is an unavailable field, one whose scores join no log is not", async () => {
	const noSleep = await run(
		uploaded(
			canonicalMembers({
				sleep: [],
				sleep_score: [],
				never_read: neverReadMembers().filter(
					(m) => !m.name.includes("UserSleeps"),
				),
			}),
		),
	);
	assertReason(noSleep, "sleep", "nothing_in_range", "empty");
	assert.deepEqual(noSleep.coverage("sleep").fields_unavailable, []);
	assert.equal(noSleep.progressDone("sleep").files, 0);

	const noScores = await run(uploaded(canonicalMembers({ sleep_score: [] })));
	assertReason(noScores, "sleep", "covered_in_full", "complete");
	assert.deepEqual(noScores.coverage("sleep").fields_unavailable, [
		"sleep_score",
	]);
	assert.deepEqual(
		noScores.records("sleep").map((r) => r.sleep_score),
		[null, null, null],
	);

	// A score file read in full whose one score is for a log not in the upload
	// still carries sleep_score: each log's null is an absent score.
	const unjoined = await run(
		uploaded(
			canonicalMembers({
				sleep_score: [
					{ name: sleepScoreMember(), data: scoreCsv([UNJOINED_SCORE_ROW]) },
				],
			}),
		),
	);
	assertReason(unjoined, "sleep", "covered_in_full", "complete");
	assert.deepEqual(unjoined.records("sleep"), SLEEP_WITHOUT_SCORES);
	assert.deepEqual(unjoined.coverage("sleep").fields_unavailable, []);
	assert.deepEqual(unjoined.coverage("sleep").fields_unreadable, []);
});

test("#17 fields_unavailable names what no row carried, whatever the window", async () => {
	const dir = uploaded(
		canonicalMembers({ distance: [], resting_heart_rate: [] }),
	);
	const whole = await run(dir);
	assertReason(whole, "daily_summaries", "covered_in_full", "complete");
	const unavailable = ["distance_m", "resting_heart_rate_bpm"];
	assert.deepEqual(
		whole.coverage("daily_summaries").fields_unavailable,
		unavailable,
	);
	assert.deepEqual(
		whole.records("daily_summaries"),
		dailyRecords(
			CANONICAL_DAYS.map(([date, steps, , lightly, moderately, very]) => [
				date,
				steps,
				null,
				lightly,
				moderately,
				very,
				null,
			]),
		),
	);

	const windowed = await run(dir, {
		timeRanges: { daily_summaries: { since: "2027-01-01" } },
	});
	assertReason(windowed, "daily_summaries", "nothing_in_range", "empty");
	assert.deepEqual(
		windowed.coverage("daily_summaries").fields_unavailable,
		unavailable,
	);
	assert.equal(windowed.progressDone("daily_summaries").outside_window, 4);

	// Distance files without steps files still need the zone to place their minutes.
	const noSteps = await run(uploaded(canonicalMembers({ steps: [] })));
	assertReason(noSteps, "daily_summaries", "covered_in_full", "complete");
	assert.deepEqual(noSteps.coverage("daily_summaries").fields_unavailable, [
		"steps",
	]);
	assert.deepEqual(
		noSteps.records("daily_summaries"),
		dailyRecords(
			CANONICAL_DAYS.slice(1).map(([date, , ...rest]) => [date, null, ...rest]),
		),
	);
});

// ─── Windows, filters and the choice of upload ───────────────────────────

test("#18 a window is applied to the exercise's UTC start and stated as dates", async () => {
	const outcome = await run(uploaded(), {
		timeRanges: {
			activities: { since: "2026-03-16", until: "2026-03-17" },
			// Applied by the runtime as text, but no date the line can state.
			sleep: { since: "2026-02-30" },
		},
	});
	// 21000000001 starts 2026-03-13T23:00:00Z, the 14th on the owner's clock:
	// out, as every start before the 16th. 21000000004 starts on the 17th,
	// which `until` excludes.
	assert.deepEqual(
		outcome.records("activities").map((r) => r.id),
		["21000000003"],
	);
	assert.equal(
		outcome.coverage("activities").text,
		"coverage stream=activities status=complete reason=covered_in_full delivered=1 fields_unavailable=none fields_unreadable=none window_requested_from=2026-03-16 window_requested_to=2026-03-17 window_covered_from=2026-03-16 window_covered_to=2026-03-16",
	);
	assert.equal(outcome.progressDone("activities").outside_window, 3);
	// A stream without a window states none.
	assert.equal(outcome.coverage("daily_summaries").window_requested_from, null);
	// Every sleep date sorts after "2026-02-30", so all three arrive, and the
	// bound, naming no real date, is stated as unparsed (#38).
	assert.equal(outcome.records("sleep").length, 3);
	assert.equal(outcome.coverage("sleep").window_requested_from, "unparsed");
	assert.equal(outcome.coverage("sleep").window_covered_from, "2026-03-14");
});

test("#18b a since inside a day is applied at its instant, not the day's start", async () => {
	// 21000000002 starts 2026-03-15T06:10:00Z, before since on since's day.
	const outcome = await run(uploaded(), {
		streams: ["activities"],
		timeRanges: {
			activities: {
				since: "2026-03-15T12:00:00Z",
				until: "2026-03-16T00:00:00Z",
			},
		},
	});
	assert.deepEqual(outcome.records("activities"), []);
	assert.equal(outcome.progressDone("activities").outside_window, 4);
});

test("#19 a resource filter delivers and counts only the ids requested", async () => {
	const outcome = await run(uploaded(), {
		resources: {
			activities: ["21000000002", "21000000004"],
			daily_summaries: ["2026-04-05"],
		},
	});
	assert.deepEqual(
		outcome.records("activities").map((r) => r.id),
		["21000000002", "21000000004"],
	);
	assert.deepEqual(
		outcome.records("daily_summaries").map((r) => r.id),
		["2026-04-05"],
	);
	assert.equal(outcome.progressDone("activities").outside_window, 2);
	assert.equal(outcome.progressDone("daily_summaries").outside_window, 3);
	for (const stream of ["activities", "daily_summaries"]) {
		assertReason(outcome, stream, "covered_in_full", "complete");
	}
});

test("#21 padded days are neither records nor failures", async () => {
	const rows = canonicalRows();
	const later = Array.from({ length: 30 }, (_, index) => {
		const date = new Date(Date.UTC(2026, 3, 11 + index));
		const month = String(date.getUTCMonth() + 1).padStart(2, "0");
		const day = String(date.getUTCDate()).padStart(2, "0");
		return `${month}/${day}/26 00:00:00`;
	});
	const padded = (base: string, values: readonly JsonObject[]): ZipMember =>
		jsonMember(`${base}-2026-04-03.json`, [
			...values,
			...later.map((dateTime) => dailyRow(dateTime, "0")),
		]);
	const outcome = await run(
		uploaded(
			canonicalMembers({
				lightly_active_minutes: [
					padded("lightly_active_minutes", rows.lightly),
				],
				moderately_active_minutes: [
					padded("moderately_active_minutes", rows.moderately),
				],
				very_active_minutes: [padded("very_active_minutes", rows.very)],
				resting_heart_rate: [
					jsonMember("resting_heart_rate-2026-04-03.json", [
						...rows.restingHeartRate,
						...later.map((dateTime) => restingRow(dateTime)),
					]),
				],
			}),
		),
	);
	assertReason(outcome, "daily_summaries", "covered_in_full", "complete");
	assert.deepEqual(
		outcome.records("daily_summaries"),
		CANONICAL_RECORDS.daily_summaries,
	);
	assert.equal(outcome.progressDone("daily_summaries").zero_only, 34);
	assert.equal(outcome.progressDone("daily_summaries").unreadable, 0);
});

test("#22 steps and distance follow the profile zone's local day across the end of daylight time", async () => {
	const outcome = await canonicalOutcome();
	const byDate = new Map(
		outcome.records("daily_summaries").map((r) => [r.date, r]),
	);
	// UTC days would give 107 and 140; a fixed +11:00 90 and 65; no dedupe 125.
	assert.deepEqual(
		["2026-04-03", "2026-04-04", "2026-04-05", "2026-04-06"].map(
			(date) => byDate.get(date)?.steps,
		),
		[7, 150, 95, 60],
	);
	// Centimetres to metres; the nested copy under archive/ is never read.
	assert.deepEqual(
		["2026-04-04", "2026-04-05", "2026-04-06"].map(
			(date) => byDate.get(date)?.distance_m,
		),
		[80, 30.5, 45],
	);
	assert.deepEqual(
		outcome.records("daily_summaries"),
		CANONICAL_RECORDS.daily_summaries,
	);
});

test("#23 a record in two files is delivered once, as first read", async () => {
	const rows = canonicalRows();
	const [firstLog] = rows.sleep;
	const [, e2] = rows.exercise;
	assert.ok(firstLog && e2);
	const outcome = await run(
		uploaded(
			canonicalMembers({
				// The earlier file holds S1 with other values: its copy is read first.
				sleep: [
					jsonMember("sleep-2026-02-12.json", [
						{ ...firstLog, minutesAsleep: 400 },
					]),
					jsonMember("sleep-2026-03-14.json", rows.sleep),
				],
				// The later page repeats E2 with another duration.
				exercise: [
					jsonMember("exercise-0.json", rows.exercise),
					jsonMember("exercise-100.json", [{ ...e2, duration: 99_000 }]),
				],
				// 4 April's light minutes again, in a later file, with another value.
				lightly_active_minutes: [
					jsonMember("lightly_active_minutes-2026-04-03.json", rows.lightly),
					jsonMember("lightly_active_minutes-2026-04-04.json", [
						dailyRow("04/04/26 00:00:00", "99"),
					]),
				],
			}),
		),
	);
	assert.deepEqual(
		outcome.records("sleep").map((r) => [r.id, r.asleep_duration_s]),
		[
			["31000000001", 24_000],
			["31000000002", 2280],
			["31000000003", 22_260],
		],
	);
	assert.deepEqual(outcome.records("activities"), CANONICAL_RECORDS.activities);
	assert.deepEqual(
		outcome.records("daily_summaries"),
		CANONICAL_RECORDS.daily_summaries,
	);
	const duplicates: Readonly<Record<string, number>> = {
		activities: 1,
		// The repeated steps minute and the repeated date.
		daily_summaries: 2,
		sleep: 1,
	};
	for (const stream of DATA_STREAMS) {
		assertReason(outcome, stream, "covered_in_full", "complete");
		assert.equal(
			outcome.progressDone(stream).duplicates,
			duplicates[stream],
			stream,
		);
	}
});

test("#24 the newest Takeout export is read, whatever else the folder holds", async () => {
	const older = canonicalMembers({
		exercise: [
			jsonMember("exercise-0.json", [exercise({ logId: 21_000_000_009 })]),
		],
	});
	const canonical = await canonicalOutcome();

	const twoStamps = importFolder();
	writeZip(join(twoStamps, partName(1, 1, OLDER_STAMP)), older);
	writeZip(join(twoStamps, partName(2, 1, OLDER_STAMP)), [
		...neverReadMembers().slice(0, 1),
	]);
	writeZip(join(twoStamps, partName(1)), canonicalMembers());
	assert.deepEqual((await run(twoStamps)).outputSet(), canonical.outputSet());

	// A stray ZIP modified after the Takeout parts does not displace them.
	const stray = uploaded();
	writeZip(join(stray, "export.zip"), older);
	setMtime(join(stray, "export.zip"), new Date(Date.now() + 60_000));
	assert.deepEqual((await run(stray)).outputSet(), canonical.outputSet());

	// Without Takeout names, the newest ZIP by modification time.
	const newestMtime = new Date("2026-02-01T00:00:00.000Z");
	for (const [newer, olderName] of [
		["a.zip", "b.zip"],
		["b.zip", "a.zip"],
	] as const) {
		const dir = importFolder();
		writeZip(join(dir, olderName), older);
		setMtime(join(dir, olderName), new Date("2026-01-01T00:00:00.000Z"));
		writeZip(join(dir, newer), canonicalMembers());
		setMtime(join(dir, newer), newestMtime);
		const outcome = await run(dir, { streams: ["activities"] });
		assert.deepEqual(
			outcome.records("activities").map((r) => r.id),
			["21000000001", "21000000002", "21000000003", "21000000004"],
			newer,
		);
		assert.deepEqual(
			[...new Set(outcome.records("activities").map((r) => r.exported_at))],
			[newestMtime.toISOString()],
		);
	}

	const gap = importFolder();
	writeZip(join(gap, partName(1)), canonicalMembers());
	writeZip(join(gap, partName(3)), neverReadMembers().slice(0, 1));
	assertAllFailed(await run(gap), "source_unreadable", {
		code: null,
		failure: "parts",
	});

	// Two middle numbers under one stamp, the families split between them.
	const members = canonicalMembers();
	const split = importFolder();
	writeParts(
		split,
		[
			members.filter((_, index) => index % 2 === 0),
			members.filter((_, index) => index % 2 === 1),
		],
		(group) => partName(1, group),
	);
	assert.deepEqual((await run(split)).outputSet(), canonical.outputSet());

	// Two middle numbers holding the same files: two copies, not two halves.
	const copies = importFolder();
	writeParts(copies, [members, members], (group) => partName(1, group));
	assertAllFailed(await run(copies), "source_unreadable", {
		code: null,
		failure: "parts",
	});
});

test("#25 an export in several parts reads as one; a file in two parts is read from neither", async () => {
	const canonical = await canonicalOutcome();
	const three = importFolder();
	canonicalParts(three, 3);
	assert.deepEqual((await run(three)).outputSet(), canonical.outputSet());

	// The second steps file in parts 1 and 3. Its name places it over 4 April
	// to the day after the export; 3 April's minutes come only from the first.
	const rows = canonicalRows();
	const duplicated = importFolder();
	writeParts(duplicated, [
		canonicalMembers(),
		neverReadMembers().slice(0, 1),
		[jsonMember("steps-2026-04-05.json", rows.stepsSecond)],
	]);
	const outcome = await run(duplicated);
	assertReason(outcome, "daily_summaries", "records_unreadable", "partial");
	assert.equal(outcome.skipDiagnostics("daily_summaries").duplicate_members, 1);
	assert.deepEqual(
		outcome.records("daily_summaries"),
		dailyRecords(withSteps([7, null, null, null])),
	);
	assert.deepEqual(outcome.coverage("daily_summaries").fields_unreadable, [
		"steps",
	]);
	for (const stream of ["activities", "sleep"]) {
		assertReason(outcome, stream, "covered_in_full", "complete");
	}

	// The score file in parts 1 and 3 is read from neither, so no log's score
	// can be ruled out: every score is blank and named, not absent.
	const scoreTwice = importFolder();
	writeParts(scoreTwice, [
		canonicalMembers(),
		neverReadMembers().slice(0, 1),
		[{ name: sleepScoreMember(), data: scoreCsv() }],
	]);
	const scores = await run(scoreTwice);
	assertReason(scores, "sleep", "records_unreadable", "partial");
	assert.equal(scores.skipDiagnostics("sleep").duplicate_members, 1);
	assert.deepEqual(scores.records("sleep"), SLEEP_WITHOUT_SCORES);
	assert.deepEqual(scores.coverage("sleep").fields_unreadable, ["sleep_score"]);
});

test("#26 a stream that was not requested is never read", async () => {
	const outcome = await run(
		uploaded(
			canonicalMembers({
				sleep: [
					{
						name: legacyMember("sleep-2026-03-14.json"),
						data: Buffer.from("{not json"),
						method: "store",
					},
				],
			}),
		),
		{ streams: ["activities"] },
	);
	assert.deepEqual(
		outcome.messages.filter((m) => m.stream === "sleep"),
		[],
	);
	assert.deepEqual(
		outcome.coverageLines().map((line) => line.stream),
		["activities"],
	);
	assertReason(outcome, "activities", "covered_in_full", "complete");
});

test("#27 every run reads the whole export: repeats and full_refresh deliver the same records", async () => {
	const dir = uploaded();
	const first = await run(dir);
	const second = await run(dir);
	const refresh = await run(dir, { fullRefresh: true });
	assert.equal(first.records("activities").length, 4);
	assert.deepEqual(second.outputSet(), first.outputSet());
	assert.deepEqual(refresh.outputSet(), first.outputSet());
});

test("#29 an unreadable row counts against a stream's reason only when it could fall inside the requested scope", async () => {
	const rows = canonicalRows();
	const dir = uploaded(
		canonicalMembers({
			exercise: [
				jsonMember("exercise-0.json", [
					...rows.exercise,
					// An id written as text; the start is readable, in 2017.
					exercise({
						logId: "21000000999",
						startTime: "06/01/17 06:00:00",
						originalStartTime: "06/01/17 06:00:00",
					}),
				]),
			],
		}),
	);
	const streams = ["activities"];

	const timed = await run(dir, {
		streams,
		timeRanges: { activities: { since: "2026-01-01" } },
	});
	assertReason(timed, "activities", "covered_in_full", "complete");
	assert.equal(timed.progressDone("activities").outside_window, 1);
	assert.equal(timed.progressDone("activities").unreadable, 0);
	assert.equal(timed.progressDone("activities").unreadable_total, 1);

	const untimed = await run(dir, { streams });
	assertReason(untimed, "activities", "records_unreadable", "partial");
	assert.equal(untimed.records("activities").length, 4);

	// A row without an id cannot be ruled out by a resource filter.
	const filtered = await run(dir, {
		streams,
		resources: { activities: ["21000000001"] },
	});
	assertReason(filtered, "activities", "records_unreadable", "partial");
	assert.equal(filtered.progressDone("activities").unreadable, 1);
	assert.equal(filtered.progressDone("activities").outside_window, 3);
});

test("#30 with no usable zone, steps and distance are blank and named on every day, and the reason follows the cause", async () => {
	const zoneColumn = PROFILE_HEADER.indexOf("timezone");
	const zoneRow = (zone: string): string[] =>
		PROFILE_ROW.map((cell, index) => (index === zoneColumn ? zone : cell));
	const profile = (data: Buffer): readonly ZipMember[] => [
		{ name: profileMember(), data },
	];
	const cases: readonly (readonly [
		label: string,
		dir: string,
		reason: string,
		duplicateMembers: number,
	])[] = [
		[
			"the literal null",
			uploaded(
				canonicalMembers({ profile: profile(profileCsv([zoneRow("null")])) }),
			),
			"records_unreadable",
			0,
		],
		[
			"an unknown zone",
			uploaded(
				canonicalMembers({
					profile: profile(profileCsv([zoneRow("Mars/Olympus")])),
				}),
			),
			"records_unreadable",
			0,
		],
		[
			"no timezone column",
			uploaded(
				canonicalMembers({
					profile: profile(
						profileCsv(
							[PROFILE_ROW],
							PROFILE_HEADER.map((cell) => (cell === "timezone" ? "tz" : cell)),
						),
					),
				}),
			),
			"export_format_changed",
			0,
		],
		[
			"no data row",
			uploaded(canonicalMembers({ profile: profile(profileCsv([])) })),
			"export_format_changed",
			0,
		],
		[
			"no Profile.csv",
			uploaded(canonicalMembers({ profile: [] })),
			"export_format_changed",
			0,
		],
		[
			"cut inside a quoted cell",
			uploaded(
				canonicalMembers({
					profile: profile(truncatedCsv(profileCsv(), "with a comma")),
				}),
			),
			"collection_interrupted",
			0,
		],
		[
			"in two parts",
			(() => {
				const dir = importFolder();
				writeParts(dir, [
					canonicalMembers(),
					[{ name: profileMember(), data: profileCsv() }],
				]);
				return dir;
			})(),
			"records_unreadable",
			1,
		],
	];
	for (const [label, dir, reason, duplicateMembers] of cases) {
		const outcome = await run(dir);
		assertReason(outcome, "daily_summaries", reason, "partial");
		// 3 April's only reading was steps, so it is not a record.
		assert.deepEqual(
			outcome.records("daily_summaries"),
			dailyRecords(
				CANONICAL_DAYS.slice(1).map(([date, , , ...rest]) => [
					date,
					null,
					null,
					...rest,
				]),
			),
			label,
		);
		const coverage = outcome.coverage("daily_summaries");
		assert.deepEqual(
			coverage.fields_unreadable,
			["distance_m", "steps"],
			label,
		);
		assert.deepEqual(coverage.fields_unavailable, [], label);
		const diagnostics = outcome.skipDiagnostics("daily_summaries");
		assert.equal(diagnostics.zone_unusable, 1, label);
		assert.equal(diagnostics.duplicate_members, duplicateMembers, label);
		assert.equal(outcome.progressDone("daily_summaries").zero_only, 5, label);
		assert.equal(outcome.progressDone("daily_summaries").zone_unusable, 1);
		for (const stream of ["activities", "sleep"]) {
			assertReason(outcome, stream, "covered_in_full", "complete");
		}
	}
});

test("#31 an exercise name becomes a type only when it is on the list", async () => {
	const outcome = await run(
		uploaded(
			canonicalMembers({
				exercise: [
					jsonMember("exercise-0.json", [
						exercise({ activityName: "  core   Training " }),
						exercise({
							logId: 21_000_000_002,
							activityName: "CrossFit",
							startTime: "03/15/26 06:10:00",
						}),
						exercise({
							logId: 21_000_000_003,
							activityName: "Parkrun with Dad",
							startTime: "03/16/26 08:00:00",
						}),
					]),
				],
			}),
		),
		{ streams: ["activities"] },
	);
	assert.deepEqual(
		outcome.records("activities").map((r) => [r.id, r.activity_type]),
		[
			["21000000001", "core_training"],
			["21000000002", "crossfit"],
			["21000000003", null],
		],
	);
	assertReason(outcome, "activities", "covered_in_full", "complete");
	assert.deepEqual(outcome.coverage("activities").fields_unreadable, []);
	assert.equal(outcome.progressDone("activities").withheld_types, 1);
	assert.ok(!outcome.rawStdout.includes("Parkrun"));
	assert.ok(!outcome.rawStdout.includes("core   Training"));
});

test("#32 an upload without a Takeout name is dated by its modification time, so staging it again re-dates every record", async () => {
	const dir = importFolder();
	const path = join(dir, "fitbit.zip");
	writeZip(path, canonicalMembers());
	const importAt = async (when: string): Promise<void> => {
		setMtime(path, new Date(when));
		const outcome = await run(dir);
		for (const message of outcome.ofType("RECORD")) {
			assert.equal((message.data as Message).exported_at, when);
		}
		assert.equal(outcome.ofType("RECORD").length, 11);
	};
	await importAt("2026-01-01T00:00:00.000Z");
	// Staged again, the same export has a new modification time.
	await importAt("2026-01-02T00:00:00.000Z");
});

test("#33 a stream whose legacy files are gone while its Google-era files remain has changed format", async () => {
	const outcome = await run(uploaded(canonicalMembers({ sleep: [] })));
	assertReason(outcome, "sleep", "export_format_changed", "empty");
	assert.deepEqual(outcome.coverage("sleep").fields_unavailable, []);
	for (const stream of ["activities", "daily_summaries"]) {
		assertReason(outcome, stream, "covered_in_full", "complete");
	}
});

test("#34 a minute file declaring more than its limit is not extracted, and only the days it could hold are blank", async () => {
	const rows = canonicalRows();
	const outcome = await run(
		uploaded(
			canonicalMembers({
				steps: [
					jsonMember("steps-2026-04-04.json", rows.stepsFirst),
					{
						...jsonMember("steps-2026-04-05.json", rows.stepsSecond),
						declaredSize: 17 * MIB,
					},
				],
			}),
		),
	);
	assertReason(outcome, "daily_summaries", "source_limit_reached", "partial");
	assert.equal(outcome.skipDiagnostics("daily_summaries").oversized_files, 1);
	assert.deepEqual(
		outcome.records("daily_summaries"),
		dailyRecords(withSteps([7, null, null, null])),
	);
	assert.deepEqual(outcome.coverage("daily_summaries").fields_unreadable, [
		"steps",
	]);
	// Only the first steps file's five rows were read.
	assert.equal(outcome.progressFamily("daily_summaries", "steps").rows, 5);
});

test("#35 a field only a row that could not be placed carried is never named unavailable", async () => {
	const rows = canonicalRows();
	const [, , weights] = rows.exercise;
	assert.ok(weights);
	const unplacedRestingRow = restingRow("garbage", { value: 58, error: 1 });
	// The one distance is on a log without an id. The one resting heart rate
	// is on a row without a day, beside padding rows that were placed.
	const beside = await run(
		uploaded(
			canonicalMembers({
				exercise: [
					jsonMember("exercise-0.json", [
						weights,
						without(exercise(), "logId"),
					]),
				],
				resting_heart_rate: [
					jsonMember("resting_heart_rate-2026-04-03.json", [
						...rows.restingHeartRate.map((row) => ({
							...row,
							value: { date: null, value: 0, error: 0 },
						})),
						unplacedRestingRow,
					]),
				],
			}),
		),
	);
	assertReason(beside, "activities", "records_unreadable", "partial");
	assert.deepEqual(
		beside.records("activities"),
		CANONICAL_RECORDS.activities?.slice(2, 3),
	);
	assertReason(beside, "daily_summaries", "records_unreadable", "partial");
	for (const stream of ["activities", "daily_summaries"]) {
		assert.deepEqual(beside.coverage(stream).fields_unavailable, [], stream);
	}

	// With no row of its family placed, the layout has changed: nothing is
	// named unavailable.
	const alone = await run(
		uploaded(
			canonicalMembers({
				resting_heart_rate: [
					jsonMember("resting_heart_rate-2026-04-03.json", [
						unplacedRestingRow,
					]),
				],
			}),
		),
	);
	assertReason(alone, "daily_summaries", "export_format_changed", "partial");
	assert.deepEqual(alone.coverage("daily_summaries").fields_unavailable, []);
	assert.deepEqual(alone.coverage("daily_summaries").fields_unreadable, [
		"resting_heart_rate_bpm",
	]);
});

test("#36 EACCES while opening a part is the device's, not the export's", {
	skip: IS_ROOT ? "root opens a file whatever its mode" : false,
}, async () => {
	const dir = uploaded();
	const path = join(dir, partName(1));
	chmodSync(path, 0o000);
	try {
		const outcome = await run(dir);
		assertAllFailed(outcome, "device_storage_unavailable", {
			code: "EACCES",
			failure: null,
		});
	} finally {
		chmodSync(path, 0o600);
	}
});

test("#37 every SKIP_RESULT carries the recovery hint for its reason and cause", async () => {
	const rows = canonicalRows();
	const csvOnly = importFolder();
	writeFileSync(join(csvOnly, "export.csv"), "date,steps\n2026-04-04,150\n");
	const noScratch = uploaded();
	const zip64 = importFolder();
	writeZip64SentinelZip(join(zip64, partName(1)), canonicalMembers());
	// A two-part export whose last part, holding the sleep logs and
	// Profile.csv, was not uploaded: nothing names the part as missing.
	const lastPartMissing = importFolder();
	const inLastPart = (member: ZipMember): boolean =>
		member.name === legacyMember("sleep-2026-03-14.json") ||
		member.name === profileMember();
	const [, lastPart] = writeParts(lastPartMissing, [
		canonicalMembers().filter((member) => !inLastPart(member)),
		canonicalMembers().filter(inLastPart),
	]);
	assert.ok(lastPart);
	rmSync(lastPart);
	const stepsInTwoParts = importFolder();
	writeParts(stepsInTwoParts, [
		canonicalMembers(),
		[jsonMember("steps-2026-04-05.json", rows.stepsSecond)],
	]);
	const unknownScoreHeader: ZipMember = {
		name: sleepScoreMember(),
		data: scoreCsv(
			SCORE_ROWS,
			SCORE_HEADER.map((cell) => (cell === "overall_score" ? "overall" : cell)),
		),
	};
	const noRetry = { action: "retry_by_runtime", retryable: true };
	const final = { action: "not_retriable", retryable: false };
	const cases: readonly (readonly [
		label: string,
		stream: string,
		dir: string,
		reason: string,
		hint: Message,
		env?: Readonly<Record<string, string>>,
	])[] = [
		["no upload", "activities", importFolder(), "awaiting_upload", OWNER_HINT],
		["not an export", "activities", csvOnly, "source_unreadable", OWNER_HINT],
		[
			"a part the zip policy refuses",
			"activities",
			uploaded([
				...canonicalMembers(),
				{
					name: `${ROOT}Physical Activity_GoogleData/huge.csv`,
					data: Buffer.alloc(0),
					method: "store",
					declaredSize: 0xff_ff_ff_ff,
				},
			]),
			"source_limit_reached",
			OWNER_HINT,
		],
		[
			"a part with ZIP64 sentinels",
			"activities",
			zip64,
			"source_limit_reached",
			OWNER_HINT,
		],
		[
			"a sleep file over its cap",
			"sleep",
			uploaded(
				canonicalMembers({
					sleep: [
						{
							...jsonMember("sleep-2026-03-14.json", rows.sleep),
							declaredSize: 300 * MIB,
						},
					],
				}),
			),
			"source_limit_reached",
			UPGRADE_HINT,
		],
		[
			"a score file over its cap",
			"sleep",
			uploaded(
				canonicalMembers({
					sleep_score: [
						{
							name: sleepScoreMember(),
							data: scoreCsv(),
							declaredSize: 9 * MIB,
						},
					],
				}),
			),
			"source_limit_reached",
			UPGRADE_HINT,
		],
		[
			"no scratch space",
			"activities",
			noScratch,
			"device_storage_unavailable",
			noRetry,
			{
				TMPDIR: join(noScratch, "no-such-directory"),
				TSX_DISABLE_CACHE: "1",
			},
		],
		[
			"a sleep file cut short",
			"sleep",
			uploaded(
				canonicalMembers({
					sleep: [
						{
							name: legacyMember("sleep-2026-03-14.json"),
							data: truncatedJson(rows.sleep, 2),
						},
					],
				}),
			),
			"collection_interrupted",
			OWNER_HINT,
		],
		[
			"the last part missing: no sleep logs beside Google-era sleep files",
			"sleep",
			lastPartMissing,
			"export_format_changed",
			OWNER_HINT,
		],
		[
			"the last part missing: no Profile.csv",
			"daily_summaries",
			lastPartMissing,
			"export_format_changed",
			OWNER_HINT,
		],
		[
			"only the Google-era layout",
			"activities",
			uploaded(
				neverReadMembers().filter((m) =>
					m.name.includes("Physical Activity_GoogleData/"),
				),
			),
			"export_format_changed",
			OWNER_HINT,
		],
		[
			"an unknown score header",
			"sleep",
			uploaded(canonicalMembers({ sleep_score: [unknownScoreHeader] })),
			"export_format_changed",
			UPGRADE_HINT,
		],
		[
			"an exercise page in an unknown layout",
			"activities",
			uploaded(
				canonicalMembers({
					exercise: [
						{
							name: legacyMember("exercise-0.json"),
							data: fitbitJson({ activities: rows.exercise }),
						},
					],
				}),
			),
			"export_format_changed",
			UPGRADE_HINT,
		],
		[
			"Profile.csv without a timezone column",
			"daily_summaries",
			uploaded(
				canonicalMembers({
					profile: [
						{
							name: profileMember(),
							data: profileCsv(
								[PROFILE_ROW],
								PROFILE_HEADER.map((cell) =>
									cell === "timezone" ? "tz" : cell,
								),
							),
						},
					],
				}),
			),
			"export_format_changed",
			UPGRADE_HINT,
		],
		[
			"no sleep logs and a score file over its cap: the owner's check first",
			"sleep",
			uploaded(
				canonicalMembers({
					sleep: [],
					sleep_score: [
						{
							name: sleepScoreMember(),
							data: scoreCsv(),
							declaredSize: 9 * MIB,
						},
					],
				}),
			),
			"source_limit_reached",
			OWNER_HINT,
		],
		[
			"no sleep logs and an unknown score header: the owner's check first",
			"sleep",
			uploaded(
				canonicalMembers({ sleep: [], sleep_score: [unknownScoreHeader] }),
			),
			"export_format_changed",
			OWNER_HINT,
		],
		[
			"an entry that cannot be placed",
			"daily_summaries",
			uploaded(
				canonicalMembers({
					lightly_active_minutes: [
						jsonMember("lightly_active_minutes-2026-04-03.json", [
							...rows.lightly,
							dailyRow("garbage", "5"),
						]),
					],
				}),
			),
			"records_unreadable",
			final,
		],
		[
			"a steps file in two parts",
			"daily_summaries",
			stepsInTwoParts,
			"records_unreadable",
			final,
		],
	];
	assert.deepEqual(
		[...new Set(cases.map(([, , , reason]) => reason))].sort(),
		[...SKIP_REASONS].sort(),
		"a case for every skip reason",
	);
	for (const [label, stream, dir, reason, hint, env] of cases) {
		const outcome = await run(dir, env === undefined ? {} : { env });
		assert.deepEqual(
			outcome.skips(stream).map((skip) => [skip.reason, skip.recovery_hint]),
			[[reason, hint]],
			label,
		);
	}
});

test("#38 a requested bound that names no real date is stated as unparsed, never as none or echoed", async () => {
	const outcome = await run(uploaded(), {
		timeRanges: {
			// Applied as text: every start sorts before it, so nothing arrives.
			activities: { since: "garbage-garbage" },
			// No month 13: every sleep date sorts before it, so all three arrive.
			sleep: { since: "2026-03-14", until: "2026-13-40" },
			// The runtime ignores an empty bound, and so does the line.
			daily_summaries: { since: "" },
		},
	});
	assert.deepEqual(outcome.records("activities"), []);
	assert.equal(outcome.progressDone("activities").outside_window, 4);
	assert.equal(
		outcome.coverage("activities").text,
		"coverage stream=activities status=empty reason=nothing_in_range delivered=0 fields_unavailable=none fields_unreadable=none window_requested_from=unparsed window_requested_to=none window_covered_from=none window_covered_to=none",
	);
	assert.equal(outcome.records("sleep").length, 3);
	const sleep = outcome.coverage("sleep");
	assert.equal(sleep.window_requested_from, "2026-03-14");
	assert.equal(sleep.window_requested_to, "unparsed");
	assert.equal(outcome.records("daily_summaries").length, 4);
	assert.equal(outcome.coverage("daily_summaries").window_requested_from, null);
	for (const bound of ["garbage", "2026-13-40"]) {
		assert.ok(!outcome.rawStdout.includes(bound), `${bound} is never echoed`);
	}
});
