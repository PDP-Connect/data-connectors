// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for a page that reloads mid-run. A live run read 454 records over
 * seven minutes, then failed terminally with "page.evaluate: TypeError:
 * window.require is not a function" from a chat-list read: the module loader
 * existed when the run began, and a reloading document does not define it
 * until the app boots again. Every value here is synthetic, in the shapes
 * `__fixtures__/` holds; the page is a fake that answers each script by what
 * it reads.
 *
 *   1. A read that fails because the page reloaded is retried once the app
 *      is signed in and its stores are ready again, and the run completes.
 *   2. A reload onto the signed-out (QR) screen ends the run as an auth
 *      failure, not an untyped error.
 *   3. More reloads than the run recovers from end it as a retryable
 *      failure.
 *   4. The on-demand history request is never resent after a reload; the
 *      chat is gapped and its gap says why the phone was not asked.
 *   5. Each recovery or give-up writes one run-log line: the app's build
 *      before and after, the screen it landed on, the seconds since the run
 *      began and the reload count. A reload onto the "open in another
 *      window" screen ends the run with its own non-retryable code.
 *   6. The history-sync-on-demand switch is read once at run start for the
 *      run log, and a chat gapped because it is off says so.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
	DIAGNOSTIC_LINE_MAX_CHARS,
	setConnectorDiagnosticSink,
} from "../../packages/polyfill-connectors/src/connector-diagnostic.ts";
import type { StreamScope } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import {
	makeRecordingEmit,
	type RecordingEmit,
} from "../../packages/polyfill-connectors/src/test-harness.ts";
import { collect, isPageReloadError } from "./index.ts";
import { validateRecord } from "./schemas.ts";

const fixture = (name: string): unknown =>
	JSON.parse(
		readFileSync(
			new URL(`./__fixtures__/${name}.json`, import.meta.url),
			"utf8",
		),
	);

const asObject = (value: unknown): Record<string, unknown> =>
	typeof value === "object" && value !== null
		? (value as Record<string, unknown>)
		: {};

const chatsFixture = fixture("chats") as Array<Record<string, unknown>>;
const memoryFixture = fixture("messages-in-memory") as Array<
	Record<string, unknown>
>;

const READY = {
	require_function: true,
	chats: true,
	contacts: true,
	groups: true,
	find_messages: true,
	send_request: true,
};

const TIMINGS = {
	settleAttempts: 1,
	settleMs: 0,
	historyAttempts: 1,
	historyMs: 0,
	reloadAttempts: 3,
	reloadMs: 0,
};

const requested = new Map<string, StreamScope>(
	["chats", "messages", "contacts", "groups"].map((name) => [name, { name }]),
);

const STATE_0 = "COMPLETE_BUT_MORE_MESSAGES_REMAIN_ON_PRIMARY";
const STATE_1 = "COMPLETE_AND_NO_MORE_MESSAGE_REMAIN_ON_PRIMARY";

/** The error the live run's chat-list read raised. */
const LOADER_GONE = () =>
	new Error(
		"page.evaluate: TypeError: window.require is not a function\n    at eval (eval at evaluate (:337:30), <anonymous>:3:27)",
	);

type Kind = "chats" | "walk" | "release" | "send" | "contacts" | "groups";

interface FakeOptions {
	historyState: string;
	/** Throw for the n-th (1-based) call of a kind, or return null. */
	fail?: (kind: Kind, call: number) => Error | null;
	session?: () => string;
	readinessFailure?: ((call: number) => Error | null) | undefined;
	/** Return unavailable stores from this 1-based readiness read onward. */
	readinessNotReadyFrom?: number;
	sendAnswer?: unknown;
	/** Replace the walk's answer for the n-th (1-based) call. */
	walkAnswer?: ((call: number, chatId: string) => unknown) | undefined;
	/** The page context (build version, screen) for the n-th read. */
	context?: ((call: number) => unknown) | undefined;
	/** The history-sync-on-demand switch's answer. */
	historyGate?: unknown;
	/** Private own-account identity on each read, starting with run setup. */
	account?: (call: number) => string | null;
}

