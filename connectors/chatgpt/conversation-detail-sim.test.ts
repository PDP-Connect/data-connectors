// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A randomized check of the cursor invariant in `conversation-detail-progress.ts`:
 *
 *   A conversation counts as read for update time T only if this connector
 *   observed exactly (id, T) and its detail read succeeded, or it was released
 *   after three counted failures. Nothing else marks one done.
 *
 * It drives the real `conversations` stream against a simulated upstream whose
 * list has no snapshot. Between and during runs the upstream gets arrivals that
 * tie the newest update time, updates, deletions, and a conversation whose
 * detail never loads. Runs hit failed list pages, 429 storms, and tiny history
 * budgets. After the chaos a few fault-free runs must settle everything.
 *
 * Checked, with a different seed per case:
 *  - at every cursor the connector stores, no (id, T) is done without a
 *    successful read of that id at T or later, or failed reads;
 *  - each version of a conversation is read successfully at most once and its
 *    counts are emitted once;
 *  - after the fault-free runs, every conversation's latest version was read
 *    and its last emitted record carries counts, and the broken one was tried
 *    three times and then left alone.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { EmittedMessage } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { makeRecordingEmit } from "../../packages/polyfill-connectors/src/test-harness.ts";
import { makePagingApi } from "./__fixtures__/paging-conversation-api.ts";
import { NO_DETAIL_WAITS } from "./__fixtures__/empty-conversation-details.ts";
import {
	CONVERSATION_DETAIL_RETRY_LIMIT,
	isDetailDone,
	readDetailProgress,
} from "./conversation-detail-progress.ts";
import {
	ChatGptRecoverableRetryExhaustedError,
	runConversationsAndMessagesStreams as runStreams,
	type StreamDeps,
} from "./index.ts";
import { validateRecord } from "./schemas.ts";
import type {
	ChatGptFetchResult,
	ChatGptNode,
	ConversationListItem,
} from "./types.ts";

const modelSwitch = JSON.parse(
	readFileSync(
		new URL("./__fixtures__/conversation-model-switch.json", import.meta.url),
		"utf8",
	),
) as { mapping: Record<string, ChatGptNode>; current_node: string };

const BASE = Date.parse("2026-04-22T00:00:00Z") / 1000;

