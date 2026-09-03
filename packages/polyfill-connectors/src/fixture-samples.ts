// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Read one scrubbed sample record from this package's own shipped fixtures.
 *
 * For consumers that need a real-shaped record to exercise ingest paths
 * against (rather than a hand-authored synthetic one) without reaching past
 * this package's public surface into its raw `fixtures/` file layout.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Read the first non-blank line of a connector's scrubbed pilot-shape sample
 * for the given stream, parsed as JSON.
 *
 * `connectorKey` and `stream` must match an existing
 * `fixtures/<connectorKey>/scrubbed/pilot-real-shape/records/<stream>.jsonl`
 * file shipped with this package.
 */
export function readSampleRecord(
	connectorKey: string,
	stream: string,
): Record<string, unknown> {
	const path = join(
		PACKAGE_ROOT,
		"fixtures",
		connectorKey,
		"scrubbed",
		"pilot-real-shape",
		"records",
		`${stream}.jsonl`,
	);
	const line = readFileSync(path, "utf8")
		.split("\n")
		.find((candidate) => candidate.trim());
	if (!line) {
		throw new Error(
			`fixtures/${connectorKey}/scrubbed/pilot-real-shape/records/${stream}.jsonl must contain a record`,
		);
	}
	return JSON.parse(line) as Record<string, unknown>;
}
