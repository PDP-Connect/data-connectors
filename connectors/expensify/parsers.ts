// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import {
	expenseExportSchema,
	expensesSchema,
	reimbursementsSchema,
	reportExportSchema,
	reportsSchema,
} from "./schemas.ts";
import type {
	ExpenseRecord,
	ExportResult,
	ReimbursementRecord,
	ReportRecord,
} from "./types.ts";

const nullableText = (value: string | null | undefined): string | null =>
	value === undefined || value === null || value.trim() === "" ? null : value;
function normalizedStatus(
	value: string | null,
): ReportRecord["status_normalized"] {
	switch (value) {
		case "Open":
			return "open";
		case "Processing":
			return "processing";
		case "Approved":
			return "approved";
		case "Reimbursed":
			return "reimbursed";
		case "Closed":
			return "closed";
		default:
			return "unknown";
	}
}

/** Parse only our owned JSON-lines format; errors never echo source data. */
export function parseExport(text: string): ExportResult {
	const expenses = new Map<string, ExpenseRecord>();
	const reports = new Map<string, ReportRecord>();
	const reimbursementByReport = new Map<string, ReimbursementRecord>();
	const rejected: ExportResult["rejected"] = [];
	const reject = (line: number, reason: string) =>
		rejected.push({ line, reason });
	text.split(/\r?\n/).forEach((line, index) => {
		const lineNumber = index + 1;
		if (!line.trim()) return;
		let raw: unknown;
		try {
			raw = JSON.parse(line);
		} catch {
			reject(lineNumber, "invalid_json");
			return;
		}
		const expense = expenseExportSchema.safeParse(raw);
		if (expense.success) {
			const e = expense.data;
			const record = expensesSchema.safeParse({
				id: e.transactionID,
				report_id: e.reportID,
				merchant: nullableText(e.modifiedMerchant) ?? nullableText(e.merchant),
				original_merchant: nullableText(e.merchant),
				expense_date:
					nullableText(e.modifiedCreated) ?? nullableText(e.created),
				amount_minor: e.modifiedAmount ?? e.amount ?? null,
				currency: nullableText(e.currency),
				report_amount_minor: e.convertedAmount ?? null,
				category: nullableText(e.category),
				tag: nullableText(e.tag),
				comment: nullableText(e.comment),
				reimbursable: e.reimbursable ?? null,
				billable: e.billable ?? null,
				card_bank: nullableText(e.bank),
				card_name: nullableText(e.cardTitle),
				receipt_present: nullableText(e.receiptID) !== null,
				inserted_at: nullableText(e.inserted),
			});
			if (!record.success) {
				reject(lineNumber, "invalid_expense_record");
				return;
			}
			expenses.set(record.data.id, record.data);
			return;
		}
		const report = reportExportSchema.safeParse(raw);
		if (!report.success) {
			reject(lineNumber, "invalid_export_row");
			return;
		}
		const r = report.data;
		const status = nullableText(r.status);
		const record = reportsSchema.safeParse({
			id: r.reportID,
			title: nullableText(r.reportName),
			status,
			status_normalized: normalizedStatus(status),
			currency: nullableText(r.currency),
			total_minor: r.total ?? null,
			created_at: nullableText(r.created),
			submitted_at: nullableText(r.submitted),
			approved_at: nullableText(r.approved),
			reimbursed_at: nullableText(r.reimbursed),
			policy_name: nullableText(r.policyName),
		});
		if (!record.success) {
			reject(lineNumber, "invalid_report_record");
			return;
		}
		// Replace the report and its derived reimbursement atomically. A later
		// non-reimbursed report must not leave behind an obsolete reimbursement.
		let reimbursement: ReimbursementRecord | undefined;
		if (
			status === "Reimbursed" &&
			record.data.reimbursed_at !== null &&
			nullableText(r.entryID) !== null
		) {
			const parsed = reimbursementsSchema.safeParse({
				id: r.entryID,
				report_id: record.data.id,
				reimbursed_at: record.data.reimbursed_at,
				amount_minor: record.data.total_minor,
				amount_source: "report_total",
				currency: record.data.currency,
				method: r.isACHReimbursed === true ? "ach" : "unknown",
			});
			if (!parsed.success) {
				reject(lineNumber, "invalid_reimbursement_record");
				return;
			}
			reimbursement = parsed.data;
		}
		reports.set(record.data.id, record.data);
		reimbursementByReport.delete(record.data.id);
		if (reimbursement) reimbursementByReport.set(record.data.id, reimbursement);
	});
	const reimbursements = new Map<string, ReimbursementRecord>();
	for (const record of reimbursementByReport.values())
		reimbursements.set(record.id, record);
	return {
		expenses: [...expenses.values()],
		reports: [...reports.values()],
		reimbursements: [...reimbursements.values()],
		rejected,
	};
}
