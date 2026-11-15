// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { parseExport } from "./parsers.ts";
import { EXPORT_TEMPLATE } from "./template.ts";

const report = (
	reportID: string,
	status: string,
	extra: Record<string, unknown> = {},
) => ({
	kind: "report",
	reportID,
	reportName: "Travel",
	status,
	currency: "USD",
	total: 12345,
	created: "2026-01-05",
	submitted: "",
	approved: "",
	reimbursed: "",
	entryID: "",
	isACHReimbursed: false,
	...extra,
});
const expense = (
	transactionID: string,
	extra: Record<string, unknown> = {},
) => ({
	kind: "expense",
	transactionID,
	reportID: "r1",
	merchant: "Original",
	created: "2026-01-05 23:59:58",
	amount: -1234,
	currency: "USD",
	...extra,
});
const lines = (...rows: unknown[]) =>
	rows.map((row) => JSON.stringify(row)).join("\n");

test("owned export maps modified/card/FX fields, all statuses, reimbursements and repeats", () => {
	const rows = [
		expense("t1", {
			modifiedMerchant: 'Corrected "Shop"\nLine',
			modifiedAmount: 0,
			bank: "Card Bank",
			cardTitle: "Business",
			receiptID: "receipt-1",
			reimbursable: true,
			billable: false,
			inserted: "2026-01-06 01:02:03",
			accountEmail: "private-marker@example.invalid",
		}),
		expense("fx", { currency: "EUR", convertedAmount: 1400, amount: 1200 }),
		...["Open", "Processing", "Approved", "Reimbursed", "Closed", "Future"].map(
			(status, i) => report("state" + i, status),
		),
		report("ach", "Reimbursed", {
			entryID: "pay-ach",
			reimbursed: "2026-02-01 09:10:11",
			isACHReimbursed: true,
		}),
		report("other", "Reimbursed", {
			entryID: "pay-other",
			reimbursed: "2026-02-02",
			isACHReimbursed: false,
		}),
		report("no-id", "Reimbursed", { reimbursed: "2026-02-02", entryID: "" }),
		expense("fx", { currency: "EUR", convertedAmount: 1500, amount: 1300 }),
	];
	const parsed = parseExport(
		lines(...rows) + "\n\nnot-json\n" + lines(expense("bad", { amount: 1.25 })),
	);
	assert.equal(parsed.expenses.length, 2);
	const card = parsed.expenses.find((r) => r.id === "t1")!;
	assert.equal(card.merchant, 'Corrected "Shop"\nLine');
	assert.equal(card.original_merchant, "Original");
	assert.equal(card.amount_minor, 0);
	assert.equal(card.report_amount_minor, null);
	assert.equal(card.expense_date, "2026-01-05 23:59:58");
	assert.equal(card.inserted_at, "2026-01-06 01:02:03");
	assert.equal(card.card_bank, "Card Bank");
	assert.equal(card.card_name, "Business");
	assert.equal(card.receipt_present, true);
	assert.equal(card.reimbursable, true);
	assert.equal(card.billable, false);
	assert.equal(
		parsed.expenses.find((r) => r.id === "fx")?.report_amount_minor,
		1500,
	);
	assert.deepEqual(
		parsed.reports.slice(0, 6).map((r) => r.status_normalized),
		["open", "processing", "approved", "reimbursed", "closed", "unknown"],
	);
	assert.equal(parsed.reimbursements.length, 2);
	assert.deepEqual(
		parsed.reimbursements.map((r) => [
			r.id,
			r.method,
			r.amount_minor,
			r.amount_source,
		]),
		[
			["pay-ach", "ach", 12345, "report_total"],
			["pay-other", "unknown", 12345, "report_total"],
		],
	);
	assert.deepEqual(parsed.rejected, [
		{ line: rows.length + 2, reason: "invalid_json" },
		{ line: rows.length + 3, reason: "invalid_export_row" },
	]);
	assert.equal(JSON.stringify(parsed).includes("private-marker"), false);
	assert.equal("accountEmail" in card, false);
});

