// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import { createDiagnosticForwarder } from "./scenario-record.ts";

test("scenario-record forwards connector diagnostic lines and nothing else", () => {
	const lines: string[] = [];
	const forward = createDiagnosticForwarder((line) => lines.push(line));
	forward(
		'[letterboxd-diagnostic] sign_in_wait {"attempt":2}\nplain stderr noise\n',
	);
	forward("[runtime-diagnostic] session_");
	assert.deepEqual(lines, [
		'[letterboxd-diagnostic] sign_in_wait {"attempt":2}',
	]);
	forward("checkpoint\n");
	forward("Error: [letterboxd-diagnostic] not at line start\n");
	forward("[Bad-diagnostic] uppercase source is not a diagnostic\n");
	assert.deepEqual(lines, [
		'[letterboxd-diagnostic] sign_in_wait {"attempt":2}',
		"[runtime-diagnostic] session_checkpoint",
	]);
});
