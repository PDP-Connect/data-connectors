// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { runOnPageShim, type ShimPage } from "../runtime.ts";

declare const PAGESHIM_OPS_SCENARIO: string;
const STREAMS = ["conversations", "memories", "projects", "tags", "notes"];
const windowed = PAGESHIM_OPS_SCENARIO === "windowed";

(globalThis as Record<string, unknown>).__pageshimMain = (
	page: ShimPage,
	initialState: Record<string, unknown>,
	supportsState: boolean,
) =>
	runOnPageShim(
		page,
		{
			platform: "chatgpt",
			scopes: STREAMS.map((s) => `chatgpt.${s}`),
			version: "1.0.0",
			loginUrl: "https://chatgpt.test/",
			loginMessage: "Sign in",
			validateRecord: (_stream, data) => ({ ok: true, data }) as never,
			isTombstone: (_stream, data) => data.deleted === true,
			prepareRequested: (requested) => {
				if (windowed)
					Object.assign(requested.get("conversations") ?? {}, {
						time_range: { until: "2026-10-22T00:00:00.000Z" },
					});
			},
			probe: async () => true,
			collect: async ({ emit, emitRecord }) => {
				if (windowed) {
					await emitRecord("conversations", {
						id: "kept",
						update_time: "2026-10-21T00:00:00.000Z",
					});
					await emitRecord("conversations", {
						id: "withheld",
						update_time: "2026-10-22T00:00:00.000Z",
					});
					return;
				}
				// conversations: a live upsert and a delete (ynab-shaped tombstone).
				await emitRecord("conversations", { id: "c1" });
				await emitRecord("conversations", { id: "c2", deleted: true });
				// memories: a record, then a skip that leaves it partial.
				await emitRecord("memories", { id: "m1" });
				await emit({
					type: "SKIP_RESULT",
					stream: "memories",
					reason: "stream_collection_failed",
					message: "boom",
				});
				// projects: a record, then a detail gap.
				await emitRecord("projects", { id: "p1" });
				await emit({ type: "DETAIL_GAP", stream: "projects" });
				// tags: no records, inventory confirmed empty by a checkpoint.
				await emit({ type: "STATE", stream: "tags", cursor: { c: 1 } });
				// notes: nothing at all.
			},
			toScope: (_stream, records) => ({ records }),
			streamScopeRecords: {
				order: ["conversations"],
				summarizeCounts: (counts: Record<string, number>) => ({
					count: counts.conversations ?? 0,
					label: "conversations",
					details: {},
				}),
			},
			summarize: () => ({ count: 0, label: "conversations", details: {} }),
		},
		initialState,
		supportsState,
	);
