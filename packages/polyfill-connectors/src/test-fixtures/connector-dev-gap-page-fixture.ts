// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Test-only connector fixture that asks the host for one page of pending
 * detail gaps (DETAIL_GAPS_PAGE_REQUEST) before it emits anything else, the
 * way connectors that recover gaps past START's first page do (character_ai,
 * slack_browser). A host that never answers leaves the run waiting until its
 * inactivity watchdog kills it; a host that keeps no gap ledger must answer
 * with an empty page so the run reaches DONE.
 *
 * Used by bin/scenario-cli.test.ts. NOT registered in src/orchestrator.ts:
 * fixture-only, never a production connector.
 */

import type { RecordData, ValidateRecord } from "../connector-runtime.ts";
import { runConnector } from "../connector-runtime.ts";

const validateRecord: ValidateRecord = (stream: string, data: RecordData) =>
	stream === "items" &&
	typeof data.id === "string" &&
	typeof data.pending_gaps === "number"
		? { ok: true, data }
		: {
				ok: false,
				issues: [{ path: "pending_gaps", message: "expected a number" }],
			};

runConnector({
	name: "connector-dev-gap-page-fixture",
	validateRecord,
	async collect({ emit, emitRecord, requestDetailGapPage }) {
		const page = await requestDetailGapPage({ streams: ["items"] });
		await emitRecord("items", { id: "item-1", pending_gaps: page.length });
		await emit({
			type: "STATE",
			stream: "items",
			cursor: { last_id: "item-1" },
		});
	},
});
