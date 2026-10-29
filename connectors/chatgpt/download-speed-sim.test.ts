// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * First-connect download speed on a fake clock. A 3,100-conversation account
 * answers search pages in 900 ms and 10-id batch requests in 3,000 ms, the
 * phone's measured latencies, and writing each conversation's records takes
 * 40 ms. The run uses the production pieces the phone
 * uses: createChatGptApi (retries, Retry-After, provider admission), the
 * default provider budget and pacing, six-page search prefetch and the detail
 * lane. Only time is fake, so every wait is exact and the result is the same
 * on every run.
 *
 * The bar is the reference connector (v4): six search pages in flight, then
 * waves of 2 rising to 4 batch requests with 200 ms pacing halved per clean
 * wave. Its detail time on the same latencies is computed below.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mock, type TestContext, test } from "node:test";
import type { Page } from "playwright";
import { makeRecordingEmit } from "../../packages/polyfill-connectors/src/test-harness.ts";
import {
	CONVERSATION_SEARCH_PREFETCH_PAGES,
	type ChatGptPreDetailPressure,
	ChatGptRunBudget,
	createChatGptApi,
	recordChatGptUnlanedRateLimit,
	resolveChatGptProviderBudget,
	runConversationsAndMessagesStreams,
	runMessagesAndConversationsWithDetail,
	type StreamDeps,
} from "./index.ts";
import { validateRecord } from "./schemas.ts";

const CONVERSATIONS = 3100;
const SEARCH_MS = 900;
const BATCH_MS = 3000;
const SINGLE_MS = 900;
// Writing one conversation's records on the phone: progress in the phone
// logs arrives 25 conversations about a second apart.
const PROCESS_MS = 40;
const PAGE = 30;
// Phone runs saw 29-row pages with no continuation at these cursors.
const SHORT_PAGES = new Set([120, 420, 1710]);

interface Throttle {
	fromMs: number;
	untilMs: number;
	retryAfterSeconds?: number;
}

interface SimOptions {
	throttle?: Throttle;
	// No batch endpoint and no search read-ahead: every request alone.
	oneAtATime?: boolean;
}

interface SimResult {
	listingMs: number;
	detailMs: number;
	conversations: number;
	gaps: number;
	peakBatchesInFlight: number;
	peakSearchesInFlight: number;
	batchStarts: { atMs: number; inFlight: number }[];
	// Every batch POST sent, including those answered with 429. A retry
	// sends the same conversation ids again.
	batchPosts: { atMs: number; ids: string; retry: boolean }[];
	// From each 429 answer on a batch POST to the end of its Retry-After.
	cooldowns: { ids: string; fromMs: number; untilMs: number }[];
	throttled: number;
	// Each emitted record as JSON, sorted by stream and record id.
	records: string[];
}

function conversation(index: number) {
	return {
		id: `c-${index}`,
		title: `Conversation ${index}`,
		create_time: 1_700_000_000,
		update_time: 1_800_000_000 - index,
		current_node: "a1",
	};
}

function detail(id: string, index: number) {
	return {
		...conversation(index),
		id,
		mapping: {
			root: { parent: null, children: ["u1"] },
			u1: {
				parent: "root",
				children: ["a1"],
				message: {
					author: { role: "user" },
					create_time: 1_700_000_000,
					content: { content_type: "text", parts: ["hello"] },
				},
			},
			a1: {
				parent: "u1",
				children: [],
				message: {
					author: { role: "assistant" },
					create_time: 1_700_000_001,
					end_turn: true,
					content: { content_type: "text", parts: ["hi there"] },
				},
			},
		},
	};
}

function searchPage(cursor: number, read: number) {
	if (cursor >= CONVERSATIONS) return { items: [] };
	if (SHORT_PAGES.has(cursor)) {
		// Each read misses one row; together the reads cover the page.
		const offset = read % 2;
		return {
			items: Array.from({ length: PAGE - 1 }, (_, i) =>
				conversation(cursor + offset + i),
			),
		};
	}
	const count = Math.min(PAGE, CONVERSATIONS - cursor);
	return {
		items: Array.from({ length: count }, (_, i) => conversation(cursor + i)),
		next_cursor: count < PAGE ? null : cursor + PAGE,
	};
}

