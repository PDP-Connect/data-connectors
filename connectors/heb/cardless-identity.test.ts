// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { EmittedMessage } from "@pdpp/connector-protocol";
import { chromium, type Page } from "playwright";
import type { BrowserCollectContext } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { makeRecordingEmit } from "../../packages/polyfill-connectors/src/test-harness.ts";
import {
	fetchOrderDetail,
	type RunFlags,
	recoverPendingOrderItemDetailGaps,
} from "./index.ts";
import { validateRecord } from "./schemas.ts";

// The repo's captured order-detail page: <li data-qe-id="itemRow"> rows with no
// data-index and no aria-posinset, in the document flow, three product lines.
// A recovery attempt has no card count, a canceled order's card says 0, and a
// refunded order's card can fall below its rows. None of these may stop a
// static, fully mounted list from being keyed by content.

const FIXTURES_DIR = join(
	dirname(fileURLToPath(import.meta.url)),
	"__fixtures__",
);
const fixture = (name: string): string =>
	readFileSync(join(FIXTURES_DIR, name), "utf8");

const immediateWait = (): Promise<void> => Promise.resolve();

async function withDetailPage<T>(
	html: string,
	run: (page: Page) => Promise<T>,
): Promise<T> {
	const browser = await chromium.launch({ headless: true });
	try {
		const page = await browser.newPage();
		await page.route(
			"https://www.heb.com/my-account/order-history/**",
			async (route) => {
				await route.fulfill({ body: html, contentType: "text/html" });
			},
		);
		return await run(page);
	} finally {
		await browser.close();
	}
}

const CAPTURED_CASES: readonly {
	card: number | undefined;
	name: string;
}[] = [
	{ name: "no card count (gap recovery)", card: undefined },
	{ name: "a card below the rows (refunded order)", card: 2 },
	{ name: "a card of 0 (canceled order)", card: 0 },
];

for (const { name, card } of CAPTURED_CASES) {
	test(`fetchOrderDetail: the captured detail page hydrates with ${name}`, async () => {
		await withDetailPage(fixture("order-detail.html"), async (page) => {
			const result = await fetchOrderDetail(page, "HEB1000000001", {
				detailSurfaceTimeoutMs: 5_000,
				...(card === undefined ? {} : { expectedItemCount: card }),
				waitForHydration: immediateWait,
			});
			assert.equal(result.status, "hydrated");
			assert.equal(
				result.status === "hydrated" ? result.detail.items.length : 0,
				3,
			);
		});
	});
}

test("fetchOrderDetail: a 20-row static list in the document flow hydrates without a card", async () => {
	await withDetailPage(
		fixture("order-detail-static-tall.html"),
		async (page) => {
			const result = await fetchOrderDetail(page, "HEB1000000001", {
				detailSurfaceTimeoutMs: 5_000,
				waitForHydration: immediateWait,
			});
			assert.equal(result.status, "hydrated");
			assert.equal(
				result.status === "hydrated" ? result.detail.items.length : 0,
				20,
			);
		},
	);
});

for (const name of [
	"order-detail-unattributed-large-virtualized.html",
	"order-detail-virtualized-ambiguous-repeat.html",
	"order-detail-missing-row-identity.html",
	"order-detail-unanchored-remount.html",
]) {
	test(`fetchOrderDetail: ${name} still fails closed without a card`, async () => {
		await withDetailPage(fixture(name), async (page) => {
			const result = await fetchOrderDetail(page, "HEB1000000001", {
				detailSurfaceTimeoutMs: 4_000,
				waitForHydration: immediateWait,
			});
			assert.equal(
				result.status,
				"failed",
				"a list that scrolls inside its own port, remounts, or hides rows cannot be proven complete without a card",
			);
		});
	});
}

test("fetchOrderDetail: a document-flow virtualizer fails closed without a card because rows unmount", async () => {
	await withDetailPage(
		fixture("order-detail-document-virtualized.html"),
		async (page) => {
			const result = await fetchOrderDetail(page, "HEB1000000001", {
				detailSurfaceTimeoutMs: 6_000,
				waitForHydration: immediateWait,
			});
			assert.equal(result.status, "failed");
			assert.notEqual(
				result.status === "failed" ? result.failureKind : null,
				"detail_surface_error",
				"it is keyed by content, then refused because no structural proof of a complete list exists",
			);
		},
	);
});

test("gap recovery hydrates an old order from the captured page and closes its gap", async () => {
	await withDetailPage(fixture("order-detail.html"), async (page) => {
		const harness = makeRecordingEmit(validateRecord);
		const flags: RunFlags = {
			detailAttempts: 0,
			isManualRun: false,
			manualRepairAttempted: false,
			sessionRepairRequired: false,
		};
		const result = await recoverPendingOrderItemDetailGaps(
			page,
			{
				detailGaps: [
					{
						gap_id: "gap_old",
						record_key: "HEB1000000001",
						reference_only: true,
						status: "pending",
						stream: "order_items",
						detail_locator: {
							kind: "heb.order_detail",
							order_id: "HEB1000000001",
							order_date: "2025-10-04",
						},
					},
				],
				emit: harness.emit,
				emitRecord: harness.emitRecord,
				emittedAt: "2026-10-17T12:00:00.000Z",
				sendInteraction: (): ReturnType<
					BrowserCollectContext["sendInteraction"]
				> => {
					throw new Error("sendInteraction should not be called");
				},
				waitForHydration: immediateWait,
			},
			flags,
		);
		assert.equal(result.recovered, 1);
		assert.equal(result.stoppedWithPending, false);
		const messages: EmittedMessage[] = harness.protocolMessages;
		assert.equal(
			messages.filter((message) => message.type === "DETAIL_GAP_RECOVERED")
				.length,
			1,
		);
		assert.equal(
			messages.filter((message) => message.type === "DETAIL_GAP").length,
			0,
			"the gap is closed, not re-deferred",
		);
		assert.equal(
			harness.emitted.filter((record) => record.stream === "order_items")
				.length,
			3,
		);
	});
});
