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
import { mock, type TestContext, test } from "node:test";
import type { Page } from "playwright";
import { makeRecordingEmit } from "../../packages/polyfill-connectors/src/test-harness.ts";
import {
	CONVERSATION_SEARCH_PREFETCH_PAGES,
	type ChatGptPreDetailPressure,
	ChatGptRunBudget,
	createChatGptApi,
	resolveChatGptProviderBudget,
	runConversationsAndMessagesStreams,
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

interface SimResult {
	listingMs: number;
	detailMs: number;
	conversations: number;
	gaps: number;
	peakBatchesInFlight: number;
	peakSearchesInFlight: number;
	batchStarts: { atMs: number; inFlight: number }[];
	throttled: number;
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
		assert.ok(Date.now() < 3_600_000, "the simulated run ends within an hour");
	}
	const settled = outcome as
		| { ok: true; value: T }
		| { ok: false; error: unknown };
	if (!settled.ok) throw settled.error;
	return settled.value;
}

async function simulate(
	batchMaxParallelism: number,
	throttle?: Throttle,
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
			if (
				throttle &&
				now >= throttle.fromMs &&
				now < throttle.untilMs &&
				!path.startsWith("/conversations/search")
			) {
				throttled += 1;
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
		onUnlanedRateLimited: () => {
			preDetailPressure.rateLimited += 1;
		},
		providerBudget,
	});
	const deps: StreamDeps = {
		api,
		sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
		emit: harness.emit,
		emitRecord: async (stream, data, options) => {
			if (stream === "conversations") {
				await new Promise((resolve) => setTimeout(resolve, PROCESS_MS));
			}
			return harness.emitRecord(stream, data, options);
		},
		preDetailPressure,
		conversationSearchPrefetchPages: CONVERSATION_SEARCH_PREFETCH_PAGES,
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
			throttled,
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
	const result = await simulate(4, throttle);
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
	// Nothing was sent into the window faster than the clean run sends.
	const clean = await simulate(4);
	assert.ok(result.detailMs > clean.detailMs, "the throttle cost time");
});
