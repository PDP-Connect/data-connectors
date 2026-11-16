// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";

const LOCAL_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}):(\d{2}))?$/;
const localDate = z
	.string()
	.refine((value) => {
		const match = LOCAL_DATE_RE.exec(value);
		if (!match) return false;
		const year = Number(match[1]),
			month = Number(match[2]),
			day = Number(match[3]);
		const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
		const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
		return (
			month >= 1 &&
			month <= 12 &&
			day >= 1 &&
			day <= days[month - 1]! &&
			(match[4] === undefined ||
				(Number(match[4]) < 24 &&
					Number(match[5]) < 60 &&
					Number(match[6]) < 60))
		);
	}, "invalid local date or date-time")
	.nullable();
const text = z.string().min(1).nullable();
const minor = z.number().int().refine(Number.isSafeInteger).nullable();
const id = z.string().min(1);
export const expensesSchema = z.object({
	id,
	report_id: id,
	merchant: text,
	original_merchant: text,
	expense_date: localDate,
	amount_minor: minor,
	currency: text,
	report_amount_minor: minor,
	category: text,
	tag: text,
	comment: text,
	reimbursable: z.boolean().nullable(),
	billable: z.boolean().nullable(),
	card_bank: text,
	card_name: text,
	receipt_present: z.boolean(),
	inserted_at: localDate,
});
export const reportsSchema = z.object({
	id,
	title: text,
	status: text,
	status_normalized: z.enum([
		"open",
		"processing",
		"approved",
		"reimbursed",
		"closed",
		"unknown",
	]),
	currency: text,
	total_minor: minor,
	created_at: localDate,
	submitted_at: localDate,
	approved_at: localDate,
	reimbursed_at: localDate,
	policy_name: text,
});
export const reimbursementsSchema = z.object({
	id,
	report_id: id,
	reimbursed_at: localDate,
	amount_minor: minor,
	amount_source: z.literal("report_total"),
	currency: text,
	method: z.enum(["ach", "unknown"]),
});
const sourceText = z.string().nullable().optional();
const sourceNumber = z
	.number()
	.int()
	.refine(Number.isSafeInteger)
	.nullable()
	.optional();
const sourceBoolean = z.boolean().nullable().optional();
export const reportExportSchema = z.object({
	kind: z.literal("report"),
	reportID: sourceText,
	reportName: sourceText,
	status: sourceText,
	currency: sourceText,
	created: sourceText,
	submitted: sourceText,
	approved: sourceText,
	reimbursed: sourceText,
	entryID: sourceText,
	policyName: sourceText,
	total: sourceNumber,
	isACHReimbursed: sourceBoolean,
});
export const expenseExportSchema = z.object({
	kind: z.literal("expense"),
	transactionID: sourceText,
	reportID: sourceText,
	merchant: sourceText,
	modifiedMerchant: sourceText,
	created: sourceText,
	modifiedCreated: sourceText,
	currency: sourceText,
	category: sourceText,
	tag: sourceText,
	comment: sourceText,
	bank: sourceText,
	cardTitle: sourceText,
	receiptID: sourceText,
	receiptFilename: sourceText,
	inserted: sourceText,
	amount: sourceNumber,
	modifiedAmount: sourceNumber,
	convertedAmount: sourceNumber,
	reimbursable: sourceBoolean,
	billable: sourceBoolean,
});

export const workspacesSchema = z.object({
	id,
	name: z.string().min(1),
	type: z.string().nullable(),
	role: z.string().nullable(),
	output_currency: z.string().nullable(),
});
const count = z.number().int().nonnegative().refine(Number.isSafeInteger);
export const accountProfileSchema = z.object({
	id: z.literal("account_profile"),
	workspace_count: count,
	admin_workspace_count: count,
	export_window_from: localDate.unwrap(),
	export_window_to: localDate.unwrap(),
	expense_count: count,
	report_count: count,
	reimbursement_count: count,
	earliest_expense_date: localDate,
	latest_expense_date: localDate,
});
