// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Sign-in handoff: a tab on WhatsApp Web's QR screen is handed to the person
 * to link it from their phone, never failed outright. Synthetic pages only.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
import type { StreamScope } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { establishSession } from "../../packages/polyfill-connectors/src/session-establish.ts";
import { TerminalError } from "../../packages/polyfill-connectors/src/terminal-error.ts";
import { makeRecordingEmit } from "../../packages/polyfill-connectors/src/test-harness.ts";
import {
	collect,
	ensureSession,
	INITIAL_SYNC_MESSAGE,
	probeSession,
	RETRYABLE_PATTERN,
	SESSION_STATE_SCRIPT,
	SIGNED_IN_SCRIPT,
	STORES_SCRIPT,
	SYNC_SCRIPT,
	type SessionTimings,
	WHATSAPP_LOGIN_MESSAGE,
} from "./index.ts";
import { validateRecord } from "./schemas.ts";

const FAST: SessionTimings = {
	bootAttempts: 3,
	bootMs: 0,
	handoffProbeMs: 1,
	handoffTimeoutSeconds: 5,
};

interface FakeApp {
	/** Reads that show the QR screen before a phone links it (Infinity: never). */
	qrReads: number;
}

function fakeWhatsAppPage(startUrl: string, app: FakeApp) {
	let url = startUrl;
	const gotos: string[] = [];
	let reads = 0;
	const signedIn = () => reads > app.qrReads;
	const sandbox = vm.createContext({
		get location() {
			return { origin: new URL(url).origin };
		},
		document: { querySelector: () => null },
		window: {
			require: (name: string) => {
				if (name === "WAWebUserPrefsMeUser") {
					return {
						getMaybeMePnUser: () =>
							signedIn() ? { _serialized: "15550000000@c.us" } : null,
						getMaybeMeLidUser: () => null,
					};
				}
				if (name === "WAWebStreamModel") {
					return { Stream: { mode: signedIn() ? "MAIN" : "QR" } };
				}
				throw new Error(`no module ${name}`);
			},
		},
	});
	const page = {
		url: () => url,
		goto: async (next: string) => {
			gotos.push(next);
			url = next;
			return null;
		},
		evaluate: async (script: unknown) => {
			reads += 1;
			return await vm.runInContext(String(script), sandbox);
		},
		context: () => ({
			newPage: async () => {
				throw new Error("the connector must never open a second tab");
			},
		}),
	};
	return { gotos, page };
}

function handoff() {
	const assists: string[] = [];
	const completions: string[] = [];
	return {
		assists,
		completions,
		hooks: {
			assist: async (req: { message: string }) => {
				assists.push(req.message);
				return "whatsapp_handoff";
			},
			capture: null,
			completeAssistance: async (_id: string, status: string) => {
				completions.push(status);
			},
			sendInteraction: async () => {
				throw new Error("unexpected manual action fallback");
			},
		},
	};
}

type EnsureArgs = Parameters<typeof ensureSession>[0];

test("signin handoff: the QR screen is handed to the person, and collection waits until a phone links the browser", async () => {
	const { gotos, page } = fakeWhatsAppPage("about:blank", { qrReads: 6 });
	const h = handoff();
	await ensureSession({ ...h.hooks, page } as unknown as EnsureArgs, FAST);
	assert.deepEqual(
		gotos,
		["https://web.whatsapp.com/"],
		"one page, opened once",
	);
	assert.deepEqual(h.assists, [WHATSAPP_LOGIN_MESSAGE]);
	assert.match(h.assists[0] ?? "", /Linked devices/);
	assert.deepEqual(h.completions, ["resolved"]);
});

test("signin handoff: a signed-in page goes straight to collection, with no handoff and no navigation", async () => {
	const { gotos, page } = fakeWhatsAppPage("https://web.whatsapp.com/", {
		qrReads: 0,
	});
	const h = handoff();
	await ensureSession({ ...h.hooks, page } as unknown as EnsureArgs, FAST);
	assert.deepEqual(gotos, []);
	assert.deepEqual(h.assists, []);
});