function fakeWorld(options: FakeOptions) {
	const chats = structuredClone(chatsFixture.slice(0, 1));
	const chat = chats[0];
	assert.ok(chat !== undefined);
	chat.history_state = options.historyState;
	const id = String(chat.id);
	const calls: Record<Kind, number> = {
		chats: 0,
		walk: 0,
		release: 0,
		send: 0,
		contacts: 0,
		groups: 0,
	};
	let sessionReads = 0;
	let readinessReads = 0;
	let contextReads = 0;
	let accountReads = 0;
	const answer = (kind: Kind, value: unknown): Promise<unknown> => {
		calls[kind] += 1;
		const error = options.fail?.(kind, calls[kind]) ?? null;
		return error ? Promise.reject(error) : Promise.resolve(value);
	};
	const page = {
		evaluate: (script: unknown): Promise<unknown> => {
			const s = String(script);
			if (s.includes("const ownAccountIdentity")) {
				accountReads += 1;
				return Promise.resolve(options.account?.(accountReads) ?? null);
			}
			if (s.includes('"signed_in"')) {
				sessionReads += 1;
				return Promise.resolve(options.session?.() ?? "signed_in");
			}
			if (s.includes("require_function")) {
				readinessReads += 1;
				const error = options.readinessFailure?.(readinessReads) ?? null;
				const ready =
					options.readinessNotReadyFrom !== undefined &&
					readinessReads >= options.readinessNotReadyFrom
						? { ...READY, chats: false }
						: READY;
				return error ? Promise.reject(error) : Promise.resolve(ready);
			}
			if (s.includes("WAWebBuildConstants") && options.context) {
				contextReads += 1;
				return Promise.resolve(options.context(contextReads));
			}
			if (s.includes("WAWebOfflineHandler"))
				return Promise.resolve({ mode: "MAIN", resume_complete: true });
			if (s.includes("sendPeerDataOperationRequest"))
				return answer("send", options.sendAnswer ?? { sent: true });
			if (
				s.includes("isHistorySyncOnDemandEnabled") &&
				"historyGate" in options
			)
				return Promise.resolve(options.historyGate);
			if (s.includes("getModelsArray().map((c) =>"))
				return answer("chats", chats);
			if (s.includes("msgFindBefore") && options.walkAnswer)
				return answer("walk", options.walkAnswer(calls.walk + 1, id));
			if (s.includes("msgFindBefore"))
				return answer("walk", {
					chat_id: id,
					status: 200,
					memory: [{ ...memoryFixture[0], remote: id }],
					messages: [],
					complete: true,
					anchored: true,
					stop: "short_page",
				});
			if (s.includes("Contact.getModelsArray().filter"))
				return answer("contacts", fixture("contacts"));
			if (s.includes("WAWebGroupMetadataCollection.getModelsArray().map"))
				return answer("groups", fixture("groups"));
			if (s.includes("if (walks) walks.delete("))
				return answer("release", true);
			return Promise.reject(new Error("fake page: unexpected script"));
		},
	};
	return {
		page,
		id,
		calls,
		sessionReads: () => sessionReads,
		readinessReads: () => readinessReads,
	};
}

async function runCollect(
	page: unknown,
	streams: Map<string, StreamScope> = requested,
): Promise<{ harness: RecordingEmit; error: unknown }> {
	const harness = makeRecordingEmit(validateRecord);
	try {
		await collect(
			{
				requested: streams,
				page: page as Parameters<typeof collect>[0]["page"],
				emit: harness.emit,
				emitRecord: harness.emitRecord,
			},
			TIMINGS,
		);
		return { harness, error: null };
	} catch (error) {
		return { harness, error };
	}
}

