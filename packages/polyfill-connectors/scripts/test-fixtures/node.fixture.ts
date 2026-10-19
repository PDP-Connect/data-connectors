// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { test } from "node:test";

test("node fixture ran", () => {
	assert.ok(process.env.TEST_DISPATCH_MARKERS);
	appendFileSync(process.env.TEST_DISPATCH_MARKERS, "node\n");
});