test("signin handoff: when no one links the browser before the window closes, the run fails as whatsapp_web_auth_failed", async () => {
	const { page } = fakeWhatsAppPage("https://web.whatsapp.com/", {
		qrReads: Number.POSITIVE_INFINITY,
	});
	const h = handoff();
	await assert.rejects(
		ensureSession({ ...h.hooks, page } as unknown as EnsureArgs, {
			...FAST,
			handoffTimeoutSeconds: 0,
		}),
		(error: unknown) => {
			// A bare code: the runtime's session wrapper keeps only that shape.
			assert.equal((error as Error).message, "whatsapp_web_auth_failed");
			return true;
		},
	);
	assert.equal(h.assists.length, 1);
	assert.deepEqual(h.completions, ["escalated"]);
});

// ─── Through the runtime's own session wrapper ───────────────────────────

test("signin handoff: through establishSession, a handoff no one completes ends as code whatsapp_web_auth_failed, not retryable", async () => {
	const { page } = fakeWhatsAppPage("https://web.whatsapp.com/", {
		qrReads: Number.POSITIVE_INFINITY,
	});
	const h = handoff();
	const stderr: string[] = [];
	const original = console.error;
	console.error = (...args: unknown[]) => {
		stderr.push(args.map(String).join(" "));
	};
	let thrown: unknown;
	try {
		await establishSession(
			{
				ensureSession: (args) =>
					ensureSession(args, { ...FAST, handoffTimeoutSeconds: 0 }),
				probeSession: probeSession as never,
				probeSessionIsAuthoritative: true,
			},
			{
				...h.hooks,
				checkpoint: async () => {},
				context: {} as never,
				name: "whatsapp_web",
				page: page as never,
				progress: async () => {},
				retryablePattern: RETRYABLE_PATTERN,
			} as never,
		);
	} catch (error) {
		thrown = error;
	} finally {
		console.error = original;
	}
	assert.ok(
		thrown instanceof TerminalError,
		"establishSession throws a TerminalError",
	);
	assert.equal(thrown.code, "whatsapp_web_auth_failed");
	assert.equal(thrown.retryable, false);
	assert.deepEqual(h.completions, ["escalated"]);
	assert.ok(
		stderr.some((line) => /stayed on its sign-in QR code/.test(line)),
		"the human sentence is kept as a stderr diagnostic",
	);
});

// ─── A fresh link, then the client's first sync ──────────────────────────

const READY = {
	require_function: true,
	chats: true,
	contacts: true,
	groups: true,
	find_messages: true,
	send_request: true,
};

const CHAT = {
	id: "15550000001@c.us",
	server: "c.us",
	title: "Synthetic chat",
	t: 1792608300,
	archive: false,
	pin: null,
	mute_expiration: 0,
	unread_count: 0,
	read_only: false,
	history_state: "COMPLETE_AND_NO_MORE_MESSAGE_REMAIN_ON_PRIMARY",
	msgs_in_memory: 1,
};

interface LinkWorld {
	/** Session reads that show the QR screen before a phone links it. */
	qrReads: number;
	/** Sync-state reads after the link that say "not caught up yet" (Infinity: never). */
	syncingPolls: number;
}

/**
 * One page across ensureSession and collect: QR, then the client knows its
 * own user, then its stream is not yet MAIN (and its offline resume not
 * complete) for N sync reads, then it has caught up. The session and sync
 * scripts run for real in a vm against stub modules; store reads are stubs.
 */