/** Run-log lines written while `run` runs. */
async function diagnosticsDuring<T>(
	run: () => Promise<T>,
): Promise<{ result: T; lines: string[] }> {
	const lines: string[] = [];
	setConnectorDiagnosticSink((line) => lines.push(line));
	try {
		return { result: await run(), lines };
	} finally {
		setConnectorDiagnosticSink(undefined);
	}
}

const BUILD_BEFORE = "2.3000.1054700624";
const BUILD_AFTER = "2.3000.1054712345";

const gapsOf = (harness: RecordingEmit) =>
	harness.protocolMessages
		.filter((m) => asObject(m).type === "DETAIL_GAP")
		.map(asObject);

test("isPageReloadError: the reload errors match; a closed page and other errors do not", () => {
	assert.equal(isPageReloadError(LOADER_GONE()), true);
	assert.equal(
		isPageReloadError(
			new Error(
				"page.evaluate: Execution context was destroyed, most likely because of a navigation",
			),
		),
		true,
	);
	assert.equal(
		isPageReloadError(
			new Error(
				"page.evaluate: Target page, context or browser has been closed",
			),
		),
		false,
	);
	assert.equal(isPageReloadError(new Error("boom")), false);
});

test("a chat-list read that hits a reloading page is retried after the app boots, and the run completes", async () => {
	const world = fakeWorld({
		historyState: STATE_1,
		// The first chat-list read succeeds; the next one lands mid-reload.
		fail: (kind, call) =>
			kind === "chats" && call === 2 ? LOADER_GONE() : null,
	});
	const { harness, error } = await runCollect(world.page);
	assert.equal(error, null);
	assert.ok(world.calls.chats >= 3, "the failed read was retried");
	assert.ok(world.sessionReads() >= 1, "the app's session was read again");
	const streams = new Set(harness.emitted.map((e) => e.stream));
	for (const stream of ["chats", "messages", "contacts", "groups"]) {
		assert.ok(streams.has(stream), `${stream} still emitted`);
	}
	assert.deepEqual(gapsOf(harness), []);
});

test("a message walk that hits a reloading page is retried, and the chat is not gapped", async () => {
	const world = fakeWorld({
		historyState: STATE_1,
		fail: (kind, call) =>
			kind === "walk" && call === 1 ? LOADER_GONE() : null,
	});
	const { harness, error } = await runCollect(world.page);
	assert.equal(error, null);
	assert.equal(world.calls.walk, 2);
	assert.ok(
		harness.emitted.some(
			(e) => e.stream === "messages" && e.data.chat_id === world.id,
		),
	);
	assert.deepEqual(gapsOf(harness), []);
});

test("a reload onto the signed-out screen ends the run as an auth failure", async () => {
	const world = fakeWorld({
		historyState: STATE_1,
		fail: (kind) => (kind === "groups" ? LOADER_GONE() : null),
		session: () => "signed_out",
	});
	const { error } = await runCollect(world.page);
	assert.equal(asObject(error).code, "whatsapp_web_auth_failed");
	assert.equal(asObject(error).retryable, false);
});

test("a page that keeps reloading ends the run as a retryable failure", async () => {
	const world = fakeWorld({
		historyState: STATE_1,
		fail: (kind) => (kind === "groups" ? LOADER_GONE() : null),
	});
	const { error } = await runCollect(world.page);
	assert.equal(asObject(error).code, "whatsapp_web_page_reloaded");
	assert.equal(asObject(error).retryable, true);
	assert.equal(world.calls.groups, 4, "one read plus three recoveries");
});

test("a history request interrupted by a reload is not resent; the chat's gap says why", async () => {
	const world = fakeWorld({
		historyState: STATE_0,
		fail: (kind, call) =>
			kind === "send" && call === 1 ? LOADER_GONE() : null,
	});
	const { harness, error } = await runCollect(world.page);
	assert.equal(error, null);
	assert.equal(world.calls.send, 1, "never resent");
	const gaps = gapsOf(harness);
	assert.equal(gaps.length, 1);
	const lastError = asObject(gaps[0]?.last_error);
	assert.equal(lastError.class, "history_remains_on_phone");
	assert.match(
		String(lastError.message),
		/delivery is unconfirmed and it was not retried$/,
	);
});

