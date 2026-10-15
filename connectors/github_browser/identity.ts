// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { RecordData } from "../../packages/polyfill-connectors/src/connector-runtime.ts";

const stringField = (record: RecordData, key: string): string | null => {
	const value = record[key];
	return typeof value === "string" ? value : null;
};

/** Shared by source validation and record emission so both paths use one key. */
export function resolveGitHubRecordId(
	stream: string,
	record: RecordData,
): string | null {
	if (stream === "profile") {
		const username = stringField(record, "username");
		return username === null ? null : `${username}:profile`;
	}
	if (stream === "repositories" || stream === "starred")
		return stringField(record, "url");
	if (stream === "events" || stream === "history")
		return stringField(record, "id");
	if (stream === "contributions") {
		const recordType = stringField(record, "recordType");
		if (recordType === "summary") {
			const username = stringField(record, "username");
			return username === null ? null : `${username}:contributions:summary`;
		}
		return stringField(record, "date");
	}
	return stringField(record, "id");
}
