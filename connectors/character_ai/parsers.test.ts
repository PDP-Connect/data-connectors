// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { Page } from "playwright";
import { z } from "zod";
import type {
	BrowserCollectContext,
	EmittedMessage,
	RecordData,
	StreamScope,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import type { EnsureSessionArgs } from "../../packages/polyfill-connectors/src/session-establish.ts";
import { isConnectorErrorCodeShaped } from "../../packages/polyfill-connectors/src/terminal-error.ts";
import {
	checkCharacterAiSession,
	collectCharacterAi,
	ensureCharacterAiSession,
	hasCharacterAiSession,
	probeCharacterAiSession,
} from "./index.ts";
import {
	buildChatRecord,
	buildMessageRecord,
	CharacterAiPayloadError,
	checkTurn,
	compareTimes,
	latestTime,
	parseChatsPage,
	parseTurnsPage,
	walkTokenPages,
} from "./parsers.ts";
import {
	chatRecordSchema,
	messageRecordSchema,
	validateRecord,
} from "./schemas.ts";

const TOKEN = "test-token-not-real";

function fixture(name: string): Record<string, unknown> {
	return JSON.parse(
		readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8"),
	);
}

const CHATS = fixture("get-neo-chats-recent.json");
const CHAT_IDS = (CHATS.chats as Array<{ chat_id: string }>).map(
	(chat) => chat.chat_id,
);
const FIXTURE_CHAT_ID = CHAT_IDS[0] ?? "";

/** The turns fixture re-keyed to another chat (turn ids get a per-chat prefix so keys stay unique). */
function turnsFor(
	chatId: string,
	nextToken: string | null = "page-2",
): Record<string, unknown> {
	const page = fixture("get-neo-turns-uuid.json") as {
		turns: Array<{ turn_key: { chat_id: string; turn_id: string } }>;
		meta: Record<string, unknown>;
	};
	for (const turn of page.turns) {
		turn.turn_key.chat_id = chatId;
		turn.turn_key.turn_id = `${chatId.slice(0, 8)}${turn.turn_key.turn_id.slice(8)}`;
	}
	page.meta.next_token = nextToken ?? "";
	return page;
}

// ─── Fake signed-in character.ai page + neo.character.ai server ───────────

interface Seen {
	authorization: string | null;
	host: string;
	pathname: string;
	search: URLSearchParams;
}

type Route = (url: URL) => Response;

function json(
	body: unknown,
	status = 200,
	headers: Record<string, string> = {},
): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", ...headers },
	});
}

interface FakePageOptions {
	/** The page's API token; a function is read on every request. */
	token?: string | null | (() => string | null);
	url?: string;
	/** Every page.goto target, in order. */
	visits?: string[];
	/** page.goto rejects, as a navigation that never lands does. */
	gotoFails?: boolean;
	/** The next N page.evaluate calls reject as if the page navigated under them. */
	interruptions?: { count: number };
	title?: string;
}

function fakePage(
	route: Route,
	seen: Seen[],
	opts: FakePageOptions = {},
): Page {
	let url = opts.url ?? "https://character.ai/chats";
	const tokenOf = (): string | null => {
		const token = typeof opts.token === "function" ? opts.token() : opts.token;
		return token === undefined ? TOKEN : token;
	};
	return Object.assign(Object.create(null) as Page, {
		url: () => url,
		goto: async (target: string) => {
			opts.visits?.push(target);
			if (opts.gotoFails) {
				throw new Error("page.goto: net::ERR_CONNECTION_RESET");
			}
			url = target;
			return null;
		},
		close: async () => {
			// nothing to close in the fake
		},
		evaluate: async (fn: (arg: unknown) => unknown, arg: unknown) => {
			if (opts.interruptions && opts.interruptions.count > 0) {
				opts.interruptions.count -= 1;
				throw new Error(
					"page.evaluate: Execution context was destroyed, most likely because of a navigation",
				);
			}
			const saved = {
				location: Object.getOwnPropertyDescriptor(globalThis, "location"),
				document: Object.getOwnPropertyDescriptor(globalThis, "document"),
				localStorage: Object.getOwnPropertyDescriptor(
					globalThis,
					"localStorage",
				),
				fetch: globalThis.fetch,
			};
			const token = tokenOf();
			const nextData = token
				? JSON.stringify({ props: { pageProps: { token } } })
				: "{}";
			Object.defineProperty(globalThis, "location", {
				configurable: true,
				value: { origin: new URL(url).origin },
			});
			Object.defineProperty(globalThis, "document", {
				configurable: true,
				value: {
					cookie: "",
					title: opts.title ?? "character.ai",
					getElementById: (id: string) =>
						id === "__NEXT_DATA__" ? { textContent: nextData } : null,
				},
			});
			Object.defineProperty(globalThis, "localStorage", {
				configurable: true,
				value: { getItem: () => null },
			});
			globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
				const target = new URL(String(input));
				const headers = new Headers(init?.headers);
				seen.push({
					authorization: headers.get("authorization"),
					host: target.host,
					pathname: target.pathname,
					search: target.searchParams,
				});
				return route(target);
			}) as typeof fetch;
			try {
				return await fn(arg);
			} finally {
				globalThis.fetch = saved.fetch;
				for (const key of ["location", "document", "localStorage"] as const) {
					const descriptor = saved[key];
					if (descriptor) {
						Object.defineProperty(globalThis, key, descriptor);
					} else {
						Reflect.deleteProperty(globalThis, key);
					}
				}
			}
		},
	});
}

/** Default server: one chat-list page, each chat's turns in one page plus an empty end page. */
function defaultRoute(overrides: Partial<Record<string, Route>> = {}): Route {
	return (url) => {
		if (url.pathname === "/chats/recent/") {
			return (overrides.chats ?? (() => json(CHATS)))(url);
		}
		if (url.pathname.startsWith("/turns/")) {
			const chatId = url.pathname.split("/")[2] ?? "";
			const custom = overrides[chatId];
			if (custom) {
				return custom(url);
			}
			if (url.searchParams.get("next_token") === "page-2") {
				return json(fixture("get-neo-turns-uuid-end.json"));
			}
			return json(turnsFor(chatId));
		}
		if (url.pathname.startsWith("/chat/")) {
			const chatId = url.pathname.split("/")[2] ?? "";
			const custom = overrides[`chat:${chatId}`];
			if (custom) {
				return custom(url);
			}
			if (!CHAT_IDS.includes(chatId)) {
				return json({ detail: "Not found" }, 404);
			}
			const detail = fixture("get-neo-chat-uuid.json") as {
				chat: Record<string, unknown>;
			};
			detail.chat.chat_id = chatId;
			return json(detail);
		}
		if (url.pathname === "/user/") {
			return json(fixture("get-neo-user.json"));
		}
		return json({ error: "not found" }, 404);
	};
}

interface Harness {
	ctx: BrowserCollectContext;
	failures: Array<{ stream: string; message: string }>;
	messages: EmittedMessage[];
	records: Array<{ stream: string; data: RecordData }>;
}

