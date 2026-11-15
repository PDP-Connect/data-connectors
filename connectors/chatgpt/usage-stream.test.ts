// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import type { StreamDeps } from "./index.ts";
import { validateRecord } from "./schemas.ts";
import { runUsageStreams } from "./usage-stream.ts";

for (const missingPage of [0, 1]) {
	test(`shared listing 404 on page ${missingPage} leaves summary count unknown`, async () => {
		const offsets: number[] = [];
		const emitted: Array<{ stream: string; record: Record<string, unknown> }> =
			[];
		const api = {
			async fetch(path: string) {
				if (path.startsWith("/shared_conversations?")) {
					const offset = Number(
						new URL(path, "https://fixture.invalid").searchParams.get("offset"),
					);
					offsets.push(offset);
					if (offset === missingPage * 100) return { status: 404, json: null };
					assert.equal(offset, 0);
					return {
						status: 200,
						json: {
							total: 200,
							items: Array.from({ length: 100 }, (_, i) => ({
								conversation_id: `share-${i}`,
							})),
						},
					};
				}
				// One listed conversation: with none, a shared count of 0 is
				// correct whatever the shared listing says.
				if (path.startsWith("/conversations?"))
					return {
						status: 200,
						json: path.includes("is_archived=true")
							? { items: [] }
							: {
									items: [
										{
											id: "conv-1",
											title: "fixture",
											create_time: 1_700_000_000,
											update_time: 1_700_000_000,
										},
									],
								},
					};
				if (path.startsWith("/conversation/"))
					return { status: 404, json: null };
				if (path === "/gizmos/snorlax/sidebar")
					return {
						status: 200,
						json: { item_count: 0, project_ids: [], has_more: false },
					};
				if (path === "/cdn-cgi/trace") return { status: 200, json: {} };
				assert.fail(`Unexpected request: ${path}`);
			},
		} as StreamDeps["api"];
		const deps: StreamDeps = {
			api,
			requested: new Map([["usage_summary", { name: "usage_summary" }]]),
			emit: async () => {},
			emitRecord: async (stream, record) => {
				emitted.push({ stream, record });
			},
			progress: async () => {},
		};
		await runUsageStreams(
			deps,
			{},
			{ classifyError: () => "other", accountsCheckPath: "/accounts/check" },
		);
		assert.deepEqual(offsets, missingPage === 0 ? [0] : [0, 100]);
		assert.equal(emitted.length, 1);
		assert.equal(emitted[0]?.stream, "usage_summary");
		const summary = emitted[0]!.record;
		assert.equal(validateRecord("usage_summary", summary).ok, true);
		assert.equal((summary.totals as Record<string, unknown>).shared, null);
	});
}
