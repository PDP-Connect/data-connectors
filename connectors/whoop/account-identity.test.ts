// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * WHOOP reports `user.id` from the bootstrap response it already fetches. The
 * bootstrap body is the committed fixture (synthetic id 41002); the fetch
 * double is the same shape `integration.test.ts` uses.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { captureAccountIdentity } from "../../packages/polyfill-connectors/src/account-identity-test-support.ts";
import { fixturesDir } from "../../packages/polyfill-connectors/src/connector-paths.ts";
import { makeRecordingEmit } from "../../packages/polyfill-connectors/src/test-harness.ts";
import { collectWhoop } from "./index.ts";
import { validateRecord } from "./schemas.ts";

test("collectWhoop reports the bootstrap user id once, whichever streams run", async () => {
	const bootstrap = JSON.parse(
		await readFile(join(fixturesDir("whoop"), "bootstrap.json"), "utf8"),
	) as unknown;
	for (const streams of [["profile"], ["profile", "body"]]) {
		const capture = captureAccountIdentity();
		try {
			const harness = makeRecordingEmit(validateRecord);
			await collectWhoop({
				emit: harness.emit,
				emitRecord: harness.emitRecord,
				fetchPath: () => Promise.resolve({ status: 200, json: bootstrap }),
				now: new Date("2026-08-13T00:00:00.000Z"),
				requested: new Set(streams),
				state: {},
			});
			assert.deepEqual(capture.ids, ["41002"], streams.join(","));
		} finally {
			capture.restore();
		}
	}
});
