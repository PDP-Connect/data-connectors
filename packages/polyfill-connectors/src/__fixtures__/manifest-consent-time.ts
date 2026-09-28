// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Test-only entry: runs the real runtime under a shipped connector's name and
// emits the records the test supplies, so the manifest's consent_time_field
// decides what a bounded run keeps.
import { runConnector } from "../connector-runtime.ts";

const records = JSON.parse(process.env.PDPP_TEST_RECORDS ?? "[]") as Array<{
	data: Record<string, unknown> & { id: string };
	stream: string;
}>;

runConnector({
	name: process.env.PDPP_TEST_CONNECTOR_NAME ?? "",
	async collect(ctx) {
		for (const record of records) {
			if (ctx.requested.has(record.stream)) {
				await ctx.emitRecord(record.stream, record.data);
			}
		}
	},
});
