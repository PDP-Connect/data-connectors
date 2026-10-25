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
	checkPerplexitySession,
	collectPerplexity,
	ensurePerplexitySession,
	hasPerplexitySession,
	PAGE_SIZE,
} from "./index.ts";
import {
	conversationSchema,
	messageSchema,
	validateRecord,
} from "./schemas.ts";

const HOME = "https://www.perplexity.ai/";
const pad = (n: number) => String(n).padStart(12, "0");
const threadId = (n: number) => `cccccccc-0000-4000-8000-${pad(n)}`;
const threadSlug = (n: number) => `bbbbbbbb-0000-4000-8000-${pad(n)}`;
const entryId = (n: number) => `eeeeeeee-0000-4000-8000-${pad(n)}`;
const stamp = (n: number) =>
	new Date(Date.UTC(2026, 9, 1, 9) + n * 3_600_000).toISOString();
/** The list's real clock: microseconds and no zone at all. */
const listStamp = (n: number) => `${stamp(n).slice(0, 23)}000`;
/** Entry timestamps: microseconds plus an explicit UTC offset. */
const entryStamp = (n: number) => `${stamp(n).slice(0, 23)}000+00:00`;
/** What the parsers emit for either: a fixed-width UTC instant. */
const instant = (n: number) => `${stamp(n).slice(0, 23)}000Z`;

/** One synthetic list item, shaped exactly like the recon's list item. */
function threadItem(n: number, hasNext: boolean): Record<string, unknown> {
	return {
		uuid: `aaaaaaaa-0000-4000-8000-${pad(n)}`,
		context_uuid: threadId(n),
		slug: threadSlug(n),
		title: `Synthetic thread ${n}`,
		query_str: `Synthetic question ${n}?`,
		mode: "web",
		display_model: "sonar",
		search_focus: "internet",
		sources: [],
		query_count: 1,
		last_query_datetime: listStamp(n),
		thread_access: 1,
		thread_number: n,
		// The real site's total_threads is unrelated to the item count (a
		// 4-thread account reported 99 on every item); the walk ignores it.
		total_threads: 99,
		has_next_page: hasNext,
		status: "COMPLETED",
		thread_status: "COMPLETED",
		unread: false,
		read_write_token: `kkkkkkkk-0000-4000-8000-${pad(n)}`,
	};
}

/** One synthetic thread response: a single complete entry. */
function threadDetail(n: number): string {
	return JSON.stringify({
		status: "COMPLETED",
		entries: [
			{
				uuid: entryId(n),
				status: "COMPLETED",
				context_uuid: threadId(n),
				query_str: `Synthetic question ${n}?`,
				entry_created_datetime: entryStamp(n),
				entry_updated_datetime: entryStamp(n),
				display_model: "sonar",
				blocks: [
					{
						intended_usage: "web_results",
						web_result_block: {
							web_results: [
								{
									name: `Synthetic source ${n}`,
									url: `https://example.com/synthetic-${n}`,
								},
							],
						},
					},
					{
						intended_usage: "ask_text",
						markdown_block: { answer: `Synthetic answer ${n}.` },
					},
				],
			},
		],
		has_next_page: false,
	});
}

interface ServedRequest {
	readonly url: URL;
	readonly method: string;
	readonly headers: Headers;
	readonly body: string | undefined;
}

/**
 * A tiny stand-in for the signed-in perplexity.ai page: the library list is
 * served by offset, each thread by slug, and every request is recorded.
 */
