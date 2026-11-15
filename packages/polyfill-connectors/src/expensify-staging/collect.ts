// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import {
	type CollectContext,
	emitDetailCoverage,
} from "../connector-runtime.ts";
import { parseExport } from "./parsers.ts";

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
	client: { exportRange(range: { from: string; to: string }): Promise<string> };
	now?: () => Date;
	/** Both the runtime's requested Map and a Set of names have this seam. */
	requested: { has(stream: string): boolean };
	years?: number;
}

function exportWindow(years: number, now: Date): { from: string; to: string } {
	if (!Number.isSafeInteger(years) || years <= 0) {
		throw new Error("Expensify years must be a positive safe integer");
	}
	const year = now.getUTCFullYear();
	if (!Number.isFinite(now.getTime()) || year > 9999 || year - years < 0) {
		throw new Error(
			"Expensify export window must fit UTC years 0000 through 9999",
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
	if (selected.length === 0) {
		return;
	}

	// The client owns credentials and chunking. Preserve its exact error object,
	// including code/retryable; no success evidence is emitted before it returns.
	const text = await deps.client.exportRange(window);
	const parsed = parseExport(text);
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
		const rows = parsed[stream];
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
				diagnostics: {
					window,
					reasons: Object.fromEntries(
						failures.map((reason) => [reason, reasons[reason]]),
					),
				},
			});
		}
		// Count the parsed inventory, not runtime-filtered emitted records. Unknown
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
	// No STATE: this export has neither a change cursor nor fingerprint state.
}