/** Runs the async work to completion, advancing fake time in small steps. */
async function onFakeClock<T>(work: () => Promise<T>): Promise<T> {
	let outcome: { ok: true; value: T } | { ok: false; error: unknown } | null =
		null;
	work().then(
		(value) => {
			outcome = { ok: true, value };
		},
		(error: unknown) => {
			outcome = { ok: false, error };
		},
	);
	while (outcome === null) {
		await new Promise((resolve) => setImmediate(resolve));
		if (outcome !== null) break;
		mock.timers.tick(10);
		assert.ok(
			Date.now() < 7_200_000,
			"the simulated run ends within two hours",
		);
	}
	const settled = outcome as
		| { ok: true; value: T }
		| { ok: false; error: unknown };
	if (!settled.ok) throw settled.error;
	return settled.value;
}

async function simulate(
	batchMaxParallelism: number,
	{ throttle, oneAtATime = false }: SimOptions = {},
): Promise<SimResult> {
	// Before anything reads the clock: the pacer keeps the Date.now it sees.
	mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
	const reads = new Map<number, number>();
	let searchesInFlight = 0;
	let peakSearchesInFlight = 0;
	let batchesInFlight = 0;
	let peakBatchesInFlight = 0;
	let lastSearchDoneAt = 0;
	let throttled = 0;
	const batchStarts: SimResult["batchStarts"] = [];
	const batchPosts: SimResult["batchPosts"] = [];
	const batchIdsSent = new Set<string>();
	const cooldowns: SimResult["cooldowns"] = [];
	const respondAfter = <T>(ms: number, value: () => T): Promise<T> =>
		new Promise((resolve) => setTimeout(() => resolve(value()), ms));
	const page = {
		evaluate: (fn: unknown, arg?: unknown) => {
			if (arg === undefined) {
				return Promise.resolve(
					typeof fn === "function"
						? "https://chatgpt.com/"
						: { accessToken: "fixture", deviceId: "fixture" },
				);
			}
			const { path, body } = arg as {
				path: string;
				body?: { conversation_ids?: string[] };
			};
			const now = Date.now();
			if (path === "/conversations/batch") {
				const key = (body?.conversation_ids ?? []).join(",");
				batchPosts.push({ atMs: now, ids: key, retry: batchIdsSent.has(key) });
				batchIdsSent.add(key);
			}
			if (
				throttle &&
				now >= throttle.fromMs &&
				now < throttle.untilMs &&
				!path.startsWith("/conversations/search")
			) {
				throttled += 1;
				if (
					path === "/conversations/batch" &&
					throttle.retryAfterSeconds !== undefined
				) {
					cooldowns.push({
						ids: (body?.conversation_ids ?? []).join(","),
						fromMs: now + SINGLE_MS,
						untilMs: now + SINGLE_MS + throttle.retryAfterSeconds * 1000,
					});
				}
				return respondAfter(SINGLE_MS, () => ({
					status: 429,
					json: null,
					...(throttle.retryAfterSeconds === undefined
						? {}
						: {
								headers: {
									"retry-after": String(throttle.retryAfterSeconds),
								},
							}),
				}));
			}
			if (path.startsWith("/conversations/search")) {
				const cursor = Number(
					new URLSearchParams(path.split("?")[1]).get("cursor"),
				);
				const read = reads.get(cursor) ?? 0;
				reads.set(cursor, read + 1);
				searchesInFlight += 1;
				peakSearchesInFlight = Math.max(peakSearchesInFlight, searchesInFlight);
				return respondAfter(SEARCH_MS, () => {
					searchesInFlight -= 1;
					lastSearchDoneAt = Date.now();
					return { status: 200, json: searchPage(cursor, read) };
				});
			}
			if (path === "/conversations/batch") {
				const ids = body?.conversation_ids ?? [];
				batchesInFlight += 1;
				peakBatchesInFlight = Math.max(peakBatchesInFlight, batchesInFlight);
				batchStarts.push({ atMs: now, inFlight: batchesInFlight });
				return respondAfter(BATCH_MS, () => {
					batchesInFlight -= 1;
					return {
						status: 200,
						json: ids.map((id) => detail(id, Number(id.slice(2)))),
					};
				});
			}
			const single = /^\/conversation\/(c-\d+)$/.exec(path);
			if (single?.[1]) {
				const id = single[1];
				return respondAfter(SINGLE_MS, () => ({
					status: 200,
					json: detail(id, Number(id.slice(2))),
				}));
			}
			return respondAfter(SEARCH_MS, () => ({ status: 404, json: null }));
		},
		goto: () => Promise.resolve(null),
		waitForFunction: () => Promise.reject(new Error("unused")),
	};
	const harness = makeRecordingEmit(validateRecord);
	const preDetailPressure: ChatGptPreDetailPressure = { rateLimited: 0 };
	const providerBudget = resolveChatGptProviderBudget({});
	const api = createChatGptApi({
		page: page as unknown as Page,
		capture: null,
		emit: harness.emit,
		onUnlanedRateLimited: (retryAfterWaitMs) =>
			recordChatGptUnlanedRateLimit(preDetailPressure, retryAfterWaitMs),
		providerBudget,
	});
	const { fetchBatch: _batchEndpoint, ...withoutBatch } = api;
	const deps: StreamDeps = {
		api: oneAtATime ? withoutBatch : api,
		sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
		emit: harness.emit,
		emitRecord: async (stream, data, options) => {
			if (stream === "conversations") {
				await new Promise((resolve) => setTimeout(resolve, PROCESS_MS));
			}
			return harness.emitRecord(stream, data, options);
		},
		preDetailPressure,
		conversationSearchPrefetchPages: oneAtATime
			? 1
			: CONVERSATION_SEARCH_PREFETCH_PAGES,
		progress: () => Promise.resolve(),
		providerBudget,
		requested: new Map(
			["conversations", "messages"].map((name) => [name, { name }]),
		),
		runBudget: new ChatGptRunBudget({
			maxFetches: Number.POSITIVE_INFINITY,
			maxWallClockMs: Number.POSITIVE_INFINITY,
		}),
	};
	const random = Math.random;
	let seed = 7;
	Math.random = () => {
		seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
		return seed / 2_147_483_648;
	};
	try {
		await onFakeClock(() =>
			runConversationsAndMessagesStreams(
				deps,
				{},
				{
					detailPacing: { batchMaxParallelism },
				},
			),
		);
		const endedAt = Date.now();
		const ids = new Set(
			harness.emitted
				.filter((record) => record.stream === "conversations")
				.map((record) => record.data.id),
		);
		return {
			listingMs: lastSearchDoneAt,
			detailMs: endedAt - lastSearchDoneAt,
			conversations: ids.size,
			gaps: harness.protocolMessages.filter(
				(message) => message.type === "DETAIL_GAP",
			).length,
			peakBatchesInFlight,
			peakSearchesInFlight,
			batchStarts,
			batchPosts,
			cooldowns,
			throttled,
			records: harness.emitted
				.map((record) => ({
					key: `${record.stream} ${String(record.data.id)}`,
					json: JSON.stringify(record),
				}))
				.sort((a, b) =>
					a.key === b.key
						? a.json.localeCompare(b.json)
						: a.key.localeCompare(b.key),
				)
				.map((record) => record.json),
		};
	} finally {
		mock.timers.reset();
		Math.random = random;
	}
}

