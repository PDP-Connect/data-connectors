// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import type { CollectContext } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { makeRecordingEmit } from "../../packages/polyfill-connectors/src/test-harness.ts";
import {
	NO_DETAIL_WAITS,
	readConversationDetail,
} from "./__fixtures__/empty-conversation-details.ts";
import {
	ChatGptPlannedProviderBudgetDeferredError,
	ChatGptRunBudget,
	runConversationsAndMessagesStreams,
	type StreamDeps,
} from "./index.ts";
import { validateRecord } from "./schemas.ts";
import type {
	ChatGptApi,
	ChatGptFetchResult,
	ConversationListItem,
} from "./types.ts";

const BASE = Date.parse("2025-06-01T00:00:00Z");
const iso = (n: number) => new Date(BASE + n * 1000).toISOString();
const row = (n: number): ConversationListItem => ({
	id: `synthetic-${n}`,
	title: "Synthetic",
	update_time: (BASE + n * 1000) / 1000,
	create_time: BASE / 1000,
});
const completed = {
	last_update_time: iso(1000),
	detail_version: 2,
	detail_frontier: null,
	detail_ids: {},
};

function fixture(
	primary: ConversationListItem[],
	search: ConversationListItem[],
	primaryPage?: (offset: number) => ChatGptFetchResult | undefined,
) {
	const details = new Map<string, number>();
	const offsets: number[] = [];
	const api: ChatGptApi = {
		auth: () => Promise.reject(new Error("unused")),
		fetch: (path) => {
			if (path.startsWith("/conversations?")) {
				const params = new URLSearchParams(path.split("?")[1]);
				assert.equal(params.get("limit"), "100");
				assert.equal(params.get("order"), "updated");
				const offset = Number(params.get("offset"));
				offsets.push(offset);
				const override = primaryPage?.(offset);
				const items = primary.slice(offset, offset + 100);
				return Promise.resolve(
					override ?? {
						status: 200,
						json: { items, total: offset + items.length + 1 },
					},
				);
			}
			if (path.startsWith("/conversations/search?")) {
				const cursor = Number(
					new URLSearchParams(path.split("?")[1]).get("cursor"),
				);
				return Promise.resolve({
					status: 200,
					json: {
						items: search.slice(cursor, cursor + 30),
						next_cursor: cursor + 30 < search.length ? cursor + 30 : null,
					},
				});
			}
			assert.ok(path.startsWith("/conversation/"));
			const id = path.slice("/conversation/".length);
			details.set(id, (details.get(id) ?? 0) + 1);
			return Promise.resolve(readConversationDetail(path));
		},
	};
	return { api, details, offsets };
}

async function collect(
	api: ChatGptApi,
	state: CollectContext["state"] = {},
	names = ["conversations", "messages"],
	since?: string,
	overrides: Partial<StreamDeps> = {},
) {
	const harness = makeRecordingEmit(validateRecord);
	const deps: StreamDeps = {
		api,
		emit: harness.emit,
		emitRecord: harness.emitRecord,
		progress: async () => undefined,
		sleep: async () => undefined,
		requested: new Map(
			names.map((name) => [
				name,
				{ name, ...(since ? { time_range: { since } } : {}) },
			]),
		),
		...overrides,
	};
	await runConversationsAndMessagesStreams(deps, state, {
		detailPacing: NO_DETAIL_WAITS,
		detailBackfillLimit: 1000,
	});
	const next = { ...state };
	for (const message of harness.protocolMessages) {
		if (message.type === "STATE") {
			next[message.stream] = message.cursor;
		}
	}
	return { ...harness, state: next };
}