function harness(
	page: Page,
	options: {
		streams?: string[];
		detailGaps?: unknown[];
		recoveryOnly?: boolean;
		/** Pages the runtime answers DETAIL_GAPS_PAGE_REQUEST with, in order; then empty. */
		gapPages?: unknown[][];
	} = {},
) {
	const gapPages = [...(options.gapPages ?? [])];
	const names = options.streams ?? ["chats", "messages"];
	const h: Harness = {
		ctx: Object.create(null) as BrowserCollectContext,
		failures: [],
		messages: [],
		records: [],
	};
	Object.assign(h.ctx, {
		page,
		state: {},
		detailGaps: options.detailGaps ?? [],
		recoveryOnly: options.recoveryOnly === true,
		requested: new Map(names.map((name) => [name, { name } as StreamScope])),
		emit: async (message: EmittedMessage) => {
			h.messages.push(message);
		},
		emitRecord: async (stream: string, data: RecordData) => {
			const parsed = validateRecord(stream, data);
			assert.equal(parsed.ok, true, JSON.stringify(parsed));
			h.records.push({ stream, data });
			h.messages.push({
				type: "RECORD",
				stream,
				key: String(data.id),
				data,
			} as EmittedMessage);
		},
		reportStreamFailure: async (stream: string, message: string) => {
			h.failures.push({ stream, message });
		},
		requestDetailGapPage: async () => {
			h.messages.push({ type: "DETAIL_GAPS_PAGE_REQUEST" } as never);
			return gapPages.shift() ?? [];
		},
		progress: async () => undefined,
	});
	return h;
}

function ofType(
	messages: EmittedMessage[],
	type: string,
): Array<Record<string, unknown>> {
	return messages.filter(
		(message) => message.type === type,
	) as unknown as Array<Record<string, unknown>>;
}

function coverageOf(
	messages: EmittedMessage[],
	stream: string,
): Record<string, unknown> | undefined {
	return ofType(messages, "DETAIL_COVERAGE").find(
		(message) => message.stream === stream,
	);
}

// ─── Parsers ─────────────────────────────────────────────────────────────

test("chat list fixture parses; an empty next_token ends the list", () => {
	const page = parseChatsPage(CHATS);
	assert.equal(page.items.length, 3);
	assert.equal(page.nextToken, null);
	const record = buildChatRecord(page.items[0]?.chat as never, {
		lastInteractionTime: "2026-01-16T10:15:45.123456Z",
		turnCount: 3,
	});
	assert.equal(validateRecord("chats", record).ok, true);
	assert.equal(record.create_time, "2026-01-02T10:01:07.123456Z");
	assert.equal(record.character_name, "Synthetic character_name 4 lorem");
});

test("turns fixture parses with a next token, and turns from another chat are refused", () => {
	const page = parseTurnsPage(
		fixture("get-neo-turns-uuid.json"),
		FIXTURE_CHAT_ID,
	);
	assert.equal(page.items.length, 3);
	assert.ok(page.nextToken);
	assert.throws(
		() => parseTurnsPage(fixture("get-neo-turns-uuid.json"), CHAT_IDS[1] ?? ""),
		CharacterAiPayloadError,
	);
	assert.throws(
		() => parseTurnsPage({ turns: "nope" }, FIXTURE_CHAT_ID),
		/character_ai_invalid_payload/,
	);
});

test("message records take the primary candidate and the author kind", () => {
	const [characterTurn, humanTurn] = parseTurnsPage(
		fixture("get-neo-turns-uuid.json"),
		FIXTURE_CHAT_ID,
	).items;
	assert.ok(characterTurn && humanTurn);
	const records = [characterTurn, humanTurn].map((turn) => {
		const checked = checkTurn(turn);
		assert.ok(checked.ok);
		return buildMessageRecord(turn, checked);
	});
	const [character, human] = records;
	assert.equal(character?.author_kind, "character");
	assert.equal(human?.author_kind, "user");
	assert.match(String(character?.text), /^Synthetic raw_content 7/);
	assert.match(String(human?.text), /^Synthetic raw_content 14/);
	assert.equal(character?.model_type, "MODEL_TYPE_PIPSQUEAK_3");
	assert.equal(human?.chat_id, FIXTURE_CHAT_ID);
	for (const record of records) {
		assert.equal(validateRecord("messages", record).ok, true);
	}
});

test("a turn is storable only with a final, PDPP-safe selected candidate", () => {
	const [turn] = parseTurnsPage(
		fixture("get-neo-turns-uuid.json"),
		FIXTURE_CHAT_ID,
	).items;
	const candidate = turn?.candidates[0];
	assert.ok(turn && candidate);
	// Stray control characters are dropped from the text, never the turn.
	const control = checkTurn({
		...turn,
		author: { ...turn.author, name: "Ch\u0007ar" },
		candidates: [{ ...candidate, raw_content: "a\u0000b\u001bc" }],
	});
	assert.ok(control.ok);
	assert.equal(control.text, "abc");
	assert.equal(control.authorName, "Char");
	const record = buildMessageRecord(turn, control);
	assert.equal(record.author_name, "Char");
	assert.equal(validateRecord("messages", record).ok, true);
	// An id with a control character is not text to clean: the turn is unreadable.
	const unsafe = checkTurn({
		...turn,
		candidates: [{ ...candidate, candidate_id: "c\u0000" }],
		primary_candidate_id: "c\u0000",
	});
	assert.deepEqual(
		[unsafe.ok, !unsafe.ok && unsafe.kind],
		[false, "unreadable"],
	);
	const missing = checkTurn({
		...turn,
		primary_candidate_id: "not-a-candidate",
	});
	assert.deepEqual(
		[missing.ok, !missing.ok && missing.kind],
		[false, "unreadable"],
	);
	const noText = checkTurn({
		...turn,
		candidates: [{ ...candidate, raw_content: null }],
	});
	assert.deepEqual(
		[noText.ok, !noText.ok && noText.kind],
		[false, "unreadable"],
	);
	const generating = checkTurn({
		...turn,
		candidates: [{ ...candidate, is_final: false }],
	});
	assert.deepEqual(
		[generating.ok, !generating.ok && generating.kind],
		[false, "generating"],
	);
});

test("zoneless source timestamps are refused at the boundary, never nulled", () => {
	const turns = fixture("get-neo-turns-uuid.json") as {
		turns: Array<Record<string, unknown>>;
	};
	const first = turns.turns[0];
	assert.ok(first);
	first.create_time = "2026-01-02T10:01:07.123456";
	assert.throws(
		() => parseTurnsPage(turns, FIXTURE_CHAT_ID),
		/character_ai_invalid_payload: turns/,
	);
	const chats = fixture("get-neo-chats-recent.json") as {
		chats: Array<Record<string, unknown>>;
	};
	const chat = chats.chats[0];
	assert.ok(chat);
	chat.create_time = "2026-01-02T10:01:07.123456";
	// Only that chat's row is unreadable; the rest of the list still parses.
	const page = parseChatsPage(chats);
	assert.equal(page.items.length, 3);
	assert.equal(page.items[0]?.chat, null);
	assert.ok(page.items[1]?.chat);
});

interface JsonProp {
	anyOf?: JsonProp[];
	const?: unknown;
	enum?: unknown[];
	format?: string;
	type?: string | string[];
}

/** The parts of a JSON-schema property both sides must agree on, with anyOf flattened. */
function contractOf(prop: JsonProp) {
	const parts = prop.anyOf ?? [prop];
	const types = parts.flatMap((part) =>
		Array.isArray(part.type) ? part.type : part.type ? [part.type] : [],
	);
	return {
		types: [...new Set(types)].sort(),
		format: parts.map((part) => part.format).find(Boolean) ?? null,
		enum: parts.map((part) => part.enum).find(Boolean) ?? null,
		const:
			parts.map((part) => part.const).find((value) => value !== undefined) ??
			null,
	};
}