/** The reference connector's detail time on the same latencies. */
function referenceDetailMs(): number {
	let remaining = CONVERSATIONS;
	let parallelism = 2;
	let paceMs = 200;
	let healthy = 0;
	let elapsed = 0;
	while (remaining > 0) {
		remaining -= Math.min(remaining, parallelism * 10);
		elapsed += BATCH_MS;
		healthy += 1;
		if (healthy >= 2 && parallelism < 4) {
			parallelism += 1;
			healthy = 0;
		}
		paceMs = Math.floor(paceMs / 2);
		// Its jitter adds 0-100 ms more per paced wave; left out, so the bar
		// is the fastest it can be.
		elapsed += paceMs;
	}
	return elapsed;
}

function report(t: TestContext, label: string, result: SimResult): void {
	t.diagnostic(
		`${label}: listing ${(result.listingMs / 1000).toFixed(1)} s, detail ${(result.detailMs / 1000).toFixed(1)} s, ${result.conversations} conversations, peak ${result.peakSearchesInFlight} searches and ${result.peakBatchesInFlight} batches in flight`,
	);
}

test("a 3,100-conversation first connect keeps pace with the reference at K=4 and is faster at K=8", async (t) => {
	const reference = referenceDetailMs();
	t.diagnostic(`reference detail time ${(reference / 1000).toFixed(1)} s`);
	const k4 = await simulate(4);
	report(t, "K=4", k4);
	const k8 = await simulate(8);
	report(t, "K=8", k8);
	for (const result of [k4, k8]) {
		assert.equal(result.conversations, CONVERSATIONS);
		assert.equal(result.gaps, 0);
		assert.equal(
			result.peakSearchesInFlight,
			CONVERSATION_SEARCH_PREFETCH_PAGES,
		);
		// 104 pages six at a time is about 16 s. The walk adds three lone reads
		// of each short page 400 ms apart, the end probe and the checks after
		// the walk. One page at a time it is over 100 s.
		assert.ok(result.listingMs <= 35_000, `listing ${result.listingMs} ms`);
	}
	assert.equal(k4.peakBatchesInFlight, 4);
	assert.equal(k8.peakBatchesInFlight, 8);
	// Pacing is charged per request, at most one per 250 ms, so a round of
	// four requests spreads over 750 ms where the reference sends them
	// together. The cold pacer also waits one 1,000 ms interval before each
	// of the first two requests, and the last batch's ten conversations are
	// written after it arrives. Nothing else may be slower.
	assert.ok(
		k4.detailMs <= reference + 3 * 250 + 2 * 1000 + 10 * PROCESS_MS,
		`K=4 detail ${k4.detailMs} ms against the reference ${reference} ms`,
	);
	assert.ok(
		k8.detailMs < k4.detailMs * 0.75,
		`K=8 detail ${k8.detailMs} ms is not clearly faster than K=4 ${k4.detailMs} ms`,
	);
});

