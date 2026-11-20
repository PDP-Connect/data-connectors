// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import { makeRecordingEmit } from "../../packages/polyfill-connectors/src/test-harness.ts";
import { collectShopify } from "./index.ts";
import { validateRecord } from "./schemas.ts";
import type { ApolloCache } from "./types.ts";

// Same cumulative Apollo connection snapshots and order rows as index.test.ts's
// connected cursor-chain fixture. Each scroll exposes one later page.
const expected = [1, 2, 3, 4].map((id) => `gid://shopify/Order/${id}`);
function cacheThrough(page: number): ApolloCache {
	const root: Record<string, unknown> = {
		viewer: { __ref: "Customer:current" },
	};
	const cache: ApolloCache = {
		ROOT_QUERY: root,
		"Customer:current": { id: "gid://shopify/Customer/current" },
		"Shop:acme": { name: "Acme Goods" },
	};
	for (let i = 1; i <= page; i += 1) {
		const ref = `Order:${i}`;
		const args =
			i === 1 ? { first: 10 } : { first: 10, after: `cursor-${i - 1}` };
		root[`deliveriesOrdersList(${JSON.stringify(args)})`] = {
			nodes: [{ __ref: ref }],
			totalCount: expected.length,
			pageInfo: { hasNextPage: i < expected.length, endCursor: `cursor-${i}` },
		};
		cache[ref] = {
			id: expected[i - 1],
			createdAt: "2024-05-01T18:22:05.000Z",
			displayStatus: "FULFILLED",
			shop: { __ref: "Shop:acme" },
			effectiveTotalPrice: { amount: "10.00", currencyCode: "USD" },
			totalItemCount: 1,
			lineItems: { nodes: [] },
		};
	}
	return cache;
}

async function walk(state: Record<string, unknown> = {}, stop = false) {
	const run = makeRecordingEmit(validateRecord);
	let page = 1,
		failedReads = 0;
	const observed = new Set<number>();
	await collectShopify({
		emit: run.emit,
		emitRecord: run.emitRecord,
		progress: async () => undefined,
		requested: new Map([["orders", { name: "orders" }]]),
		state,
		cacheWaitTimeoutMs: 0,
		wait: async () => undefined,
		readCache: async () => {
			if (stop && page === 3) {
				failedReads += 1;
				throw new Error("synthetic third-page cache read failure");
			}
			observed.add(page);
			return cacheThrough(page);
		},
		scroll: async () => {
			page = Math.min(page + 1, stop ? 3 : expected.length);
		},
	});
	const messages = run.protocolMessages;
	const last = messages.filter((message) => message.type === "STATE").at(-1);
	return {
		ids: run.emitted
			.filter((entry) => entry.stream === "orders")
			.map((entry) => entry.data.id),
		cursor: last?.type === "STATE" ? last.cursor : undefined,
		coverage: messages.filter((message) => message.type === "DETAIL_COVERAGE"),
		skips: messages.filter((message) => message.type === "SKIP_RESULT"),
		failedReads,
		observed: [...observed],
	};
}

test("Shop order history reaches four unique pages and restarts safely after a retryable stop", async () => {
	const complete = await walk();
	assert.deepEqual(complete.observed, [1, 2, 3, 4]);
	assert.deepEqual([...complete.ids].sort(), expected);
	assert.ok(complete.cursor && typeof complete.cursor === "object");
	assert.equal(
		"resume" in complete.cursor || "continuation" in complete.cursor,
		false,
	);
	assert.deepEqual(complete.skips, []);

	const stopped = await walk({}, true);
	assert.ok(stopped.failedReads > 0);
	assert.deepEqual(stopped.observed, [1, 2]);
	assert.equal(stopped.coverage.length, 0);
	assert.ok(
		stopped.skips.some(
			(row) =>
				row.type === "SKIP_RESULT" &&
				typeof row.recovery_hint === "object" &&
				row.recovery_hint.retryable === true,
		),
	);
	assert.ok(
		stopped.ids.every((id) => expected.slice(0, 2).includes(String(id))),
	);
	// This revision emits no checkpoint on an incomplete walk; retry starts from the head.
	assert.equal(stopped.cursor, undefined);
	const resumed = await walk(
		stopped.cursor === undefined ? {} : { orders: stopped.cursor },
	);
	assert.deepEqual(resumed.observed, [1, 2, 3, 4]);
	assert.deepEqual(
		[...new Set([...stopped.ids, ...resumed.ids])].sort(),
		expected,
	);
	assert.deepEqual(resumed.cursor, complete.cursor);
	assert.deepEqual(resumed.skips, []);
});