test("manifest required fields and properties match the zod record schemas exactly", () => {
	const manifest = JSON.parse(
		readFileSync(new URL("./manifest.json", import.meta.url), "utf8"),
	) as {
		streams: Array<{
			name: string;
			schema: { properties: Record<string, unknown>; required: string[] };
		}>;
	};
	const zodShapes: Record<
		string,
		Record<string, { safeParse: (v: unknown) => { success: boolean } }>
	> = {
		chats: chatRecordSchema.shape,
		messages: messageRecordSchema.shape,
	};
	for (const stream of manifest.streams) {
		const shape = zodShapes[stream.name];
		assert.ok(shape, stream.name);
		const zodKeys = Object.keys(shape).sort();
		assert.deepEqual(
			Object.keys(stream.schema.properties).sort(),
			zodKeys,
			`${stream.name} properties`,
		);
		// Every zod field is required (none is optional), so the manifest must require all of them.
		for (const key of zodKeys) {
			assert.equal(
				shape[key]?.safeParse(undefined).success,
				false,
				`${stream.name}.${key} must not be optional`,
			);
		}
		assert.deepEqual(
			[...stream.schema.required].sort(),
			zodKeys,
			`${stream.name} required`,
		);
		// Field by field: types (incl. null), format, enum and const agree.
		const zodJson = z.toJSONSchema(
			stream.name === "chats" ? chatRecordSchema : messageRecordSchema,
		) as {
			properties: Record<string, JsonProp>;
		};
		for (const key of zodKeys) {
			assert.deepEqual(
				contractOf(stream.schema.properties[key] as JsonProp),
				contractOf(zodJson.properties[key] as JsonProp),
				`${stream.name}.${key}`,
			);
		}
	}
});

test("pagination only completes on the source's end signal", async () => {
	const pages =
		(tokens: Array<string | null>, items: string[][]) =>
		async (token: string | null) => {
			const index = token === null ? 0 : Number(token.slice(1));
			return { items: items[index] ?? [], nextToken: tokens[index] ?? null };
		};
	const keyOf = (item: string) => item;
	const done = await walkTokenPages({
		fetchPage: pages(["t1", null], [["a"], ["b"]]),
		keyOf,
		maxPages: 10,
	});
	assert.deepEqual(done, { complete: true, items: ["a", "b"], unkeyed: 0 });
	const emptyEnd = await walkTokenPages({
		fetchPage: pages(["t1", null], [["a"], []]),
		keyOf,
		maxPages: 10,
	});
	assert.deepEqual(emptyEnd, { complete: true, items: ["a"], unkeyed: 0 });
	// An empty page that still claims a continuation does not prove the end.
	const emptyWithToken = await walkTokenPages({
		fetchPage: pages(["t1", "t2"], [["a"], []]),
		keyOf,
		maxPages: 10,
	});
	assert.equal(emptyWithToken.complete, false);
	const sameAgain = await walkTokenPages({
		fetchPage: pages([null], [["a", "a", "b"]]),
		keyOf,
		maxPages: 10,
	});
	assert.deepEqual(sameAgain, {
		complete: true,
		items: ["a", "b"],
		unkeyed: 0,
	});
	const repeatedToken = await walkTokenPages({
		fetchPage: pages(["t1", "t1"], [["a"], ["b"]]),
		keyOf,
		maxPages: 10,
	});
	assert.equal(repeatedToken.complete, false);
	const repeatedItems = await walkTokenPages({
		fetchPage: pages(["t1", "t2"], [["a"], ["a"]]),
		keyOf,
		maxPages: 10,
	});
	assert.equal(repeatedItems.complete, false);
	const capped = await walkTokenPages({
		fetchPage: pages(["t1", "t2", "t3"], [["a"], ["b"], ["c"]]),
		keyOf,
		maxPages: 2,
	});
	assert.equal(capped.complete, false);
});

// ─── Collection ──────────────────────────────────────────────────────────

test("full run: chats then their messages, coverage, STATE last; token stays in the page", async () => {
	const seen: Seen[] = [];
	const h = harness(fakePage(defaultRoute(), seen));
	await collectCharacterAi(h.ctx);

	assert.ok(seen.every((request) => request.host === "neo.character.ai"));
	assert.ok(
		seen.every((request) => request.authorization === `Token ${TOKEN}`),
	);
	const listCall = seen.find(
		(request) => request.pathname === "/chats/recent/",
	);
	assert.equal(listCall?.search.get("include_restricted"), "true");
	for (const chatId of CHAT_IDS) {
		const calls = seen.filter(
			(request) => request.pathname === `/turns/${chatId}/`,
		);
		assert.equal(
			calls.length,
			2,
			"the end of each turn list is proven by an empty page",
		);
		assert.equal(calls[1]?.search.get("next_token"), "page-2");
	}

	const chats = h.records.filter((record) => record.stream === "chats");
	const messages = h.records.filter((record) => record.stream === "messages");
	assert.equal(chats.length, 3);
	assert.equal(messages.length, 9);
	assert.equal(new Set(messages.map((record) => record.data.id)).size, 9);
	assert.equal(chats[0]?.data.turn_count, 3);
	assert.equal(
		chats[0]?.data.last_interaction_time,
		"2026-01-16T10:15:45.123456Z",
	);

	// Parent record precedes each of its children.
	for (const chatId of CHAT_IDS) {
		const parentAt = h.messages.findIndex(
			(m) => m.type === "RECORD" && m.stream === "chats" && m.key === chatId,
		);
		const firstChild = h.messages.findIndex(
			(m) =>
				m.type === "RECORD" &&
				m.stream === "messages" &&
				(m as { data: RecordData }).data.chat_id === chatId,
		);
		assert.ok(parentAt >= 0 && parentAt < firstChild);
	}

	const coverage = coverageOf(h.messages, "messages");
	assert.deepEqual(coverage?.required_keys, CHAT_IDS);
	assert.deepEqual(coverage?.hydrated_keys, CHAT_IDS);
	assert.equal(coverage?.gap_keys, undefined);
	const chatsCoverage = coverageOf(h.messages, "chats");
	assert.deepEqual([chatsCoverage?.considered, chatsCoverage?.covered], [3, 3]);
	const last = h.messages.at(-1) as {
		type: string;
		stream: string;
		cursor: Record<string, unknown>;
	};
	assert.equal(last.type, "STATE");
	assert.equal(last.stream, "chats");
	assert.deepEqual(last.cursor, {
		last_interaction_time: "2026-01-16T10:15:45.123456Z",
		chat_count: 3,
	});
	assert.deepEqual(h.failures, []);
	assert.ok(!JSON.stringify(h.messages).includes(TOKEN));
});

test("the chat list follows meta.next_token until it is empty", async () => {
	const seen: Seen[] = [];
	const route = defaultRoute({
		chats: (url) =>
			url.searchParams.get("next_token") === "Synthetic next_token chats page 2"
				? json(fixture("get-neo-chats-recent-page2.json"))
				: json(fixture("get-neo-chats-recent-page1.json")),
	});
	const h = harness(fakePage(route, seen), { streams: ["chats"] });
	await collectCharacterAi(h.ctx);
	assert.equal(
		seen.filter((request) => request.pathname === "/chats/recent/").length,
		2,
	);
	assert.deepEqual(
		h.records.map((record) => record.data.id),
		CHAT_IDS,
	);
	assert.deepEqual(
		ofType(h.messages, "DETAIL_COVERAGE").map((m) => [m.stream, m.covered]),
		[["chats", 3]],
	);
	assert.equal(ofType(h.messages, "STATE").length, 1);
});