test("a history request the page refused names the page's reason in the gap", async () => {
	const world = fakeWorld({
		historyState: STATE_0,
		sendAnswer: {
			sent: false,
			reason: "history_sync_on_demand_gate_unverified",
		},
	});
	const { harness, error } = await runCollect(world.page);
	assert.equal(error, null);
	const lastError = asObject(gapsOf(harness)[0]?.last_error);
	assert.match(
		String(lastError.message),
		/no on-demand history request was sent this run \(history_sync_on_demand_gate_unverified\)$/,
	);
});

test("a recovered reload writes one run-log line with the build before and after, the screen, the time and the count", async () => {
	const world = fakeWorld({
		historyState: STATE_1,
		fail: (kind, call) =>
			kind === "chats" && call === 2 ? LOADER_GONE() : null,
		// Read once at run start, then once per boot poll after the reload.
		context: (call) => ({
			version: call === 1 ? BUILD_BEFORE : BUILD_AFTER,
			screen: "main",
		}),
	});
	const { result, lines } = await diagnosticsDuring(() =>
		runCollect(world.page),
	);
	assert.equal(result.error, null);
	const reloadLines = lines.filter((line) => line.includes(" reload_"));
	assert.equal(reloadLines.length, 1);
	const line = reloadLines[0] ?? "";
	assert.ok(line.startsWith("[whatsapp_web-diagnostic] reload_recovered {"));
	const fields = JSON.parse(line.slice(line.indexOf("{")));
	assert.deepEqual(
		{ ...fields, secs: typeof fields.secs },
		{
			before: BUILD_BEFORE,
			after: BUILD_AFTER,
			screen: "main",
			secs: "number",
			reloads: 1,
		},
	);
	assert.ok(line.length <= DIAGNOSTIC_LINE_MAX_CHARS, line);
});

test("a reload onto the open-in-another-window screen ends the run with its own non-retryable code", async () => {
	const world = fakeWorld({
		historyState: STATE_1,
		fail: (kind) => (kind === "groups" ? LOADER_GONE() : null),
		context: (call) => ({
			version: BUILD_BEFORE,
			screen: call === 1 ? "main" : "takeover",
		}),
	});
	const { result, lines } = await diagnosticsDuring(() =>
		runCollect(world.page),
	);
	assert.equal(asObject(result.error).code, "whatsapp_web_opened_elsewhere");
	assert.equal(asObject(result.error).retryable, false);
	assert.equal(world.calls.groups, 1, "not retried");
	assert.ok(
		lines.some((line) =>
			line.startsWith("[whatsapp_web-diagnostic] reload_takeover {"),
		),
		lines.join("\n"),
	);
});

test("the history switch is read once at run start, and a chat gapped because it is off says so", async () => {
	const world = fakeWorld({
		historyState: STATE_0,
		historyGate: false,
		sendAnswer: { sent: false, reason: "history_sync_on_demand_disabled" },
	});
	const { result, lines } = await diagnosticsDuring(() =>
		runCollect(world.page),
	);
	assert.equal(result.error, null);
	assert.deepEqual(
		lines.filter((line) => line.includes(" history_on_demand")),
		['[whatsapp_web-diagnostic] history_on_demand {"enabled":false}'],
	);
	const lastError = asObject(gapsOf(result.harness)[0]?.last_error);
	assert.equal(lastError.class, "history_remains_on_phone");
	assert.match(
		String(lastError.message),
		/WhatsApp Web has on-demand history turned off for this client/,
	);
});

// Messages are only collected together with their chats.
const chatsAndMessages = new Map<string, StreamScope>(
	["chats", "messages"].map((name) => [name, { name }]),
);
const CONTEXT_GONE = () =>
	new Error("page.evaluate: Execution context was destroyed");

