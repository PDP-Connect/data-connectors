// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Prefetched conversation search must decide exactly what the in-order walk
 * decides. Every fixture here runs twice through the real
 * runConversationsAndMessagesStreams: once in order (prefetch width 1, the
 * walk from #250) and once at the production width. A fixture answers each
 * request from (path, how many times that path was asked before), the shape
 * of the recorded provider pages, and settles requests in a seeded random
 * order. Records and protocol messages must match exactly. The only extra
 * requests allowed are one first read of a cursor the in-order walk never
 * asked for, up to three first-page reads (and two 400 ms waits) for the
 * check after the walk, one more read of each page that stayed short, up to
 * two more reads of a cursor whose prefetched read failed, and one more of a
 * cursor whose first answer leaves the grid.
 *
 * A second group changes the list while requests are in flight, which the
 * per-path fixtures cannot express: rows arrive at the top or move to it.
 * A complete result must contain every row that stayed in place, and a row
 * that arrived or moved must be collected or newer than the saved watermark.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { EmittedMessage } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { ProviderBudgetController } from "../../packages/polyfill-connectors/src/provider-budget.ts";
import {
	type EmittedRecord,
	makeRecordingEmit,
} from "../../packages/polyfill-connectors/src/test-harness.ts";
import {
	runConversationsAndMessagesStreams,
	type StreamDeps,
} from "./index.ts";
import { validateRecord } from "./schemas.ts";
import type { ChatGptApi, ChatGptFetchResult } from "./types.ts";

const PRODUCTION_WIDTH = 6;
const SEARCH_PREFIX = "/conversations/search?query=&cursor=";

type Page = { items: unknown[]; next_cursor?: number | null } | "503" | "null";
/** Responses per cursor; the k-th read of a cursor gets entry min(k, last). */
type Pages = ReadonlyMap<number, readonly Page[]>;

function convo(
	id: string,
	updateTime = 1_700_000_100,
): Record<string, unknown> {
	return {
		id,
		title: "Fixture",
		create_time: 1_700_000_000,
		update_time: updateTime,
		current_node: "a1",
	};
}

function range(
	prefix: string,
	from: number,
	count: number,
	time?: (index: number) => number,
): Record<string, unknown>[] {
	return Array.from({ length: count }, (_, offset) =>
		convo(`${prefix}-${from + offset}`, time?.(from + offset)),
	);
}

function cursorOf(path: string): number {
	return Number(new URLSearchParams(path.split("?")[1]).get("cursor"));
}

function seededRandom(seed: number): () => number {
	let state = seed >>> 0 || 1;
	return () => {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		return (state >>> 0) / 4_294_967_296;
	};
}

function respond(page: Page | undefined): ChatGptFetchResult {
	if (page === "503") return { status: 503, json: null };
	if (page === "null") return { status: 200, json: null };
	const { items, next_cursor } = page ?? { items: [] };
	return {
		status: 200,
		json: { items, ...(next_cursor === undefined ? {} : { next_cursor }) },
	};
}

interface Outcome {
	delays: number[];
	messages: EmittedMessage[];
	paths: string[];
	records: EmittedRecord[];
	state: Record<string, unknown> | undefined;
}

async function runFixture(
	pages: Pages,
	width: number,
	seed: number,
	state: Record<string, unknown> = {},
): Promise<Outcome> {
	const harness = makeRecordingEmit(validateRecord);
	const random = seededRandom(seed);
	const reads = new Map<number, number>();
	const paths: string[] = [];
	const delays: number[] = [];
	const api: ChatGptApi = {
		auth: () => Promise.reject(new Error("auth unused")),
		fetch: async (path) => {
			paths.push(path);
			if (!path.startsWith(SEARCH_PREFIX)) return { status: 404, json: null };
			const cursor = cursorOf(path);
			const read = reads.get(cursor) ?? 0;
			reads.set(cursor, read + 1);
			const responses = pages.get(cursor);
			const response = respond(
				responses?.[Math.min(read, (responses?.length ?? 1) - 1)],
			);
			// Settle in a seeded random order, as concurrent requests do.
			await new Promise((resolve) => setTimeout(resolve, random() * 3));
			return response;
		},
	};
	const deps: StreamDeps = {
		api,
		sleep: (milliseconds) => {
			delays.push(milliseconds);
			return Promise.resolve();
		},
		emit: harness.emit,
		emitRecord: harness.emitRecord,
		progress: () => Promise.resolve(),
		requested: new Map([["conversations", { name: "conversations" }]]),
		conversationSearchPrefetchPages: width,
	};
	await runConversationsAndMessagesStreams(deps, state);
	const stateMessage = harness.protocolMessages.find(
		(message) => message.type === "STATE" && message.stream === "conversations",
	);
	return {
		delays,
		messages: harness.protocolMessages,
		paths,
		records: harness.emitted,
		state:
			stateMessage?.type === "STATE"
				? (stateMessage.cursor as Record<string, unknown>)
				: undefined,
	};
}

function readsByCursor(paths: readonly string[]): Map<number, number> {
	const counts = new Map<number, number>();
	for (const path of paths) {
		const cursor = cursorOf(path);
		counts.set(cursor, (counts.get(cursor) ?? 0) + 1);
	}
	return counts;
}

/** Runs one fixture in order and prefetched, and asserts equal decisions. */
async function assertSameDecisions(
	name: string,
	pages: Pages,
	seed = 1,
	state: Record<string, unknown> = {},
): Promise<{ inOrder: Outcome; prefetched: Outcome }> {
	const inOrder = await runFixture(pages, 1, seed, state);
	const prefetched = await runFixture(pages, PRODUCTION_WIDTH, seed, state);
	assert.deepEqual(prefetched.records, inOrder.records, `${name}: records`);
	assert.deepEqual(prefetched.messages, inOrder.messages, `${name}: messages`);
	// The first-page check adds up to three reads and two waits.
	assert.ok(
		[...inOrder.delays, ...prefetched.delays].every((ms) => ms === 400),
		`${name}: every wait is the 400 ms list retry wait`,
	);
	const extraWaits = prefetched.delays.length - inOrder.delays.length;
	assert.ok(
		extraWaits >= 0 && extraWaits <= 2,
		`${name}: ${extraWaits} extra waits`,
	);
	const before = readsByCursor(inOrder.paths);
	const after = readsByCursor(prefetched.paths);
	for (const [cursor, count] of after) {
		const expected = before.get(cursor) ?? 0;
		const extra = count - expected;
		if (cursor === 0) {
			assert.ok(
				extra >= 0 && extra <= 4,
				`${name}: cursor 0 read ${count} times, in order ${expected}`,
			);
		} else if (expected > 0) {
			// A failed prefetched read is asked again, and again alone if the
			// second read was also sent during a burst. A crowded read that
			// moves the walk off the 30-row grid is asked again alone.
			const first = pages.get(cursor)?.[0];
			const leavesGrid =
				typeof first === "object" &&
				first.next_cursor !== undefined &&
				first.next_cursor !== null &&
				first.next_cursor !== cursor + 30;
			// Any page that stayed short is read once more after the walk.
			const allowed = (first === "503" ? 2 : leavesGrid ? 1 : 0) + 1;
			assert.ok(extra <= allowed, `${name}: cursor ${cursor} was read again`);
		} else {
			assert.equal(count, 1, `${name}: unvisited cursor ${cursor} read once`);
		}
	}
	for (const [cursor, count] of before) {
		assert.ok(
			(after.get(cursor) ?? 0) >= count,
			`${name}: cursor ${cursor} lost reads`,
		);
	}
	return { inOrder, prefetched };
}

function fullPages(
	prefix: string,
	count: number,
	time?: (index: number) => number,
): Map<number, Page[]> {
	const pages = new Map<number, Page[]>();
	for (let cursor = 0; cursor < count; cursor += 30) {
		pages.set(cursor, [
			{
				items: range(prefix, cursor, Math.min(30, count - cursor), time),
				next_cursor: cursor + 30,
			},
		]);
	}
	return pages;
}

test("#250 search fixtures decide the same when pages are prefetched", async () => {
	// cursor search follows a short page and confirms an empty terminal
	await assertSameDecisions(
		"short page then empty terminal",
		new Map<number, Page[]>([
			[0, [{ items: range("a", 0, 30) }]],
			[30, [{ items: range("tail", 0, 4) }]],
			[60, [{ items: [] }]],
		]),
	);
	// an empty cursor page with a continuation is followed
	await assertSameDecisions(
		"empty page with continuation",
		new Map<number, Page[]>([
			[0, [{ items: range("before", 0, 30) }]],
			[30, [{ items: [], next_cursor: 60 }]],
			[60, [{ items: [convo("after-empty")] }]],
		]),
	);
	// a short cursor page followed by more items is complete
	await assertSameDecisions(
		"short page followed by more",
		new Map<number, Page[]>([
			[0, [{ items: range("early", 0, 12) }]],
			[30, [{ items: [convo("later")] }]],
		]),
	);
	// recorded early-end patterns on search cursors (4x30, 3x30+12, 5x30)
	const earlyEnds = [
		[4, 0],
		[3, 12],
		[5, 0],
	] as const;
	const earlyEndRuns = earlyEnds.map(([full, short]) => {
		const pages = fullPages(`recorded-${full}`, full * 30);
		pages.set(full * 30, [
			{ items: range(`short-${full}`, 0, short), next_cursor: full * 30 + 30 },
		]);
		pages.set(full * 30 + 30, [{ items: [convo("recorded-later")] }]);
		return assertSameDecisions(`early end ${full}x30+${short}`, pages);
	});
	await Promise.all(earlyEndRuns);
	// disagreeing short-page retries union ids and follow the cursor
	await assertSameDecisions(
		"disagreeing short retries",
		new Map<number, Page[]>([
			[
				0,
				[
					{ items: [convo("probe-a")] },
					{ items: [convo("probe-b")] },
					{ items: [convo("probe-c")] },
				],
			],
		]),
	);
	// tapped ChatGPT cursor-120 shapes, runs A and B
	const tapped = [
		[
			[120, 27],
			[125, 25],
			[120, 30],
		],
		[
			[120, 28],
			[122, 28],
			[120, 28],
		],
	] as const;
	const tappedRuns = tapped.map(async (attempts) => {
		const pages = fullPages("c", 120);
		pages.set(
			120,
			attempts.map(([start, count]) => ({
				items: range("c", start, count),
				next_cursor: 150,
			})),
		);
		pages.set(150, [{ items: [] }]);
		const { prefetched } = await assertSameDecisions(
			`tapped cursor 120 ${attempts[1][0]}`,
			pages,
		);
		assert.equal(new Set(prefetched.records.map((r) => r.data.id)).size, 150);
	});
	await Promise.all(tappedRuns);
	// round-2 B1: a stable short page with a next cursor, then a shifted grid
	{
		const all = range("b1", 0, 600, (index) => 1_800_000_000 - index);
		const pages = new Map<number, Page[]>();
		for (let cursor = 0; cursor < 390; cursor += 30) {
			pages.set(cursor, [
				{ items: all.slice(cursor, cursor + 30), next_cursor: cursor + 30 },
			]);
		}
		pages.set(390, [{ items: all.slice(390, 400), next_cursor: 420 }]);
		for (let cursor = 420; cursor <= 600; cursor += 30) {
			pages.set(cursor, [
				{
					items: all.slice(cursor - 20, cursor + 10),
					next_cursor: cursor + 30,
				},
			]);
		}
		pages.set(630, [{ items: [] }]);
		const { prefetched } = await assertSameDecisions("B1 grid shift", pages);
		assert.equal(new Set(prefetched.records.map((r) => r.data.id)).size, 600);
	}
});

test("the recorded 2,039-conversation live walk decides the same when prefetched", async () => {
	// Shape of the live proof walk at 180fb83: short first page (16, 14, 20),
	// short mid-list pages at 720, 780, 840, 1410 and 1500, an 8-item tail
	// with no continuation at 2040, then an empty end that is re-probed.
	const total = 2048;
	const time = (index: number) => 1_800_000_000 - index;
	const pages = fullPages("live", 2040, time);
	const shortReads = (cursor: number, counts: readonly number[]): Page[] =>
		// Alternate head and tail windows: the live retries together covered
		// the whole page.
		counts.map((count, read) => ({
			items: range(
				"live",
				cursor + (read % 2 === 0 ? 0 : 30 - count),
				count,
				time,
			),
			next_cursor: cursor + 30,
		}));
	pages.set(0, shortReads(0, [16, 14, 20]));
	pages.set(720, shortReads(720, [29, 29, 29]));
	pages.set(780, shortReads(780, [28, 28, 28]));
	pages.set(840, shortReads(840, [28, 28, 28]));
	pages.set(1410, shortReads(1410, [29, 29, 29]));
	pages.set(1500, shortReads(1500, [26, 30]));
	pages.set(2040, [{ items: range("live", 2040, 8, time), next_cursor: null }]);
	pages.set(2070, [{ items: [] }]);
	const { inOrder, prefetched } = await assertSameDecisions("live walk", pages);
	assert.equal(new Set(prefetched.records.map((r) => r.data.id)).size, total);
	const extra = prefetched.paths.length - inOrder.paths.length;
	// At most five reads past the end, plus three first-page check reads.
	assert.ok(extra <= PRODUCTION_WIDTH - 1 + 3, `extra reads ${extra}`);
});

test("#250 shift and tie fixtures keep the same backfill when the first run is prefetched", async () => {
	const old = range("old", 0, 60, (index) => 1_700_001_000 - index);
	const firstRun = new Map<number, Page[]>([
		[0, [{ items: old.slice(0, 30), next_cursor: 30 }]],
		[30, ["503"]],
	]);
	for (let cursor = 60; cursor <= 180; cursor += 30)
		firstRun.set(cursor, ["503"]);
	const { prefetched: first } = await assertSameDecisions(
		"shift fixture run 1",
		firstRun,
	);
	assert.deepEqual(first.state?.backfill, {
		position_hint: 30,
		oldest_update_time: new Date(1_700_000_971 * 1000).toISOString(),
		boundary_ids: ["old-29"],
	});
	// Run 2 inserts one row, updates old-40 to the top and drops two rows.
	const rows = [
		convo("new", 1_700_002_000),
		convo("old-40", 1_700_003_000),
		...old.filter((_, index) => ![1, 2, 40].includes(index)),
	].sort((a, b) => Number(b.update_time) - Number(a.update_time));
	const secondRun = new Map<number, Page[]>();
	for (let cursor = 0; cursor <= 90; cursor += 30) {
		secondRun.set(cursor, [
			{
				items: rows.slice(cursor, cursor + 30),
				next_cursor: cursor + 30 < rows.length ? cursor + 30 : null,
			},
		]);
	}
	const { prefetched: second } = await assertSameDecisions(
		"shift fixture run 2",
		secondRun,
		1,
		{ conversations: first.state ?? {} },
	);
	assert.equal(second.state?.backfill, undefined);

	// Equal-time rows: tie-29 and tie-30 share the boundary time.
	const boundary = 1_700_000_971;
	const ties = range("tie", 0, 60, (index) =>
		index === 29 || index === 30 ? boundary : 1_700_001_000 - index,
	);
	const tieRun = new Map<number, Page[]>([
		[0, [{ items: ties.slice(0, 30), next_cursor: 30 }]],
		[30, ["503"]],
	]);
	for (let cursor = 60; cursor <= 180; cursor += 30)
		tieRun.set(cursor, ["503"]);
	const { prefetched: tie } = await assertSameDecisions("tie run 1", tieRun);
	assert.deepEqual(tie.state?.backfill, {
		position_hint: 30,
		oldest_update_time: new Date(boundary * 1000).toISOString(),
		boundary_ids: ["tie-29"],
	});
});

test("failures, malformed pages and the safety cap decide the same when prefetched", async () => {
	const failing = fullPages("fail", 150);
	failing.set(90, ["503"]);
	await assertSameDecisions("503 mid-list", failing);
	const unreadable = fullPages("unreadable", 150);
	unreadable.set(60, ["null"]);
	await assertSameDecisions("unreadable page", unreadable);
	const malformed = fullPages("malformed", 90);
	malformed.set(30, [{ items: [{ title: "no id" }], next_cursor: 60 }]);
	await assertSameDecisions("item without id", malformed);
	const endless = new Map<number, Page[]>();
	for (let cursor = 0; cursor <= 5100; cursor += 30) {
		endless.set(cursor, [
			{ items: range("cap", cursor, 30), next_cursor: cursor + 30 },
		]);
	}
	await assertSameDecisions("safety cap", endless);
});

test("randomized provider pages decide the same in order and prefetched", async () => {
	const seeds = Array.from({ length: 300 }, (_, index) => index + 1);
	const seedRuns = seeds.map((seed) => {
		const random = seededRandom(seed * 7919);
		const pick = <T>(choices: readonly T[]): T =>
			choices[Math.floor(random() * choices.length)] as T;
		const size = Math.floor(random() * 420);
		const tieTime = 1_700_000_500;
		const time = (index: number) =>
			random() < 0.1 ? tieTime : 1_800_000_000 - index;
		const pages = new Map<number, Page[]>();
		let cursor = 0;
		while (cursor < size) {
			const kind = pick([
				"full",
				"full",
				"full",
				"short",
				"varying",
				"empty-next",
				"jump",
				"fail",
				"reprobe-more",
			] as const);
			const next = kind === "jump" ? cursor + 60 : cursor + 30;
			// An empty first page is tested on its own below: it cannot be
			// checked after the walk, so the in-order walk runs again.
			if (cursor === 0 && kind === "empty-next") continue;
			const rows = range(`r${seed}`, cursor, 30, time);
			if (kind === "full" || kind === "jump") {
				pages.set(cursor, [{ items: rows, next_cursor: next }]);
			} else if (kind === "short") {
				pages.set(cursor, [
					{
						items: rows.slice(0, 1 + Math.floor(random() * 29)),
						next_cursor: next,
					},
				]);
			} else if (kind === "varying") {
				pages.set(
					cursor,
					[0, 1, 2].map(() => ({
						items: rows.filter(() => random() < 0.9),
						next_cursor: random() < 0.8 ? next : null,
					})),
				);
			} else if (kind === "empty-next") {
				pages.set(cursor, [{ items: [], next_cursor: next }]);
			} else if (kind === "fail") {
				pages.set(cursor, [random() < 0.5 ? "503" : "null"]);
			} else {
				pages.set(cursor, [
					{ items: [], next_cursor: null },
					{ items: rows.slice(0, 5), next_cursor: next },
				]);
			}
			cursor = next;
		}
		pages.set(cursor, [
			{
				items: range(`r${seed}`, cursor, Math.floor(random() * 30), time),
				next_cursor: null,
			},
		]);
		return assertSameDecisions(`seed ${seed}`, pages, seed);
	});
	await Promise.all(seedRuns);
});

/**
 * A newest-first list that changes while requests are in flight. Each request
 * reads the list at a random moment and answers a little later, so prefetched
 * pages are served out of order. With `shortReads`, a read can drop rows, as
 * the live provider does, but every third read of a cursor is whole and no
 * read drops every row: the provider behavior the in-order walk relies on.
 */
async function runChangingList(
	width: number,
	seed: number,
	shortReads: boolean,
): Promise<{
	complete: boolean;
	missing: string[];
	partialWithBackfill: boolean;
	reads: number;
	unreachable: string[];
}> {
	const random = seededRandom(seed * 104_729);
	let clock = 2_000_000_000;
	const size = 60 + Math.floor(random() * 300);
	let rows = Array.from({ length: size }, (_, index) =>
		convo(`row-${index}`, 1_900_000_000 - index),
	);
	const stayed = new Set(rows.map((row) => String(row.id)));
	const changed = new Map<string, number>();
	let reads = 0;
	const readsByCursorSoFar = new Map<number, number>();
	const changeAfterReads = new Set(
		Array.from({ length: 1 + Math.floor(random() * 3) }, () =>
			Math.floor(random() * (size / 30 + 2)),
		),
	);
	const change = (): void => {
		clock += 1;
		if (random() < 0.5) {
			changed.set(`arrived-${clock}`, clock);
			rows = [convo(`arrived-${clock}`, clock), ...rows];
			return;
		}
		const index = Math.floor(random() * rows.length);
		const moved = rows[index];
		if (!moved) return;
		stayed.delete(String(moved.id));
		changed.set(String(moved.id), clock);
		rows = [
			{ ...moved, update_time: clock },
			...rows.filter((_, i) => i !== index),
		];
	};
	const harness = makeRecordingEmit(validateRecord);
	const api: ChatGptApi = {
		auth: () => Promise.reject(new Error("auth unused")),
		fetch: async (path) => {
			if (!path.startsWith(SEARCH_PREFIX)) return { status: 404, json: null };
			const cursor = cursorOf(path);
			const read = readsByCursorSoFar.get(cursor) ?? 0;
			readsByCursorSoFar.set(cursor, read + 1);
			await new Promise((resolve) => setTimeout(resolve, random() * 4));
			reads += 1;
			if (changeAfterReads.has(reads)) change();
			let items = rows.slice(cursor, cursor + 30);
			if (shortReads && read % 3 !== 2 && random() < 0.6 && items.length > 1) {
				// A short read keeps at least one row. An empty page with no next
				// cursor looks like the true end to any client; #250 documents that.
				const kept = items.filter(() => random() < 0.6);
				items = kept.length > 0 ? kept : items.slice(0, 1);
			}
			const next = cursor + 30 < rows.length ? cursor + 30 : null;
			await new Promise((resolve) => setTimeout(resolve, random() * 4));
			return { status: 200, json: { items, next_cursor: next } };
		},
	};
	await runConversationsAndMessagesStreams(
		{
			api,
			sleep: () => Promise.resolve(),
			emit: harness.emit,
			emitRecord: harness.emitRecord,
			progress: () => Promise.resolve(),
			requested: new Map([["conversations", { name: "conversations" }]]),
			conversationSearchPrefetchPages: width,
		},
		{},
	);
	const collected = new Set(
		harness.emitted.map((record) => String(record.data.id)),
	);
	const stateMessage = harness.protocolMessages.find(
		(message) => message.type === "STATE" && message.stream === "conversations",
	);
	const cursor =
		stateMessage?.type === "STATE"
			? (stateMessage.cursor as Record<string, unknown>)
			: {};
	const watermark = String(cursor.last_update_time ?? "");
	return {
		complete: harness.protocolMessages.some(
			(message) => message.type === "DETAIL_COVERAGE",
		),
		missing: [...stayed].filter((id) => !collected.has(id)),
		partialWithBackfill:
			cursor.backfill !== undefined &&
			harness.protocolMessages.some(
				(message) =>
					message.type === "SKIP_RESULT" &&
					typeof message.recovery_hint === "object" &&
					message.recovery_hint.action === "retry_by_runtime",
			),
		reads,
		// A row that arrived or moved during the walk may be missed by this run,
		// but only if the saved watermark is older, so the next run lists it.
		unreachable: [...changed]
			.filter(
				([id, time]) =>
					!collected.has(id) &&
					new Date(time * 1000).toISOString() <= watermark,
			)
			.map(([id]) => id),
	};
}

for (const shortReads of [false, true]) {
	test(`a list that changes during a prefetched walk never loses a row${shortReads ? ", with short reads" : ""}`, async () => {
		const seeds = Array.from({ length: 200 }, (_, index) => index + 1);
		await Promise.all(
			seeds.map(async (seed) => {
				const [inOrder, prefetched] = await Promise.all([
					runChangingList(1, seed, shortReads),
					runChangingList(PRODUCTION_WIDTH, seed, shortReads),
				]);
				for (const [label, outcome] of [
					["in order", inOrder],
					["prefetched", prefetched],
				] as const) {
					// A list that changes at its end can make two reads of one cursor
					// disagree. #250 then ends partial and saves a backfill to retry.
					if (!outcome.complete) {
						assert.ok(outcome.partialWithBackfill, `${label}, seed ${seed}`);
						continue;
					}
					assert.deepEqual(outcome.missing, [], `${label}, seed ${seed}`);
					assert.deepEqual(outcome.unreachable, [], `${label}, seed ${seed}`);
				}
			}),
		);
	});
}

test("a short first-page check cannot hide a row that arrived during the walk", async () => {
	// Review counterexample: cursor 60 is answered before a new conversation
	// arrives and cursor 30 after it, so row-59 falls between the two pages.
	// Short reads then hide every repeated row: the walk's reads of cursor 30
	// drop row-29 (cursor 0 returned it) and the tail retries drop row-119
	// (cursor 90 returned it). The first check read omits the new row too.
	// Only a whole first-page read can find the arrival.
	let rows = range("row", 0, 125, (index) => 1_900_000_000 - index);
	let servedSixty: () => void = () => undefined;
	const sixtyServed = new Promise<void>((resolve) => {
		servedSixty = resolve;
	});
	let firstPageReads = 0;
	let thirtyReads = 0;
	let tailReads = 0;
	const harness = makeRecordingEmit(validateRecord);
	const api: ChatGptApi = {
		auth: () => Promise.reject(new Error("auth unused")),
		fetch: async (path) => {
			if (!path.startsWith(SEARCH_PREFIX)) return { status: 404, json: null };
			const cursor = cursorOf(path);
			if (cursor === 30) {
				await sixtyServed;
				if (!rows.some((row) => row.id === "arrived")) {
					rows = [convo("arrived", 2_000_000_000), ...rows];
				}
			}
			let items = rows.slice(cursor, cursor + 30);
			if (cursor === 30 && ++thirtyReads <= 3)
				items = items.filter((row) => row.id !== "row-29");
			if (cursor === 120 && ++tailReads <= 3)
				items = items.filter((row) => row.id !== "row-119");
			if (cursor === 0 && ++firstPageReads === 2) {
				items = items.filter((row) => row.id !== "arrived").slice(0, 16);
			}
			const next = cursor + 30 < rows.length ? cursor + 30 : null;
			if (cursor === 60) servedSixty();
			return { status: 200, json: { items, next_cursor: next } };
		},
	};
	await runConversationsAndMessagesStreams(
		{
			api,
			sleep: () => Promise.resolve(),
			emit: harness.emit,
			emitRecord: harness.emitRecord,
			progress: () => Promise.resolve(),
			requested: new Map([["conversations", { name: "conversations" }]]),
			conversationSearchPrefetchPages: PRODUCTION_WIDTH,
		},
		{},
	);
	const collected = new Set(harness.emitted.map((r) => String(r.data.id)));
	assert.deepEqual(
		range("row", 0, 125)
			.map((row) => String(row.id))
			.filter((id) => !collected.has(id)),
		[],
	);
	assert.ok(collected.has("arrived"));
	assert.ok(harness.protocolMessages.some((m) => m.type === "DETAIL_COVERAGE"));
});

test("a failed first-page check walks again in order instead of failing the stream", async () => {
	const pages = fullPages("rejected", 60);
	const inOrder = await runFixture(pages, 1, 3);
	const harness = makeRecordingEmit(validateRecord);
	let firstPageReads = 0;
	const reads: number[] = [];
	const api: ChatGptApi = {
		auth: () => Promise.reject(new Error("auth unused")),
		fetch: (path) => {
			if (!path.startsWith(SEARCH_PREFIX))
				return Promise.resolve({ status: 404, json: null });
			const cursor = cursorOf(path);
			reads.push(cursor);
			if (cursor === 0 && ++firstPageReads === 2) {
				return Promise.reject(new Error("retry budget exhausted"));
			}
			return Promise.resolve(respond(pages.get(cursor)?.[0]));
		},
	};
	await runConversationsAndMessagesStreams(
		{
			api,
			sleep: () => Promise.resolve(),
			emit: harness.emit,
			emitRecord: harness.emitRecord,
			progress: () => Promise.resolve(),
			requested: new Map([["conversations", { name: "conversations" }]]),
			conversationSearchPrefetchPages: PRODUCTION_WIDTH,
		},
		{},
	);
	assert.deepEqual(harness.emitted, inOrder.records);
	assert.deepEqual(harness.protocolMessages, inOrder.messages);
	assert.equal(reads.filter((cursor) => cursor === 0).length, 3);
});

test("an empty first page cannot be checked, so the in-order walk decides", async () => {
	const pages = fullPages("empty-first", 120);
	pages.set(0, [{ items: [], next_cursor: 30 }]);
	const inOrder = await runFixture(pages, 1, 5);
	const prefetched = await runFixture(pages, PRODUCTION_WIDTH, 5);
	assert.deepEqual(prefetched.records, inOrder.records);
	assert.deepEqual(prefetched.messages, inOrder.messages);
	assert.equal(readsByCursor(prefetched.paths).get(30), 2);
});

test("prefetch never has more than six search requests in flight", async () => {
	// Continuations skip every other grid cursor, and the skipped cursors
	// answer slowly, so their reads stay in flight while the walk moves on.
	let inFlight = 0;
	let peak = 0;
	const harness = makeRecordingEmit(validateRecord);
	const api: ChatGptApi = {
		auth: () => Promise.reject(new Error("auth unused")),
		fetch: async (path) => {
			if (!path.startsWith(SEARCH_PREFIX)) return { status: 404, json: null };
			const cursor = cursorOf(path);
			inFlight += 1;
			peak = Math.max(peak, inFlight);
			const visited = cursor === 0 || cursor % 60 === 30;
			await new Promise((resolve) => setTimeout(resolve, visited ? 1 : 40));
			inFlight -= 1;
			if (cursor >= 900) return { status: 200, json: { items: [] } };
			return {
				status: 200,
				json: {
					items: range("jump", cursor, 30),
					next_cursor: cursor === 0 ? 30 : cursor + 60,
				},
			};
		},
	};
	await runConversationsAndMessagesStreams(
		{
			api,
			sleep: () => Promise.resolve(),
			emit: harness.emit,
			emitRecord: harness.emitRecord,
			progress: () => Promise.resolve(),
			requested: new Map([["conversations", { name: "conversations" }]]),
			conversationSearchPrefetchPages: PRODUCTION_WIDTH,
		},
		{},
	);
	assert.ok(peak <= PRODUCTION_WIDTH, `peak ${peak}`);
	assert.ok(peak > 1, "prefetch ran");
});

for (const burst of ["503", "false end"] as const) {
	test(`a provider that answers bursts badly (${burst}) still gets the in-order result`, async () => {
		// Reads past cursor 30 are slow. Reads sent while another is in flight
		// fail, or come back as
		// an empty page with no continuation: the end-of-list shape. The walk
		// asks failed reads again in order and confirms an end alone.
		const pages = fullPages("burst", 400);
		const run = async (width: number) => {
			let inFlight = 0;
			const harness = makeRecordingEmit(validateRecord);
			const api: ChatGptApi = {
				auth: () => Promise.reject(new Error("auth unused")),
				fetch: async (path) => {
					if (!path.startsWith(SEARCH_PREFIX))
						return { status: 404, json: null };
					inFlight += 1;
					const crowded = inFlight > 1;
					await new Promise((resolve) =>
						setTimeout(resolve, cursorOf(path) <= 30 ? 2 : 30),
					);
					inFlight -= 1;
					if (crowded && burst === "503") return { status: 503, json: null };
					if (crowded) return { status: 200, json: { items: [] } };
					return respond(pages.get(cursorOf(path))?.[0]);
				},
			};
			await runConversationsAndMessagesStreams(
				{
					api,
					sleep: () => Promise.resolve(),
					emit: harness.emit,
					emitRecord: harness.emitRecord,
					progress: () => Promise.resolve(),
					requested: new Map([["conversations", { name: "conversations" }]]),
					conversationSearchPrefetchPages: width,
				},
				{},
			);
			return harness;
		};
		const inOrder = await run(1);
		const prefetched = await run(PRODUCTION_WIDTH);
		assert.equal(inOrder.emitted.length, 400);
		assert.deepEqual(prefetched.emitted, inOrder.emitted);
		assert.deepEqual(prefetched.protocolMessages, inOrder.protocolMessages);
	});
}

test("a row that arrives during a mid-list end re-probe is not lost to a cached page", async () => {
	// Review counterexample: cursor 60 first answers as an empty end, a row
	// arrives during its re-probe, and cursor 90 was read before the arrival.
	let rows = range("row", 0, 125, (index) => 1_900_000_000 - index);
	let sixtyReads = 0;
	const harness = makeRecordingEmit(validateRecord);
	const api: ChatGptApi = {
		auth: () => Promise.reject(new Error("auth unused")),
		fetch: async (path) => {
			if (!path.startsWith(SEARCH_PREFIX)) return { status: 404, json: null };
			const cursor = cursorOf(path);
			await new Promise((resolve) => setTimeout(resolve, 1));
			if (cursor === 60 && ++sixtyReads === 1) {
				return { status: 200, json: { items: [] } };
			}
			if (cursor === 60 && !rows.some((row) => row.id === "arrived")) {
				rows = [convo("arrived", 2_000_000_000), ...rows];
			}
			const next = cursor + 30 < rows.length ? cursor + 30 : null;
			return {
				status: 200,
				json: { items: rows.slice(cursor, cursor + 30), next_cursor: next },
			};
		},
	};
	await runConversationsAndMessagesStreams(
		{
			api,
			sleep: () => Promise.resolve(),
			emit: harness.emit,
			emitRecord: harness.emitRecord,
			progress: () => Promise.resolve(),
			requested: new Map([["conversations", { name: "conversations" }]]),
			conversationSearchPrefetchPages: PRODUCTION_WIDTH,
		},
		{},
	);
	const collected = new Set(harness.emitted.map((r) => String(r.data.id)));
	assert.deepEqual(
		range("row", 0, 125)
			.map((row) => String(row.id))
			.filter((id) => !collected.has(id)),
		[],
	);
});

test("a crowded read that returns another cursor's rows does not decide the result", async () => {
	// Review counterexample: while other reads are in flight, cursor 90
	// answers once with a 503 and then with cursor 60's rows. Alone it
	// answers right.
	const rows = range("row", 0, 120);
	let inFlight = 0;
	let ninetyReads = 0;
	const harness = makeRecordingEmit(validateRecord);
	const api: ChatGptApi = {
		auth: () => Promise.reject(new Error("auth unused")),
		fetch: async (path) => {
			if (!path.startsWith(SEARCH_PREFIX)) return { status: 404, json: null };
			const cursor = cursorOf(path);
			inFlight += 1;
			const crowded = inFlight > 1;
			await new Promise((resolve) => setTimeout(resolve, 2));
			inFlight -= 1;
			const next = cursor + 30 < rows.length ? cursor + 30 : null;
			if (cursor === 90 && crowded && ++ninetyReads === 1) {
				return { status: 503, json: null };
			}
			const start = cursor === 90 && crowded ? 60 : cursor;
			return {
				status: 200,
				json: { items: rows.slice(start, start + 30), next_cursor: next },
			};
		},
	};
	await runConversationsAndMessagesStreams(
		{
			api,
			sleep: () => Promise.resolve(),
			emit: harness.emit,
			emitRecord: harness.emitRecord,
			progress: () => Promise.resolve(),
			requested: new Map([["conversations", { name: "conversations" }]]),
			conversationSearchPrefetchPages: PRODUCTION_WIDTH,
		},
		{},
	);
	assert.equal(new Set(harness.emitted.map((r) => r.data.id)).size, 120);
});

test("a crowded read that misplaces a page sends the walk back in order", async () => {
	// Cursor 90 answers with cursor 120's rows whenever other reads are in
	// flight. No count or timing check can see that; the repeated rows can.
	const rows = range("row", 0, 150);
	let inFlight = 0;
	const harness = makeRecordingEmit(validateRecord);
	const api: ChatGptApi = {
		auth: () => Promise.reject(new Error("auth unused")),
		fetch: async (path) => {
			if (!path.startsWith(SEARCH_PREFIX)) return { status: 404, json: null };
			const cursor = cursorOf(path);
			inFlight += 1;
			const crowded = inFlight > 1;
			await new Promise((resolve) => setTimeout(resolve, 2));
			inFlight -= 1;
			const start = cursor === 90 && crowded ? 120 : cursor;
			const next = cursor + 30 < rows.length ? cursor + 30 : null;
			return {
				status: 200,
				json: { items: rows.slice(start, start + 30), next_cursor: next },
			};
		},
	};
	await runConversationsAndMessagesStreams(
		{
			api,
			sleep: () => Promise.resolve(),
			emit: harness.emit,
			emitRecord: harness.emitRecord,
			progress: () => Promise.resolve(),
			requested: new Map([["conversations", { name: "conversations" }]]),
			conversationSearchPrefetchPages: PRODUCTION_WIDTH,
		},
		{},
	);
	assert.equal(new Set(harness.emitted.map((r) => r.data.id)).size, 150);
	assert.ok(harness.protocolMessages.some((m) => m.type === "DETAIL_COVERAGE"));
});

/** A full walk of a static list where `answer` may change crowded reads. */
async function runStaticList(
	rows: Record<string, unknown>[],
	answer: (
		cursor: number,
		crowded: boolean,
		read: number,
	) =>
		| Record<string, unknown>[]
		| { items: Record<string, unknown>[]; next_cursor: number | null }
		| null,
	slowCursor?: number,
): Promise<{ ids: Set<unknown>; complete: boolean }> {
	let inFlight = 0;
	const reads = new Map<number, number>();
	const harness = makeRecordingEmit(validateRecord);
	const api: ChatGptApi = {
		auth: () => Promise.reject(new Error("auth unused")),
		fetch: async (path) => {
			if (!path.startsWith(SEARCH_PREFIX)) return { status: 404, json: null };
			const cursor = cursorOf(path);
			const read = reads.get(cursor) ?? 0;
			reads.set(cursor, read + 1);
			inFlight += 1;
			const crowdedAtSend = inFlight > 1;
			await new Promise((resolve) =>
				setTimeout(resolve, cursor === slowCursor ? 40 : 2),
			);
			const crowded = crowdedAtSend || inFlight > 1;
			inFlight -= 1;
			const answered = answer(cursor, crowded, read);
			const next = cursor + 30 < rows.length ? cursor + 30 : null;
			if (answered && !Array.isArray(answered))
				return { status: 200, json: answered };
			const items = answered ?? rows.slice(cursor, cursor + 30);
			return { status: 200, json: { items, next_cursor: next } };
		},
	};
	await runConversationsAndMessagesStreams(
		{
			api,
			sleep: () => Promise.resolve(),
			emit: harness.emit,
			emitRecord: harness.emitRecord,
			progress: () => Promise.resolve(),
			requested: new Map([["conversations", { name: "conversations" }]]),
			conversationSearchPrefetchPages: PRODUCTION_WIDTH,
		},
		{},
	);
	return {
		ids: new Set(harness.emitted.map((r) => r.data.id)),
		complete: harness.protocolMessages.some(
			(m) => m.type === "DETAIL_COVERAGE",
		),
	};
}

test("retries of a short page are sent alone, so crowded short reads cannot decide it", async () => {
	// Review counterexample: while slow cursor 60 is in flight, every read of
	// cursor 30 drops row-59. Alone, cursor 30 answers whole.
	const rows = range("row", 0, 90);
	const outcome = await runStaticList(
		rows,
		(cursor, crowded) =>
			cursor === 30 && crowded
				? rows.slice(30, 60).filter((row) => row.id !== "row-59")
				: null,
		60,
	);
	assert.equal(outcome.ids.size, 90);
	assert.ok(outcome.complete);
});

test("a crowded page that repeats a row inside itself does not count as full", async () => {
	const rows = range("row", 0, 90);
	const outcome = await runStaticList(rows, (cursor, crowded) =>
		cursor === 60 && crowded
			? [...rows.slice(60, 89), rows[60] as Record<string, unknown>]
			: null,
	);
	assert.equal(outcome.ids.size, 90);
	assert.ok(outcome.complete);
});

test("rows from an end re-probe are checked for repeats like any other read", async () => {
	// Review counterexample: cursor 90's first read is an empty end, and its
	// re-probe returns cursor 60's rows. Later reads of cursor 90 are right.
	const rows = range("row", 0, 150);
	const outcome = await runStaticList(rows, (cursor, _crowded, read) => {
		if (cursor !== 90) return null;
		if (read === 0) return { items: [], next_cursor: null };
		if (read === 1) return rows.slice(60, 90);
		return null;
	});
	assert.equal(outcome.ids.size, 150);
	assert.ok(outcome.complete);
});

for (const jump of [60, 300] as const) {
	test(`a crowded read that jumps to cursor ${jump} with its own continuation is asked again alone`, async () => {
		// Review counterexample: crowded cursor 30 answers with another page's
		// rows and that page's next cursor, so the walk would skip pages.
		const rows = range("row", 0, jump + 60);
		const outcome = await runStaticList(rows, (cursor, crowded) =>
			cursor === 30 && crowded
				? { items: rows.slice(jump, jump + 30), next_cursor: jump + 30 }
				: null,
		);
		assert.equal(outcome.ids.size, jump + 60);
		assert.ok(outcome.complete);
	});
}

test("a run with a request cap walks in order", async () => {
	// Concurrent requests could each pass the cap check before any is counted.
	let inFlight = 0;
	let peak = 0;
	const rows = range("capped", 0, 150);
	const harness = makeRecordingEmit(validateRecord);
	const api: ChatGptApi = {
		auth: () => Promise.reject(new Error("auth unused")),
		fetch: async (path) => {
			if (!path.startsWith(SEARCH_PREFIX)) return { status: 404, json: null };
			const cursor = cursorOf(path);
			inFlight += 1;
			peak = Math.max(peak, inFlight);
			await new Promise((resolve) => setTimeout(resolve, 2));
			inFlight -= 1;
			const next = cursor + 30 < rows.length ? cursor + 30 : null;
			return {
				status: 200,
				json: { items: rows.slice(cursor, cursor + 30), next_cursor: next },
			};
		},
	};
	await runConversationsAndMessagesStreams(
		{
			api,
			sleep: () => Promise.resolve(),
			emit: harness.emit,
			emitRecord: harness.emitRecord,
			progress: () => Promise.resolve(),
			requested: new Map([["conversations", { name: "conversations" }]]),
			conversationSearchPrefetchPages: PRODUCTION_WIDTH,
			providerBudget: new ProviderBudgetController({
				runBudget: { maxRequests: 1000 },
			}),
		},
		{},
	);
	assert.equal(peak, 1);
	assert.equal(harness.emitted.length, 150);
});

test("a page short for three reads after a burst is read again after the walk", async () => {
	// Review counterexample: a crowded read of cursor 60 makes its next three
	// answers short (rows 60-79), even the retries sent alone. A later read
	// is whole. The in-order walk never crowds the provider.
	const rows = range("row", 0, 120);
	let degraded = 0;
	const outcome = await runStaticList(rows, (cursor, crowded) => {
		if (cursor !== 60) return null;
		if (crowded && degraded === 0) degraded = 3;
		if (degraded === 0) return null;
		degraded -= 1;
		return { items: rows.slice(60, 80), next_cursor: 90 };
	});
	assert.equal(outcome.ids.size, 120);
	assert.ok(outcome.complete);
});