test("a chat list whose token repeats keeps the chats seen, fails both streams, and checkpoints nothing", async () => {
	const seen: Seen[] = [];
	const route = defaultRoute({
		chats: () => json(fixture("get-neo-chats-recent-page1.json")),
	});
	const h = harness(fakePage(route, seen));
	await collectCharacterAi(h.ctx);
	const page1 = (
		fixture("get-neo-chats-recent-page1.json").chats as Array<{
			chat_id: string;
		}>
	).map((chat) => chat.chat_id);
	assert.deepEqual(
		h.records.map((record) => [record.stream, record.data.id]),
		page1.map((id) => ["chats", id]),
	);
	assert.equal(
		seen.filter((request) => request.pathname.startsWith("/turns/")).length,
		0,
		"no chat is read in depth before the list proves its end",
	);
	assert.deepEqual(
		h.failures.map((failure) => failure.stream),
		["chats", "messages"],
	);
	assert.match(h.failures[0]?.message ?? "", /did not prove its end/);
	assert.equal(ofType(h.messages, "STATE").length, 0);
	assert.equal(ofType(h.messages, "DETAIL_COVERAGE").length, 0);
});

for (const status of [429, 500]) {
	test(`HTTP ${status} on a chat's turns fails the run retryably instead of becoming a gap`, async () => {
		const [, second] = CHAT_IDS;
		assert.ok(second);
		const h = harness(
			fakePage(defaultRoute({ [second]: () => json({}, status) }), []),
		);
		await assert.rejects(
			collectCharacterAi(h.ctx),
			new RegExp(`character_ai_api_${status}`),
		);
		assert.equal(ofType(h.messages, "DETAIL_GAP").length, 0);
		assert.equal(ofType(h.messages, "DETAIL_COVERAGE").length, 0);
		assert.equal(ofType(h.messages, "STATE").length, 0);
	});
}

