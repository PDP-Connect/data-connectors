// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { z } from "zod";
import type {
	expensesSchema,
	reimbursementsSchema,
	reportsSchema,
} from "./schemas.ts";
export type ExpenseRecord = z.infer<typeof expensesSchema>;
export type ReportRecord = z.infer<typeof reportsSchema>;
export type ReimbursementRecord = z.infer<typeof reimbursementsSchema>;
export interface ExportResult {
	expenses: ExpenseRecord[];
	reports: ReportRecord[];
	reimbursements: ReimbursementRecord[];
	rejected: { line: number; reason: string }[];
}
