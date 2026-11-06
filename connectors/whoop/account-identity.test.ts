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

/** Runs `collectWhoop` over the bootstrap fixture and returns the ids it reported. */
async function reportedIds(streams: string[]): Promise<string[]> {
	const bootstrap = JSON.parse(
		await readFile(join(fixturesDir("whoop"), "bootstrap.json"), "utf8"),
	) as unknown;
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
		return capture.ids;
	} finally {
		capture.restore();
	}
}

test("collectWhoop reports the bootstrap user id once for a profile-only run", async () => {
	assert.deepEqual(await reportedIds(["profile"]), ["41002"]);
});

test("collectWhoop reports the same id when more streams run", async () => {
	assert.deepEqual(await reportedIds(["profile", "body"]), ["41002"]);
});