test("served 429s during the download back off to one request in flight and the run still completes", async (t) => {
	const throttle = { fromMs: 60_000, untilMs: 75_000, retryAfterSeconds: 5 };
	const result = await simulate(4, { throttle });
	report(t, "429 window 60-75 s", result);
	assert.ok(result.throttled > 0, "the throttle window was hit");
	assert.equal(result.conversations, CONVERSATIONS);
	assert.equal(result.gaps, 0);
	// The first request after the throttle starts alone.
	const after = result.batchStarts.filter(
		(start) => start.atMs >= throttle.untilMs,
	);
	assert.equal(after[0]?.inFlight, 1);
	assert.ok(
		after.some((start) => start.inFlight > 1),
		"concurrency ramps up again after the throttle",
	);
	// No new batch request starts while a server Retry-After wait runs, and
	// a throttled request retries only after its own wait ends.
	assert.ok(result.cooldowns.length > 0, "a batch request was throttled");
	const inCooldown = (atMs: number, cooldown: SimResult["cooldowns"][number]) =>
		atMs > cooldown.fromMs && atMs < cooldown.untilMs;
	assert.deepEqual(
		result.batchPosts
			.filter(
				(post) =>
					!post.retry &&
					result.cooldowns.some((cooldown) => inCooldown(post.atMs, cooldown)),
			)
			.map((post) => post.atMs),
		[],
		"new batch requests sent during a Retry-After wait",
	);
	assert.deepEqual(
		result.batchPosts
			.filter(
				(post) =>
					post.retry &&
					result.cooldowns.some(
						(cooldown) =>
							cooldown.ids === post.ids && inCooldown(post.atMs, cooldown),
					),
			)
			.map((post) => post.atMs),
		[],
		"retries sent before their own Retry-After ended",
	);
	const clean = await simulate(4);
	assert.ok(result.detailMs > clean.detailMs, "the throttle cost time");
});

test("the overlapped download writes the same records as one request at a time", async (t) => {
	const overlapped = await simulate(4);
	const alone = await simulate(4, { oneAtATime: true });
	report(t, "one at a time", alone);
	assert.equal(alone.peakBatchesInFlight, 0);
	assert.equal(alone.peakSearchesInFlight, 1);
	assert.equal(alone.gaps, 0);
	assert.equal(overlapped.gaps, 0);
	// Each record is written once.
	assert.equal(new Set(overlapped.records).size, overlapped.records.length);
	assert.equal(overlapped.records.length, alone.records.length);
	// Compare every record's bytes in key order; report the first difference.
	const firstDifference = overlapped.records.findIndex(
		(record, index) => record !== alone.records[index],
	);
	assert.equal(
		firstDifference,
		-1,
		`first differing record: ${overlapped.records[firstDifference]} against ${alone.records[firstDifference]}`,
	);
	t.diagnostic(
		`${overlapped.records.length} records identical, sha256 ${createHash("sha256").update(overlapped.records.join("\n")).digest("hex")}`,
	);
});

