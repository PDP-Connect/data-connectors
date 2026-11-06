// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * ChatGPT reports the signed-in user's id (`user.id` in the session object)
 * as the account id, right after it authenticates and before any stream work.
 * The run uses the real `collectChatGpt` and the real auth extraction with a
 * synthetic page (see `__fixtures__/account-identity-runtime.ts`).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	assertAccountIdentity,
	runAndReadWire,
} from "../../packages/polyfill-connectors/src/account-identity-test-support.ts";
import { packageRoot } from "../../packages/polyfill-connectors/src/connector-paths.ts";

const RUNTIME = "../../connectors/chatgpt/__fixtures__/account-identity-runtime.ts";

test("collectChatGpt reports the session's user id before the run ends", async () => {
	const wire = await runAndReadWire({
		cwd: packageRoot,
		entrypoint: RUNTIME,
		start: { type: "START", scope: { streams: [{ name: "memories" }] } },
	});
	assertAccountIdentity(wire, "user-synthetic0001");
});

test("the id comes from the user, not from a workspace or the email", async () => {
	const wire = await runAndReadWire({
		cwd: packageRoot,
		entrypoint: RUNTIME,
		env: { SYNTHETIC_USER_ID: "user-synthetic0002" },
		start: { type: "START", scope: { streams: [{ name: "memories" }] } },
	});
	const identity = wire.find((m) => m.type === "ACCOUNT_IDENTITY");
	assert.equal(Reflect.get(Object(identity), "account_id"), "user-synthetic0002");
});
