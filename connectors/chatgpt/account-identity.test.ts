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

const RUNTIME =
	"../../connectors/chatgpt/__fixtures__/account-identity-runtime.ts";

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
	assert.equal(
		Reflect.get(Object(identity), "account_id"),
		"user-synthetic0002",
	);
});

// ─── A token refresh must keep the run on one account ───────────────────

const SESSION_A = { accessToken: "token-a1", user: { id: "user-synthetic-a" } };

async function runWithSessions(
	sessions: unknown[],
	revokedTokens: string[],
): Promise<Record<string, unknown>[]> {
	return runAndReadWire({
		cwd: packageRoot,
		entrypoint: RUNTIME,
		env: {
			SYNTHETIC_REVOKED_TOKENS: JSON.stringify(revokedTokens),
			SYNTHETIC_SESSIONS: JSON.stringify(sessions),
		},
		start: { type: "START", scope: { streams: [{ name: "memories" }] } },
	});
}

function memoryIdsRead(wire: readonly Record<string, unknown>[]): string[] {
	return wire
		.filter((m) => m.type === "RECORD")
		.map((m) => String(Reflect.get(Object(m.data), "id")));
}

function doneStatus(wire: readonly Record<string, unknown>[]): unknown {
	return wire.find((m) => m.type === "DONE")?.status;
}

test("A, then a 401, then B: the run stops and nothing of B is read or committed", async () => {
	const wire = await runWithSessions(
		[SESSION_A, { accessToken: "token-b1", user: { id: "user-synthetic-b" } }],
		["token-a1"],
	);
	assertAccountIdentity(wire, "user-synthetic-a");
	assert.deepEqual(memoryIdsRead(wire), [], "no record of either account");
	assert.equal(
		wire.some((m) => m.type === "STATE"),
		false,
		"no state commit",
	);
	assert.equal(doneStatus(wire), "failed");
});

test("A, then a 401, then A with a new token: the run continues", async () => {
	const wire = await runWithSessions(
		[SESSION_A, { accessToken: "token-a2", user: { id: "user-synthetic-a" } }],
		["token-a1"],
	);
	assertAccountIdentity(wire, "user-synthetic-a");
	assert.deepEqual(memoryIdsRead(wire), ["memory-read-with-token-a2"]);
	assert.equal(doneStatus(wire), "succeeded");
});

test("A, then a 401, then a session with no user id: the run stops", async () => {
	const wire = await runWithSessions(
		[SESSION_A, { accessToken: "token-x1" }],
		["token-a1"],
	);
	assertAccountIdentity(wire, "user-synthetic-a");
	assert.deepEqual(memoryIdsRead(wire), []);
	assert.equal(
		wire.some((m) => m.type === "STATE"),
		false,
	);
	assert.equal(doneStatus(wire), "failed");
});

test("a first session with no user id fails the run with the missing-id error", async () => {
	const wire = await runWithSessions([{ accessToken: "token-x1" }], []);
	assert.equal(
		wire.some((m) => m.type === "ACCOUNT_IDENTITY"),
		false,
	);
	assert.deepEqual(memoryIdsRead(wire), []);
	assert.equal(doneStatus(wire), "failed");
	const done = wire.find((m) => m.type === "DONE");
	assert.match(
		String(Reflect.get(Object(done?.error), "message")),
		/account id/i,
	);
});
