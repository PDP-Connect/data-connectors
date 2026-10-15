// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { RecordData } from "../connector-runtime.ts";
import { runConnector } from "../connector-runtime.ts";

const validateRecord = (_stream: string, data: RecordData) => ({
	ok: true as const,
	data,
});

runConnector({
	name: "connector-dev-skip-diagnostics-fixture",
	validateRecord,
	async collect({ emit }) {
		await emit({
			type: "SKIP_RESULT",
			stream: "notes",
			reason: "icloud_omitted_rows",
			message: "one row withheld",
			diagnostics: {
				omitted_rows: 1,
				source_rows_seen: 3,
				note_rows_seen: 2,
				deleted_note_rows: 1,
				omitted_row_diagnostics: [
					{
						row_index: 3,
						field_count: 1,
						field_omissions: [],
						row_reason: "unavailable_fields",
					},
				],
				field_omissions: [
					{
						field: "TextDataEncrypted",
						reason: "body_text_unreadable",
						source_shape: { type: "object", keys: ["data", "format"] },
						value: "PRIVATE_NOTE_SENTINEL",
					},
				],
			},
		});
	},
});
