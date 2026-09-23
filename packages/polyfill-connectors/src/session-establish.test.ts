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
				return {};
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
					return { ICLOUD_USERNAME: "resolved" };
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

test("ensureSession-only path (no probeSession) is unaffected: resolveDeferredCredentials is never consulted", async () => {
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
				return {};
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
		"no probeSession means there is no probe result to defer credentials on, so this path is byte-for-byte unchanged",
	);
});

// ─── Both hooks present (heb shape: auth + probeSession + ensureSession) ────
//
// Root cause fixed here: heb's probeSession used to be cookie-name-based and
// missed real session cookies (sst, sat, HEB_AMP_SESSION_ID), so a genuinely
// live seeded browser profile probed as dead. Separately, ensureSession's
// unconditional priority over probeSession meant credentials resolved eagerly
// before any probe ran at all, failing the run as `heb_credentials_missing`
// even on a live session. Both are fixed together: probeSession now runs
// FIRST when both hooks are declared; a live result skips ensureSession (and
// credential resolution) entirely, and only a dead result falls through to
// resolveDeferredCredentials + ensureSession, unchanged from the
// ensureSession-only path from that point on.

test("both hooks, live probe, probeSessionIsAuthoritative=true (heb shape): ensureSession never runs and credentials are never resolved", async () => {
	let resolveCalls = 0;
	let ensureSessionCalls = 0;
	let probeCalls = 0;

	await establishSession(
		{
			ensureSession: async () => {
				ensureSessionCalls += 1;
			},
			probeSession: async () => {
				probeCalls += 1;
				return true;
			},
			probeSessionIsAuthoritative: true,
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
			credentials: {},
			name: "heb",
			page: makeStubPage(),
			progress: async () => {
				/* no-op */
			},
			resolveDeferredCredentials: async () => {
				resolveCalls += 1;
				return { HEB_USERNAME: "resolved", HEB_PASSWORD: "resolved" };
			},
			retryablePattern: /never/,
			sendInteraction: async (req) => ({
				request_id: req.request_id ?? "int-1",
				status: "success",
				type: "INTERACTION_RESPONSE",
			}),
		},
	);

	assert.equal(probeCalls, 1);
	assert.equal(
		ensureSessionCalls,
		0,
		"a live probe on a connector with both hooks must skip ensureSession entirely",
	);
	assert.equal(
		resolveCalls,
		0,
		"a live probe must never resolve or require credentials",
	);
});

test("both hooks, dead probe, probeSessionIsAuthoritative=true (heb shape): credentials resolve before ensureSession, which then runs with the resolved values", async () => {
	let resolveCalls = 0;
	let ensureSessionCredentials: Readonly<Record<string, string>> | null = null;
	let probeCalls = 0;

	await establishSession(
		{
			ensureSession: async ({ credentials }) => {
				ensureSessionCredentials = credentials;
			},
			probeSession: async () => {
				probeCalls += 1;
				return false;
			},
			probeSessionIsAuthoritative: true,
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
			credentials: {},
			name: "heb",
			page: makeStubPage(),
			progress: async () => {
				/* no-op */
			},
			resolveDeferredCredentials: async () => {
				resolveCalls += 1;
				return { HEB_USERNAME: "resolved", HEB_PASSWORD: "resolved" };
			},
			retryablePattern: /never/,
			sendInteraction: async (req) => ({
				request_id: req.request_id ?? "int-1",
				status: "success",
				type: "INTERACTION_RESPONSE",
			}),
		},
	);

	assert.equal(
		probeCalls,
		1,
		"the probe must run exactly once before ensureSession",
	);
	assert.equal(resolveCalls, 1);
	assert.deepEqual(ensureSessionCredentials, {
		HEB_USERNAME: "resolved",
		HEB_PASSWORD: "resolved",
	});
});

test("both hooks, not opted in, no resolveDeferredCredentials supplied: dead probe still runs ensureSession with the eagerly-resolved credentials", async () => {
	let ensureSessionCredentials: Readonly<Record<string, string>> | null = null;

	await establishSession(
		{
			ensureSession: async ({ credentials }) => {
				ensureSessionCredentials = credentials;
			},
			probeSession: async () => false,
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
			credentials: {
				HEB_USERNAME: "already-resolved",
				HEB_PASSWORD: "already-resolved",
			},
			name: "heb",
			page: makeStubPage(),
			progress: async () => {
				/* no-op */
			},
			// No resolveDeferredCredentials — every non-deferred caller shape.
			retryablePattern: /never/,
			sendInteraction: async (req) => ({
				request_id: req.request_id ?? "int-1",
				status: "success",
				type: "INTERACTION_RESPONSE",
			}),
		},
	);

	assert.deepEqual(ensureSessionCredentials, {
		HEB_USERNAME: "already-resolved",
		HEB_PASSWORD: "already-resolved",
	});
});

// ─── Negative controls: connectors with weak (cookie-only) probes that have
// NOT opted in via probeSessionIsAuthoritative (doordash/wholefoods shape) ──
//
// Integration-blocker regression this guards: a stale or challenge cookie
// can make a cookie-name-based probeSession report "live" even when the
// session is actually dead/challenged. Without requiring an explicit opt-in,
// that false-live probe would skip ensureSession's page-level repair entirely
// for every auth+browser+probeSession+ensureSession connector, not just heb.
// These tests pin that a live probe result, by itself, is NOT authoritative
// unless the connector explicitly opts in.

test("both hooks, live probe, probeSessionIsAuthoritative NOT set (doordash/wholefoods shape): ensureSession still runs despite the stale-cookie live probe", async () => {
	let ensureSessionCalls = 0;
	let probeCalls = 0;

	await establishSession(
		{
			ensureSession: async () => {
				ensureSessionCalls += 1;
			},
			probeSession: async () => {
				probeCalls += 1;
				// Simulates a stale/challenge cookie still present: the cookie-only
				// probe reports "live" even though the session is not actually usable.
				return true;
			},
			// probeSessionIsAuthoritative intentionally omitted.
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
			credentials: {
				DOORDASH_USERNAME: "resolved",
				DOORDASH_PASSWORD: "resolved",
			},
			name: "doordash",
			page: makeStubPage(),
			progress: async () => {
				/* no-op */
			},
			retryablePattern: /never/,
			sendInteraction: async (req) => ({
				request_id: req.request_id ?? "int-1",
				status: "success",
				type: "INTERACTION_RESPONSE",
			}),
		},
	);

	assert.equal(
		probeCalls,
		0,
		"without the opt-in, establishSession runs ensureSession directly and never consults probeSession at all — restoring exact pre-1ab4e75 ordering",
	);
	assert.equal(
		ensureSessionCalls,
		1,
		"a connector without the opt-in must always run ensureSession, even though a cookie-only probe would have reported live — this is the fix for the stale-cookie regression",
	);
});

test("both hooks, live probe, probeSessionIsAuthoritative=false explicitly (wholefoods shape): ensureSession still runs", async () => {
	let ensureSessionCalls = 0;

	await establishSession(
		{
			ensureSession: async () => {
				ensureSessionCalls += 1;
			},
			probeSession: async () => true,
			probeSessionIsAuthoritative: false,
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
			credentials: {},
			name: "wholefoods",
			page: makeStubPage(),
			progress: async () => {
				/* no-op */
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
});