test("a message walk that reloads into signed-out ends with auth failure, not a chat gap", async () => {
	const world = fakeWorld({
		historyState: STATE_1,
		fail: (kind) => (kind === "walk" ? LOADER_GONE() : null),
		session: () => "signed_out",
	});
	const { harness, error } = await runCollect(world.page, chatsAndMessages);
	assert.equal(asObject(error).code, "whatsapp_web_auth_failed");
	assert.equal(asObject(error).retryable, false);
	assert.deepEqual(gapsOf(harness), []);
	assert.equal(world.calls.walk, 1);
});

test("a message walk that exhausts the reload budget ends the run, not a chat gap", async () => {
	const world = fakeWorld({
		historyState: STATE_1,
		fail: (kind) => (kind === "walk" ? LOADER_GONE() : null),
	});
	const { harness, error } = await runCollect(world.page, chatsAndMessages);
	assert.equal(asObject(error).code, "whatsapp_web_page_reloaded");
	assert.equal(asObject(error).retryable, true);
	assert.equal(world.calls.walk, 4);
	assert.deepEqual(gapsOf(harness), []);
});

test("a second navigation during readiness consumes budget and recovers", async () => {
	const world = fakeWorld({
		historyState: STATE_1,
		fail: (kind, call) =>
			kind === "groups" && call === 1 ? LOADER_GONE() : null,
		// First readiness read is initial collect setup; second is recovery.
		readinessFailure: (call) => (call === 2 ? CONTEXT_GONE() : null),
	});
	const { harness, error } = await runCollect(world.page);
	assert.equal(error, null);
	assert.equal(world.readinessReads(), 3);
	assert.equal(world.sessionReads(), 2);
	assert.ok(world.calls.groups >= 2);
	assert.deepEqual(gapsOf(harness), []);
});

test("continuous readiness navigation exhausts the shared reload budget", async () => {
	const world = fakeWorld({
		historyState: STATE_1,
		fail: (kind) => (kind === "groups" ? LOADER_GONE() : null),
		readinessFailure: (call) => (call > 1 ? CONTEXT_GONE() : null),
	});
	const { error } = await runCollect(world.page);
	assert.equal(asObject(error).code, "whatsapp_web_page_reloaded");
	assert.equal(asObject(error).retryable, true);
	assert.equal(
		world.calls.groups,
		1,
		"read cannot retry before recovery succeeds",
	);
	assert.equal(
		world.readinessReads(),
		4,
		"initial read plus three bounded recovery reads",
	);
	assert.equal(world.sessionReads(), 3);
});

test("ordinary message read failures still produce a per-chat gap", async () => {
	const world = fakeWorld({
		historyState: STATE_1,
		fail: (kind) =>
			kind === "walk" ? new Error("ordinary local read failure") : null,
	});
	const { harness, error } = await runCollect(world.page, chatsAndMessages);
	assert.equal(error, null);
	const gaps = gapsOf(harness);
	assert.equal(gaps.length, 1);
	assert.equal(asObject(gaps[0]?.last_error).class, "local_walk_failed");
});

/** A walk chunk that reads one message and says more remain. */
const unfinishedChunk = (_call: number, chatId: string) => ({
	chat_id: chatId,
	status: 200,
	memory: [{ ...memoryFixture[0], remote: chatId }],
	messages: [],
	complete: false,
	anchored: true,
	more: true,
	token: "walk-1",
	stop: null,
});