function perplexityLibrary(options: {
	readonly total: number;
	readonly listStatus?: number;
	readonly failingSlugs?: readonly string[];
	readonly failStatus?: number;
}) {
	const requests: ServedRequest[] = [];
	const serve: typeof fetch = async (input, init) => {
		const url = new URL(String(input), HOME);
		const headers = new Headers(init?.headers);
		const body = typeof init?.body === "string" ? init.body : undefined;
		requests.push({
			url,
			method: init?.method ?? "GET",
			headers,
			body,
		});
		if (url.pathname === "/api/auth/session") {
			return Response.json({ user: { id: "synthetic-owner" } });
		}
		if (url.pathname === "/rest/thread/list_ask_threads") {
			if (options.listStatus !== undefined) {
				return new Response("{}", { status: options.listStatus });
			}
			const offset =
				body === undefined
					? 0
					: (JSON.parse(body) as { offset: number }).offset;
			const slice = Array.from(
				{ length: Math.min(PAGE_SIZE, options.total - offset) },
				(_, index) =>
					threadItem(offset + index + 1, offset + index + 1 < options.total),
			);
			return Response.json(slice);
		}
		const slug = url.pathname.split("/").pop() ?? "";
		if (options.failingSlugs?.includes(slug)) {
			return new Response("{}", { status: options.failStatus ?? 500 });
		}
		return new Response(threadDetail(Number(slug.slice(-12))), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	};
	return { requests, serve };
}

async function withBrowser<T>(
	fetcher: typeof fetch,
	run: () => Promise<T>,
): Promise<T> {
	const savedFetch = globalThis.fetch;
	const savedLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
	Object.defineProperty(globalThis, "location", {
		configurable: true,
		value: { origin: new URL(HOME).origin },
	});
	globalThis.fetch = fetcher;
	return run().finally(() => {
		globalThis.fetch = savedFetch;
		if (savedLocation)
			Object.defineProperty(globalThis, "location", savedLocation);
		else Reflect.deleteProperty(globalThis, "location");
	});
}

function page(initial = HOME, visits: string[] = []): Page {
	let url = initial;
	return {
		url: () => url,
		goto: async (target: string) => {
			url = target;
			visits.push(target);
			return null;
		},
		evaluate: async (fn: (arg: unknown) => unknown, arg: unknown) => {
			const previousLocation = Object.getOwnPropertyDescriptor(
				globalThis,
				"location",
			);
			Object.defineProperty(globalThis, "location", {
				configurable: true,
				value: { origin: new URL(url).origin },
			});
			try {
				return await fn(arg);
			} finally {
				if (previousLocation)
					Object.defineProperty(globalThis, "location", previousLocation);
				else Reflect.deleteProperty(globalThis, "location");
			}
		},
		close: async () => {},
		context: () => ({ newPage: async () => page() }),
	} as Page;
}

function harness(
	names: string[],
	browserPage: Page,
	state: Record<string, unknown> = {},
	timeRange: { since?: string; until?: string } = {},
) {
	const messages: EmittedMessage[] = [];
	const records: Array<{ stream: string; data: RecordData }> = [];
	const failures: Array<{ stream: string; retryable: boolean }> = [];
	const ctx = Object.assign(Object.create(null) as BrowserCollectContext, {
		page: browserPage,
		state,
		detailGaps: [],
		requested: new Map(
			names.map((name) => [
				name,
				{ name, time_range: timeRange } as StreamScope,
			]),
		),
		emit: async (message: EmittedMessage) => {
			messages.push(message);
		},
		emitRecord: async (stream: string, data: RecordData) => {
			const parsed = validateRecord(stream, data);
			assert.equal(parsed.ok, true, JSON.stringify(parsed));
			records.push({ stream, data });
		},
		reportStreamFailure: async (
			stream: string,
			message: string,
			options?: { retryable?: boolean },
		) => {
			failures.push({ stream, retryable: options?.retryable === true });
			messages.push({
				type: "SKIP_RESULT",
				stream,
				reason: "stream_collection_failed",
				message,
			} as EmittedMessage);
		},
		progress: async (message: string, extra?: Record<string, unknown>) => {
			messages.push({ type: "PROGRESS", message, ...extra } as EmittedMessage);
		},
	});
	return { ctx, messages, records, failures };
}

function stateCursor(
	messages: readonly EmittedMessage[],
	stream: string,
): Record<string, unknown> {
	const message = messages.find(
		(item) => item.type === "STATE" && item.stream === stream,
	);
	assert.equal(
		message?.type,
		"STATE",
		`expected a STATE message for ${stream}`,
	);
	return (message as { cursor: Record<string, unknown> }).cursor;
}

function detailCoverage(
	messages: readonly EmittedMessage[],
	stream: string,
): Record<string, unknown> {
	const message = messages.find(
		(item) =>
			(item as { type?: string }).type === "DETAIL_COVERAGE" &&
			(item as { stream?: string }).stream === stream,
	);
	assert.ok(message, `expected a DETAIL_COVERAGE message for ${stream}`);
	return message as Record<string, unknown>;
}

const ALL_STREAMS = ["conversations", "messages"];

test("the manifest declares the browser-session profile and its two streams", () => {
	const manifest = JSON.parse(
		readFileSync(new URL("./manifest.json", import.meta.url), "utf8"),
	) as {
		connector_key: string;
		runtime_requirements: {
			bindings: Record<
				string,
				{
					features: string[];
					constraints?: { hosts?: string[]; navigate?: string[] };
				}
			>;
		};
		streams: Array<{
			name: string;
			required: boolean;
			coverage_strategy: string;
			cursor_field: string;
			parent_streams?: string[];
		}>;
	};
	assert.equal(manifest.connector_key, "perplexity");
	const network = manifest.runtime_requirements.bindings.network;
	const browserBinding = manifest.runtime_requirements.bindings.browser;
	assert.deepEqual(network?.features ?? [], ["same_origin_page_fetch"]);
	assert.deepEqual(network?.constraints?.hosts ?? [], [
		"https://www.perplexity.ai",
	]);
	assert.deepEqual(browserBinding?.constraints?.navigate ?? [], [
		"https://www.perplexity.ai",
	]);
	assert.deepEqual(
		manifest.streams.map((stream) => stream.name),
		["conversations", "messages"],
	);
	assert.equal(manifest.streams[0]?.required, true);
	assert.equal(manifest.streams[0]?.coverage_strategy, "checkpoint_window");
	assert.equal(manifest.streams[0]?.cursor_field, "update_time");
	assert.equal(
		manifest.streams[1]?.coverage_strategy,
		"parent_detail_accounting",
	);
	assert.deepEqual(manifest.streams[1]?.parent_streams, ["conversations"]);
});

test("collect walks the list page by page and reads every thread", async () => {
	const library = perplexityLibrary({ total: PAGE_SIZE + 5 });
	await withBrowser(library.serve, async () => {
		const h = harness(ALL_STREAMS, page());
		await collectPerplexity(h.ctx, { threadDelayMs: 0 });
		assert.equal(
			h.records.filter((r) => r.stream === "conversations").length,
			25,
		);
		assert.equal(h.records.filter((r) => r.stream === "messages").length, 50);
		assert.deepEqual(h.failures, []);

		// The list is POSTed with the app's own headers and paged by offset.
		// A list longer than one page is walked twice to prove it held still.
		const listCalls = library.requests.filter(
			(request) => request.url.pathname === "/rest/thread/list_ask_threads",
		);
		assert.equal(listCalls.length, 4);
		const first = listCalls[0];
		assert.ok(first, "the list was requested");
		assert.equal(first.method, "POST");
		assert.equal(first.headers.get("x-app-apiclient"), "default");
		assert.equal(first.headers.get("x-app-apiversion"), "2.18");
		assert.equal(first.headers.get("content-type"), "application/json");
		const requestBody = JSON.parse(first.body ?? "{}") as Record<
			string,
			unknown
		>;
		assert.deepEqual(requestBody, {
			limit: PAGE_SIZE,
			offset: 0,
			ascending: false,
			search_term: "",
		});
		const second = listCalls[1];
		assert.equal(
			(JSON.parse(second?.body ?? "{}") as { offset: number }).offset,
			20,
		);

		// Each thread is read through its slug with the app's query parameters.
		const threadCalls = library.requests.filter(
			(request) =>
				request.method === "GET" &&
				request.url.pathname.startsWith("/rest/thread/"),
		);
		assert.equal(threadCalls.length, 25);
		for (const call of threadCalls) {
			assert.match(call.url.pathname, /^\/rest\/thread\/bbbbbbbb-/);
			assert.equal(call.url.searchParams.get("version"), "2.18");
			assert.equal(call.url.searchParams.get("source"), "default");
			assert.equal(call.url.searchParams.get("from_first"), "true");
			assert.equal(
				call.url.searchParams.get("with_schematized_response"),
				"true",
			);
			assert.equal(call.url.searchParams.get("limit"), "10");
		}

		// Records carry the expected shape.
		const firstConversation = h.records.find(
			(r) => r.stream === "conversations" && r.data.id === threadId(1),
		)?.data;
		assert.equal(firstConversation?.title, "Synthetic thread 1");
		assert.equal(firstConversation?.create_time, instant(1));
		assert.equal(firstConversation?.update_time, instant(1));
		const userMessage = h.records.find(
			(r) => r.stream === "messages" && r.data.id === `${entryId(1)}:user`,
		)?.data;
		assert.equal(userMessage?.content, "Synthetic question 1?");
		const assistantMessage = h.records.find(
			(r) => r.stream === "messages" && r.data.id === `${entryId(1)}:assistant`,
		)?.data;
		assert.equal(assistantMessage?.content, "Synthetic answer 1.");
		assert.deepEqual(assistantMessage?.citations, [
			{ title: "Synthetic source 1", url: "https://example.com/synthetic-1" },
		]);
	});
});

test("both streams prove their boundary and checkpoint their cursors", async () => {
	const library = perplexityLibrary({ total: 3 });
	await withBrowser(library.serve, async () => {
		const h = harness(ALL_STREAMS, page());
		await collectPerplexity(h.ctx, { threadDelayMs: 0 });

		assert.deepEqual(detailCoverage(h.messages, "conversations"), {
			type: "DETAIL_COVERAGE",
			reference_only: true,
			stream: "conversations",
			state_stream: "conversations",
			required_keys: [],
			hydrated_keys: [],
			considered: 3,
			covered: 3,
		});
		const coverage = detailCoverage(h.messages, "messages");
		assert.equal(coverage.considered, 3);
		assert.equal(coverage.covered, 3);
		assert.equal((coverage.required_keys as string[]).length, 3);
		assert.equal((coverage.hydrated_keys as string[]).length, 3);

		const conversationsCursor = stateCursor(h.messages, "conversations");
		// The cursor carries no thread count: `total_threads` is not the
		// library size on the real site, and the walk proves its own end.
		assert.equal(conversationsCursor.last_update_time, instant(3));
		const messagesCursor = stateCursor(h.messages, "messages") as {
			synced: Record<
				string,
				{ update_time: string | null; create_time: string | null }
			>;
		};
		assert.equal(Object.keys(messagesCursor.synced).length, 3);
	});
});

test("an unchanged thread is not re-read, but its conversation stays whole", async () => {
	const library = perplexityLibrary({ total: 2 });
	await withBrowser(library.serve, async () => {
		const first = harness(ALL_STREAMS, page());
		await collectPerplexity(first.ctx, { threadDelayMs: 0 });
		const messagesState = stateCursor(first.messages, "messages");
		const conversationsState = stateCursor(first.messages, "conversations");
		// Second run with the saved state: nothing has changed upstream.
		const before = library.requests.filter((r) =>
			r.url.pathname.startsWith("/rest/thread/"),
		).length;
		const second = harness(ALL_STREAMS, page(), {
			conversations: conversationsState,
			messages: messagesState,
		});
		await collectPerplexity(second.ctx, { threadDelayMs: 0 });
		const after = library.requests.filter((r) =>
			r.url.pathname.startsWith("/rest/thread/"),
		).length;
		assert.equal(after - before, 1, "only the list is requested again");
		assert.equal(
			second.records.filter((r) => r.stream === "conversations").length,
			2,
		);
		// create_time survives the skip because it was checkpointed.
		const skipped = second.records.find(
			(r) => r.stream === "conversations" && r.data.id === threadId(1),
		)?.data;
		assert.equal(skipped?.create_time, instant(1));
		const coverage = detailCoverage(second.messages, "messages");
		assert.equal(coverage.covered, 2);
		assert.equal((coverage.optional_skip_keys as string[]).length, 2);
	});
});

test("a thread that fails is a reported gap, not a silent hole", async () => {
	const library = perplexityLibrary({
		total: 2,
		failingSlugs: [threadSlug(1)],
		failStatus: 404,
	});
	await withBrowser(library.serve, async () => {
		const h = harness(ALL_STREAMS, page());
		await collectPerplexity(h.ctx, { threadDelayMs: 0 });
		const gap = h.messages.find(
			(item) => (item as { type?: string }).type === "DETAIL_GAP",
		) as Record<string, unknown> | undefined;
		assert.ok(gap, "expected a DETAIL_GAP");
		assert.equal(gap?.stream, "messages");
		assert.equal(gap?.parent_stream, "conversations");
		assert.equal(gap?.record_key, threadId(1));
		assert.equal(gap?.status, "pending");
		assert.equal(gap?.reason, "temporary_unavailable");
		const coverage = detailCoverage(h.messages, "messages");
		assert.equal(coverage.considered, 2);
		assert.equal(coverage.covered, 1);
		assert.deepEqual(coverage.gap_keys, [threadId(1)]);
		// The failed thread's conversation record still lands, from the list.
		assert.equal(
			h.records.filter((r) => r.stream === "conversations").length,
			2,
		);
	});
});

test("a dead session during a run aborts it loudly", async () => {
	const library = perplexityLibrary({
		total: 2,
		failingSlugs: [threadSlug(1)],
		failStatus: 401,
	});
	await withBrowser(library.serve, async () => {
		const h = harness(ALL_STREAMS, page());
		await assert.rejects(
			collectPerplexity(h.ctx, { threadDelayMs: 0 }),
			/perplexity_auth_failed/,
		);
	});
});

test("a list body of the wrong shape fails the run, not the stream", async () => {
	const serve: typeof fetch = async () => Response.json({ models: [] });
	await withBrowser(serve, async () => {
		const h = harness(ALL_STREAMS, page());
		await assert.rejects(
			collectPerplexity(h.ctx, { threadDelayMs: 0 }),
			/perplexity_source_unreadable/,
		);
	});
});

test("a library whose only item cannot be read reports it and completes", async () => {
	const serve: typeof fetch = async () =>
		Response.json([
			{
				uuid: "aaaaaaaa-0000-4000-8000-000000000001",
				title: "a thread with no id of its own",
				total_threads: 1,
				has_next_page: false,
			},
		]);
	await withBrowser(serve, async () => {
		const h = harness(ALL_STREAMS, page());
		// `total_threads` must not gate completeness: the walk proved its own
		// end (the last item said has_next_page: false), so the run
		// completes, reports the unreadable thread, and emits no records.
		await collectPerplexity(h.ctx, { threadDelayMs: 0 });
		assert.deepEqual(h.records, []);
		assert.equal(h.failures.length, 1);
		assert.equal(h.failures[0]?.stream, "conversations");
		assert.equal(h.failures[0]?.retryable, false);
	});
});

test("an empty library is proven empty, with zero records and a null cursor", async () => {
	const serve: typeof fetch = async (input) =>
		new URL(String(input), HOME).pathname === "/api/auth/session"
			? Response.json({ user: { id: "synthetic-owner" } })
			: Response.json([]);
	await withBrowser(serve, async () => {
		const h = harness(ALL_STREAMS, page());
		await collectPerplexity(h.ctx, { threadDelayMs: 0 });
		assert.deepEqual(h.records, []);
		assert.deepEqual(h.failures, []);
		assert.equal(detailCoverage(h.messages, "conversations").considered, 0);
		assert.equal(detailCoverage(h.messages, "messages").covered, 0);
		const cursor = stateCursor(h.messages, "conversations");
		assert.equal(cursor.last_update_time, null);
	});
});

test("a signed-in session is verified through the page's session endpoint", async () => {
	const requests: string[] = [];
	const visits: string[] = [];
	await withBrowser(
		async (input) => {
			requests.push(String(input));
			return Response.json({
				user: { id: "synthetic-owner" },
				expires: "2027-01-01T00:00:00Z",
			});
		},
		async () => {
			assert.equal(await hasPerplexitySession(page(HOME, visits)), true);
		},
	);
	assert.deepEqual(requests, ["/api/auth/session"]);
	assert.deepEqual(visits, []);
});

test("an expired session hands off to the owner and resolves when they sign in", async () => {
	let authenticated = false;
	const visits: string[] = [];
	const statuses: string[] = [];
	await withBrowser(
		async (input) => {
			void input;
			return Response.json(
				authenticated ? { user: { id: "synthetic-owner" } } : {},
			);
		},
		async () => {
			await ensurePerplexitySession(
				Object.assign(Object.create(null) as EnsureSessionArgs, {
					page: page("about:blank", visits),
					assist: async () => {
						authenticated = true;
						return "assist-1";
					},
					completeAssistance: async (_id: string, status: string) => {
						statuses.push(status);
					},
				}),
			);
		},
	);
	assert.deepEqual(visits, [HOME]);
	assert.deepEqual(statuses, ["resolved"]);
});

// ─── review follow-ups ───────────────────────────────────────────────────

/** A server whose list pages and thread bodies a test scripts directly. */
function scriptedLibrary(options: {
	readonly listPage: (offset: number, walk: number) => unknown[];
	readonly thread?: (slug: string, offset: number) => Response;
	/** The session endpoint's body; signed in unless a test says otherwise. */
	readonly session?: () => unknown;
}) {
	const requests: ServedRequest[] = [];
	let walk = 0;
	const serve: typeof fetch = async (input, init) => {
		const url = new URL(String(input), HOME);
		const body = typeof init?.body === "string" ? init.body : undefined;
		requests.push({
			url,
			method: init?.method ?? "GET",
			headers: new Headers(init?.headers),
			body,
		});
		if (url.pathname === "/api/auth/session") {
			return Response.json(
				options.session?.() ?? { user: { id: "synthetic-owner" } },
			);
		}
		if (url.pathname === "/rest/thread/list_ask_threads") {
			const offset =
				body === undefined
					? 0
					: (JSON.parse(body) as { offset: number }).offset;
			if (offset === 0) walk += 1;
			return Response.json(options.listPage(offset, walk));
		}
		const slug = url.pathname.split("/").pop() ?? "";
		const offset = Number(url.searchParams.get("offset") ?? "0");
		if (options.thread) return options.thread(slug, offset);
		return new Response(threadDetail(Number(slug.slice(-12))), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	};
	return { requests, serve };
}

const listItems = (ns: readonly number[], lastHasNext: boolean) =>
	ns.map((n, index) =>
		threadItem(n, index === ns.length - 1 ? lastHasNext : true),
	);

test("a short list page that says there is more is followed, not taken as the end", async () => {
	const library = scriptedLibrary({
		listPage: (offset) =>
			offset === 0
				? listItems([1, 2], true)
				: offset === 2
					? listItems([3], false)
					: [],
	});
	await withBrowser(library.serve, async () => {
		const h = harness(ALL_STREAMS, page());
		await collectPerplexity(h.ctx, { threadDelayMs: 0 });
		assert.equal(
			h.records.filter((r) => r.stream === "conversations").length,
			3,
		);
		assert.equal(detailCoverage(h.messages, "messages").covered, 3);
	});
});

test("a list that moves under the walk is re-walked until two walks agree", async () => {
	const all = Array.from({ length: PAGE_SIZE + 2 }, (_, i) => i + 1);
	// The first walk misses thread 22 (it moved during the walk); later walks see it.
	const library = scriptedLibrary({
		listPage: (offset, walk) => {
			const ids = walk === 1 ? all.filter((n) => n !== 22) : all;
			const slice = ids.slice(offset, offset + PAGE_SIZE);
			return listItems(slice, offset + PAGE_SIZE < ids.length);
		},
	});
	await withBrowser(library.serve, async () => {
		const h = harness(["conversations"], page());
		await collectPerplexity(h.ctx, { threadDelayMs: 0 });
		assert.equal(h.records.length, PAGE_SIZE + 2);
	});
});

test("a list that never holds still keeps its threads, fails both streams retryably and checkpoints nothing", async () => {
	const library = scriptedLibrary({
		listPage: (offset, walk) => {
			const ids = Array.from(
				{ length: PAGE_SIZE + 2 },
				(_, i) => i + 1 + walk * 100,
			);
			return listItems(
				ids.slice(offset, offset + PAGE_SIZE),
				offset + PAGE_SIZE < ids.length,
			);
		},
	});
	await withBrowser(library.serve, async () => {
		const h = harness(ALL_STREAMS, page());
		await collectPerplexity(h.ctx, { threadDelayMs: 0 });
		// The threads seen are kept, but neither stream is proven: both fail
		// retryably, with no coverage claim and no checkpoint.
		assert.equal(
			h.records.filter((r) => r.stream === "conversations").length,
			PAGE_SIZE + 2,
		);
		assert.equal(h.records.filter((r) => r.stream === "messages").length, 0);
		assert.deepEqual(h.failures, [
			{ stream: "conversations", retryable: true },
			{ stream: "messages", retryable: true },
		]);
		assert.equal(
			h.messages.some(
				(m) =>
					m.type === "STATE" ||
					(m as { type: string }).type === "DETAIL_COVERAGE",
			),
			false,
		);
	});
});

test("a thread that returns fewer entries than the list reports is a gap, not hydrated", async () => {
	const library = scriptedLibrary({
		listPage: () => [{ ...threadItem(1, false), query_count: 2 }],
	});
	await withBrowser(library.serve, async () => {
		const h = harness(ALL_STREAMS, page());
		await collectPerplexity(h.ctx, { threadDelayMs: 0 });
		const coverage = detailCoverage(h.messages, "messages");
		assert.equal(coverage.covered, 0);
		assert.deepEqual(coverage.gap_keys, [threadId(1)]);
		const cursor = stateCursor(h.messages, "messages") as {
			synced: Record<string, unknown>;
		};
		assert.deepEqual(cursor.synced, {});
	});
});

test("an entries page that claims more but adds nothing is a gap", async () => {
	const library = scriptedLibrary({
		listPage: () => listItems([1], false),
		thread: () =>
			Response.json({
				status: "success",
				entries: [],
				has_next_page: true,
				next_cursor: "c",
			}),
	});
	await withBrowser(library.serve, async () => {
		const h = harness(ALL_STREAMS, page());
		await collectPerplexity(h.ctx, { threadDelayMs: 0 });
		assert.deepEqual(detailCoverage(h.messages, "messages").gap_keys, [
			threadId(1),
		]);
	});
});

test("an answer still being written is a gap and is not remembered", async () => {
	const library = scriptedLibrary({
		listPage: () => [{ ...threadItem(1, false), status: "IN_PROGRESS" }],
		thread: () => {
			const body = JSON.parse(threadDetail(1)) as {
				entries: Array<Record<string, unknown>>;
			};
			const [entry] = body.entries;
			if (entry) entry.status = "IN_PROGRESS";
			return Response.json(body);
		},
	});
	await withBrowser(library.serve, async () => {
		const h = harness(ALL_STREAMS, page());
		await collectPerplexity(h.ctx, { threadDelayMs: 0 });
		const gap = h.messages.find(
			(m) => (m as { type?: string }).type === "DETAIL_GAP",
		) as { detail?: { class?: string } } | undefined;
		assert.equal(gap?.detail?.class, "answer_still_generating");
		assert.equal(h.records.filter((r) => r.stream === "messages").length, 0);
	});
});

test("each conversation is emitted before its messages and before its gap", async () => {
	const library = scriptedLibrary({
		listPage: () => listItems([1, 2], false),
		thread: (slug) =>
			slug === threadSlug(2)
				? new Response("{}", {
						status: 404,
						headers: { "content-type": "application/json" },
					})
				: new Response(threadDetail(1), {
						headers: { "content-type": "application/json" },
					}),
	});
	await withBrowser(library.serve, async () => {
		const order: string[] = [];
		const h = harness(ALL_STREAMS, page());
		const emitRecord = h.ctx.emitRecord;
		const emit = h.ctx.emit;
		h.ctx.emitRecord = async (stream, data) => {
			order.push(`${stream}:${String(data.conversation_id ?? data.id)}`);
			await emitRecord(stream, data);
		};
		h.ctx.emit = async (message) => {
			if (message.type === "DETAIL_GAP")
				order.push(`gap:${String(message.record_key)}`);
			await emit(message);
		};
		await collectPerplexity(h.ctx, { threadDelayMs: 0 });
		assert.deepEqual(order, [
			`conversations:${threadId(1)}`,
			`messages:${threadId(1)}`,
			`messages:${threadId(1)}`,
			`conversations:${threadId(2)}`,
			`gap:${threadId(2)}`,
		]);
	});
});

test("a rate limit or server error stops the run instead of gapping every thread", async () => {
	for (const status of [429, 500]) {
		const library = perplexityLibrary({
			total: 3,
			failingSlugs: [threadSlug(1)],
			failStatus: status,
		});
		await withBrowser(library.serve, async () => {
			const h = harness(ALL_STREAMS, page());
			await assert.rejects(
				collectPerplexity(h.ctx, { threadDelayMs: 0 }),
				new RegExp(`perplexity_internal_api_${String(status)}`),
			);
			assert.equal(
				h.messages.some((m) => m.type === "STATE"),
				false,
			);
		});
	}
});

test("a Cloudflare page instead of JSON is a challenge, not a schema failure", async () => {
	const serve: typeof fetch = async () =>
		new Response("<html>Just a moment...</html>", {
			status: 200,
			headers: { "content-type": "text/html" },
		});
	await withBrowser(serve, async () => {
		const h = harness(ALL_STREAMS, page());
		await assert.rejects(
			collectPerplexity(h.ctx, { threadDelayMs: 0 }),
			/perplexity_challenge/,
		);
	});
	const forbidden: typeof fetch = async () =>
		new Response("{}", { status: 403 });
	await withBrowser(forbidden, async () => {
		const h = harness(ALL_STREAMS, page());
		await assert.rejects(
			collectPerplexity(h.ctx, { threadDelayMs: 0 }),
			/perplexity_challenge/,
		);
	});
});

test("an update inside the same second is not mistaken for no change", async () => {
	const library = perplexityLibrary({ total: 1 });
	await withBrowser(library.serve, async () => {
		const first = harness(ALL_STREAMS, page());
		await collectPerplexity(first.ctx, { threadDelayMs: 0 });
		const synced = (
			stateCursor(first.messages, "messages") as {
				synced: Record<string, { update_time: string }>;
			}
		).synced;
		const remembered = synced[threadId(1)];
		assert.ok(remembered);
		// The thread was remembered a fraction of a second earlier than it now reads.
		remembered.update_time =
			remembered.update_time
				.replace(/\.\d{6}Z$/, ".000001Z")
				.replace(".000001Z", ".000000Z") === remembered.update_time
				? remembered.update_time.replace(/\.\d{6}Z$/, ".999999Z")
				: remembered.update_time.replace(/\.\d{6}Z$/, ".000000Z");
		const before = library.requests.length;
		const second = harness(ALL_STREAMS, page(), { messages: { synced } });
		await collectPerplexity(second.ctx, { threadDelayMs: 0 });
		const threadReads = library.requests
			.slice(before)
			.filter((r) => r.method === "GET");
		assert.equal(threadReads.length, 1, "the thread is read again");
	});
});

test("a pending gap is recovered from its locator, and recovery-only stops there", async () => {
	const library = perplexityLibrary({ total: 1 });
	await withBrowser(library.serve, async () => {
		const h = harness(ALL_STREAMS, page());
		const gap = {
			status: "pending",
			stream: "messages",
			record_key: threadId(1),
			detail_locator: { kind: "perplexity.thread", slug: threadSlug(1) },
		};
		Object.assign(h.ctx, {
			recoveryOnly: true,
			detailGaps: [
				{ ...gap, gap_id: "gap-1" },
				{ ...gap, gap_id: "gap-2" },
			],
		});
		await collectPerplexity(h.ctx, { threadDelayMs: 0 });
		// Two gaps for one thread: its messages once, both gaps resolved.
		assert.equal(h.records.filter((r) => r.stream === "messages").length, 2);
		const recovered = h.messages
			.filter((m) => m.type === "DETAIL_GAP_RECOVERED")
			.map((m) => (m as { gap_id?: string }).gap_id);
		assert.deepEqual(recovered, ["gap-1", "gap-2"]);
		assert.equal(
			library.requests.some(
				(r) => r.url.pathname === "/rest/thread/list_ask_threads",
			),
			false,
			"recovery-only never walks the list",
		);
		assert.equal(
			h.messages.some((m) => m.type === "STATE"),
			false,
			"recovery-only checkpoints nothing",
		);
	});
});

test("an ordinary run resolves a pending gap in the forward walk, parent first", async () => {
	const library = perplexityLibrary({ total: 1 });
	await withBrowser(library.serve, async () => {
		const order: string[] = [];
		const h = harness(ALL_STREAMS, page());
		Object.assign(h.ctx, {
			detailGaps: [
				{
					gap_id: "gap-1",
					status: "pending",
					stream: "messages",
					record_key: threadId(1),
					detail_locator: { kind: "perplexity.thread", slug: threadSlug(1) },
				},
			],
		});
		const emitRecord = h.ctx.emitRecord;
		const emit = h.ctx.emit;
		h.ctx.emitRecord = async (stream, data) => {
			order.push(stream);
			await emitRecord(stream, data);
		};
		h.ctx.emit = async (message) => {
			if (message.type === "DETAIL_GAP_RECOVERED") order.push("recovered");
			await emit(message);
		};
		await collectPerplexity(h.ctx, { threadDelayMs: 0 });
		assert.deepEqual(order, [
			"conversations",
			"messages",
			"messages",
			"recovered",
		]);
	});
});

test("a pending gap whose thread is still short stays pending and is not remembered", async () => {
	const library = scriptedLibrary({
		listPage: () => [{ ...threadItem(1, false), query_count: 2 }],
	});
	await withBrowser(library.serve, async () => {
		const h = harness(ALL_STREAMS, page());
		Object.assign(h.ctx, {
			detailGaps: [
				{
					gap_id: "gap-1",
					status: "pending",
					stream: "messages",
					record_key: threadId(1),
					detail_locator: { kind: "perplexity.thread", slug: threadSlug(1) },
				},
			],
		});
		await collectPerplexity(h.ctx, { threadDelayMs: 0 });
		assert.equal(
			h.messages.some((m) => m.type === "DETAIL_GAP_RECOVERED"),
			false,
		);
		const cursor = stateCursor(h.messages, "messages") as {
			synced: Record<string, unknown>;
		};
		assert.deepEqual(cursor.synced, {});
	});
});

test("a two-page walk whose second page repeats a shifted thread is re-walked", async () => {
	const all = Array.from({ length: PAGE_SIZE + 1 }, (_, i) => i + 1);
	// Walk 1: thread 21 was pushed back by new activity, page 2 repeats thread 20.
	const library = scriptedLibrary({
		listPage: (offset, walk) => {
			if (walk === 1 && offset === PAGE_SIZE)
				return listItems([PAGE_SIZE], false);
			const slice = all.slice(offset, offset + PAGE_SIZE);
			return listItems(slice, offset + PAGE_SIZE < all.length);
		},
	});
	await withBrowser(library.serve, async () => {
		const h = harness(["conversations"], page());
		await collectPerplexity(h.ctx, { threadDelayMs: 0 });
		assert.equal(h.records.length, PAGE_SIZE + 1);
	});
});

test("a thread answered between walks does not make the list unstable", async () => {
	const all = Array.from({ length: PAGE_SIZE + 2 }, (_, i) => i + 1);
	const library = scriptedLibrary({
		listPage: (offset, walk) =>
			all.slice(offset, offset + PAGE_SIZE).map((n, index, slice) => ({
				...threadItem(
					n,
					index < slice.length - 1 || offset + PAGE_SIZE < all.length,
				),
				...(n === 1 ? { last_query_datetime: listStamp(100 + walk) } : {}),
			})),
	});
	await withBrowser(library.serve, async () => {
		const h = harness(["conversations"], page());
		await collectPerplexity(h.ctx, { threadDelayMs: 0 });
		assert.equal(h.records.length, PAGE_SIZE + 2);
	});
});

test("a thread with no entry count is read but never remembered", async () => {
	const library = scriptedLibrary({
		listPage: () => [{ ...threadItem(1, false), query_count: null }],
	});
	await withBrowser(library.serve, async () => {
		const h = harness(ALL_STREAMS, page());
		await collectPerplexity(h.ctx, { threadDelayMs: 0 });
		assert.equal(h.records.filter((r) => r.stream === "messages").length, 2);
		const cursor = stateCursor(h.messages, "messages") as {
			synced: Record<string, unknown>;
		};
		assert.deepEqual(cursor.synced, {});
	});
});

test("an over-long title is cut inside the schema bound", async () => {
	const library = scriptedLibrary({
		listPage: () => [{ ...threadItem(1, false), title: "t".repeat(600) }],
	});
	await withBrowser(library.serve, async () => {
		// The harness validates every record against the schema.
		const h = harness(["conversations"], page());
		await collectPerplexity(h.ctx, { threadDelayMs: 0 });
		const title = h.records[0]?.data.title;
		assert.equal(typeof title, "string");
		assert.ok(String(title).length <= 500);
	});
});

test("the manifest's record contracts match the schemas", () => {
	const manifest = JSON.parse(
		readFileSync(new URL("./manifest.json", import.meta.url), "utf8"),
	) as {
		streams: Array<{
			name: string;
			schema: {
				required: string[];
				properties: Record<
					string,
					{ type?: unknown; items?: { required?: string[] } }
				>;
			};
		}>;
	};
	for (const stream of manifest.streams) {
		assert.deepEqual(
			[...stream.schema.required].sort(),
			Object.keys(stream.schema.properties).sort(),
			`${stream.name}: every field is required, as the zod schema requires it`,
		);
	}
	const messages = manifest.streams.find(
		(stream) => stream.name === "messages",
	);
	assert.equal(messages?.schema.properties.role?.type, "string");
	assert.deepEqual(messages?.schema.properties.citations?.items?.required, [
		"title",
		"url",
	]);
});

test("a pending gap whose thread still fails is gapped again in this run, matching gap_keys", async () => {
	const library = perplexityLibrary({
		total: 2,
		failingSlugs: [threadSlug(1)],
		failStatus: 404,
	});
	await withBrowser(library.serve, async () => {
		const h = harness(ALL_STREAMS, page());
		Object.assign(h.ctx, {
			detailGaps: [
				{
					gap_id: "gap-1",
					status: "pending",
					stream: "messages",
					record_key: threadId(1),
					detail_locator: { kind: "perplexity.thread", slug: threadSlug(1) },
				},
			],
		});
		await collectPerplexity(h.ctx, { threadDelayMs: 0 });
		const gapped = h.messages
			.filter((m) => m.type === "DETAIL_GAP")
			.map((m) => (m as { record_key?: string }).record_key);
		assert.deepEqual(gapped, [threadId(1)]);
		assert.deepEqual(detailCoverage(h.messages, "messages").gap_keys, gapped);
		assert.equal(
			h.messages.some((m) => m.type === "DETAIL_GAP_RECOVERED"),
			false,
		);
	});
});

test("a Cloudflare 503 challenge page is a challenge, not a retryable outage", async () => {
	const htmlChallenge: typeof fetch = async () =>
		new Response("<html>Just a moment...</html>", {
			status: 503,
			headers: { "content-type": "text/html; charset=UTF-8" },
		});
	await withBrowser(htmlChallenge, async () => {
		const h = harness(ALL_STREAMS, page());
		await assert.rejects(
			collectPerplexity(h.ctx, { threadDelayMs: 0 }),
			/perplexity_challenge/,
		);
	});
	const marked: typeof fetch = async () =>
		new Response("{}", {
			status: 503,
			headers: {
				"content-type": "application/json",
				"cf-mitigated": "challenge",
			},
		});
	await withBrowser(marked, async () => {
		const h = harness(ALL_STREAMS, page());
		await assert.rejects(
			collectPerplexity(h.ctx, { threadDelayMs: 0 }),
			/perplexity_challenge/,
		);
	});
	// A plain JSON 503 is still an outage the runtime retries.
	const outage: typeof fetch = async () =>
		new Response("{}", {
			status: 503,
			headers: { "content-type": "application/json" },
		});
	await withBrowser(outage, async () => {
		const h = harness(ALL_STREAMS, page());
		await assert.rejects(
			collectPerplexity(h.ctx, { threadDelayMs: 0 }),
			/perplexity_internal_api_503/,
		);
	});
});

interface JsonFieldSchema {
	type?: string | string[];
	format?: string;
	enum?: unknown[];
	anyOf?: JsonFieldSchema[];
	items?: JsonFieldSchema;
	properties?: Record<string, JsonFieldSchema>;
	required?: string[];
}

/** The comparable facts of one field: its types (null included), format and enum. */
function fieldFacts(
	schema: JsonFieldSchema | undefined,
): Record<string, unknown> {
	const parts = schema?.anyOf ?? (schema ? [schema] : []);
	const valued = parts.find(({ type }) => type !== "null") ?? {};
	return {
		types: parts
			.flatMap(({ type }) => (type === undefined ? [] : [type].flat()))
			.sort(),
		format: valued.format ?? null,
		enum: valued.enum ?? null,
		items:
			valued.items?.properties === undefined
				? null
				: Object.fromEntries(
						Object.entries(valued.items.properties).map(([key, value]) => [
							key,
							fieldFacts(value),
						]),
					),
		itemsRequired: valued.items?.required
			? [...valued.items.required].sort()
			: null,
	};
}

test("each manifest field matches its zod schema in type, format, nullability and enum", () => {
	const manifest = JSON.parse(
		readFileSync(new URL("./manifest.json", import.meta.url), "utf8"),
	) as { streams: Array<{ name: string; schema: JsonFieldSchema }> };
	const zodSchemas: Record<string, z.ZodTypeAny> = {
		conversations: conversationSchema,
		messages: messageSchema,
	};
	for (const stream of manifest.streams) {
		const zodSchema = zodSchemas[stream.name];
		assert.ok(zodSchema, `${stream.name} has a zod schema`);
		const zod = z.toJSONSchema(zodSchema, { io: "input" }) as JsonFieldSchema;
		const keys = Object.keys(stream.schema.properties ?? {}).sort();
		assert.deepEqual(
			Object.keys(zod.properties ?? {}).sort(),
			keys,
			`${stream.name}: keys`,
		);
		for (const key of keys) {
			assert.deepEqual(
				fieldFacts(stream.schema.properties?.[key]),
				fieldFacts(zod.properties?.[key]),
				`${stream.name}.${key}`,
			);
		}
		assert.deepEqual(
			[...(stream.schema.required ?? [])].sort(),
			[...(zod.required ?? [])].sort(),
			`${stream.name}: required`,
		);
	}
});

// ─── current runtime: session handoff and completeness proof ─────────────

/** EnsureSession arguments whose assist records each handoff it is asked for. */
function sessionArgs(
	browserPage: Page,
	onAssist: () => void = () => {},
): {
	args: EnsureSessionArgs;
	handoffs: string[];
	statuses: string[];
} {
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

test("a signed-out page elsewhere on the site is moved to the sign-in page, then handed over", async () => {
	let authenticated = false;
	const visits: string[] = [];
	const session = sessionArgs(
		page(`${HOME}search/synthetic-thread`, visits),
		() => {
			authenticated = true;
		},
	);
	await withBrowser(
		async () =>
			Response.json(authenticated ? { user: { id: "synthetic-owner" } } : {}),
		() => ensurePerplexitySession(session.args, noDelay),
	);
	assert.deepEqual(visits, [HOME]);
	assert.equal(session.handoffs.length, 1);
	assert.match(session.handoffs[0] ?? "", /^Sign in to Perplexity/);
	assert.deepEqual(session.statuses, ["resolved"]);
});

test("a human check is handed over in place, never navigated away from", async () => {
	let cleared = false;
	const visits: string[] = [];
	const session = sessionArgs(
		page(`${HOME}search/synthetic-thread`, visits),
		() => {
			cleared = true;
		},
	);
	await withBrowser(
		async () =>
			cleared
				? Response.json({ user: { id: "synthetic-owner" } })
				: new Response("<html>Just a moment...</html>", {
						status: 403,
						headers: {
							"content-type": "text/html",
							"cf-mitigated": "challenge",
						},
					}),
		() => ensurePerplexitySession(session.args, noDelay),
	);
	assert.deepEqual(visits, []);
	assert.equal(session.handoffs.length, 1);
	assert.match(session.handoffs[0] ?? "", /human check/);
	assert.doesNotMatch(session.handoffs[0] ?? "", /^Sign in/);
});

test("a Cloudflare challenge document is read as a challenge without a request", async () => {
	const requests: string[] = [];
	const saved = Object.getOwnPropertyDescriptor(globalThis, "document");
	Object.defineProperty(globalThis, "document", {
		configurable: true,
		value: { title: "Just a moment..." },
	});
	try {
		await withBrowser(
			async (input) => {
				requests.push(String(input));
				return Response.json({});
			},
			async () => {
				assert.equal(await checkPerplexitySession(page()), "challenge");
			},
		);
	} finally {
		if (saved) Object.defineProperty(globalThis, "document", saved);
		else Reflect.deleteProperty(globalThis, "document");
	}
	assert.deepEqual(requests, []);
});

test("a session check with no usable answer is retried in place, then fails with a bare code and no handoff", async () => {
	let reads = 0;
	const visits: string[] = [];
	const session = sessionArgs(page(HOME, visits));
	let thrown: unknown;
	await withBrowser(
		async () => {
			reads += 1;
			return new Response("{}", {
				status: 502,
				headers: { "content-type": "application/json" },
			});
		},
		async () => {
			try {
				await ensurePerplexitySession(session.args, noDelay);
			} catch (error) {
				thrown = error;
			}
		},
	);
	assert.ok(thrown instanceof Error);
	assert.equal(thrown.message, "perplexity_interrupted");
	assert.equal(isConnectorErrorCodeShaped(thrown.message), true);
	assert.equal(reads, 3);
	assert.deepEqual(session.handoffs, []);
	assert.deepEqual(visits, []);
});

test("a sign-in that is never completed fails with the bare perplexity_auth_failed code", async () => {
	const visits: string[] = [];
	const browserPage = page(HOME, visits);
	let thrown: unknown;
	await withBrowser(
		async () => Response.json({}),
		async () => {
			try {
				// A host without the streamed handoff: the owner says they are
				// done, and the session is then read once and is still signed out.
				await ensurePerplexitySession(
					Object.assign(Object.create(null) as EnsureSessionArgs, {
						page: browserPage,
						sendInteraction: async () => ({
							type: "INTERACTION_RESPONSE",
							request_id: "synthetic",
							status: "success",
						}),
					}),
					noDelay,
				);
			} catch (error) {
				thrown = error;
			}
		},
	);
	assert.ok(thrown instanceof Error);
	assert.equal(thrown.message, "perplexity_auth_failed");
	assert.equal(isConnectorErrorCodeShaped(thrown.message), true);
});

test("exactly one full page whose last item ends the list is one request and a proven, checkpointed list", async () => {
	// The owner's live library shape: 20 threads, one page, the last item
	// saying has_next_page: false.
	const library = perplexityLibrary({ total: PAGE_SIZE });
	await withBrowser(library.serve, async () => {
		const h = harness(ALL_STREAMS, page());
		await collectPerplexity(h.ctx, { threadDelayMs: 0 });
		const listCalls = library.requests.filter(
			(request) => request.url.pathname === "/rest/thread/list_ask_threads",
		);
		assert.equal(listCalls.length, 1);
		assert.equal(h.records.filter((r) => r.stream === "messages").length, 40);
		assert.deepEqual(h.failures, []);
		assert.equal(detailCoverage(h.messages, "messages").covered, PAGE_SIZE);
		assert.equal(
			Object.keys(
				(stateCursor(h.messages, "messages") as { synced: object }).synced,
			).length,
			PAGE_SIZE,
		);
	});
});

test("a full page that still claims more ends on the empty page after it, only once the session is confirmed", async () => {
	const library = scriptedLibrary({
		listPage: (offset) =>
			offset === 0
				? listItems(
						Array.from({ length: PAGE_SIZE }, (_, i) => i + 1),
						true,
					)
				: [],
	});
	await withBrowser(library.serve, async () => {
		const h = harness(ALL_STREAMS, page());
		await collectPerplexity(h.ctx, { threadDelayMs: 0 });
		const offsets = library.requests
			.filter((r) => r.url.pathname === "/rest/thread/list_ask_threads")
			.map((r) => (JSON.parse(r.body ?? "{}") as { offset: number }).offset);
		// Two pages per walk, walked twice to prove it held still.
		assert.deepEqual(offsets, [0, PAGE_SIZE, 0, PAGE_SIZE]);
		assert.equal(
			library.requests.filter((r) => r.url.pathname === "/api/auth/session")
				.length,
			2,
		);
		assert.equal(detailCoverage(h.messages, "messages").covered, PAGE_SIZE);
		assert.deepEqual(h.failures, []);
	});
});

test("an empty list from a session that is no longer signed in fails the run with no checkpoint", async () => {
	const library = scriptedLibrary({
		listPage: () => [],
		session: () => ({}),
	});
	await withBrowser(library.serve, async () => {
		const h = harness(ALL_STREAMS, page());
		await assert.rejects(
			collectPerplexity(h.ctx, { threadDelayMs: 0 }),
			/perplexity_auth_failed/,
		);
		assert.equal(
			h.messages.some(
				(m) =>
					m.type === "STATE" ||
					(m as { type: string }).type === "DETAIL_COVERAGE",
			),
			false,
		);
	});
});

test("a stream failure without the runtime's reporter fails the run instead of finishing complete", async () => {
	const serve: typeof fetch = async () =>
		Response.json([
			{
				uuid: "aaaaaaaa-0000-4000-8000-000000000001",
				title: "a thread with no id of its own",
				has_next_page: false,
			},
		]);
	await withBrowser(serve, async () => {
		const h = harness(ALL_STREAMS, page());
		Reflect.deleteProperty(h.ctx, "reportStreamFailure");
		await assert.rejects(
			collectPerplexity(h.ctx, { threadDelayMs: 0 }),
			(error: unknown) =>
				error instanceof Error &&
				(error as { code?: string }).code === "perplexity_stream_incomplete",
		);
	});
});
