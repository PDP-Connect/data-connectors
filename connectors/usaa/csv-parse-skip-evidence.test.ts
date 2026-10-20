// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Behavioral coverage for the USAA transactions CSV-parse skip evidence.
 *
 * Before this fix, `emitCsvTransactions` silently emitted nothing when a
 * downloaded CSV (i.e. not the known-empty export path) produced zero usable
 * transactions — a header-only file, or data rows that all failed the
 * header/shape checks in `rowsToTransactions`. The account then looked
 * successfully processed. It now emits one bounded SKIP_RESULT naming the
 * account ORDINAL (never the account number / last-four) so the run does not
 * look complete, and the caller does not advance this account's cursor.
 *
 * These tests write a real temp CSV (the function does readFile + cleanup),
 * call the exported `emitCsvTransactions`, and assert on the captured
 * protocol messages. The `progress-signal-invariants.test.ts` source-text
 * guard already proves no PROGRESS/SKIP template interpolates banned PII fields.
 */

import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { makeRecordingEmit } from "../../packages/polyfill-connectors/src/test-harness.ts";
import {
	emitCsvTransactions,
	classifyCsvTransactionResult,
	recoverServedAccountTransactionGaps,
	emitTransactionsDetailCoverage,
} from "./index.ts";
import { validateRecord } from "./schemas.ts";
import type { DashboardAccount } from "./types.ts";

function makeAccount(
	overrides: Partial<DashboardAccount> = {},
): DashboardAccount {
	return {
		account_id_raw: "acct-raw-0001",
		account_type: "checking",
		account_url: "https://example.com/acct",
		balance_cents: 1000,
		last_four: "0000",
		name: "Test Checking",
		raw_text: "Test Checking ...0000",
		...overrides,
	};
}

async function writeTempCsv(contents: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "usaa-csv-test-"));
	const path = join(dir, "usaa-export.csv");
	await writeFile(path, contents, "utf8");
	return path;
}

const VALID_CSV = [
	"Date,Description,Amount",
	"01/05/2026,Coffee Shop,-4.50",
	"01/06/2026,Paycheck,1200.00",
].join("\n");

// A header whose columns don't match any of the expected header regexes →
// every data row drops in rowsToTransactions → zero usable transactions.
const UNRECOGNIZED_HEADER_CSV = [
	"Col1,Col2,Col3",
	"foo,bar,baz",
	"qux,quux,corge",
].join("\n");

const HEADER_ONLY_CSV = "Date,Description,Amount\n";

test("emitCsvTransactions: CSV with data rows but zero usable transactions emits a bounded SKIP_RESULT", async () => {
	const harness = makeRecordingEmit(validateRecord);
	const path = await writeTempCsv(UNRECOGNIZED_HEADER_CSV);
	const result = await emitCsvTransactions(
		harness,
		path,
		makeAccount(),
		null,
		2,
		3,
	);

	assert.equal(harness.emitted.length, 0, "no transactions should be emitted");
	const skips = harness.protocolMessages.filter(
		(m) => m.type === "SKIP_RESULT",
	);
	assert.equal(skips.length, 1);
	assert.equal(
		skips[0]?.type === "SKIP_RESULT" ? skips[0].reason : "",
		"csv_no_usable_transactions",
	);
	const msg = skips[0]?.type === "SKIP_RESULT" ? skips[0].message : "";
	assert.match(
		msg,
		/CSV parsed no usable transactions from 2 data row\(s\) for account 2\/3/,
	);
	assert.deepEqual(
		skips[0]?.type === "SKIP_RESULT" ? skips[0].diagnostics : null,
		{
			account_ordinal: 2,
			account_total: 3,
			data_rows: 2,
		},
	);
	// No account number / last-four / name in the evidence.
	assert.doesNotMatch(msg, /0000|Test Checking|acct-raw/);
	assert.deepEqual(result, { dataRows: 2, latest: null, usableCount: 0 });
});