for (const [name, session, code] of [
	["signed-out", "signed_out", "whatsapp_web_auth_failed"],
	["an exhausted reload budget", "signed_in", "whatsapp_web_page_reloaded"],
] as const) {
	test(`releasing a stalled walk's anchor on a reloading page ends the run with ${name}, not a chat gap`, async () => {
		// The second chunk brings nothing new, so the walk stops and releases
		// its anchor; that release meets a reloading page.
		const world = fakeWorld({
			historyState: STATE_1,
			walkAnswer: unfinishedChunk,
			fail: (kind) => (kind === "release" ? LOADER_GONE() : null),
			session: () => session,
		});
		const { harness, error } = await runCollect(world.page, chatsAndMessages);
		assert.equal(asObject(error).code, code);
		assert.equal(world.calls.walk, 2);
		assert.ok(world.calls.release >= 1);
		assert.deepEqual(gapsOf(harness), []);
	});
}

test("an anchor release that fails for an ordinary reason leaves the stalled walk's gap on its chat", async () => {
	const world = fakeWorld({
		historyState: STATE_1,
		walkAnswer: unfinishedChunk,
		fail: (kind) =>
			kind === "release" ? new Error("ordinary release failure") : null,
	});
	const { harness, error } = await runCollect(world.page, chatsAndMessages);
	assert.equal(error, null);
	assert.equal(world.calls.release, 1);
	const gaps = gapsOf(harness);
	assert.equal(gaps.length, 1);
	assert.equal(asObject(gaps[0]?.last_error).class, "local_walk_page_cap");
});

for (const kind of ["walk", "release"] as const) {
	test(`store readiness exhaustion during ${kind} recovery ends the run without a chat gap`, async () => {
		const world = fakeWorld({
			historyState: STATE_1,
			...(kind === "release" ? { walkAnswer: unfinishedChunk } : {}),
			fail: (operation, call) =>
				operation === kind && call === 1 ? LOADER_GONE() : null,
			// Initial collect setup succeeds; recovery never regains its stores.
			readinessNotReadyFrom: 2,
		});
		const { harness, error } = await runCollect(world.page, chatsAndMessages);
		assert.equal(asObject(error).code, "whatsapp_web_stores_not_ready");
		assert.equal(asObject(error).retryable, true);
		assert.deepEqual(gapsOf(harness), []);
		assert.equal(world.readinessReads(), 1 + TIMINGS.reloadAttempts);
		assert.equal(world.calls[kind], 1, "the failed operation was not retried");
		assert.equal(world.calls.walk, kind === "walk" ? 1 : 2);
	});
}

for (const kind of ["groups", "chats"] as const) {
	test(`a changed account after ${kind} reload stops before retry without leaking identity`, async () => {
		const before = "synthetic-own-account-A";
		const after = "synthetic-own-account-B";
		const world = fakeWorld({
			historyState: STATE_1,
			account: (call) => (call === 1 ? before : after),
			fail: (operation, call) =>
				operation === kind && call === 1 ? LOADER_GONE() : null,
		});
		const { result, lines } = await diagnosticsDuring(() =>
			runCollect(world.page),
		);
		assert.equal(asObject(result.error).code, "whatsapp_web_auth_failed");
		assert.equal(asObject(result.error).retryable, false);
		assert.equal(
			world.calls[kind],
			1,
			"the other account's read was never retried",
		);
		assert.equal(
			result.harness.emitted.some((e) => e.stream === kind),
			false,
		);
		assert.ok(lines.some((line) => line.includes("reload_signed_out")));
		for (const id of [before, after]) {
			assert.equal(lines.join("\n").includes(id), false);
			assert.equal(String(result.error).includes(id), false);
			assert.equal(JSON.stringify(result.harness.emitted).includes(id), false);
		}
	});
}

test("the same account after a groups reload recovers normally", async () => {
	const world = fakeWorld({
		historyState: STATE_1,
		account: () => "synthetic-own-account-A",
		fail: (kind, call) =>
			kind === "groups" && call === 1 ? LOADER_GONE() : null,
	});
	const { harness, error } = await runCollect(world.page);
	assert.equal(error, null);
	assert.ok(world.calls.groups >= 2, "the failed groups read was retried");
	assert.ok(harness.emitted.some((e) => e.stream === "groups"));
	assert.deepEqual(gapsOf(harness), []);
});
