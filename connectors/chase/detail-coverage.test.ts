// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Chase account -> transactions DETAIL_COVERAGE evidence.
 *
 * Chase's `accounts` stream is an enumerated inventory: a real, known
 * denominator for the per-account QFX detail fan-out. These tests pin the
 * honest coverage the connector emits over that fan-out:
 *   - every considered account lands in `required_keys`;
 *   - a reached account (parsed QFX, even 0 transactions) is hydrated;
 *   - a source-limited no-activity account is ALSO hydrated coverage, never
 *     a gap (Chase's "won't backfill" windows are complete, not broken);
 *   - a transient QFX failure is a retryable DETAIL_GAP keyed by account id
 *     AND lands in `gap_keys`, so the run is honestly partial and the
 *     runtime's coverage invariant stays satisfiable;
 *   - the report is suppressed when the denominator is not genuinely known
 *     (accounts or transactions out of scope, or zero accounts considered)
 *     rather than inventing a `complete` projection.
 *
 * These exercise the exported helpers directly through the recording
 * harness — the same pattern integration.test.ts uses — so they validate
 * the emitted protocol messages without driving Playwright.
 *
 * The bottom section also pins Chase's statement-PDF posture: statement index
 * rows are covered source metadata, while missing local PDF bytes are optional
 * detail evidence, not a source coverage gap.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	EmittedMessage,
	StreamScope,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { makeRecordingEmit } from "../../packages/polyfill-connectors/src/test-harness.ts";
import {
	type AccountDetailOutcome,
	buildAccountDetailGap,
	type EmitDeps,
	emitStatementDetailCoverage,
	emitTransactionsDetailCoverage,
	emitTransactionsStateIfAny,
	parseQfxFile,
	processParsedAccountQfx,
	recoverServedAccountGaps,
	type StatementDetailOutcome,
} from "./index.ts";
import { validateRecord } from "./schemas.ts";
import type { TransactionCursor, TransactionsStateShape } from "./types.ts";

const FROZEN_EMITTED_AT = "2026-04-22T12:00:00.000Z";

interface HarnessOverrides {
	maxSeenByAccount?: Record<string, TransactionCursor>;
	requestedStreams?: readonly StreamScope[];
	resFilters?: Map<string, ReadonlySet<string> | null>;
	txState?: TransactionsStateShape;
	wantsAccounts?: boolean;
	wantsBalances?: boolean;
	wantsCurrentActivity?: boolean;
	wantsStatements?: boolean;
	wantsTransactions?: boolean;
}

interface Harness {
	deps: EmitDeps;
	messages: EmittedMessage[];
}

function makeHarness(overrides: HarnessOverrides = {}): Harness {
	const harness = makeRecordingEmit(validateRecord);
	const requestedStreams = overrides.requestedStreams ?? [
		{ name: "accounts" },
		{ name: "transactions" },
		{ name: "balances" },
		{ name: "statements" },
	];
	const requested = new Map<string, StreamScope>(
		requestedStreams.map((s) => [s.name, s]),
	);
	const deps: EmitDeps = {
		capture: null,
		emit: harness.emit,
		emitRecord: harness.emitRecord,
		emittedAt: FROZEN_EMITTED_AT,
		maxSeenByAccount: overrides.maxSeenByAccount ?? {},
		progress: (): Promise<void> => Promise.resolve(),
		requested,
		resFilters: overrides.resFilters ?? new Map(),
		tmpDir: "/tmp/pdpp-chase-test-noop",
		txState: overrides.txState ?? {},
		wantsAccounts: overrides.wantsAccounts ?? true,
		wantsBalances: overrides.wantsBalances ?? true,
		wantsCurrentActivity: overrides.wantsCurrentActivity ?? true,
		wantsStatements: overrides.wantsStatements ?? true,
		wantsTransactions: overrides.wantsTransactions ?? true,
	};
	return { deps, messages: harness.protocolMessages };
}

function coverageOf(
	messages: EmittedMessage[],
): Extract<EmittedMessage, { type: "DETAIL_COVERAGE" }> | undefined {
	return messages.find(
		(m): m is Extract<EmittedMessage, { type: "DETAIL_COVERAGE" }> =>
			m.type === "DETAIL_COVERAGE",
	);
}

// ─── buildAccountDetailGap ──────────────────────────────────────────────

test("buildAccountDetailGap: a transient QFX failure becomes a retryable, reference-only gap keyed by account id", () => {
	const gap = buildAccountDetailGap({
		accountId: "INTACC123",
		reason: "temporary_unavailable",
		errorClass: "qfx_download_failed",
	});
	assert.deepEqual(gap, {
		type: "DETAIL_GAP",
		stream: "transactions",
		parent_stream: "accounts",
		record_key: "INTACC123",
		status: "pending",
		reason: "temporary_unavailable",
		detail_locator: {
			kind: "chase.account",
			account_id: "INTACC123",
		},
		retryable: true,
		reference_only: true,
		detail: { class: "qfx_download_failed" },
		last_error: { class: "qfx_download_failed" },
	});
});

test("buildAccountDetailGap: locator carries only the account id, never PII (name/last_four)", () => {
	const gap = buildAccountDetailGap({
		accountId: "INTACC123",
		reason: "temporary_unavailable",
		errorClass: "qfx_parse_failed",
	});
	const locatorValues = Object.values(gap.detail_locator).map((v) => String(v));
	assert.ok(
		!locatorValues.includes("Sapphire Preferred"),
		"no account name in locator",
	);
	assert.ok(!locatorValues.includes("9241"), "no last_four in locator");
});

// ─── emitTransactionsDetailCoverage: honest hydrated/gap classification ──

test("emitTransactionsDetailCoverage: all accounts hydrated -> complete coverage, no gap_keys", async () => {
	const { deps, messages } = makeHarness();
	const outcomes: AccountDetailOutcome[] = [
		{ kind: "hydrated", accountId: "ACC-1" },
		{ kind: "hydrated", accountId: "ACC-2" },
	];
	await emitTransactionsDetailCoverage(deps, outcomes);

	const coverage = coverageOf(messages);
	assert.deepEqual(coverage, {
		type: "DETAIL_COVERAGE",
		reference_only: true,
		state_stream: "accounts",
		stream: "transactions",
		required_keys: ["ACC-1", "ACC-2"],
		hydrated_keys: ["ACC-1", "ACC-2"],
		considered: 2,
		covered: 2,
	});
});

test("emitTransactionsDetailCoverage: a source-limited no-activity account is HYDRATED coverage, never a gap", async () => {
	const { deps, messages } = makeHarness();
	const outcomes: AccountDetailOutcome[] = [
		{ kind: "hydrated", accountId: "ACC-1" },
		{ kind: "no_activity", accountId: "ACC-2" },
	];
	await emitTransactionsDetailCoverage(deps, outcomes);

	const coverage = coverageOf(messages);
	assert.ok(coverage, "expected a DETAIL_COVERAGE message");
	// No-activity is "won't backfill" completeness: the account was reached,
	// the source had nothing. It must be hydrated, NOT a gap.
	assert.deepEqual(coverage.required_keys, ["ACC-1", "ACC-2"]);
	assert.deepEqual(coverage.hydrated_keys, ["ACC-1", "ACC-2"]);
	assert.equal(
		coverage.considered,
		2,
		"the run still accounted for both considered accounts",
	);
	assert.equal(
		coverage.covered,
		2,
		"no-activity counts as covered, not collected-only",
	);
	assert.equal(
		coverage.gap_keys,
		undefined,
		"no-activity must not appear in gap_keys",
	);
});

test("emitTransactionsDetailCoverage: a transient QFX failure makes the run partial via gap_keys", async () => {
	const { deps, messages } = makeHarness();
	const outcomes: AccountDetailOutcome[] = [
		{ kind: "hydrated", accountId: "ACC-1" },
		{
			kind: "gap",
			accountId: "ACC-2",
			reason: "temporary_unavailable",
			errorClass: "qfx_download_failed",
		},
	];
	await emitTransactionsDetailCoverage(deps, outcomes);

	const coverage = coverageOf(messages);
	assert.ok(coverage, "expected a DETAIL_COVERAGE message");
	assert.deepEqual(coverage.required_keys, ["ACC-1", "ACC-2"]);
	assert.deepEqual(coverage.hydrated_keys, ["ACC-1"]);
	assert.deepEqual(
		coverage.gap_keys,
		["ACC-2"],
		"the failed account is reported as a gap, not silently complete",
	);
	assert.equal(coverage.considered, 2, "the run considered both accounts");
	assert.equal(
		coverage.covered,
		1,
		"a failed account is not counted as covered",
	);
});

// ─── emitTransactionsDetailCoverage: known-zero vs unknown-scope ─────────

test("emitTransactionsDetailCoverage: zero outcomes still emits an explicit considered:0/covered:0 report (known-zero, not unmeasured)", async () => {
	// emitTransactionsDetailCoverage's only caller, runTransactionsAndBalances,
	// is only ever reached after discoverAccounts() finds at least one account
	// (a zero-accounts-at-source enumeration returns early via
	// emitNoAccountsDiagnostic before this call chain — see
	// runTransactionsAndBalances's doc comment in index.ts). So an empty
	// `outcomes` here always means a real resource filter narrowed a genuine,
	// non-empty enumeration to zero eligible accounts: a proven 0/0, not an
	// unknown denominator. Suppressing this case would leave a real, completed
	// scoped run permanently unmeasured — the same defect class fixed for
	// Chase `balances` (connectors/chase/index.ts,
	// accountDetailCoverageKeys).
	const { deps, messages } = makeHarness();
	await emitTransactionsDetailCoverage(deps, []);

	const coverage = coverageOf(messages);
	assert.deepEqual(coverage, {
		type: "DETAIL_COVERAGE",
		reference_only: true,
		state_stream: "accounts",
		stream: "transactions",
		required_keys: [],
		hydrated_keys: [],
		considered: 0,
		covered: 0,
	});
});

test("emitTransactionsDetailCoverage: emits nothing when transactions are out of scope", async () => {
	const { deps, messages } = makeHarness({
		requestedStreams: [{ name: "accounts" }],
		wantsTransactions: false,
	});
	await emitTransactionsDetailCoverage(deps, [
		{ kind: "hydrated", accountId: "ACC-1" },
	]);
	assert.equal(
		coverageOf(messages),
		undefined,
		"the detail stream must be in scope before its coverage is declared",
	);
});

test("emitTransactionsDetailCoverage: emits nothing when accounts (the state_stream) is out of scope", async () => {
	const { deps, messages } = makeHarness({
		requestedStreams: [{ name: "transactions" }],
		wantsAccounts: false,
	});
	await emitTransactionsDetailCoverage(deps, [
		{ kind: "hydrated", accountId: "ACC-1" },
	]);
	assert.equal(
		coverageOf(messages),
		undefined,
		"the state_stream anchor must be in scope before coverage is declared",
	);
});

// ─── shape-level invariants the runtime relies on ───────────────────────

test("emitTransactionsDetailCoverage: required_keys is the union of hydrated + gap keys (every account accounted for)", async () => {
	const { deps, messages } = makeHarness();
	const outcomes: AccountDetailOutcome[] = [
		{ kind: "hydrated", accountId: "ACC-1" },
		{ kind: "no_activity", accountId: "ACC-2" },
		{
			kind: "gap",
			accountId: "ACC-3",
			reason: "temporary_unavailable",
			errorClass: "qfx_parse_failed",
		},
	];
	await emitTransactionsDetailCoverage(deps, outcomes);

	const coverage = coverageOf(messages);
	assert.ok(coverage);
	const accountedFor = new Set([
		...coverage.hydrated_keys,
		...(coverage.gap_keys ?? []),
	]);
	assert.deepEqual(
		[...coverage.required_keys].sort(),
		[...accountedFor].sort(),
		"every required account is either hydrated or a gap — no key silently dropped",
	);
	assert.equal(
		coverage.considered,
		3,
		"the run considered every emitted outcome",
	);
	assert.equal(
		coverage.covered,
		2,
		"only hydrated + no-activity outcomes are covered",
	);
});

// ─── emitStatementDetailCoverage: metadata covered, PDF detail optional ──

test("emitStatementDetailCoverage: all statement PDFs hydrated -> complete statement coverage", async () => {
	const { deps, messages } = makeHarness();
	const outcomes: StatementDetailOutcome[] = [
		{ kind: "hydrated", id: "STMT-1" },
		{ kind: "hydrated", id: "STMT-2" },
	];
	await emitStatementDetailCoverage(deps, outcomes);

	const coverage = coverageOf(messages);
	assert.deepEqual(coverage, {
		type: "DETAIL_COVERAGE",
		reference_only: true,
		state_stream: "statements",
		stream: "statements",
		required_keys: ["STMT-1", "STMT-2"],
		hydrated_keys: ["STMT-1", "STMT-2"],
		considered: 2,
		covered: 2,
	});
});

test("emitStatementDetailCoverage: PDF download failure emits DETAIL_GAP, not optional_skip_keys", async () => {
	const { deps, messages } = makeHarness();
	const outcomes: StatementDetailOutcome[] = [
		{ kind: "hydrated", id: "STMT-1" },
		{
			kind: "gap",
			id: "STMT-2",
			reason: "temporary_unavailable",
			errorClass: "pdf_download_failed",
		},
	];
	await emitStatementDetailCoverage(deps, outcomes);

	const coverage = coverageOf(messages);
	assert.ok(coverage, "expected a DETAIL_COVERAGE message");
	assert.deepEqual(coverage.required_keys, ["STMT-1", "STMT-2"]);
	assert.deepEqual(coverage.hydrated_keys, ["STMT-1"]);
	assert.deepEqual(
		coverage.gap_keys,
		["STMT-2"],
		"missing local PDF bytes due to transport failure is a retryable gap",
	);
	assert.equal(
		coverage.optional_skip_keys,
		undefined,
		"transport failures must not populate optional_skip_keys",
	);
	assert.equal(
		coverage.considered,
		2,
		"both statement index rows were enumerated",
	);
	assert.equal(
		coverage.covered,
		1,
		"only hydrated statements count as covered; gaps are partial",
	);

	const gaps = messages.filter(
		(m): m is Extract<EmittedMessage, { type: "DETAIL_GAP" }> =>
			m.type === "DETAIL_GAP",
	);
	assert.equal(gaps.length, 1, "one DETAIL_GAP emitted for the failed PDF");
	assert.ok(
		gaps.some((g) => g.record_key === "STMT-2"),
		"gap keyed by statement ID",
	);
});

test("emitStatementDetailCoverage: gap outcome with no carried hydration remains a retryable gap", async () => {
	// A first-time statement (no prior PDF pointers) whose PDF download fails this run
	// is a genuine first-time gap that must be retried.
	const { deps, messages } = makeHarness();
	const outcomes: StatementDetailOutcome[] = [
		{
			kind: "gap",
			id: "NEW-STMT",
			reason: "temporary_unavailable",
			errorClass: "pdf_download_failed",
		},
	];
	await emitStatementDetailCoverage(deps, outcomes);

	const coverage = coverageOf(messages);
	assert.ok(coverage);
	assert.deepEqual(coverage.required_keys, ["NEW-STMT"]);
	assert.deepEqual(coverage.hydrated_keys, []);
	assert.deepEqual(
		coverage.gap_keys,
		["NEW-STMT"],
		"first-time statement with failed PDF is a retryable gap",
	);
	assert.equal(coverage.covered, 0, "gap outcome does not count as covered");

	const gaps = messages.filter(
		(m): m is Extract<EmittedMessage, { type: "DETAIL_GAP" }> =>
			m.type === "DETAIL_GAP",
	);
	assert.equal(gaps.length, 1);
	assert.ok(
		gaps.some(
			(g) =>
				g.record_key === "NEW-STMT" && g.reason === "temporary_unavailable",
		),
	);
});

test("emitStatementDetailCoverage: emits nothing when statements are out of scope", async () => {
	const { deps, messages } = makeHarness({
		requestedStreams: [{ name: "accounts" }],
		wantsStatements: false,
	});
	await emitStatementDetailCoverage(deps, [{ kind: "hydrated", id: "STMT-1" }]);
	assert.equal(
		coverageOf(messages),
		undefined,
		"statement coverage must not emit outside requested scope",
	);
});

test("emitStatementDetailCoverage: a steady-state run with zero statement rows still emits considered 0 / covered 0", async () => {
	const { deps, messages } = makeHarness();
	await emitStatementDetailCoverage(deps, []);

	const coverage = coverageOf(messages);
	assert.deepEqual(coverage, {
		type: "DETAIL_COVERAGE",
		reference_only: true,
		state_stream: "statements",
		stream: "statements",
		required_keys: [],
		hydrated_keys: [],
		considered: 0,
		covered: 0,
	});
});

// ─── Real QFX extraction -> production account credit ──────────────────

const VALID_QFX_ROW =
	"<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20260415</DTPOSTED><TRNAMT>-12.34</TRNAMT><FITID>valid-1</FITID></STMTTRN>";
const QFX_ACCOUNT = {
	internal_id: "ACC-QFX",
	name: "Fixture checking",
	type: "checking" as const,
	last_four: "1234",
};
const PRIOR_QFX_CURSOR = {
	max_seen_date: "2026-04-01",
	last_activity: "all" as const,
	last_fetched_at: "2026-04-02T00:00:00.000Z",
};

async function runQfxFixture(
	rows: string,
	options: {
		prior?: boolean;
		body?: string;
		since?: string;
	} = {},
) {
	const dir = await mkdtemp(join(tmpdir(), "chase-partial-qfx-"));
	try {
		const path = join(dir, "activity.qfx");
		await writeFile(
			path,
			options.body ??
				`<?xml version="1.0"?>
<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>USD</CURDEF>
<BANKTRANLIST><DTSTART>20260401</DTSTART><DTEND>20260422</DTEND>${rows}</BANKTRANLIST>
</STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`,
		);
		const { deps, messages } = makeHarness({
			wantsBalances: false,
			maxSeenByAccount:
				options.prior === false
					? {}
					: {
							[QFX_ACCOUNT.internal_id]: { ...PRIOR_QFX_CURSOR },
						},
		});
		if (options.since) {
			deps.requested.set("transactions", {
				name: "transactions",
				time_range: { since: options.since },
			});
		}
		deps.servedAccountGaps = new Map([[QFX_ACCOUNT.internal_id, "served-gap"]]);
		const records: Record<string, unknown>[] = [];
		const emitRecord = deps.emitRecord;
		deps.emitRecord = async (stream, record) => {
			// Model the runtime's proven scope exclusion, not a parser failure.
			if (
				stream === "transactions" &&
				options.since &&
				typeof record.date === "string" &&
				record.date < options.since
			)
				return;
			if (stream === "transactions") records.push(record);
			return emitRecord(stream, record);
		};
		const parsed = await parseQfxFile(path);
		const outcome = await processParsedAccountQfx(
			deps,
			QFX_ACCOUNT,
			"all",
			parsed,
		);
		if (outcome.kind === "gap") await deps.emit(buildAccountDetailGap(outcome));
		await recoverServedAccountGaps(deps, [outcome]);
		await emitTransactionsDetailCoverage(deps, [outcome]);
		await emitTransactionsStateIfAny(deps);
		return { deps, messages, outcome, records };
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

for (const [label, badRow] of [
	[
		"missing date",
		"<STMTTRN><TRNAMT>8.00</TRNAMT><FITID>undated</FITID></STMTTRN>",
	],
	[
		"missing identity",
		"<STMTTRN><DTPOSTED>20260410</DTPOSTED><TRNAMT>8.00</TRNAMT></STMTTRN>",
	],
	[
		"invalid date",
		"<STMTTRN><DTPOSTED>20260230</DTPOSTED><TRNAMT>8.00</TRNAMT><FITID>invalid-day</FITID></STMTTRN>",
	],
] as const) {
	test(`real QFX partial parse: ${label} holds account credit and prior watermark`, async () => {
		const { deps, messages, outcome, records } = await runQfxFixture(
			VALID_QFX_ROW + badRow,
		);
		assert.equal(outcome.kind, "gap");
		assert.deepEqual(
			records.map((r) => r.fitid),
			["valid-1"],
			"valid sibling is retained",
		);
		assert.deepEqual(
			deps.maxSeenByAccount[QFX_ACCOUNT.internal_id],
			PRIOR_QFX_CURSOR,
		);
		const coverage = coverageOf(messages);
		assert.deepEqual(coverage?.hydrated_keys, []);
		assert.deepEqual(coverage?.gap_keys, [QFX_ACCOUNT.internal_id]);
		assert.equal(
			messages.some((m) => m.type === "DETAIL_GAP_RECOVERED"),
			false,
		);
		const gap = messages.find((m) => m.type === "DETAIL_GAP");
		assert.ok(gap && gap.type === "DETAIL_GAP");
		assert.equal(gap.retryable, true);
		assert.equal(gap.record_key, QFX_ACCOUNT.internal_id);
		const state = messages.find(
			(m) => m.type === "STATE" && m.stream === "transactions",
		);
		assert.ok(state && state.type === "STATE");
		const cursor = state.cursor as { per_account?: unknown } | undefined;
		assert.deepEqual(cursor?.per_account, {
			[QFX_ACCOUNT.internal_id]: PRIOR_QFX_CURSOR,
		});
	});

	test(`real QFX malformed-only: ${label} is not empty success`, async () => {
		const { deps, messages, outcome, records } = await runQfxFixture(badRow, {
			prior: false,
		});
		assert.equal(outcome.kind, "gap");
		assert.equal(records.length, 0);
		assert.deepEqual(deps.maxSeenByAccount, {});
		assert.deepEqual(coverageOf(messages)?.hydrated_keys, []);
		assert.equal(
			messages.some((m) => m.type === "DETAIL_GAP_RECOVERED"),
			false,
		);
	});
}

test("real QFX all-valid control credits account and advances watermark", async () => {
	const { deps, messages, outcome, records } =
		await runQfxFixture(VALID_QFX_ROW);
	assert.equal(outcome.kind, "hydrated");
	assert.equal(records.length, 1);
	assert.equal(
		deps.maxSeenByAccount[QFX_ACCOUNT.internal_id]?.max_seen_date,
		"2026-04-15",
	);
	assert.deepEqual(coverageOf(messages)?.hydrated_keys, [
		QFX_ACCOUNT.internal_id,
	]);
	assert.equal(
		messages.some((m) => m.type === "DETAIL_GAP"),
		false,
	);
	assert.equal(
		messages.some((m) => m.type === "DETAIL_GAP_RECOVERED"),
		true,
	);
});

test("real QFX source-empty control remains hydrated without inventing a cursor", async () => {
	const { deps, messages, outcome, records } = await runQfxFixture("", {
		prior: false,
	});
	assert.equal(outcome.kind, "hydrated");
	assert.equal(records.length, 0);
	assert.deepEqual(deps.maxSeenByAccount, {});
	assert.deepEqual(coverageOf(messages)?.hydrated_keys, [
		QFX_ACCOUNT.internal_id,
	]);
});

test("real QFX missing transaction-list shape is not a proven empty ledger", async () => {
	const { outcome } = await runQfxFixture("", {
		body: "<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>USD</CURDEF></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>",
	});
	assert.equal(outcome.kind, "gap");
});

test("real QFX partial first run retains valid rows without inventing a watermark", async () => {
	const malformed =
		"<STMTTRN><TRNAMT>8.00</TRNAMT><FITID>undated</FITID></STMTTRN>";
	const { deps, outcome, records, messages } = await runQfxFixture(
		VALID_QFX_ROW + malformed,
		{ prior: false },
	);
	assert.equal(outcome.kind, "gap");
	assert.deepEqual(
		records.map((r) => r.fitid),
		["valid-1"],
	);
	assert.deepEqual(deps.maxSeenByAccount, {});
	assert.equal(
		messages.some((m) => m.type === "STATE"),
		false,
	);
});

test("real QFX valid row excluded by scope does not become malformed debt", async () => {
	const { outcome, records, messages } = await runQfxFixture(VALID_QFX_ROW, {
		since: "2026-05-01",
	});
	assert.equal(outcome.kind, "hydrated");
	assert.equal(
		records.length,
		0,
		"recording emitter enforces the known date exclusion",
	);
	assert.equal(
		messages.some((m) => m.type === "DETAIL_GAP"),
		false,
	);
	assert.deepEqual(coverageOf(messages)?.hydrated_keys, [
		QFX_ACCOUNT.internal_id,
	]);
});