for (const names of [
	["conversations", "messages"],
	["conversations"],
	["messages"],
]) {
	for (const legacy of [false, true, "watermark"] as const) {
		test(`union repairs seven interior omissions: ${names.join("+")} legacy=${legacy}`, async () => {
			const primary = Array.from({ length: 9 }, (_, i) => row(10 - i));
			const search = [row(11), row(10), row(2)];
			const fake = fixture(primary, search);
			const cursor =
				legacy === "watermark"
					? { last_update_time: completed.last_update_time }
					: completed;
			const result = await collect(
				fake.api,
				legacy ? { conversations: cursor, messages: cursor } : {},
				names,
			);
			for (const item of [...primary, row(11)]) {
				assert.equal(
					fake.details.get(item.id),
					1,
					"union hydrates every id exactly once",
				);
				for (const stream of names) {
					assert.ok(
						result.emitted.some(
							(record) =>
								record.stream === stream &&
								(stream === "conversations"
									? record.data.id === item.id
									: record.data.conversation_id === item.id),
						),
					);
				}
			}
		});
	}
}

test("primary moving total is a lower bound, and both sources retain their exclusive rows", async () => {
	const fake = fixture(
		Array.from({ length: 205 }, (_, i) => row(300 - i)),
		[row(999)],
	);
	await collect(fake.api);
	assert.deepEqual(fake.offsets, [0, 100, 200, 205, 205]);
	assert.equal(fake.details.size, 206);
});

test("primary failure cannot advance either watermark or emit full coverage", async () => {
	const fake = fixture([], [row(2000)], () => ({ status: 500, json: null }));
	const result = await collect(fake.api, {
		conversations: completed,
		messages: completed,
	});
	for (const stream of ["conversations", "messages"]) {
		assert.equal(
			(result.state[stream] as typeof completed).last_update_time,
			completed.last_update_time,
		);
		assert.ok(
			!result.protocolMessages.some(
				(message) =>
					message.type === "DETAIL_COVERAGE" && message.stream === stream,
			),
		);
	}
});

test("failed initial primary discovery still repairs an old row on the next run", async () => {
	const failed = fixture([], [], () => ({ status: 500, json: null }));
	const partial = await collect(failed.api, {
		conversations: completed,
		messages: completed,
	});
	const healthy = fixture([row(10)], []);
	const repaired = await collect(healthy.api, partial.state);
	assert.equal(healthy.details.get(row(10).id), 1);
	assert.ok(
		repaired.emitted.some(
			(record) =>
				record.stream === "conversations" && record.data.id === row(10).id,
		),
	);
	const next = fixture([row(10)], []);
	await collect(next.api, repaired.state);
	assert.equal(
		next.details.size,
		0,
		"a completed migration does not reopen history on every run",
	);
});

test("malformed primary rows cannot commit either stream", async () => {
	for (const json of [null, { items: [{}] }]) {
		const fake = fixture([], [row(2000)], () => ({ status: 200, json }));
		const result = await collect(fake.api, {
			conversations: completed,
			messages: completed,
		});
		assert.equal(
			result.protocolMessages.filter(
				(message) => message.type === "DETAIL_COVERAGE",
			).length,
			0,
		);
		for (const name of ["conversations", "messages"]) {
			assert.equal(
				(result.state[name] as typeof completed).last_update_time,
				completed.last_update_time,
			);
			assert.ok(
				result.protocolMessages.some(
					(message) =>
						message.type === "SKIP_RESULT" && message.stream === name,
				),
			);
		}
	}
});

test("primary-only rows on either side of consent are filtered before detail hydration", async () => {
	const fake = fixture([row(20), row(10), row(9), row(1)], [row(21)]);
	await collect(
		fake.api,
		{ conversations: completed, messages: completed },
		["conversations", "messages"],
		iso(10),
	);
	assert.deepEqual(
		[...fake.details.keys()].sort(),
		[row(10).id, row(20).id, row(21).id].sort(),
	);
});

test("recovery-only pacing checkpoints preserve independent primary continuation", async () => {
	const primaryBackfill = {
		position_hint: 100,
		oldest_update_time: iso(10),
		boundary_ids: [row(10).id],
	};
	const cursor = {
		last_update_time: completed.last_update_time,
		enumeration_version: 1,
		primary_backfill: primaryBackfill,
	};
	const fake = fixture([], []);
	const result = await collect(
		fake.api,
		{ messages: cursor },
		["messages"],
		undefined,
		{ recoveryOnly: true },
	);
	assert.equal(fake.offsets.length, 0);
	assert.deepEqual(result.state.messages, cursor);
});