test("non-JSON answers from the API are bot checks, whatever their status", async () => {
	const forms: Array<[string, () => Response]> = [
		[
			"503 HTML",
			() =>
				new Response("<html>Just a moment</html>", {
					status: 503,
					headers: { "content-type": "text/html" },
				}),
		],
		[
			"403 text",
			() =>
				new Response("Access denied", {
					status: 403,
					headers: { "content-type": "text/plain" },
				}),
		],
		[
			"200 non-JSON",
			() =>
				new Response("<!doctype html>", {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		],
	];
	for (const [label, respond] of forms) {
		await assert.rejects(
			collectCharacterAi(
				harness(fakePage(defaultRoute({ chats: respond }), [])).ctx,
			),
			/character_ai_challenge/,
			label,
		);
	}
});

/** The turns fixture for a chat, ending on its first page, with one candidate field changed. */
function turnsWithCandidate(
	chatId: string,
	change: Record<string, unknown>,
): Route {
	return () => {
		const page = turnsFor(chatId, "") as {
			turns: Array<{ candidates: Array<Record<string, unknown>> }>;
		};
		const candidate = page.turns[1]?.candidates[0];
		assert.ok(candidate);
		Object.assign(candidate, change);
		return json(page);
	};
}

test("a chat with an unstorable or unfinished turn emits no messages and is a gap", async () => {
	const [first, second, third] = CHAT_IDS;
	assert.ok(first && second && third);
	const h = harness(
		fakePage(
			defaultRoute({
				[second]: turnsWithCandidate(second, { model_type: "not an enum" }),
				[third]: turnsWithCandidate(third, { is_final: false }),
			}),
			[],
		),
	);
	await collectCharacterAi(h.ctx);
	const gaps = ofType(h.messages, "DETAIL_GAP");
	assert.deepEqual(
		gaps.map((gap) => [gap.record_key, gap.reason]),
		[
			[second, "retry_exhausted"],
			[third, "temporary_unavailable"],
		],
	);
	const messageChats = new Set(
		h.records
			.filter((record) => record.stream === "messages")
			.map((record) => record.data.chat_id),
	);
	assert.deepEqual([...messageChats], [first]);
	const coverage = coverageOf(h.messages, "messages");
	assert.deepEqual(coverage?.hydrated_keys, [first]);
	assert.deepEqual(coverage?.gap_keys, [second, third]);
	// The gap covers only those chats: the stream is not failed, so the
	// checkpoint is not held back by one bad turn.
	assert.deepEqual(h.failures, []);
	assert.equal(ofType(h.messages, "STATE").length, 1);
});

test("a turn list that never ends is a gap for that chat only", async () => {
	const [, second] = CHAT_IDS;
	assert.ok(second);
	const h = harness(
		fakePage(
			defaultRoute({ [second]: () => json(turnsFor(second, "same-token")) }),
			[],
		),
	);
	await collectCharacterAi(h.ctx);
	const gaps = ofType(h.messages, "DETAIL_GAP");
	assert.deepEqual(
		gaps.map((gap) => [gap.record_key, gap.reason]),
		[[second, "retry_exhausted"]],
	);
	assert.equal(
		h.records.filter(
			(record) =>
				record.stream === "messages" && record.data.chat_id === second,
		).length,
		0,
	);
	assert.deepEqual(h.failures, []);
	assert.equal(ofType(h.messages, "STATE").length, 1);
});

test("auth failures and bot checks throw with their error class", async () => {
	await assert.rejects(
		collectCharacterAi(
			harness(fakePage(defaultRoute(), [], { token: null })).ctx,
		),
		(error: unknown) =>
			error instanceof Error &&
			error.message.startsWith(
				"character_ai_auth_failed: no Character.AI API token",
			),
	);
	await assert.rejects(
		collectCharacterAi(
			harness(
				fakePage(
					defaultRoute({ chats: () => json({ detail: "Auth" }, 401) }),
					[],
				),
			).ctx,
		),
		/character_ai_auth_failed: HTTP 401/,
	);
	const challenge = () =>
		new Response("<html>Just a moment</html>", {
			status: 403,
			headers: { "content-type": "text/html" },
		});
	await assert.rejects(
		collectCharacterAi(
			harness(fakePage(defaultRoute({ chats: challenge }), [])).ctx,
		),
		/character_ai_challenge/,
	);
	const [first] = CHAT_IDS;
	assert.ok(first);
	await assert.rejects(
		collectCharacterAi(
			harness(
				fakePage(
					defaultRoute({ [first]: () => json({ detail: "x" }, 401) }),
					[],
				),
			).ctx,
		),
		/character_ai_auth_failed/,
	);
});

test("listed chats with no turns at all fail the messages stream", async () => {
	const route = defaultRoute(
		Object.fromEntries(
			CHAT_IDS.map((id) => [
				id,
				() => json(fixture("get-neo-turns-uuid-end.json")),
			]),
		),
	);
	const h = harness(fakePage(route, []));
	await collectCharacterAi(h.ctx);
	assert.equal(h.failures.length, 1);
	assert.match(h.failures[0]?.message ?? "", /returned no turns/);
});

const GONE_CHAT = "0f0e0d0c-0b0a-4908-8706-050403020100";

function pendingGaps(first: string) {
	return [
		{
			gap_id: "g1",
			lease_id: "l1",
			status: "pending",
			stream: "messages",
			record_key: first,
			detail_locator: { kind: "character_ai.chat_turns", chat_id: first },
		},
		{
			gap_id: "g2",
			status: "pending",
			stream: "messages",
			record_key: GONE_CHAT,
			detail_locator: { kind: "character_ai.chat_turns", chat_id: GONE_CHAT },
		},
	];
}

test("recovery-only: parents come from the chat endpoint, recovered gaps are closed, a 404 keeps its gap open", async () => {
	const [first] = CHAT_IDS;
	assert.ok(first);
	const seen: Seen[] = [];
	const h = harness(fakePage(defaultRoute(), seen), {
		detailGaps: pendingGaps(first),
		recoveryOnly: true,
	});
	await collectCharacterAi(h.ctx);
	assert.equal(
		seen.filter((request) => request.pathname === "/chats/recent/").length,
		0,
	);
	assert.deepEqual(
		seen
			.filter((request) => request.pathname.startsWith("/chat/"))
			.map((request) => request.pathname),
		[`/chat/${first}/`, `/chat/${GONE_CHAT}/`],
	);
	// The parent chat record precedes its messages; its name comes from the character's turns.
	const firstRecordAt = h.messages.findIndex((m) => m.type === "RECORD");
	const parent = h.messages[firstRecordAt] as {
		stream: string;
		data: RecordData;
	};
	assert.equal(parent.stream, "chats");
	assert.equal(parent.data.id, first);
	assert.equal(parent.data.character_name, "Synthetic name 4 lorem");
	assert.equal(
		h.records.filter((record) => record.stream === "messages").length,
		3,
	);
	const recovered = ofType(h.messages, "DETAIL_GAP_RECOVERED");
	assert.deepEqual(
		recovered.map((m) => [m.gap_id, m.record_key, m.lease_id]),
		[["g1", first, "l1"]],
	);
	// A 404 on the chat endpoint proves nothing was read: g2 stays open (re-emitted).
	assert.deepEqual(
		ofType(h.messages, "DETAIL_GAP").map((gap) => [gap.record_key, gap.reason]),
		[[GONE_CHAT, "temporary_unavailable"]],
	);
	assert.deepEqual(h.failures, []);
	const recoveredAt = h.messages.findIndex(
		(m) => m.type === "DETAIL_GAP_RECOVERED",
	);
	const lastMessageAt = h.messages.findLastIndex(
		(m) => m.type === "RECORD" && m.stream === "messages",
	);
	assert.ok(
		recoveredAt > lastMessageAt,
		"a gap is closed only after its chat's messages",
	);
	const coverage = coverageOf(h.messages, "messages");
	assert.deepEqual(coverage?.required_keys, [first, GONE_CHAT]);
	assert.deepEqual(coverage?.hydrated_keys, [first]);
	assert.deepEqual(coverage?.gap_keys, [GONE_CHAT]);
	assert.equal(ofType(h.messages, "STATE").length, 0);
});

test("a pending gap that still fails is re-emitted, not recovered", async () => {
	const [first] = CHAT_IDS;
	assert.ok(first);
	const h = harness(
		fakePage(
			defaultRoute({ [first]: () => json(turnsFor(first, "same-token")) }),
			[],
		),
		{
			detailGaps: pendingGaps(first).slice(0, 1),
			recoveryOnly: true,
		},
	);
	await collectCharacterAi(h.ctx);
	assert.equal(ofType(h.messages, "DETAIL_GAP_RECOVERED").length, 0);
	assert.deepEqual(
		ofType(h.messages, "DETAIL_GAP").map((gap) => gap.record_key),
		[first],
	);
	const parentAt = h.messages.findIndex(
		(m) => m.type === "RECORD" && m.stream === "chats",
	);
	const gapAt = h.messages.findIndex((m) => m.type === "DETAIL_GAP");
	assert.ok(parentAt >= 0 && parentAt < gapAt, "the parent precedes its gap");
});

test("recovery-only with no pending gaps still reports (empty) coverage", async () => {
	for (const detailGaps of [[], undefined]) {
		const h = harness(fakePage(defaultRoute(), []), {
			recoveryOnly: true,
			...(detailGaps ? { detailGaps } : {}),
		});
		if (detailGaps === undefined) {
			Reflect.deleteProperty(h.ctx, "detailGaps");
		}
		await collectCharacterAi(h.ctx);
		const coverage = ofType(h.messages, "DETAIL_COVERAGE");
		assert.equal(coverage.length, 1);
		assert.deepEqual(
			[coverage[0]?.required_keys, coverage[0]?.hydrated_keys],
			[[], []],
		);
		assert.equal(h.records.length, 0);
	}
});

test("a normal run retries pending gaps the list no longer returns, parent first", async () => {
	const [first] = CHAT_IDS;
	assert.ok(first);
	const full = harness(fakePage(defaultRoute(), []), {
		detailGaps: pendingGaps(first),
	});
	await collectCharacterAi(full.ctx);
	const coverage = coverageOf(full.messages, "messages");
	assert.deepEqual(coverage?.required_keys, [...CHAT_IDS, GONE_CHAT]);
	assert.deepEqual(coverage?.hydrated_keys, CHAT_IDS);
	assert.deepEqual(coverage?.gap_keys, [GONE_CHAT]);
	assert.deepEqual(
		ofType(full.messages, "DETAIL_GAP_RECOVERED").map((m) => m.gap_id),
		["g1"],
	);
});

test("a messages-only scope emits no orphan children", async () => {
	const seen: Seen[] = [];
	const h = harness(fakePage(defaultRoute(), seen), { streams: ["messages"] });
	await collectCharacterAi(h.ctx);
	assert.equal(h.records.length, 0);
	assert.equal(seen.length, 0);
	assert.equal(h.failures[0]?.stream, "messages");
});

test("session probe reads the user endpoint with the page token", async () => {
	const seen: Seen[] = [];
	assert.equal(
		await probeCharacterAiSession(fakePage(defaultRoute(), seen)),
		true,
	);
	assert.equal(seen[0]?.pathname, "/user/");
	assert.equal(
		await probeCharacterAiSession(
			fakePage(defaultRoute(), [], { token: null }),
		),
		false,
	);
	assert.equal(
		await probeCharacterAiSession(
			fakePage(defaultRoute(), [], { url: "about:blank" }),
		),
		false,
	);
});

test("chats-only runs keep the hydration of a complete turn walk, whatever the bodies", async () => {
	const [, second, third] = CHAT_IDS;
	assert.ok(second && third);
	const route = defaultRoute({
		[second]: turnsWithCandidate(second, { raw_content: "a\u0000b" }),
		[third]: turnsWithCandidate(third, { is_final: false }),
	});
	const h = harness(fakePage(route, []), { streams: ["chats"] });
	await collectCharacterAi(h.ctx);
	const chats = h.records.filter((record) => record.stream === "chats");
	assert.equal(chats.length, 3);
	for (const chat of chats) {
		assert.equal(chat.data.turn_count, 3, String(chat.data.id));
		assert.equal(
			chat.data.last_interaction_time,
			"2026-01-16T10:15:45.123456Z",
			String(chat.data.id),
		);
	}
	assert.equal(ofType(h.messages, "DETAIL_GAP").length, 0);
	assert.deepEqual(h.failures, []);
	assert.equal(h.messages.at(-1)?.type, "STATE");

	// With messages in scope the same chats are still hydrated; only their messages become gaps.
	const both = harness(fakePage(route, []));
	await collectCharacterAi(both.ctx);
	const gapped = both.records.find(
		(record) => record.stream === "chats" && record.data.id === second,
	);
	assert.equal(gapped?.data.turn_count, 3);
});

test("a 401 is a sign-in failure whatever its body; an explicit challenge still wins", async () => {
	const bodies: Array<[string, string, string]> = [
		["empty", "", "text/plain"],
		["text", "Unauthorized", "text/plain"],
		["HTML", "<html>Sign in</html>", "text/html"],
	];
	for (const [label, body, type] of bodies) {
		const respond = () =>
			new Response(body, { status: 401, headers: { "content-type": type } });
		await assert.rejects(
			collectCharacterAi(
				harness(fakePage(defaultRoute({ chats: respond }), [])).ctx,
			),
			/character_ai_auth_failed: HTTP 401/,
			label,
		);
	}
	const challenged = () =>
		new Response("<html>Just a moment</html>", {
			status: 401,
			headers: { "content-type": "text/html", "cf-mitigated": "challenge" },
		});
	await assert.rejects(
		collectCharacterAi(
			harness(fakePage(defaultRoute({ chats: challenged }), [])).ctx,
		),
		/character_ai_challenge/,
	);
});

test("messages are mutable state: a swiped turn is re-emitted under the same id with its new text", async () => {
	const manifest = JSON.parse(
		readFileSync(new URL("./manifest.json", import.meta.url), "utf8"),
	) as {
		streams: Array<{ name: string; semantics: string; primary_key: string[] }>;
	};
	const messages = manifest.streams.find(
		(stream) => stream.name === "messages",
	);
	assert.equal(messages?.semantics, "mutable_state");
	assert.deepEqual(messages?.primary_key, ["id"]);

	const [first] = CHAT_IDS;
	assert.ok(first);
	const swiped = () => {
		const page = turnsFor(first, "") as {
			turns: Array<{
				primary_candidate_id: string;
				candidates: Array<Record<string, unknown>>;
			}>;
		};
		const turn = page.turns[0];
		const original = turn?.candidates[0];
		assert.ok(turn && original);
		turn.candidates.push({
			...original,
			candidate_id: "5b2f9a1c-7d3e-4c8a-9f60-2e1d4c7b8a93",
			raw_content: "Swiped reply",
		});
		turn.primary_candidate_id = "5b2f9a1c-7d3e-4c8a-9f60-2e1d4c7b8a93";
		return json(page);
	};
	const before = harness(fakePage(defaultRoute(), []));
	await collectCharacterAi(before.ctx);
	const after = harness(fakePage(defaultRoute({ [first]: swiped }), []));
	await collectCharacterAi(after.ctx);
	const turnId = (before.records.find(
		(r) => r.stream === "messages" && r.data.chat_id === first,
	)?.data.id ?? "") as string;
	const old = before.records.find(
		(r) => r.stream === "messages" && r.data.id === turnId,
	);
	const now = after.records.find(
		(r) => r.stream === "messages" && r.data.id === turnId,
	);
	assert.notEqual(old?.data.text, "Swiped reply");
	assert.equal(now?.data.text, "Swiped reply");
	assert.equal(now?.data.candidate_count, 2);
});

test("a list response without the pagination envelope is unreadable, not the end", async () => {
	const chats = fixture("get-neo-chats-recent.json");
	const turns = fixture("get-neo-turns-uuid.json");
	for (const [label, change] of [
		[
			"no meta",
			(body: Record<string, unknown>) => Reflect.deleteProperty(body, "meta"),
		],
		[
			"no next_token",
			(body: Record<string, unknown>) =>
				Reflect.deleteProperty(body.meta as object, "next_token"),
		],
	] as const) {
		const c = structuredClone(chats);
		change(c);
		assert.throws(
			() => parseChatsPage(c),
			/character_ai_invalid_payload: chats\/recent/,
			label,
		);
		const t = structuredClone(turns);
		change(t);
		assert.throws(
			() => parseTurnsPage(t, FIXTURE_CHAT_ID),
			/character_ai_invalid_payload: turns/,
			label,
		);
	}
	const explicitNull = structuredClone(chats);
	(explicitNull.meta as Record<string, unknown>).next_token = null;
	assert.equal(parseChatsPage(explicitNull).nextToken, null);

	const { meta: _meta, ...noMeta } = chats;
	const h = harness(fakePage(defaultRoute({ chats: () => json(noMeta) }), []));
	await assert.rejects(
		collectCharacterAi(h.ctx),
		/character_ai_invalid_payload/,
	);
	assert.equal(ofType(h.messages, "STATE").length, 0);
	assert.equal(ofType(h.messages, "DETAIL_COVERAGE").length, 0);
});

test("control characters are dropped from display text; other unsafe values make only that item unreadable", async () => {
	const chats = fixture("get-neo-chats-recent.json") as {
		chats: Array<Record<string, unknown>>;
	};
	const named = structuredClone(chats);
	assert.ok(named.chats[0]);
	named.chats[0].character_name = "a\u0000b\u0007";
	assert.equal(parseChatsPage(named).items[0]?.chat?.character_name, "ab");
	for (const [field, value] of [
		["creator_id", "a\u0001b"],
		["state", "not an enum"],
	] as const) {
		const body = structuredClone(chats);
		const chat = body.chats[0];
		assert.ok(chat);
		chat[field] = value;
		const page = parseChatsPage(body);
		assert.equal(page.items[0]?.chat, null, field);
		assert.equal(page.items[0]?.chatId, CHAT_IDS[0], field);
		assert.equal(page.items.filter((row) => row.chat !== null).length, 2);
	}
	const [turn] = parseTurnsPage(
		fixture("get-neo-turns-uuid.json"),
		FIXTURE_CHAT_ID,
	).items;
	const candidate = turn?.candidates[0];
	assert.ok(turn && candidate);
	assert.equal(
		checkTurn({ ...turn, author: { ...turn.author, name: "a\u0000b" } }).ok,
		true,
	);
	for (const changed of [
		{ ...turn, author: { ...turn.author, author_id: "a\u0000b" } },
		{ ...turn, state: "ok?" },
		{ ...turn, candidates: [{ ...candidate, model_type: "pipsqueak 3" }] },
	]) {
		const checked = checkTurn(changed);
		assert.deepEqual(
			[checked.ok, !checked.ok && checked.kind],
			[false, "unreadable"],
		);
	}
	// In a run, the chat with the unsafe author id is a gap; nothing else is held back.
	const [first, second, third] = CHAT_IDS;
	assert.ok(first && second && third);
	const unsafeAuthor = () => {
		const page = turnsFor(second, "") as {
			turns: Array<{ author: Record<string, unknown> }>;
		};
		const author = page.turns[1]?.author;
		assert.ok(author);
		author.author_id = "a\u0000b";
		return json(page);
	};
	const h = harness(fakePage(defaultRoute({ [second]: unsafeAuthor }), []));
	await collectCharacterAi(h.ctx);
	assert.deepEqual(
		ofType(h.messages, "DETAIL_GAP").map((gap) => gap.record_key),
		[second],
	);
	assert.equal(
		h.records.filter(
			(r) => r.stream === "messages" && r.data.chat_id === second,
		).length,
		0,
	);
	assert.deepEqual(h.failures, []);
	assert.equal(ofType(h.messages, "STATE").length, 1);

	// A chat row that cannot be stored: no chat record and a gap for that chat
	// only; the rest is collected, covered and checkpointed.
	const badRow = structuredClone(chats);
	assert.ok(badRow.chats[1]);
	badRow.chats[1].state = "not an enum";
	const rows = harness(
		fakePage(defaultRoute({ chats: () => json(badRow) }), []),
	);
	await collectCharacterAi(rows.ctx);
	assert.deepEqual(
		rows.records
			.filter((record) => record.stream === "chats")
			.map((record) => record.data.id),
		[first, third],
	);
	assert.deepEqual(
		ofType(rows.messages, "DETAIL_GAP").map((gap) => [
			gap.record_key,
			(gap.last_error as { class?: string } | undefined)?.class,
		]),
		[[second, "chat_row_unreadable"]],
	);
	const chatsCoverage = coverageOf(rows.messages, "chats");
	assert.deepEqual([chatsCoverage?.considered, chatsCoverage?.covered], [3, 2]);
	assert.deepEqual(coverageOf(rows.messages, "messages")?.gap_keys, [second]);
	assert.deepEqual(rows.failures, []);
	assert.equal(ofType(rows.messages, "STATE").length, 1);
});

test("a chat list row with no usable id fails both streams without a checkpoint; the readable chats are kept", async () => {
	const chats = fixture("get-neo-chats-recent.json") as {
		chats: Array<Record<string, unknown>>;
	};
	const body = structuredClone(chats);
	assert.ok(body.chats[2]);
	body.chats[2].chat_id = "not-a-uuid";
	const h = harness(fakePage(defaultRoute({ chats: () => json(body) }), []));
	await collectCharacterAi(h.ctx);
	assert.equal(
		h.records.filter((record) => record.stream === "chats").length,
		2,
	);
	assert.deepEqual(
		h.failures.map((failure) => failure.stream),
		["chats", "messages"],
	);
	assert.equal(ofType(h.messages, "STATE").length, 0);
	assert.equal(ofType(h.messages, "DETAIL_COVERAGE").length, 0);
});

test("a page of turns that cannot be parsed is a gap for that chat, not a failed run", async () => {
	const [, second] = CHAT_IDS;
	assert.ok(second);
	const h = harness(
		fakePage(
			defaultRoute({ [second]: () => json({ turns: "nope", meta: {} }) }),
			[],
		),
	);
	await collectCharacterAi(h.ctx);
	assert.deepEqual(
		ofType(h.messages, "DETAIL_GAP").map((gap) => [
			gap.record_key,
			(gap.last_error as { class?: string } | undefined)?.class,
		]),
		[[second, "chat_turns_unreadable"]],
	);
	assert.deepEqual(h.failures, []);
	assert.equal(ofType(h.messages, "STATE").length, 1);
});

test("the latest time is chosen at full fractional precision, offsets normalized", () => {
	// Beyond 12 fractional digits: the last digit still decides.
	assert.equal(
		latestTime([
			"2026-01-01T00:00:00.1234567890123Z",
			"2026-01-01T00:00:00.1234567890124Z",
		]),
		"2026-01-01T00:00:00.1234567890124Z",
	);
	assert.equal(
		compareTimes(
			"2026-01-01T00:00:00.1234567890123Z",
			"2026-01-01T00:00:00.1234567890124Z",
		),
		-1,
	);
	assert.equal(
		compareTimes(
			"2026-01-01T00:00:00.5Z",
			"2026-01-01T00:00:00.500000000000000Z",
		),
		0,
	);
	assert.equal(
		latestTime(["2026-01-01T00:00:00.123400Z", "2026-01-01T00:00:00.123900Z"]),
		"2026-01-01T00:00:00.123900Z",
	);
	assert.equal(
		latestTime(["2026-01-01T00:00:00.4Z", "2026-01-01T01:00:00.5+01:00", null]),
		"2026-01-01T01:00:00.5+01:00",
	);
	assert.equal(
		latestTime(["2026-01-01T00:00:00.000001Z", "2026-01-01T00:00:00Z"]),
		"2026-01-01T00:00:00.000001Z",
	);
});

// ─── Later gap pages, page interruptions, session handoff ───────────────

function gap(gapId: string, chatId: string, leaseId?: string) {
	return {
		gap_id: gapId,
		...(leaseId ? { lease_id: leaseId } : {}),
		status: "pending",
		stream: "messages",
		record_key: chatId,
		detail_locator: { kind: "character_ai.chat_turns", chat_id: chatId },
	};
}

test("pending gaps on later pages are recovered too, each after its chat's messages, with its lease", async () => {
	const [first, second] = CHAT_IDS;
	assert.ok(first && second);
	const seen: Seen[] = [];
	const h = harness(fakePage(defaultRoute(), seen), {
		detailGaps: [gap("g1", first, "l1")],
		// The runtime pages further gaps in: one for a listed chat, one for a
		// chat the list no longer returns; then g1 again (still pending to it).
		gapPages: [
			[gap("g1", first, "l1"), gap("g3", second, "l3"), gap("g4", GONE_CHAT)],
		],
	});
	await collectCharacterAi(h.ctx);
	const recovered = ofType(h.messages, "DETAIL_GAP_RECOVERED");
	assert.deepEqual(
		recovered.map((m) => [m.gap_id, m.record_key, m.lease_id]),
		[
			["g1", first, "l1"],
			["g3", second, "l3"],
		],
	);
	for (const message of recovered) {
		const at = h.messages.indexOf(message as never);
		const lastChild = h.messages.findLastIndex(
			(m) =>
				m.type === "RECORD" &&
				m.stream === "messages" &&
				(m as { data: RecordData }).data.chat_id === message.record_key,
		);
		assert.ok(lastChild >= 0 && at > lastChild);
	}
	// The chat on a later page that the list did not return is read from its detail.
	assert.ok(seen.some((request) => request.pathname === `/chat/${GONE_CHAT}/`));
	assert.deepEqual(
		ofType(h.messages, "DETAIL_GAP").map((m) => m.record_key),
		[GONE_CHAT],
	);
	const coverage = coverageOf(h.messages, "messages");
	assert.deepEqual(coverage?.required_keys, [...CHAT_IDS, GONE_CHAT]);
	assert.deepEqual(coverage?.gap_keys, [GONE_CHAT]);
	// Every gap page was asked for before coverage and STATE.
	const lastRequest = h.messages.findLastIndex(
		(m) => m.type === "DETAIL_GAPS_PAGE_REQUEST",
	);
	assert.ok(lastRequest < h.messages.indexOf(coverage as never));
	assert.equal(h.messages.at(-1)?.type, "STATE");
});

test("recovery-only reads the pending gaps on every page, not just the first", async () => {
	const [first, second] = CHAT_IDS;
	assert.ok(first && second);
	const seen: Seen[] = [];
	const h = harness(fakePage(defaultRoute(), seen), {
		detailGaps: [gap("g1", first)],
		// A second gap for the first chat arrives on the later page as well.
		gapPages: [[gap("g2", second, "l2"), gap("g5", first, "l5")]],
		recoveryOnly: true,
	});
	await collectCharacterAi(h.ctx);
	assert.equal(
		seen.filter((request) => request.pathname === "/chats/recent/").length,
		0,
	);
	assert.deepEqual(
		ofType(h.messages, "DETAIL_GAP_RECOVERED").map((m) => [
			m.gap_id,
			m.lease_id,
		]),
		[
			["g1", undefined],
			["g2", "l2"],
			["g5", "l5"],
		],
	);
	assert.deepEqual(coverageOf(h.messages, "messages")?.required_keys, [
		first,
		second,
	]);
	assert.equal(ofType(h.messages, "STATE").length, 0);
});

/** Make the page's evaluate calls after the first `after` ones reject `times` times as a navigation would. */
function interruptAfter(
	page: Page,
	interruptions: { count: number },
	after: number,
	times: number,
): void {
	const target = page as unknown as {
		evaluate: (...args: unknown[]) => Promise<unknown>;
	};
	const evaluate = target.evaluate;
	let calls = 0;
	target.evaluate = (...args: unknown[]) => {
		calls += 1;
		if (calls === after + 1) {
			interruptions.count = times;
		}
		return evaluate(...args);
	};
}

test("a page that navigates under one request is retried in place", async () => {
	const interruptions = { count: 0 };
	const h = harness(fakePage(defaultRoute(), [], { interruptions }));
	// The fourth call is a chat's turns request.
	interruptAfter(h.ctx.page, interruptions, 3, 1);
	await collectCharacterAi(h.ctx);
	assert.equal(h.messages.at(-1)?.type, "STATE");
	assert.equal(
		h.records.filter((record) => record.stream === "messages").length,
		9,
	);
});

test("a page that keeps going away stops the run with the retryable interrupted code", async () => {
	const interruptions = { count: 0 };
	const h = harness(fakePage(defaultRoute(), [], { interruptions }));
	interruptAfter(h.ctx.page, interruptions, 3, 1000);
	await assert.rejects(collectCharacterAi(h.ctx), (error: unknown) => {
		assert.ok(error instanceof Error);
		assert.equal(error.message, "character_ai_interrupted");
		assert.match(
			error.message,
			/character_ai_api_(?:429|5\d\d)|character_ai_timeout|character_ai_network_error|character_ai_interrupted|fetch failed/i,
		);
		return true;
	});
	assert.equal(ofType(h.messages, "STATE").length, 0);
});

test("a navigation to character.ai that fails stops the run with a bare interrupted code", async () => {
	const visits: string[] = [];
	const h = harness(
		fakePage(defaultRoute(), [], {
			url: "about:blank",
			visits,
			gotoFails: true,
		}),
	);
	await assert.rejects(collectCharacterAi(h.ctx), (error: unknown) => {
		assert.ok(error instanceof Error);
		assert.equal(error.message, "character_ai_interrupted");
		assert.equal(isConnectorErrorCodeShaped(error.message), true);
		return true;
	});
	assert.deepEqual(visits, ["https://character.ai/"]);
});

/** EnsureSession arguments whose assist records each handoff it is asked for. */
function sessionArgs(
	browserPage: Page,
	onAssist: () => void = () => {},
): { args: EnsureSessionArgs; handoffs: string[]; statuses: string[] } {
	const handoffs: string[] = [];
	const statuses: string[] = [];
	const args = Object.assign(Object.create(null) as EnsureSessionArgs, {
		page: browserPage,
		assist: async (request: { message: string }) => {
			handoffs.push(request.message);
			onAssist();
			return `assist-${String(handoffs.length)}`;
		},
		completeAssistance: async (_id: string, status: string) => {
			statuses.push(status);
		},
	});
	return { args, handoffs, statuses };
}

const noDelay = async (): Promise<void> => {};

test("a signed-in page is verified in place and never moved", async () => {
	const visits: string[] = [];
	const session = sessionArgs(fakePage(defaultRoute(), [], { visits }));
	await ensureCharacterAiSession(session.args, noDelay);
	assert.deepEqual(visits, []);
	assert.deepEqual(session.handoffs, []);
});

test("a signed-out page goes to the sign-in page and is handed over; readiness never navigates", async () => {
	let token: string | null = null;
	const visits: string[] = [];
	const session = sessionArgs(
		fakePage(defaultRoute(), [], {
			token: () => token,
			url: "https://character.ai/chat/some-chat",
			visits,
		}),
		() => {
			token = TOKEN;
		},
	);
	await ensureCharacterAiSession(session.args, noDelay);
	assert.deepEqual(visits, ["https://character.ai/"]);
	assert.equal(session.handoffs.length, 1);
	assert.match(session.handoffs[0] ?? "", /^Sign in to Character\.AI/);
	assert.deepEqual(session.statuses, ["resolved"]);
});

test("a 401 from the user endpoint is signed out, not an outage", async () => {
	const page = fakePage(
		(url) =>
			url.pathname === "/user/"
				? json({ error: "Unauthorized" }, 401)
				: json({}, 404),
		[],
	);
	assert.equal(await checkCharacterAiSession(page), "signed_out");
});

test("a human check is handed over in place, never navigated away from", async () => {
	let cleared = false;
	const visits: string[] = [];
	const session = sessionArgs(
		fakePage(
			(url) =>
				cleared
					? defaultRoute()(url)
					: new Response("<html>Just a moment...</html>", {
							status: 403,
							headers: {
								"content-type": "text/html",
								"cf-mitigated": "challenge",
							},
						}),
			[],
			{ visits },
		),
		() => {
			cleared = true;
		},
	);
	await ensureCharacterAiSession(session.args, noDelay);
	assert.deepEqual(visits, []);
	assert.equal(session.handoffs.length, 1);
	assert.match(session.handoffs[0] ?? "", /human check/);
});

test("a Cloudflare challenge document is a challenge without any API request", async () => {
	const seen: Seen[] = [];
	assert.equal(
		await checkCharacterAiSession(
			fakePage(defaultRoute(), seen, { title: "Just a moment..." }),
		),
		"challenge",
	);
	assert.deepEqual(seen, []);
});

test("a session check with no usable answer is retried, then fails with a bare code and no handoff", async () => {
	let reads = 0;
	const visits: string[] = [];
	const session = sessionArgs(
		fakePage(
			() => {
				reads += 1;
				return json({}, 502);
			},
			[],
			{ visits },
		),
	);
	await assert.rejects(
		ensureCharacterAiSession(session.args, noDelay),
		(error: unknown) => {
			assert.ok(error instanceof Error);
			assert.equal(error.message, "character_ai_interrupted");
			assert.equal(isConnectorErrorCodeShaped(error.message), true);
			return true;
		},
	);
	assert.equal(reads, 3);
	assert.deepEqual(session.handoffs, []);
	assert.deepEqual(visits, []);
});

test("a page closed during the session check is retried, not a crash", async () => {
	const session = sessionArgs(
		fakePage(defaultRoute(), [], { interruptions: { count: 2 } }),
	);
	await ensureCharacterAiSession(session.args, noDelay);
	assert.deepEqual(session.handoffs, []);
});

test("an off-site page that cannot reach character.ai fails with the bare interrupted code", async () => {
	const visits: string[] = [];
	const session = sessionArgs(
		fakePage(defaultRoute(), [], {
			url: "about:blank",
			visits,
			gotoFails: true,
		}),
	);
	await assert.rejects(
		ensureCharacterAiSession(session.args, noDelay),
		(error: unknown) =>
			error instanceof Error && error.message === "character_ai_interrupted",
	);
	assert.deepEqual(visits, ["https://character.ai/"]);
	assert.equal(await hasCharacterAiSession(session.args.page), false);
});

test("a sign-in that is never completed fails with the bare auth code, and the check never moves the page", async () => {
	const visits: string[] = [];
	const browserPage = fakePage(defaultRoute(), [], {
		token: null,
		url: "https://character.ai/",
		visits,
	});
	await assert.rejects(
		ensureCharacterAiSession(
			Object.assign(Object.create(null) as EnsureSessionArgs, {
				page: browserPage,
				sendInteraction: async () => {
					// The owner is still on the identity provider's page.
					await browserPage.goto("https://accounts.example.com/sign-in");
					return {
						type: "INTERACTION_RESPONSE",
						request_id: "synthetic",
						status: "success",
					};
				},
			}),
			noDelay,
		),
		(error: unknown) => {
			assert.ok(error instanceof Error);
			assert.equal(error.message, "character_ai_auth_failed");
			assert.equal(isConnectorErrorCodeShaped(error.message), true);
			return true;
		},
	);
	assert.deepEqual(visits, ["https://accounts.example.com/sign-in"]);
});
