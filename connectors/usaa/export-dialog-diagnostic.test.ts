// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// A failed Mobile Export dialog step names the check that failed, per
// account, in the SKIP_RESULT: the run's result keeps only the message, so
// the check is in the message too. No field values leave the page.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { EmittedMessage } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { makeRecordingEmit } from "../../packages/polyfill-connectors/src/test-harness.ts";
import { type EmitDeps, emitExportFailure } from "./index.ts";
import { validateRecord } from "./schemas.ts";
import type { DashboardAccount, DiagnosticInfo } from "./types.ts";

const ACCOUNT: DashboardAccount = {
	account_id_raw: "ACCT-CHK-0001",
	account_type: "checking",
	account_url: "/my/checking?accountId=ACCT-CHK-0001",
	balance_cents: 123_456,
	last_four: "9241",
	name: "USAA CLASSIC CHECKING",
	raw_text: "USAA CLASSIC CHECKING Ending in *9241 $1,234.56",
};

async function skipFor(
	diag: DiagnosticInfo,
): Promise<Extract<EmittedMessage, { type: "SKIP_RESULT" }>> {
	const harness = makeRecordingEmit(validateRecord);
	const deps: EmitDeps = {
		emit: harness.emit,
		emitRecord: harness.emitRecord,
	};
	await emitExportFailure(deps, ACCOUNT, diag, { ordinal: 2, total: 4 });
	const skip = harness.protocolMessages.find(
		(m): m is Extract<EmittedMessage, { type: "SKIP_RESULT" }> =>
			m.type === "SKIP_RESULT",
	);
	assert.ok(skip);
	return skip;
}

test("export dialog: rejected dates are named in the message and diagnostics, without values", async () => {
	const skip = await skipFor({
		diag: null,
		error: "date_fields_rejected",
		phase: "export_dialog_fill_failed",
		export_dialog: {
			check: "dates_rejected",
			dialog_state: "ready",
			dialog_wait_ms: 1520,
			role_dialogs_visible: 1,
			export_dialog_candidates: 1,
			selection_type: "accepted",
			from_field: "ready",
			to_field: "ready",
			date_inputs_in_document: 2,
			fields_wait_ms: 120,
			// A page function shapes these; the connector shapes them again.
			from_value_shape: "11/04/2025",
			to_value_shape: "",
		},
	});
	assert.equal(skip.reason, "export_affordance_missing");
	assert.equal(
		skip.message,
		"Export ladder exhausted (source_structure_changed); export_dialog_fill_failed; page=unavailable; check=dates_rejected",
	);
	assert.deepEqual(skip.diagnostics, {
		outcome: "source_structure_changed",
		phase: "export_dialog_fill_failed",
		export_dialog: {
			check: "dates_rejected",
			dialog_state: "ready",
			dialog_wait_ms: 1520,
			role_dialogs_visible: 1,
			export_dialog_candidates: 1,
			selection_type: "accepted",
			from_field: "ready",
			to_field: "ready",
			date_inputs_in_document: 2,
			fields_wait_ms: 120,
			from_value_shape: "99/99/9999",
			to_value_shape: "",
		},
		account_ordinal: 2,
		account_total: 4,
	});
	assert.doesNotMatch(JSON.stringify(skip), /11\/04\/2025|9241|ACCT-CHK/);
});

test("export dialog: a dialog the selector did not keep is told apart from no dialog", async () => {
	const skip = await skipFor({
		diag: null,
		error: "dialog_not_open",
		phase: "export_dialog_unexpected_shape",
		export_dialog: {
			check: "dialog_not_found",
			dialog_state: "none",
			dialog_wait_ms: 5000,
			role_dialogs_visible: 1,
			export_dialog_candidates: 0,
		},
	});
	assert.match(skip.message, /; check=dialog_not_found$/);
	assert.deepEqual(
		(skip.diagnostics as { export_dialog?: unknown }).export_dialog,
		{
			check: "dialog_not_found",
			dialog_state: "none",
			dialog_wait_ms: 5000,
			role_dialogs_visible: 1,
			export_dialog_candidates: 0,
		},
	);
});