type BatchPost = { atMs: number; first: string; retry: boolean };
type RetryAfterWindow = { fromMs: number; untilMs: number };

/**
 * A detail pass against a fake page whose batch endpoint answers each POST
 * after `answer(post).delayMs`, with a 429 and Retry-After when
 * `retryAfterS` is set. Records every POST and every Retry-After window.
 */
function batchEndpointPass(
	answer: (post: BatchPost) => { delayMs: number; retryAfterS?: number },
) {
	const posts: BatchPost[] = [];
	const windows: RetryAfterWindow[] = [];
	const page = {
		evaluate: (fn: unknown, arg?: unknown) => {
			if (arg === undefined) {
				return Promise.resolve(
					typeof fn === "function"
						? "https://chatgpt.com/"
						: { accessToken: "fixture", deviceId: "fixture" },
				);
			}
			const ids =
				(arg as { body?: { conversation_ids?: string[] } }).body
					?.conversation_ids ?? [];
			const first = ids[0] ?? "";
			const post = {
				atMs: Date.now(),
				first,
				retry: posts.some((earlier) => earlier.first === first),
			};
			posts.push(post);
			const { delayMs, retryAfterS } = answer(post);
			return new Promise((resolve) =>
				setTimeout(() => {
					if (retryAfterS === undefined) {
						resolve({
							status: 200,
							json: ids.map((id) => detail(id, Number(id.slice(2)))),
						});
						return;
					}
					windows.push({
						fromMs: Date.now(),
						untilMs: Date.now() + retryAfterS * 1000,
					});
					resolve({
						status: 429,
						json: null,
						headers: { "retry-after": String(retryAfterS) },
					});
				}, delayMs),
			);
		},
		goto: () => Promise.resolve(null),
		waitForFunction: () => Promise.reject(new Error("unused")),
	};
	const harness = makeRecordingEmit(validateRecord);
	const gapsAtMs: number[] = [];
	const preDetailPressure: ChatGptPreDetailPressure = { rateLimited: 0 };
	const providerBudget = resolveChatGptProviderBudget({});
	const api = createChatGptApi({
		page: page as unknown as Page,
		capture: null,
		emit: harness.emit,
		onUnlanedRateLimited: (retryAfterWaitMs) =>
			recordChatGptUnlanedRateLimit(preDetailPressure, retryAfterWaitMs),
		providerBudget,
	});
	const deps: StreamDeps = {
		api,
		emit: (message) => {
			if (message.type === "DETAIL_GAP") gapsAtMs.push(Date.now());
			return harness.emit(message);
		},
		emitRecord: harness.emitRecord,
		preDetailPressure,
		progress: () => Promise.resolve(),
		providerBudget,
		requested: new Map(
			["conversations", "messages"].map((name) => [name, { name }]),
		),
	};
	/** A list request outside the detail lane is served a 429 at `atMs`. */
	function listRequestThrottledAt(atMs: number, waitMs: number): void {
		setTimeout(() => {
			windows.push({ fromMs: Date.now(), untilMs: Date.now() + waitMs });
			recordChatGptUnlanedRateLimit(preDetailPressure, waitMs);
		}, atMs);
	}
	/** New batch requests (not retries) sent inside a Retry-After window. */
	function postsInsideRetryAfter(): BatchPost[] {
		return posts.filter(
			(post) =>
				!post.retry &&
				windows.some(
					(window) => post.atMs > window.fromMs && post.atMs < window.untilMs,
				),
		);
	}
	return {
		deps,
		gapsAtMs,
		listRequestThrottledAt,
		posts,
		postsInsideRetryAfter,
		windows,
	};
}

