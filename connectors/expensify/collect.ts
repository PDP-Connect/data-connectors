// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import {
	type CollectContext,
	createConnectorFailure,
	emitDetailCoverage,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import type { createExpensifyClient } from "./client.ts";
import { parseExport } from "./parsers.ts";
import { accountProfileSchema, workspacesSchema } from "./schemas.ts";

const STREAMS = ["expenses", "reports", "reimbursements"] as const;
type Stream = (typeof STREAMS)[number];
const REASONS = [
	"invalid_json",
	"invalid_export_row",
	"invalid_expense_record",
	"invalid_report_record",
	"invalid_reimbursement_record",
] as const;
type Reason = (typeof REASONS)[number];

export interface ExpensifyCollectDeps
	extends Pick<CollectContext, "emit" | "emitRecord" | "progress"> {
	isRecordSelected?: CollectContext["isRecordSelected"];
	client: Pick<
		ReturnType<typeof createExpensifyClient>,
		"exportRange" | "listPolicies"
	>;
	now?: () => Date;
	/** Both the runtime's requested Map and a Set of names have this seam. */
	requested: { has(stream: string): boolean };
	years?: number;
}

function exportWindow(years: number, now: Date): { from: string; to: string } {
	if (!Number.isSafeInteger(years) || years <= 0) {
		throw createConnectorFailure(
			"expensify_invalid_window",
			"Expensify years must be a positive safe integer",
			{
				retryable: false,
				recoveryHint: { action: "manual_action_required" },
			},
		);
	}
	const year = now.getUTCFullYear();
	if (!Number.isFinite(now.getTime()) || year > 9999 || year - years < 0) {
		throw createConnectorFailure(
			"expensify_invalid_window",
			"Expensify export window must fit UTC years 0000 through 9999",
			{
				retryable: false,
				recoveryHint: { action: "manual_action_required" },
			},
		);
	}
	const from = new Date(now.getTime());
	// Start on day one before moving the year, then clamp leap day.
	from.setUTCDate(1);
	from.setUTCFullYear(year - years);
	const last = new Date(from.getTime());
	last.setUTCMonth(last.getUTCMonth() + 1, 0);
	from.setUTCDate(Math.min(now.getUTCDate(), last.getUTCDate()));
	return {
		from: from.toISOString().slice(0, 10),
		to: now.toISOString().slice(0, 10),
	};
}

function affects(reason: Reason, stream: Stream): boolean {
	if (reason === "invalid_expense_record") {
		return stream === "expenses";
	}
	// A failed reimbursement also prevents the parser's atomic report update.
	if (
		reason === "invalid_report_record" ||
		reason === "invalid_reimbursement_record"
	) {
		return stream === "reports" || stream === "reimbursements";
	}
	return true;
}

/** A full scan of the selected export window, never an all-time inventory. */
export async function collectExpensify(
	deps: ExpensifyCollectDeps,
): Promise<void> {
	const window = exportWindow(
		deps.years ?? 3,
		(deps.now ?? (() => new Date()))(),
	);
	const selected = STREAMS.filter((stream) => deps.requested.has(stream));
	const profileRequested = deps.requested.has("account_profile");
	const workspacesRequested = deps.requested.has("workspaces");
	if (selected.length === 0 && !profileRequested && !workspacesRequested) {
		return;
	}

	// The client owns credentials and chunking. Preserve its exact error object,
	// including code/retryable; no success evidence is emitted before it returns.
	const policies =
		workspacesRequested || profileRequested
			? await deps.client.listPolicies()
			: [];
	const parsed =
		selected.length > 0 || profileRequested
			? parseExport(await deps.client.exportRange(window))
			: null;
	if (workspacesRequested) {
		let covered = 0;
		for (const policy of policies) {
			const row = workspacesSchema.parse({
				id: policy.id,
				name: policy.name,
				type: policy.type,
				role: policy.role,
				output_currency: policy.outputCurrency,
			});
			if (deps.isRecordSelected?.("workspaces", row) === false) continue;
			await deps.emitRecord("workspaces", row);
			covered++;
		}
		await emitDetailCoverage(
			{ emit: deps.emit },
			{
				stream: "workspaces",
				stateStream: "workspaces",
				requiredKeys: [],
				hydratedKeys: [],
				considered: covered,
				covered,
			},
		);
	}
	if (parsed === null) return;
	const reasons: Record<Reason, number> = {
		invalid_json: 0,
		invalid_export_row: 0,
		invalid_expense_record: 0,
		invalid_report_record: 0,
		invalid_reimbursement_record: 0,
	};
	for (const rejection of parsed.rejected) {
		// Fixed keys keep diagnostics bounded even if the parser gains a reason.
		const reason =
			REASONS.find((key) => key === rejection.reason) ?? "invalid_export_row";
		reasons[reason] += 1;
	}
	await deps.progress(
		`Expensify full scan for UTC ${window.from} through ${window.to}; not all-time coverage`,
	);
	for (const stream of selected) {
		const rows = parsed[stream].filter(
			(row) => deps.isRecordSelected?.(stream, row) !== false,
		);
		const failures = REASONS.filter((reason) => affects(reason, stream));
		const rejected = failures.reduce((sum, reason) => sum + reasons[reason], 0);
		for (const row of rows) {
			await deps.emitRecord(stream, row);
		}
		if (rejected > 0) {
			await deps.emit({
				type: "SKIP_RESULT",
				stream,
				reason: "expensify_export_incomplete",
				message: "Export rows rejected within the selected UTC window",
				recovery_hint: { action: "retry_by_runtime", retryable: true },
				diagnostics: {
					window,
					reasons: Object.fromEntries(
						failures.map((reason) => [reason, reasons[reason]]),
					),
				},
			});
		}
		// Count only selected parsed rows. Unknown
		// rejected rows conservatively leave a hole in every affected requested
		// stream. This is per-run/window detail coverage, not wholesale authority.
		await emitDetailCoverage(
			{ emit: deps.emit },
			{
				stream,
				stateStream: stream,
				requiredKeys: [],
				hydratedKeys: [],
				considered: rows.length + rejected,
				covered: rows.length,
			},
		);
	}
	if (profileRequested) {
		const dates = parsed.expenses
			.map((row) => row.expense_date)
			.filter((value): value is string => value !== null)
			.sort();
		await deps.emitRecord(
			"account_profile",
			accountProfileSchema.parse({
				id: "account_profile",
				workspace_count: policies.length,
				admin_workspace_count: policies.filter(
					(policy) => policy.role === "admin",
				).length,
				export_window_from: window.from,
				export_window_to: window.to,
				expense_count: parsed.expenses.length,
				report_count: parsed.reports.length,
				reimbursement_count: parsed.reimbursements.length,
				earliest_expense_date: dates[0] ?? null,
				latest_expense_date: dates.at(-1) ?? null,
			}),
		);
		if (parsed.rejected.length > 0) {
			await deps.emit({
				type: "SKIP_RESULT",
				stream: "account_profile",
				reason: "expensify_export_incomplete",
				message:
					"Profile counts cover only accepted rows in the selected UTC window",
				recovery_hint: { action: "retry_by_runtime", retryable: true },
				diagnostics: { window, reasons },
			});
		}
		await emitDetailCoverage(
			{ emit: deps.emit },
			{
				stream: "account_profile",
				stateStream: "account_profile",
				requiredKeys: [],
				hydratedKeys: [],
				considered: 1,
				covered: parsed.rejected.length === 0 ? 1 : 0,
			},
		);
	}
	// No STATE: this export has neither a change cursor nor fingerprint state.
}
