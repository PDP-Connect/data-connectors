// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
	assertUserFacingProgress,
	CONNECTOR_DIAGNOSTIC_MAX_CHARS,
	connectorDiagnostic,
	formatConnectorDiagnostic,
	setConnectorDiagnosticSink,
} from "./connector-diagnostic.ts";

afterEach(() => {
	setConnectorDiagnosticSink(undefined);
});

test("formatConnectorDiagnostic: prefix, event and defined fields only", () => {
	assert.equal(
		formatConnectorDiagnostic("anthropic", "users_metadata_mismatch", {
			expected: 2,
			observed: 1,
			skipped: undefined,
		}),
		'[anthropic-diagnostic] users_metadata_mismatch {"expected":2,"observed":1}',
	);
	assert.equal(
		formatConnectorDiagnostic("runtime", "shape_check_skipped"),
		"[runtime-diagnostic] shape_check_skipped",
	);
});

test("formatConnectorDiagnostic: bounds long lines", () => {
	const line = formatConnectorDiagnostic("x", "long", {
		value: "a".repeat(CONNECTOR_DIAGNOSTIC_MAX_CHARS * 2),
	});
	assert.equal(line.length, CONNECTOR_DIAGNOSTIC_MAX_CHARS);
	assert.ok(line.endsWith("…"));
});

test("connectorDiagnostic: writes through the sink and never throws", () => {
	const lines: string[] = [];
	setConnectorDiagnosticSink((line) => lines.push(line));
	connectorDiagnostic("gmail", "imap_reconnect", { attempt: 2 });
	assert.deepEqual(lines, ['[gmail-diagnostic] imap_reconnect {"attempt":2}']);

	setConnectorDiagnosticSink(() => {
		throw new Error("sink failed");
	});
	assert.doesNotThrow(() => connectorDiagnostic("gmail", "x"));
});

test("assertUserFacingProgress: accepts plain English", () => {
	assertUserFacingProgress([
		{ type: "PROGRESS", message: "Fetching conversations" },
		{ type: "PROGRESS", message: "Found 404 orders" },
		{ type: "PROGRESS", message: "Downloaded 3 of 12 export files" },
		{
			type: "PROGRESS",
			message: "Claude is slowing down requests; waiting 2 minutes",
		},
		{ type: "RECORD", message: "ignored: not PROGRESS {json}" },
	]);
});

test("assertUserFacingProgress: rejects technical text", () => {
	for (const message of [
		"Claude users.json metadata: mismatch (expected 2, saw 1)",
		'browser_surface.diagnostic {"posture":"recognized"}',
		"HTTP 429 on GET /conversations",
		"Slack phase timing: users took 1200ms",
		"lane started active=0 queued=4",
		"Set PDPP_BROWSER_HEADLESS=0 to finish sign-in",
	]) {
		assert.throws(
			() => assertUserFacingProgress([{ type: "PROGRESS", message }]),
			/owner-facing/,
			message,
		);
	}
});

test("assertUserFacingProgress: allow list exempts named messages", () => {
	assertUserFacingProgress(
		[{ type: "PROGRESS", message: "Reading my_takeout archive" }],
		[/^Reading .+ archive$/],
	);
});
