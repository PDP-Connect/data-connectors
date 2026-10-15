// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { Page } from "playwright";
import type {
	BrowserCollectContext,
	EmittedMessage,
	RecordData,
	StreamScope,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import type { EnsureSessionArgs } from "../../packages/polyfill-connectors/src/session-establish.ts";
import {
	collectPerplexity,
	ensurePerplexitySession,
	hasPerplexitySession,
	PAGE_SIZE,
} from "./index.ts";
import { validateRecord } from "./schemas.ts";

const HOME = "https://www.perplexity.ai/";
const pad = (n: number) => String(n).padStart(12, "0");
const threadId = (n: number) => `cccccccc-0000-4000-8000-${pad(n)}`;
const threadSlug = (n: number) => `bbbbbbbb-0000-4000-8000-${pad(n)}`;
const entryId = (n: number) => `eeeeeeee-0000-4000-8000-${pad(n)}`;
const stamp = (n: number) =>
	new Date(Date.UTC(2026, 9, 1, 9) + n * 3_600_000).toISOString();

/** One synthetic list item, shaped exactly like the recon's list item. */
function threadItem(
	n: number,
	total: number,
	hasNext: boolean,
): Record<string, unknown> {
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
		last_query_datetime: stamp(n),
		thread_access: 1,
		thread_number: n,
		total_threads: total,
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
				context_uuid: threadId(n),
				query_str: `Synthetic question ${n}?`,
				entry_created_datetime: stamp(n),
				entry_updated_datetime: stamp(n),
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
					threadItem(
						offset + index + 1,
						options.total,
						offset + index + 1 < options.total,
					),
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
		const listCalls = library.requests.filter(
			(request) => request.url.pathname === "/rest/thread/list_ask_threads",
		);
		assert.equal(listCalls.length, 2);
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
		assert.equal(firstConversation?.create_time, stamp(1).slice(0, 19) + "Z");
		assert.equal(firstConversation?.update_time, stamp(1).slice(0, 19) + "Z");
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
		assert.equal(conversationsCursor.total_threads, 3);
		assert.equal(
			conversationsCursor.last_update_time,
			stamp(3).slice(0, 19) + "Z",
		);
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
		assert.equal(skipped?.create_time, stamp(1).slice(0, 19) + "Z");
		const coverage = detailCoverage(second.messages, "messages");
		assert.equal(coverage.covered, 2);
		assert.equal((coverage.optional_skip_keys as string[]).length, 2);
	});
});

test("a thread that fails is a reported gap, not a silent hole", async () => {
	const library = perplexityLibrary({
		total: 2,
		failingSlugs: [threadSlug(1)],
		failStatus: 500,
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

test("a library that reports threads but reads none is a failure", async () => {
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
		await assert.rejects(
			collectPerplexity(h.ctx, { threadDelayMs: 0 }),
			/perplexity_list_unreadable/,
		);
	});
});

test("an empty library is proven empty, with zero records and a null cursor", async () => {
	const serve: typeof fetch = async () => Response.json([]);
	await withBrowser(serve, async () => {
		const h = harness(ALL_STREAMS, page());
		await collectPerplexity(h.ctx, { threadDelayMs: 0 });
		assert.deepEqual(h.records, []);
		assert.deepEqual(h.failures, []);
		assert.equal(detailCoverage(h.messages, "conversations").considered, 0);
		assert.equal(detailCoverage(h.messages, "messages").covered, 0);
		const cursor = stateCursor(h.messages, "conversations");
		assert.equal(cursor.total_threads, null);
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
