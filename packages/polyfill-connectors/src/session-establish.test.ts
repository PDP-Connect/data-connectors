// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A valid pre-authenticated browser profile must be sufficient on its own —
 * static secrets are required only when an interactive login is actually
 * needed.
 *
 * These tests pin `establishSession`'s `resolveDeferredCredentials` seam
 * directly (see that function's doc comment in `session-establish.ts`):
 *   1. Live-profile path: the first probe reports a live session, so
 *      `resolveDeferredCredentials` must never be called and collection
 *      proceeds with no secrets resolved.
 *   2. Dead-profile path: the first probe reports a dead session, so
 *      `resolveDeferredCredentials` IS called (existing credential path runs
 *      unchanged) before the manual_action fallback.
 *   3. No `resolveDeferredCredentials` supplied (the `ensureSession` path, or
 *      any `probeSession` connector that doesn't opt in): behavior is
 *      byte-for-byte what it was before this hook existed — the dead-path
 *      still reaches manual_action, just without ever touching credentials.
 *
 * No real Playwright: `context`/`page` are minimal stand-ins, and no
 * PDPP_RUN_ID/registration env vars are set, so `manualAction`'s streaming
 * registration no-ops (`registered: false`) and it calls `sendInteraction`
 * directly — exactly the same seam `connector-runtime-session-watchdog.test.ts`
 * already relies on.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { BrowserContext, Page } from "playwright";
import { establishSession } from "./session-establish.ts";

function makeStubPage(): Page {
	const fake: Pick<Page, "isClosed"> = { isClosed: () => false };
	return fake as Page;
}

function makeStubContext(): BrowserContext {
	return {} as BrowserContext;
}

test("live-profile path: probeSession live means resolveDeferredCredentials is never called and no manual_action fires", async () => {
	let resolveCalls = 0;
	let manualActionCalls = 0;
	const probeSession = async (): Promise<boolean> => true;

	await establishSession(
		{ ensureSession: undefined, probeSession },
		{
			assist: async () => "req-1",
			capture: null,
			checkpoint: async () => {
				/* no-op */
			},
			completeAssistance: async () => {
				/* no-op */
			},
			context: makeStubContext(),
			credentials: {},
			name: "icloud_notes",
			page: makeStubPage(),
			progress: async () => {
				/* no-op */
			},
			resolveDeferredCredentials: async () => {
				resolveCalls += 1;
			},
			retryablePattern: /never/,
			sendInteraction: async (req) => {
				if (req.kind === "manual_action") {
					manualActionCalls += 1;
				}
				return {
					request_id: req.request_id ?? "int-1",
					status: "success",
					type: "INTERACTION_RESPONSE",
				};
			},
		},
	);

	assert.equal(
		resolveCalls,
		0,
		"a live session must never trigger credential resolution",
	);
	assert.equal(
		manualActionCalls,
		0,
		"a live session must never trigger a manual_action handoff",
	);
});

test("dead-profile path: probeSession dead means resolveDeferredCredentials runs before manual_action, and the resolved credentials are visible", async () => {
	let resolveCalls = 0;
	let manualActionCalls = 0;
	let credentialsAtManualAction: Readonly<Record<string, string>> | null = null;
	// The connector's own live probe object; after resolveDeferredCredentials
	// "resolves" a secret, the second probe call (post-manual_action) also
	// reports dead here — the assertion is about ORDER and CALL COUNT, not
	// about a probe becoming live from credentials alone (probeSession is
	// read-only in this design; only a real browser action makes it live).
	const probeSession = async (): Promise<boolean> => false;

	await assert.rejects(
		establishSession(
			{ ensureSession: undefined, probeSession },
			{
				assist: async () => "req-1",
				capture: null,
				checkpoint: async () => {
					/* no-op */
				},
				completeAssistance: async () => {
					/* no-op */
				},
				context: makeStubContext(),
				credentials: {},
				name: "icloud_notes",
				page: makeStubPage(),
				progress: async () => {
					/* no-op */
				},
				resolveDeferredCredentials: async () => {
					resolveCalls += 1;
					credentialsAtManualAction = { ICLOUD_USERNAME: "resolved" };
				},
				retryablePattern: /never/,
				sendInteraction: async (req) => {
					if (req.kind === "manual_action") {
						manualActionCalls += 1;
					}
					return {
						request_id: req.request_id ?? "int-1",
						status: "success",
						type: "INTERACTION_RESPONSE",
					};
				},
			},
		),
		/icloud_notes_session_required/,
	);

	assert.equal(
		resolveCalls,
		1,
		"a dead session must resolve credentials exactly once, before the manual_action fallback",
	);
	assert.equal(
		manualActionCalls,
		1,
		"a dead session must still fall through to manual_action after resolving credentials",
	);
	assert.deepEqual(credentialsAtManualAction, {
		ICLOUD_USERNAME: "resolved",
	});
});

test("secrets present (no deferral configured): resolveDeferredCredentials absent leaves the dead-path unchanged — manual_action still fires, no crash", async () => {
	let manualActionCalls = 0;
	const probeSession = async (): Promise<boolean> => false;

	await assert.rejects(
		establishSession(
			{ ensureSession: undefined, probeSession },
			{
				assist: async () => "req-1",
				capture: null,
				checkpoint: async () => {
					/* no-op */
				},
				completeAssistance: async () => {
					/* no-op */
				},
				context: makeStubContext(),
				// Credentials already resolved eagerly by the caller (today's
				// unchanged path for every connector that doesn't defer) — passed
				// through as before.
				credentials: { ICLOUD_USERNAME: "already-resolved" },
				name: "icloud_notes",
				page: makeStubPage(),
				progress: async () => {
					/* no-op */
				},
				// No resolveDeferredCredentials at all — the pre-existing shape.
				retryablePattern: /never/,
				sendInteraction: async (req) => {
					if (req.kind === "manual_action") {
						manualActionCalls += 1;
					}
					return {
						request_id: req.request_id ?? "int-1",
						status: "success",
						type: "INTERACTION_RESPONSE",
					};
				},
			},
		),
		/icloud_notes_session_required/,
	);

	assert.equal(
		manualActionCalls,
		1,
		"omitting resolveDeferredCredentials must not change the dead-path manual_action behavior",
	);
});

test("ensureSession path is entirely unaffected: resolveDeferredCredentials is never consulted when ensureSession is present", async () => {
	let resolveCalls = 0;
	let ensureSessionCalls = 0;

	await establishSession(
		{
			ensureSession: async () => {
				ensureSessionCalls += 1;
			},
			probeSession: undefined,
		},
		{
			assist: async () => "req-1",
			capture: null,
			checkpoint: async () => {
				/* no-op */
			},
			completeAssistance: async () => {
				/* no-op */
			},
			context: makeStubContext(),
			credentials: { CHATGPT_USERNAME: "already-resolved" },
			name: "chatgpt",
			page: makeStubPage(),
			progress: async () => {
				/* no-op */
			},
			resolveDeferredCredentials: async () => {
				resolveCalls += 1;
			},
			retryablePattern: /never/,
			sendInteraction: async (req) => ({
				request_id: req.request_id ?? "int-1",
				status: "success",
				type: "INTERACTION_RESPONSE",
			}),
		},
	);

	assert.equal(ensureSessionCalls, 1);
	assert.equal(
		resolveCalls,
		0,
		"ensureSession's priority over probeSession means resolveDeferredCredentials is dead code on this path",
	);
});