test("emitCsvTransactions: header-only CSV reports no data rows by ordinal", async () => {
	const harness = makeRecordingEmit(validateRecord);
	const path = await writeTempCsv(HEADER_ONLY_CSV);
	const result = await emitCsvTransactions(
		harness,
		path,
		makeAccount(),
		null,
		1,
		1,
	);

	const skips = harness.protocolMessages.filter(
		(m) => m.type === "SKIP_RESULT",
	);
	assert.equal(skips.length, 1);
	assert.equal(
		skips[0]?.type === "SKIP_RESULT" ? skips[0].reason : "",
		"csv_no_data_rows",
	);
	const msg = skips[0]?.type === "SKIP_RESULT" ? skips[0].message : "";
	assert.match(msg, /CSV had no data rows for account 1\/1/);
	assert.deepEqual(result, { dataRows: 0, latest: null, usableCount: 0 });
});

test("emitCsvTransactions: a parseable CSV emits transactions and NO parse-loss SKIP_RESULT", async () => {
	const harness = makeRecordingEmit(validateRecord);
	const path = await writeTempCsv(VALID_CSV);
	const result = await emitCsvTransactions(
		harness,
		path,
		makeAccount(),
		null,
		1,
		1,
	);

	assert.equal(
		harness.emitted.filter((r) => r.stream === "transactions").length,
		2,
	);
	assert.equal(
		harness.protocolMessages.filter((m) => m.type === "SKIP_RESULT").length,
		0,
		"a CSV that yields transactions must not emit a parse-loss SKIP_RESULT",
	);
	assert.deepEqual(
		result,
		{ dataRows: 2, latest: "2026-01-06", usableCount: 2 },
		"returns parse outcome plus latest transaction date seen",
	);
});

for (const [name, csv, count, expected] of [
	[
		"mixed",
		"Date,Description,Amount\n01/05/2026,Coffee,-4.50\nnot-a-date,Unparsed,12.00\n",
		1,
		"gap",
	],
	[
		"all-invalid",
		"Date,Description,Amount\nnot-a-date,Unparsed,12.00\n",
		0,
		"gap",
	],
	["empty", "Date,Description,Amount\n", 0, "no_activity"],
	["all-valid", VALID_CSV, 2, "hydrated"],
] as const) {
	test(`CSV ${name}: actual parser and account credit preserve unparsed debt`, async () => {
		const harness = makeRecordingEmit(validateRecord);
		const result = await emitCsvTransactions(
			harness,
			await writeTempCsv(csv),
			makeAccount(),
			"2025-01-01",
			1,
			1,
		);
		assert.equal(harness.emitted.length, count, "retain every valid record");
		const account = classifyCsvTransactionResult(
			"acct-raw-0001",
			"2025-01-01",
			"2025-01-01",
			result,
		);
		assert.equal(account.outcome.kind, expected);
		if (expected !== "hydrated") assert.equal(account.last_date, "2025-01-01");
		if (name === "mixed") {
			assert.ok(
				harness.protocolMessages.some(
					(m) => m.type === "SKIP_RESULT" && m.reason === "csv_partial_parse",
				),
			);
		}
	});
}

test("CSV valid rows excluded downstream do not become parse failures", async () => {
	const harness = makeRecordingEmit(validateRecord);
	const result = await emitCsvTransactions(
		{ ...harness, emitRecord: async () => undefined },
		await writeTempCsv(VALID_CSV),
		makeAccount(),
		null,
		1,
		1,
	);
	assert.equal(
		result.usableCount,
		2,
		"candidate disposition precedes local emission filtering",
	);
	assert.equal(
		classifyCsvTransactionResult("acct-raw-0001", null, null, result).outcome
			.kind,
		"hydrated",
	);
	assert.equal(
		harness.protocolMessages.filter((m) => m.type === "SKIP_RESULT").length,
		0,
	);
});

test("CSV blank separator rows are not malformed transaction candidates", async () => {
	const harness = makeRecordingEmit(validateRecord);
	const result = await emitCsvTransactions(
		harness,
		await writeTempCsv(VALID_CSV + "\n, ,\n"),
		makeAccount(),
		null,
		1,
		1,
	);
	assert.equal(result.dataRows, 2);
	assert.equal(
		classifyCsvTransactionResult("acct-raw-0001", null, null, result).outcome
			.kind,
		"hydrated",
	);
});

