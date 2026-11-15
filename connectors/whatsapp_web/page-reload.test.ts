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
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
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

type Kind = "chats" | "walk" | "send" | "contacts" | "groups";

interface FakeOptions {
	historyState: string;
	/** Throw for the n-th (1-based) call of a kind, or return null. */
	fail?: (kind: Kind, call: number) => Error | null;
	session?: () => string;
	sendAnswer?: unknown;
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
		send: 0,
		contacts: 0,
		groups: 0,
	};
	let sessionReads = 0;
	const answer = (kind: Kind, value: unknown): Promise<unknown> => {
		calls[kind] += 1;
		const error = options.fail?.(kind, calls[kind]) ?? null;
		return error ? Promise.reject(error) : Promise.resolve(value);
	};
	const page = {
		evaluate: (script: unknown): Promise<unknown> => {
			const s = String(script);
			if (s.includes('"signed_in"')) {
				sessionReads += 1;
				return Promise.resolve(options.session?.() ?? "signed_in");
			}
			if (s.includes("require_function")) return Promise.resolve(READY);
			if (s.includes("WAWebOfflineHandler"))
				return Promise.resolve({ mode: "MAIN", resume_complete: true });
			if (s.includes("sendPeerDataOperationRequest"))
				return answer("send", options.sendAnswer ?? { sent: true });
			if (s.includes("getModelsArray().map((c) =>"))
				return answer("chats", chats);
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
			return Promise.reject(new Error("fake page: unexpected script"));
		},
	};
	return { page, id, calls, sessionReads: () => sessionReads };
}

async function runCollect(
	page: unknown,
): Promise<{ harness: RecordingEmit; error: unknown }> {
	const harness = makeRecordingEmit(validateRecord);
	try {
		await collect(
			{
				requested,
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
		/no on-demand history request was sent this run \(page_reloaded\)$/,
	);
});

test("a history request the page refused names the page's reason in the gap", async () => {
	const world = fakeWorld({
		historyState: STATE_0,
		sendAnswer: { sent: false, reason: "history_sync_on_demand_disabled" },
	});
	const { harness, error } = await runCollect(world.page);
	assert.equal(error, null);
	const lastError = asObject(gapsOf(harness)[0]?.last_error);
	assert.match(
		String(lastError.message),
		/no on-demand history request was sent this run \(history_sync_on_demand_disabled\)$/,
	);
});