test("primary catch-up resumes an interrupted walk and retains the consent floor", async () => {
	const rows = Array.from({ length: 305 }, (_, i) => row(400 - i));
	const first = fixture(rows, [], (offset) => {
		if (offset === 200) {
			throw new ChatGptPlannedProviderBudgetDeferredError(
				"synthetic budget",
				"max_detail_fetches",
			);
		}
	});
	const partial = await collect(
		first.api,
		{ conversations: completed, messages: completed },
		["conversations", "messages"],
		iso(150),
	);
	const resumed = fixture(rows, []);
	const result = await collect(
		resumed.api,
		partial.state,
		["conversations", "messages"],
		iso(150),
	);
	assert.ok(
		(resumed.offsets[0] ?? 0) > 0,
		"resume from an identity-checked overlap, not the beginning",
	);
	assert.equal(resumed.details.get(row(151).id), 1);
	assert.ok(!resumed.details.has(row(149).id));
	assert.ok(!first.details.has(row(149).id));
	assert.ok(
		result.emitted.some(
			(record) =>
				record.stream === "conversations" && record.data.id === row(150).id,
		),
	);
});

test("bounded listing runs drain both source continuations without restarting primary forever", async () => {
	let state: CollectContext["state"] = {
		conversations: completed,
		messages: completed,
	};
	const seen = new Set<string>();
	const starts: number[] = [];
	for (let run = 0; run < 8; run += 1) {
		const fake = fixture(
			Array.from({ length: 1005 }, (_, i) => row(1400 - i)),
			[row(9999)],
		);
		let requests = 0;
		const api: ChatGptApi = {
			...fake.api,
			fetch: (path, options) => {
				if (path.startsWith("/conversations") && ++requests > 10) {
					throw new ChatGptPlannedProviderBudgetDeferredError(
						"synthetic listing cap",
						"max_detail_fetches",
					);
				}
				return fake.api.fetch(path, options);
			},
		};
		const result = await collect(api, state);
		state = result.state;
		starts.push(fake.offsets[0] ?? -1);
		for (const record of result.emitted) {
			if (record.stream === "conversations") {
				seen.add(String(record.data.id));
			}
		}
		const messages = state.messages as {
			backfill?: unknown;
			primary_backfill?: unknown;
		};
		if (
			messages.backfill === undefined &&
			messages.primary_backfill === undefined
		) {
			break;
		}
	}
	assert.ok(
		seen.has(row(9999).id),
		"search-exclusive row is reached after primary catch-up",
	);
	assert.equal(seen.size, 1006);
	assert.ok(
		starts.slice(1).some((offset) => offset > 0),
		"primary resumes",
	);
	const messages = state.messages as {
		backfill?: unknown;
		primary_backfill?: unknown;
	};
	assert.equal(messages.backfill, undefined);
	assert.equal(messages.primary_backfill, undefined);
});

test("conversation-only migration keeps bounded detail progress across runs", async () => {
	let state: CollectContext["state"] = { conversations: completed };
	const rows = Array.from({ length: 9 }, (_, i) => row(10 - i));
	const reads = new Map<string, number>();
	for (let run = 0; run < 6; run += 1) {
		const fake = fixture(rows, []);
		const result = await collect(
			fake.api,
			state,
			["conversations"],
			undefined,
			{
				runBudget: new ChatGptRunBudget({ maxFetches: 2 }),
			},
		);
		state = result.state;
		assert.ok(fake.details.size <= 2);
		for (const [id, count] of fake.details)
			reads.set(id, (reads.get(id) ?? 0) + count);
	}
	assert.equal(reads.size, rows.length);
	assert.ok([...reads.values()].every((count) => count === 1));
});

