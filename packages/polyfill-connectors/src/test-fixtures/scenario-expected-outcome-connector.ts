// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { RecordData, ValidateRecord } from "../connector-runtime.ts";
import { runConnector } from "../connector-runtime.ts";

const validateRecord: ValidateRecord = (_stream: string, data: RecordData) => ({
	ok: true,
	data,
});

runConnector({
	name: "scenario-expected-outcome-connector",
	validateRecord,
	async collect({ emit }) {
		if (process.env.PDPP_SCENARIO_FIXTURE_FIXED === "1") {
			return;
		}
		process.stderr.write("synthetic-secret-child-stderr\n");
		await emit({
			type: "SKIP_RESULT",
			stream: "items",
			reason: process.env.PDPP_SCENARIO_FIXTURE_REASON ?? "stream_capped",
			message: "synthetic-secret-protocol-payload",
		});
		throw new Error("synthetic-secret-done-payload");
	},
});