/** The first attempt of chunk c-0 gets a 429 with Retry-After: 5 after 1.5 s. */
function throttleFirstChunkOnce(post: BatchPost): {
	delayMs: number;
	retryAfterS?: number;
} {
	return post.first === "c-0" && !post.retry
		? { delayMs: 1500, retryAfterS: 5 }
		: { delayMs: 50 };
}

test("a batch request waiting for its pacing turn does not start during another request's Retry-After wait", async () => {
	mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
	try {
		// The other chunks are answered at once, so the pump starts the next
		// chunk while the first one is still out.
		const pass = batchEndpointPass(throttleFirstChunkOnce);
		let written = 0;
		await onFakeClock(() =>
			runMessagesAndConversationsWithDetail(
				pass.deps,
				Array.from({ length: 40 }, (_, index) => conversation(index)),
				async () => {
					written += 1;
				},
				{ batchMaxParallelism: 4, random: () => 0 },
			),
		);
		assert.equal(written, 40);
		assert.equal(pass.windows.length, 1, "the first chunk was throttled once");
		const [window] = pass.windows;
		assert.ok(
			pass.posts.some(
				(post) => post.first !== "c-0" && post.atMs < (window?.fromMs ?? 0),
			),
			"another chunk was sent while the first one was out",
		);
		assert.deepEqual(
			pass.postsInsideRetryAfter(),
			[],
			"batch requests sent during the Retry-After wait",
		);
	} finally {
		mock.timers.reset();
	}
});

test("a batch request waits out a Retry-After wait that is extended while it waits", async () => {
	mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
	try {
		const pass = batchEndpointPass(throttleFirstChunkOnce);
		// The first chunk's 429 at 2.5 s sets a wait until 7.5 s. A list
		// request's 429 at 3 s extends it to 10 s while a queued batch request
		// sleeps toward 7.5 s, and another at 9 s extends it to 14 s while that
		// request sleeps toward 10 s.
		pass.listRequestThrottledAt(3000, 7000);
		pass.listRequestThrottledAt(9000, 5000);
		let written = 0;
		await onFakeClock(() =>
			runMessagesAndConversationsWithDetail(
				pass.deps,
				Array.from({ length: 40 }, (_, index) => conversation(index)),
				async () => {
					written += 1;
				},
				{ batchMaxParallelism: 4, random: () => 0 },
			),
		);
		assert.equal(written, 40);
		assert.equal(pass.windows.length, 3);
		assert.deepEqual(
			pass.postsInsideRetryAfter(),
			[],
			"batch requests sent during an extended Retry-After wait",
		);
	} finally {
		mock.timers.reset();
	}
});

test("no batch request starts after the detail pass defers its tail", async () => {
	mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
	try {
		const pass = batchEndpointPass(throttleFirstChunkOnce);
		// A list request's 429 at 2.2 s holds queued batch requests, chunk c-20
		// among them, until 32.2 s. The run's wall-clock budget runs out at 4 s,
		// and the lane defers the tail when the first chunk's retry comes back
		// at 7.5 s.
		pass.listRequestThrottledAt(2200, 30_000);
		const runBudget = new ChatGptRunBudget({
			maxWallClockMs: 4000,
			now: () => Date.now(),
		});
		let written = 0;
		await onFakeClock(() =>
			runMessagesAndConversationsWithDetail(
				pass.deps,
				Array.from({ length: 40 }, (_, index) => conversation(index)),
				async () => {
					written += 1;
				},
				{ batchMaxParallelism: 4, random: () => 0, runBudget },
			),
		);
		const returnedAtMs = Date.now();
		// Let any batch request left behind by the pass run.
		await onFakeClock(
			() => new Promise<void>((resolve) => setTimeout(resolve, 60_000)),
		);
		const [deferredAtMs] = pass.gapsAtMs;
		assert.ok(deferredAtMs !== undefined, "the pass deferred its tail");
		assert.ok(written < 40, "the pass stopped before the end");
		assert.deepEqual(
			pass.posts.filter((post) => post.atMs >= deferredAtMs),
			[],
			"batch requests sent after the tail was deferred",
		);
		assert.ok(
			pass.posts.every((post) => post.atMs <= returnedAtMs),
			"batch requests sent after the pass returned",
		);
		assert.ok(
			returnedAtMs < 32_200,
			"the pass returned without waiting out the queued request's wait",
		);
	} finally {
		mock.timers.reset();
	}
});
