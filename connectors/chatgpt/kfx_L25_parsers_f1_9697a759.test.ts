// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import { tsToIso } from "./parsers.ts";

test("zone-less ISO timestamps normalize to UTC on different hosts", () => {
	const previous = process.env.TZ;
	try {
		for (const tz of ["America/Los_Angeles", "Asia/Tokyo"]) {
			process.env.TZ = tz;
			assert.equal(tsToIso("2024-01-02T03:04:05"), "2024-01-02T03:04:05.000Z");
			assert.equal(
				tsToIso("2024-01-02T03:04:05.125"),
				"2024-01-02T03:04:05.125Z",
			);
			assert.equal(
				tsToIso("2024-01-02T03:04:05-08:00"),
				"2024-01-02T11:04:05.000Z",
			);
			assert.equal(tsToIso("2024-01-02T03:04:05Z"), "2024-01-02T03:04:05.000Z");
		}
	} finally {
		if (previous === undefined) delete process.env.TZ;
		else process.env.TZ = previous;
	}
});
