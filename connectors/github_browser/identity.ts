// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { RecordData } from "../../packages/polyfill-connectors/src/connector-runtime.ts";

/** Preserve main's single snapshot primary key for every existing stream. */
export function resolveGitHubRecordId(stream: string, record: RecordData): string | null {
	if (!["profile", "repositories", "starred", "events", "contributions", "history"].includes(stream)) return null;
	if (stream === "profile")
		return typeof record.username === "string" ? `${record.username}:profile` : null;
	const id = record.id;
	return typeof id === "string" && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?:[a-z]+$/u.test(id) && id.endsWith(`:${stream}`) ? id : null;
}