for (const [name, csv, count] of [
	[
		"stray quote preserves later siblings",
		'Date,Description,Amount\n01/05/2026,Coffee,-4.50\n01/06/2026,PIZZA 5" PAN,-12.00\n01/07/2026,Later,0.00\n01/08/2026,Last,2.00',
		3,
	],
	[
		"unclosed quoted tail",
		'Date,Description,Amount\n01/05/2026,Coffee,-4.50\n01/06/2026,"Unclosed,-12.00\n01/07/2026,Ambiguous,3.00',
		1,
	],
	[
		"text after closing quote",
		'Date,Description,Amount\n01/06/2026,"Pizza"x,-12.00\n01/07/2026,Later,2.00',
		1,
	],
	["malformed only", 'Date,Description,Amount\n01/06/2026,"Unclosed,-12.00', 0],
	["malformed header", '"Date,Description,Amount', 0],
	[
		"invalid calendar mixed",
		"Date,Description,Amount\n02/28/2026,Good,-4.50\n02/30/2026,Bad,12.00",
		1,
	],
	["invalid calendar only", "Date,Description,Amount\n2026-02-29,Bad,12.00", 0],
] as const) {
	test(`CSV integrity: ${name} cannot settle a served gap`, async () => {
		const harness = makeRecordingEmit(validateRecord);
		const deps = {
			...harness,
			servedAccountTransactionGaps: new Map([["acct-raw-0001", "served-gap"]]),
		};
		const result = await emitCsvTransactions(
			deps,
			await writeTempCsv(csv),
			makeAccount(),
			"2025-01-01",
			1,
			1,
		);
		const account = classifyCsvTransactionResult(
			"acct-raw-0001",
			"2025-01-01",
			"2025-01-01",
			result,
		);
		assert.equal(
			account.outcome.kind,
			"gap",
			"malformed source must not certify full account coverage",
		);
		assert.equal(account.last_date, "2025-01-01");
		assert.equal(
			harness.emitted.length,
			count,
			"retain only unambiguous valid siblings",
		);
		await recoverServedAccountTransactionGaps(deps, [account.outcome]);
		await emitTransactionsDetailCoverage(deps, [account.outcome], true);
		assert.equal(
			harness.protocolMessages.some((m) => m.type === "DETAIL_GAP_RECOVERED"),
			false,
		);
		const coverage = harness.protocolMessages.find(
			(m) => m.type === "DETAIL_COVERAGE",
		);
		assert.ok(coverage && coverage.type === "DETAIL_COVERAGE");
		assert.deepEqual(coverage.hydrated_keys, []);
		assert.ok(
			harness.protocolMessages.some(
				(m) => m.type === "SKIP_RESULT" && m.reason !== "csv_no_data_rows",
			),
		);
	});
}

test("CSV integrity: quoted commas, multiline fields, escaped quotes and leap dates stay complete", async () => {
	const harness = makeRecordingEmit(validateRecord);
	const csv =
		'Date,Description,Amount\r\n02/29/2024,"Coffee, shop",-4.50\r\n2024-03-01,"Line one\nLine two",0.00\r\n03/02/2024,"PIZZA 5"" PAN",12.00\r\n';
	const result = await emitCsvTransactions(
		harness,
		await writeTempCsv(csv),
		makeAccount(),
		"2023-01-01",
		1,
		1,
	);
	assert.equal(result.usableCount, 3);
	assert.equal(result.dataRows, 3, "count logical records, not physical lines");
	assert.equal(harness.emitted.length, 3);
	assert.equal(
		classifyCsvTransactionResult("acct-raw-0001", "2023-01-01", null, result)
			.outcome.kind,
		"hydrated",
	);
	assert.equal(
		harness.protocolMessages.some((m) => m.type === "SKIP_RESULT"),
		false,
	);
});