function linkingPage(world: LinkWorld) {
	let sessionReads = 0;
	let syncReads = 0;
	const linked = () => sessionReads > world.qrReads;
	const caughtUp = () => syncReads > world.syncingPolls;
	const sandbox = vm.createContext({
		location: { origin: "https://web.whatsapp.com" },
		document: { querySelector: () => null },
		window: {
			require: (name: string) => {
				if (name === "WAWebUserPrefsMeUser") {
					return {
						getMaybeMePnUser: () =>
							linked() ? { _serialized: "15550000000@c.us" } : null,
						getMaybeMeLidUser: () => null,
					};
				}
				if (name === "WAWebStreamModel") {
					return {
						Stream: {
							mode: !linked() ? "QR" : caughtUp() ? "MAIN" : "SYNCING",
						},
					};
				}
				if (name === "WAWebOfflineHandler") {
					return {
						OfflineMessageHandler: { isResumeComplete: () => caughtUp() },
					};
				}
				throw new Error(`no module ${name}`);
			},
		},
	});
	const page = {
		url: () => "https://web.whatsapp.com/",
		goto: async () => {
			throw new Error("no navigation expected");
		},
		evaluate: async (script: unknown) => {
			const s = String(script);
			if (s === SESSION_STATE_SCRIPT || s === SIGNED_IN_SCRIPT) {
				sessionReads += 1;
				return await vm.runInContext(s, sandbox);
			}
			if (s === SYNC_SCRIPT) {
				syncReads += 1;
				return await vm.runInContext(s, sandbox);
			}
			if (s === STORES_SCRIPT) return READY;
			if (s.includes("getModelsArray().map((c) =>")) {
				// Before the client has caught up the list is still filling.
				return caughtUp() ? [CHAT] : [];
			}
			if (s.includes("Contact.getModelsArray().filter")) return [];
			throw new Error("fake page: unexpected script");
		},
	};
	return { page, syncReads: () => syncReads };
}

/** Tight steady-state budget: far fewer reads than the cold sync needs. */
const STEADY = {
	settleAttempts: 2,
	settleMs: 0,
	historyAttempts: 1,
	historyMs: 0,
	initialSyncAttempts: 50,
	initialSyncMs: 0,
	initialSyncProgressEvery: 5,
};

async function linkThenCollect(world: LinkWorld, handoffFirst: boolean) {
	const { page, syncReads } = linkingPage(world);
	const h = handoff();
	if (handoffFirst) {
		await ensureSession({ ...h.hooks, page } as unknown as EnsureArgs, FAST);
		assert.deepEqual(
			h.completions,
			["resolved"],
			"the person linked the browser",
		);
	}
	const harness = makeRecordingEmit(validateRecord);
	const progress: string[] = [];
	let error: unknown;
	try {
		await collect(
			{
				requested: new Map<string, StreamScope>([["chats", { name: "chats" }]]),
				page: page as never,
				emit: harness.emit,
				emitRecord: harness.emitRecord,
				progress: async (message: string) => {
					progress.push(message);
				},
			},
			STEADY,
		);
	} catch (e) {
		error = e;
	}
	const states = harness.protocolMessages.filter(
		(m) => (m as { type?: string }).type === "STATE",
	);
	return { error, harness, progress, states, syncReads: syncReads() };
}

test("fresh link: collect waits through the client's first sync, then completes", async () => {
	const r = await linkThenCollect({ qrReads: 4, syncingPolls: 12 }, true);
	assert.equal(r.error, undefined, String(r.error));
	assert.ok(
		r.syncReads > 12,
		"it kept reading the sync state past the steady budget",
	);
	assert.equal(r.harness.emitted.filter((e) => e.stream === "chats").length, 1);
	assert.equal(
		r.states.length,
		1,
		"chats checkpointed once the sync completed",
	);
	assert.ok(r.progress.length >= 2, "progress while it waits");
	assert.ok(r.progress.every((m) => m === INITIAL_SYNC_MESSAGE));
	assert.match(INITIAL_SYNC_MESSAGE, /syncing your chats from your phone/);
});

test("fresh link: a first sync that never completes fails retryable, with no STATE", async () => {
	const r = await linkThenCollect(
		{ qrReads: 4, syncingPolls: Number.POSITIVE_INFINITY },
		true,
	);
	assert.equal(
		(r.error as { code?: string }).code,
		"whatsapp_web_chat_list_never_settled",
	);
	assert.equal((r.error as { retryable?: boolean }).retryable, true);
	assert.match(String((r.error as Error).message), /nothing was checkpointed/);
	assert.equal(r.states.length, 0);
	assert.equal(r.harness.emitted.length, 0);
});

test("fresh link: without a handoff in this run the steady-state budget is kept", async () => {
	const r = await linkThenCollect({ qrReads: -1, syncingPolls: 12 }, false);
	assert.equal(
		(r.error as { code?: string }).code,
		"whatsapp_web_chat_list_never_settled",
	);
	assert.equal(r.syncReads, STEADY.settleAttempts + 1);
	assert.deepEqual(r.progress, []);
	assert.equal(r.states.length, 0);
});