/** A small seeded generator, so a failing case can be replayed. */
function seeded(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function detailOk(id: string): ChatGptFetchResult {
	return {
		status: 200,
		json: {
			conversation_id: id,
			title: `Conversation ${id}`,
			create_time: BASE,
			update_time: BASE,
			...modelSwitch,
		},
	};
}

const rateLimited = (): ChatGptRecoverableRetryExhaustedError =>
	new ChatGptRecoverableRetryExhaustedError("429 after retries", {
		class: "rate_limited",
		httpStatus: 429,
	});

interface Sim {
	/** id -> update time, in seconds. */
	upstream: Map<string, number>;
	/** Ids whose detail always answers 422. */
	broken: Set<string>;
	/** `${id}@${t}` -> successful detail reads that returned that version. */
	reads: Map<string, number>;
	/** id -> newest version a detail read returned. */
	readMax: Map<string, number>;
	/** `${id}@${t}` -> counted failures. */
	failures: Map<string, number>;
	/** Every conversations record, in order. */
	records: { id: string; hasCounts: boolean }[];
	clock: number;
	nextId: number;
}

const key = (id: string, t: number): string => `${id}@${t}`;

function listItem(id: string, t: number): ConversationListItem {
	return {
		id,
		title: `Conversation ${id}`,
		create_time: t - 1000,
		update_time: t,
		is_archived: false,
		is_starred: false,
		workspace_id: null,
		current_node: `${id}-m1`,
		gizmo_id: null,
	};
}

function newestFirst(sim: Sim): ConversationListItem[] {
	return [...sim.upstream]
		.sort(([ia, ta], [ib, tb]) => (tb !== ta ? tb - ta : ia < ib ? -1 : 1))
		.map(([id, t]) => listItem(id, t));
}

interface RunFaults {
	/** List page cursors that fail, and how. */
	failedPage: { cursor: number; how: "throw" | "503" } | null;
	/** Chance that any one detail answers 429. */
	rateLimit: number;
	/** Arrivals tying the newest time, added after the first list page. */
	midWalkArrivals: number;
	backfillLimit: number;
}

const CLEAN: RunFaults = {
	failedPage: null,
	rateLimit: 0,
	midWalkArrivals: 0,
	backfillLimit: 200,
};

/**
 * Whether the cursor may call (id, t) done. The connector read that id at t or
 * later, or the id is the broken one and it failed enough times.
 */
function justified(sim: Sim, id: string, t: number): boolean {
	if ((sim.readMax.get(id) ?? Number.NEGATIVE_INFINITY) >= t) return true;
	return (
		sim.broken.has(id) &&
		(sim.failures.get(key(id, t)) ?? 0) >= CONVERSATION_DETAIL_RETRY_LIMIT
	);
}

function assertCursorSound(sim: Sim, cursor: unknown, where: string): void {
	const progress = readDetailProgress(cursor);
	for (const [id, t] of sim.upstream) {
		if (isDetailDone(progress, id, t * 1000)) {
			assert.ok(
				justified(sim, id, t),
				`${where}: ${id} at ${t - BASE}s is marked done without a read`,
			);
		}
	}
}

async function runOnce(
	sim: Sim,
	rnd: () => number,
	state: Record<string, unknown>,
	faults: RunFaults,
	where: string,
): Promise<Record<string, unknown>> {
	let walked = false;
	const api = makePagingApi({
		list: () => newestFirst(sim),
		detail: (id) => {
			const t = sim.upstream.get(id);
			if (t === undefined) return { status: 404, json: null };
			if (rnd() < faults.rateLimit) throw rateLimited();
			if (sim.broken.has(id)) {
				sim.failures.set(key(id, t), (sim.failures.get(key(id, t)) ?? 0) + 1);
				return { status: 422, json: null };
			}
			sim.reads.set(key(id, t), (sim.reads.get(key(id, t)) ?? 0) + 1);
			sim.readMax.set(id, Math.max(sim.readMax.get(id) ?? t, t));
			return detailOk(id);
		},
		onListPage: (cursor) => {
			if (cursor === 30 && !walked) {
				walked = true;
				for (let i = 0; i < faults.midWalkArrivals; i += 1) {
					sim.upstream.set(`c${sim.nextId++}`, sim.clock);
				}
			}
			if (faults.failedPage?.cursor === cursor) {
				if (faults.failedPage.how === "throw") throw rateLimited();
				return { status: 503, json: null };
			}
			return undefined;
		},
	});
	const harness = makeRecordingEmit(validateRecord);
	let last: Record<string, unknown> = state.conversations as Record<
		string,
		unknown
	>;
	const deps: StreamDeps = {
		api,
		sleep: (): Promise<void> => Promise.resolve(),
		emit: (message: EmittedMessage): Promise<void> => {
			if (message.type === "STATE" && message.stream === "conversations") {
				last = message.cursor as Record<string, unknown>;
				assertCursorSound(sim, last, where);
			}
			return harness.emit(message);
		},
		emitRecord: harness.emitRecord,
		progress: (): Promise<void> => Promise.resolve(),
		requested: new Map([["conversations", { name: "conversations" }]]),
	};
	await runStreams(deps, state, {
		detailPacing: NO_DETAIL_WAITS,
		detailBackfillLimit: faults.backfillLimit,
	});
	for (const record of harness.emitted) {
		if (record.stream !== "conversations") continue;
		sim.records.push({
			id: String(record.data.id),
			hasCounts: record.data.model_counts !== null,
		});
	}
	return last === undefined ? {} : { conversations: last };
}

function between(rnd: () => number, low: number, high: number): number {
	return low + Math.floor(rnd() * (high - low + 1));
}

/** What happens upstream between two runs. */
function churn(sim: Sim, rnd: () => number): void {
	if (rnd() < 0.6) sim.clock += between(rnd, 1, 3);
	for (let i = between(rnd, 0, 3); i > 0; i -= 1) {
		const id = `c${sim.nextId++}`;
		sim.upstream.set(id, sim.clock);
		if (rnd() < 0.08 && sim.broken.size === 0) sim.broken.add(id);
	}
	const ids = [...sim.upstream.keys()];
	for (let i = between(rnd, 0, 2); i > 0 && ids.length > 0; i -= 1) {
		const id = ids[between(rnd, 0, ids.length - 1)];
		if (id !== undefined) sim.upstream.set(id, sim.clock);
	}
	if (rnd() < 0.15 && ids.length > 0) {
		const id = ids[between(rnd, 0, ids.length - 1)];
		if (id !== undefined) sim.upstream.delete(id);
	}
}

function randomFaults(rnd: () => number): RunFaults {
	const roll = rnd();
	return {
		failedPage:
			rnd() < 0.3
				? {
						cursor: [0, 30, 60][between(rnd, 0, 2)] ?? 0,
						how: rnd() < 0.5 ? "throw" : "503",
					}
				: null,
		rateLimit: roll < 0.4 ? 0 : roll < 0.8 ? 0.3 : 1,
		midWalkArrivals: rnd() < 0.3 ? between(rnd, 1, 2) : 0,
		backfillLimit: [1, 3, 10, 200][between(rnd, 0, 3)] ?? 200,
	};
}

function newSim(rnd: () => number): Sim {
	const sim: Sim = {
		upstream: new Map(),
		broken: new Set(),
		reads: new Map(),
		readMax: new Map(),
		failures: new Map(),
		records: [],
		clock: BASE + 20,
		nextId: 0,
	};
	// Ten distinct times for up to 60 rows: ties everywhere.
	for (let i = between(rnd, 5, 60); i > 0; i -= 1) {
		sim.upstream.set(`c${sim.nextId++}`, BASE + between(rnd, 0, 9));
	}
	return sim;
}

/** Run `step` for each index in order, one after another. */
async function inOrder(
	count: number,
	step: (index: number) => Promise<void>,
	from = 0,
): Promise<void> {
	if (from >= count) return;
	await step(from);
	await inOrder(count, step, from + 1);
}

async function simulate(seed: number, legacyStart: boolean): Promise<void> {
	const rnd = seeded(seed);
	const sim = newSim(rnd);
	const label = `seed ${seed}${legacyStart ? " (legacy start)" : ""}`;
	let state: Record<string, unknown> = {};
	if (legacyStart) {
		// The published cursor: a watermark, no detail progress.
		const newest = Math.max(...sim.upstream.values());
		state = {
			conversations: {
				last_update_time: new Date(newest * 1000).toISOString(),
			},
		};
	}

	await inOrder(25, async (run) => {
		churn(sim, rnd);
		state = await runOnce(
			sim,
			rnd,
			state,
			randomFaults(rnd),
			`${label} run ${run}`,
		);
	});

	// Fault-free runs: nothing else changes, so these must settle every row.
	let quiet = 0;
	await inOrder(40, async (run) => {
		if (quiet >= 2) return;
		const before = [...sim.reads.values()].reduce((a, b) => a + b, 0);
		const failuresBefore = [...sim.failures.values()].reduce(
			(a, b) => a + b,
			0,
		);
		state = await runOnce(sim, rnd, state, CLEAN, `${label} settle ${run}`);
		const after = [...sim.reads.values()].reduce((a, b) => a + b, 0);
		const failuresAfter = [...sim.failures.values()].reduce((a, b) => a + b, 0);
		quiet =
			after === before && failuresAfter === failuresBefore ? quiet + 1 : 0;
	});
	assert.ok(quiet >= 2, `${label}: the fault-free runs settled`);

	for (const [versionKey, count] of sim.reads) {
		assert.equal(count, 1, `${label}: ${versionKey} was read ${count} times`);
	}
	for (const [id, t] of sim.upstream) {
		if (sim.broken.has(id)) {
			assert.equal(
				sim.failures.get(key(id, t)),
				CONVERSATION_DETAIL_RETRY_LIMIT,
				`${label}: ${id} is tried three times, then left alone`,
			);
			continue;
		}
		assert.ok(
			(sim.readMax.get(id) ?? Number.NEGATIVE_INFINITY) >= t,
			`${label}: the latest version of ${id} was never read`,
		);
		const last = sim.records.findLast((record) => record.id === id);
		assert.equal(
			last?.hasCounts,
			true,
			`${label}: the last record for ${id} has counts`,
		);
	}
	const withCounts = new Map<string, number>();
	for (const record of sim.records) {
		if (record.hasCounts) {
			withCounts.set(record.id, (withCounts.get(record.id) ?? 0) + 1);
		}
	}
	const readsById = new Map<string, number>();
	for (const [versionKey, count] of sim.reads) {
		const id = versionKey.slice(0, versionKey.indexOf("@"));
		readsById.set(id, (readsById.get(id) ?? 0) + count);
	}
	for (const [id, count] of readsById) {
		assert.equal(
			withCounts.get(id) ?? 0,
			count,
			`${label}: ${id} is emitted with counts once per version it read`,
		);
	}
}

test("conversation detail progress: over arrivals, ties, updates, page failures and 429s, every latest version is read and emitted once and nothing is done unread", async () => {
	await inOrder(40, (seed) => simulate(1000 + seed, false));
});

test("conversation detail progress: the same holds from a cursor in the published shape", async () => {
	await inOrder(20, (seed) => simulate(5000 + seed, true));
});