test("dates stay local, missing fields stay null, and malformed rows are rejected", () => {
	const parsed = parseExport(
		lines(
			expense("local", {
				modifiedCreated: "2026-02-01",
				modifiedMerchant: "",
				amount: null,
				modifiedAmount: null,
			}),
			report("empty", "Open", { total: null, created: "" }),
			expense("bad-date", { created: "2026-02-30" }),
			expense("zoned", { created: "2026-01-01T00:00:00Z" }),
			expense("bad-bool", { billable: "false" }),
			expense("unsafe", { amount: Number.MAX_SAFE_INTEGER + 1 }),
			{ kind: "mystery" },
			null,
			[],
		),
	);
	assert.equal(parsed.expenses.length, 1);
	assert.equal(parsed.expenses[0]?.expense_date, "2026-02-01");
	assert.equal(parsed.expenses[0]?.merchant, "Original");
	assert.equal(parsed.expenses[0]?.amount_minor, null);
	assert.equal(parsed.expenses[0]?.billable, null);
	assert.equal(parsed.expenses[0]?.receipt_present, false);
	assert.equal(parsed.reports[0]?.created_at, null);
	assert.equal(parsed.reports[0]?.total_minor, null);
	assert.equal(parsed.rejected.length, 7);
	assert.deepEqual(parseExport(" \n\r\n"), {
		expenses: [],
		reports: [],
		reimbursements: [],
		rejected: [],
	});
});

test("last report supersedes derived reimbursement; reimbursement ids also deduplicate", () => {
	const parsed = parseExport(
		lines(
			report("r1", "Reimbursed", { reimbursed: "2026-02-01", entryID: "old" }),
			report("r1", "Open", { reportName: "Latest" }),
			report("r2", "Reimbursed", {
				reimbursed: "2026-02-01",
				entryID: "same",
				total: 1,
			}),
			report("r3", "Reimbursed", {
				reimbursed: "2026-02-01",
				entryID: "same",
				total: 2,
			}),
		),
	);
	assert.equal(parsed.reports.length, 3);
	assert.equal(parsed.reports[0]?.title, "Latest");
	assert.deepEqual(
		parsed.reimbursements.map((r) => [r.id, r.report_id, r.amount_minor]),
		[["same", "r3", 2]],
	);
});

test("owned export preserves plain numeric identifier strings", () => {
	const parsed = parseExport(
		lines(
			expense("1234567", { reportID: "2345678", receiptID: "3456789" }),
			report("2345678", "Reimbursed", {
				entryID: "4567890",
				reimbursed: "2026-02-01",
			}),
		),
	);
	assert.deepEqual(parsed.rejected, []);
	assert.equal(parsed.expenses[0]?.id, "1234567");
	assert.equal(parsed.expenses[0]?.report_id, "2345678");
	assert.equal(parsed.expenses[0]?.receipt_present, true);
	assert.equal(parsed.reports[0]?.id, "2345678");
	assert.equal(parsed.reimbursements[0]?.id, "4567890");
	assert.equal(parsed.reimbursements[0]?.report_id, "2345678");
});

test("every dynamic string in the owned template is JSON escaped, including optional defaults", () => {
	assert.ok(
		EXPORT_TEMPLATE.startsWith(
			'<#setting number_format="computer"><#list reports as report>',
		),
	);
	const fields = {
		report: [
			"reportID",
			"reportName",
			"status",
			"currency",
			"created",
			"submitted",
			"approved",
			"reimbursed",
			"entryID",
			"policyName",
		],
		expense: [
			"transactionID",
			"reportID",
			"merchant",
			"modifiedMerchant",
			"created",
			"modifiedCreated",
			"currency",
			"category",
			"tag",
			"comment",
			"bank",
			"cardTitle",
			"receiptID",
			"receiptFilename",
			"inserted",
		],
	};
	for (const [variable, names] of Object.entries(fields)) {
		for (const name of names) {
			assert.ok(
				EXPORT_TEMPLATE.includes(
					"${(" + variable + "." + name + '!"")?string?json_string}',
				),
				name,
			);
		}
	}
	const expressions = [...EXPORT_TEMPLATE.matchAll(/\$\{([^}]+)\}/g)].map(
		(m) => m[1]!,
	);
	assert.equal(
		expressions.length,
		fields.report.length + fields.expense.length + 7,
	);
	for (const expression of expressions) {
		assert.ok(
			expression.endsWith("?json_string") || expression.endsWith("?c"),
			expression,
		);
	}
	assert.equal(EXPORT_TEMPLATE.includes("accountEmail"), false);
	assert.equal(EXPORT_TEMPLATE.includes("addHeader"), false); // No header is emitted.
	assert.ok(
		EXPORT_TEMPLATE.includes("<#list (report.transactionList![]) as expense>"),
	);
});