for (const names of [
	["conversations"],
	["messages"],
	["conversations", "messages"],
]) {
	for (const partialPrimary of [false, true]) {
		test(`skipped primary holds the discovery watermark across search arrivals: ${names.join("+")} partialPrimary=${partialPrimary}`, async () => {
			const anchor = row(900);
			const primaryOnly = row(1100);
			const searchOnly = row(1200);
			const primary: ConversationListItem[] = [];
			const search = [anchor];
			let interruptPrimary = partialPrimary;
			const fake = fixture(primary, search, (offset) => {
				if (interruptPrimary && offset === 100) {
					throw new ChatGptPlannedProviderBudgetDeferredError(
						"synthetic primary interruption",
						"max_detail_fetches",
					);
				}
			});
			let arrived = false;
			const api: ChatGptApi = {
				...fake.api,
				fetch: (path, options) => {
					if (!arrived && path.startsWith("/conversations/search?")) {
						// Arrivals after T0: T1 exists only in the source skipped this
						// run, while the draining search walk observes the later T2.
						arrived = true;
						if (partialPrimary) {
							primary.push(
								...Array.from({ length: 100 }, (_, i) => ({
									...row(1200 - i),
									id: `synthetic-primary-control-${i}`,
								})),
							);
						}
						primary.push(primaryOnly);
						search.unshift(searchOnly);
					}
					return fake.api.fetch(path, options);
				},
			};
			const cursor = {
				...completed,
				enumeration_version: 1,
				backfill: {
					position_hint: 30,
					oldest_update_time: iso(900),
					boundary_ids: [anchor.id],
				},
			};
			const first = await collect(
				api,
				Object.fromEntries(names.map((name) => [name, cursor])),
				names,
			);
			assert.equal(
				fake.offsets.length,
				0,
				"search drains before primary restarts",
			);
			assert.equal(fake.details.has(primaryOnly.id), false);
			for (const name of names) {
				assert.equal(
					(first.state[name] as typeof cursor).last_update_time,
					completed.last_update_time,
					"unread primary interval cannot advance from T0 to T2",
				);
				assert.ok(
					!first.protocolMessages.some(
						(message) =>
							message.type === "DETAIL_COVERAGE" && message.stream === name,
					),
				);
				assert.equal(
					(first.state[name] as { backfill?: unknown }).backfill,
					undefined,
					"the saved search continuation was drained",
				);
			}
			const second = await collect(api, first.state, names);
			assert.ok(fake.offsets.length > 0, "the next run really reads primary");
			let finalRun = second;
			if (partialPrimary) {
				assert.equal(
					fake.details.has(primaryOnly.id),
					false,
					"T1 is beyond the interrupted primary prefix",
				);
				for (const name of names) {
					assert.equal(
						(second.state[name] as typeof cursor).last_update_time,
						completed.last_update_time,
					);
					assert.ok(
						!second.protocolMessages.some(
							(message) =>
								message.type === "DETAIL_COVERAGE" && message.stream === name,
						),
					);
					assert.ok(
						(second.state[name] as { primary_backfill?: unknown })
							.primary_backfill,
					);
				}
				interruptPrimary = false;
				finalRun = await collect(api, second.state, names);
			}
			assert.equal(
				fake.details.get(primaryOnly.id),
				1,
				"T1 is hydrated exactly once",
			);
			for (const name of names) {
				assert.equal(
					[
						...first.emitted,
						...second.emitted,
						...(partialPrimary ? finalRun.emitted : []),
					].filter(
						(record) =>
							record.stream === name &&
							(name === "conversations"
								? record.data.id === primaryOnly.id
								: record.data.conversation_id === primaryOnly.id),
					).length,
					1,
				);
				assert.equal(
					(finalRun.state[name] as typeof cursor).last_update_time,
					iso(1200),
				);
				assert.ok(
					finalRun.protocolMessages.some(
						(message) =>
							message.type === "DETAIL_COVERAGE" && message.stream === name,
					),
				);
			}
		});
	}
}
