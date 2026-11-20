#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PDPP DoorDash Connector (v0.2.0) — order history via GraphQL response capture.
 *
 * Streams: doordash.orders, doordash.order_items (per capability-map.json,
 * lane cut-doordash: doordash.orders splits into the two per D3).
 *
 * ## Acquisition strategy
 *
 * DoorDash's orders page (https://www.doordash.com/orders) fires a
 * `getConsumerOrdersWithDetails` GraphQL request as its own SPA loads. The
 * legacy Playwright scraper (data-connectors/doordash/doordash-playwright.js)
 * confirmed this endpoint name and used `page.captureNetwork` keyed on it,
 * plus a DOM-scrape fallback when the network capture came back empty. This
 * connector captures the SAME response with a plain Playwright
 * `page.waitForResponse` (no bespoke capture API — Patchright/Playwright's
 * response object is enough), and does not fall back to DOM scraping: the
 * authoring guide's structure-over-text rule (§2) says DOM scraping is a last
 * resort, and this connector has an evidenced network-response path, so a
 * duplicate/inconsistent DOM path only adds a second thing that can drift.
 * If the GraphQL response never arrives, the run reports a SKIP_RESULT
 * (`doordash_orders_response_not_observed`) instead of guessing from the DOM.
 *
 * Pagination: DoorDash's orders page infinite-scrolls, firing a repeat
 * `getConsumerOrdersWithDetails` request as the owner (or an automated
 * scroll) nears the bottom. Scroll until an observed, structurally valid
 * empty orders response; stop as partial on silence, unreadable responses,
 * or two consecutive responses with no new IDs.
 *
 * ## Incremental cursor — NOT implemented; full refresh only
 *
 * Neither the legacy scraper nor any other evidence available to this lane
 * shows a `getConsumerOrdersWithDetails` request carrying an `after`/`offset`
 * cursor parameter, a `hasMore` field, or a stable "next page token" in its
 * response envelope — the legacy code's own pagination is scroll-triggered
 * and stops on "no new orders in this scroll", which is an anti-duplicate
 * heuristic, not a documented cursor contract. Per the authoring guide §6
 * ("don't invent cursors where the platform has none") and the task's
 * explicit instruction to default to full refresh when a stable stop
 * condition can't be justified, this connector performs a FULL REFRESH every
 * run: it walks the order list from the top on every invocation and does
 * not persist or consult a STATE cursor. An interrupted run starts over.
 * The connector manifest reflects this (`incremental: false`,
 * `coverage_strategy: full_inventory`). Re-evaluate this once a live capture
 * shows the real request/response shape.
 *
 * ## Money
 *
 * DoorDash's GraphQL money envelope (`{ unitAmount, displayString }`) is
 * already integer minor units in `unitAmount` — no scaling needed. See
 * `parsers.ts#centsFromMonetary`.
 *
 * ## Auth
 *
 * Session-based via the shared Playwright persistent profile
 * (`browser: { profileName: "doordash" }`), same posture as Amazon/Reddit:
 * try the profile's existing session first, fall back to automated
 * email/password login (env `DOORDASH_USERNAME`/`DOORDASH_PASSWORD`), then
 * manual browser hand-off. DoorDash's login form is multi-step
 * (email → Continue → password → Submit) per the legacy scraper.
 *
 * ## Live-verified 2026-09-22 (cut-doordash-live lane)
 *
 * Two live runs against a real, freshly-authenticated DoorDash account
 * (`www.doordash.com/orders`, confirmed not `identity.doordash.com`)
 * captured the real `getConsumerOrdersWithDetails` response: 3 orders,
 * identical ids across both runs (full-refresh consistency, no dupes). The
 * real response did NOT carry `deliveryStatus` or `orderItems` on any of
 * the 3 orders (both fields absent, not empty-array) — `status` and
 * `item_count` correctly resolve to `null` for every record, and no
 * `order_items` records were ever emitted (there is nothing to emit). No
 * `payment_method_summary` source field was observed, confirming the
 * pre-existing null-only decision below. No incremental cursor/`hasMore`/
 * `after` param was observed on the real request either, confirming the
 * full-refresh design. `fixtures/doordash/scrubbed/pilot-real-shape/` is
 * now populated, calibrated by this capture's null/non-null field pattern
 * (no real owner values committed — see the pilot-fixture.test.ts header
 * and the lane report's Live evidence section). A negative control against
 * a fresh empty profile root confirmed the connector fails honestly
 * (`doordash_login_manual_incomplete`, landing on `identity.doordash.com`)
 * instead of reporting a false empty success.
 *
 * CHANGES
 *   v0.2.0 (2026-09-22) — real GraphQL response-capture collector; parsers.ts
 *     extracted and unit-tested against synthetic fixtures; full-refresh
 *     cursor policy (no evidenced incremental cursor). Live-verified same
 *     day (see above) after the session-probe host-detection fix.
 *   v0.1.0 (2026-04-19) — scaffold: session reachability probe only,
 *     unconditional SKIP_RESULT.
 */

import { isMainModule } from "@pdpp/connector-protocol";
import type { Page, Response } from "playwright";
import { ensureDoorDashSession } from "../../packages/polyfill-connectors/src/auto-login/doordash.ts";
import { connectorDiagnostic } from "../../packages/polyfill-connectors/src/connector-diagnostic.ts";
import {
	type BrowserCollectContext,
	buildDetailCoverageMessage,
	type EnsureSessionArgs,
	type ProbeSessionArgs,
	politeDelay,
	runConnector,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import {
	orderItemRecords,
	orderRecord,
	parseOrdersResponse,
} from "./parsers.ts";
import { validateRecord } from "./schemas.ts";
import type { DoorDashOrderNode } from "./types.ts";

const SESSION_COOKIE = /^(session_id|dd_login|_cfuvid)$/;
const ORDERS_GRAPHQL_URL_RE = /getConsumerOrdersWithDetails/i;
const ORDERS_URL = "https://www.doordash.com/orders";

const SCROLL_SETTLE_MS = 3000;
const RESPONSE_WAIT_TIMEOUT_MS = 12_000;

export const DOORDASH_RETRYABLE_PATTERN =
	/ECONN|ETIMEDOUT|fetch failed|net::ERR_/i;

// ─── Network capture ─────────────────────────────────────────────────────

/**
 * Wait for the next `getConsumerOrdersWithDetails` response after triggering
 * `action` (a navigation or scroll). Neither a timeout nor unreadable JSON
 * certifies exhaustion.
 */
export type OrdersResponse =
	| { kind: "none" }
	| { kind: "unreadable" }
	| { kind: "body"; body: unknown };

export async function waitForOrdersResponse(
	page: Page,
	action: () => Promise<void>,
): Promise<OrdersResponse> {
	const responsePromise = page
		.waitForResponse((res: Response) => ORDERS_GRAPHQL_URL_RE.test(res.url()), {
			timeout: RESPONSE_WAIT_TIMEOUT_MS,
		})
		.catch((): null => null);
	await action();
	const response = await responsePromise;
	if (!response) {
		return { kind: "none" };
	}
	try {
		return { kind: "body", body: await response.json() };
	} catch {
		return { kind: "unreadable" };
	}
}

// ─── Collect ─────────────────────────────────────────────────────────────

type IncompleteReason =
	| "response_not_observed"
	| "unreadable_response"
	| "no_new_order_ids";

export interface CollectOrdersResult {
	nodes: DoorDashOrderNode[];
	truncated: boolean;
	stopReason: IncompleteReason | null;
}

// Require the known fixture envelope for empty-list evidence. The parser's
// [] fallback also covers malformed/unrecognized inputs, so [] alone is
// not proof. Keep using the parser for nonempty responses.
function isObservedEmptyOrders(body: unknown): boolean {
	const envelope = body as {
		data?: { consumer?: { ordersWithDetails?: { orders?: unknown } } };
	} | null;
	const orders = envelope?.data?.consumer?.ordersWithDetails?.orders;
	return Array.isArray(orders) && orders.length === 0;
}

function readOrdersPage(
	response: OrdersResponse,
):
	| { kind: "orders"; orders: DoorDashOrderNode[] }
	| { kind: IncompleteReason } {
	if (response.kind === "none") return { kind: "response_not_observed" };
	if (response.kind === "unreadable") return { kind: "unreadable_response" };
	const errors = (response.body as { errors?: unknown } | null)?.errors;
	if (errors != null && (!Array.isArray(errors) || errors.length > 0)) {
		return { kind: "unreadable_response" };
	}
	const orders = parseOrdersResponse(response.body);
	if (orders.length > 0 || isObservedEmptyOrders(response.body)) {
		return { kind: "orders", orders };
	}
	return { kind: "unreadable_response" };
}

/**
 * Walk the orders page, capturing every `getConsumerOrdersWithDetails`
 * response as the page loads and then as it's scrolled. Dedupes by
 * `orderUuid` across pages (DoorDash's scroll-triggered refetch can overlap
 * the previous page). Injected `waitForResponseFn` + `scrollFn` so this is
 * testable without a real Playwright page.
 */
export async function collectOrderNodes(args: {
	page: Page;
	/** Pacing delay between scroll pages. Defaults to politeDelay(3000ms).
	 *  Tests can inject a no-op. */
	delay?: (ms: number) => Promise<void>;
	progress?: (
		message: string,
		extra?: Record<string, unknown>,
	) => Promise<void>;
	scrollFn?: (page: Page) => Promise<void>;
	waitForResponseFn?: typeof waitForOrdersResponse;
}): Promise<CollectOrdersResult> {
	const { page, progress } = args;
	const delay = args.delay ?? politeDelay;
	const scrollFn =
		args.scrollFn ??
		(async (p: Page): Promise<void> => {
			await p.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
		});
	const waitForResponseFn = args.waitForResponseFn ?? waitForOrdersResponse;

	const seen = new Set<string>();
	const nodes: DoorDashOrderNode[] = [];

	const addNodes = (newNodes: DoorDashOrderNode[]): number => {
		let added = 0;
		for (const node of newNodes) {
			const id = node.orderUuid;
			// A node with no orderUuid can't be deduped across pages — keep it
			// (don't drop it silently here); collectAllStreams reports it as a
			// shape anomaly via PROGRESS rather than swallowing it at this
			// layer. Only an already-seen id is a true duplicate to skip.
			if (id && seen.has(id)) {
				continue;
			}
			if (id) {
				seen.add(id);
				added += 1;
			}
			nodes.push(node);
		}
		return added;
	};

	let zeroAddResponses = 0;
	const collectPage = async (
		pageIndex: number,
	): Promise<"advance" | "exhausted" | IncompleteReason> => {
		const response = await waitForResponseFn(page, async () => {
			if (pageIndex === 0) {
				await page
					.goto(ORDERS_URL, { waitUntil: "domcontentloaded", timeout: 30_000 })
					.catch((): undefined => undefined);
			} else {
				await scrollFn(page);
			}
		});
		const parsed = readOrdersPage(response);
		if (parsed.kind !== "orders") return parsed.kind;
		if (parsed.orders.length === 0) return "exhausted";

		const added = addNodes(parsed.orders);
		await progress?.("Fetched DoorDash orders page", {
			phase: "page",
			page_index: pageIndex,
			item_count: nodes.length,
		});
		// The initial navigation isn't a repeat; one later fetch may overlap.
		if (pageIndex > 0) {
			zeroAddResponses = added === 0 ? zeroAddResponses + 1 : 0;
			if (zeroAddResponses >= 2) return "no_new_order_ids";
			await delay(SCROLL_SETTLE_MS);
		}
		return "advance";
	};

	for (let pageIndex = 0; ; pageIndex += 1) {
		const result = await collectPage(pageIndex);
		if (result === "exhausted") {
			return { nodes, truncated: false, stopReason: null };
		}
		if (result !== "advance") {
			return { nodes, truncated: true, stopReason: result };
		}
	}
}

export async function collectAllStreams(
	ctx: BrowserCollectContext,
	/** Pacing delay between scroll pages, forwarded to collectOrderNodes.
	 *  Defaults to politeDelay(3000ms); tests inject a no-op. */
	delay?: (ms: number) => Promise<void>,
): Promise<void> {
	const { emit, emitRecord, page, progress, requested } = ctx;

	const wantsOrders = requested.has("orders");
	const wantsItems = requested.has("order_items");
	if (!(wantsOrders || wantsItems)) {
		return;
	}

	const { nodes, stopReason } = await collectOrderNodes({
		page,
		progress,
		...(delay ? { delay } : {}),
	});

	let ordersConsidered = 0;
	let ordersCovered = 0;
	let itemsCovered = 0;
	let itemsConsidered = 0;

	for (const node of nodes) {
		const order = orderRecord(node);
		if (!order) {
			// No orderUuid — the platform's own primary key is absent; skip
			// silently is wrong here, report it as a record-level shape anomaly
			// (PROGRESS, not a stream SKIP_RESULT: one bad node must not drop every
			// order) so drift is visible rather than swallowed. The node still
			// counts as considered and not covered.
			ordersConsidered += 1;
			if (wantsOrders) {
				connectorDiagnostic("doordash", "shape_check_failed", {
					stream: "orders",
					reason: "order node missing orderUuid",
				});
				await emit({
					type: "PROGRESS",
					stream: "orders",
					message: "Skipped an order DoorDash returned without an ID",
				});
			}
			continue;
		}
		ordersConsidered += 1;
		if (wantsOrders) {
			const validation = validateRecord("orders", order);
			if (validation.ok) {
				ordersCovered += 1;
			}
			await emitRecord("orders", order);
		}

		if (wantsItems) {
			const items = orderItemRecords(order.id, node.orderItems);
			itemsConsidered += items.length;
			for (const item of items) {
				const validation = validateRecord("order_items", item);
				if (validation.ok) {
					itemsCovered += 1;
				}
				await emitRecord("order_items", item);
			}
		}
	}

	if (stopReason !== null) {
		const reportPartial = async (stream: string): Promise<void> => {
			await emit({
				type: "SKIP_RESULT",
				stream,
				reason:
					nodes.length === 0 && stopReason === "response_not_observed"
						? "doordash_orders_response_not_observed"
						: "older_pages_deferred_page_budget",
				// Silence and stalls are transient; an unreadable body may be a changed response shape.
				recovery_hint:
					stopReason === "unreadable_response"
						? { action: "retry_on_connector_upgrade", retryable: false }
						: { action: "retry_by_runtime", retryable: true },
				message:
					"We couldn't verify that all DoorDash orders were read. A new run will start at the newest orders.",
				diagnostics: { total_seen: nodes.length, stop_reason: stopReason },
			});
		};
		if (wantsOrders) await reportPartial("orders");
		if (wantsItems) await reportPartial("order_items");
	}

	if (wantsOrders) {
		await emit(
			buildDetailCoverageMessage({
				stream: "orders",
				stateStream: "orders",
				requiredKeys: [],
				hydratedKeys: [],
				considered: ordersConsidered,
				covered: ordersCovered,
			}),
		);
	}
	if (wantsItems) {
		await emit(
			buildDetailCoverageMessage({
				stream: "order_items",
				stateStream: "order_items",
				requiredKeys: [],
				hydratedKeys: [],
				considered: itemsConsidered,
				covered: itemsCovered,
			}),
		);
	}

	// Full refresh only (see header comment) — no STATE cursor is emitted for
	// either stream. Emitting a STATE message here would imply a resumable
	// incremental cursor this connector cannot honestly claim.
}

// ─── Entry ──────────────────────────────────────────────────────────────

export async function doorDashEnsureSession(
	args: EnsureSessionArgs,
): Promise<void> {
	await ensureDoorDashSession({
		assist: args.assist,
		capture: args.capture,
		checkpoint: args.checkpoint,
		completeAssistance: args.completeAssistance,
		context: args.context,
		credentials: args.credentials,
		onCredentialSubmit: args.onCredentialSubmit,
		page: args.page,
		sendInteraction: args.sendInteraction,
	});
}

if (isMainModule(import.meta.url)) {
	runConnector({
		name: "doordash",
		browser: { profileName: "doordash" },
		validateRecord,
		retryablePattern: DOORDASH_RETRYABLE_PATTERN,
		auth: { kind: "env", required: ["DOORDASH_USERNAME", "DOORDASH_PASSWORD"] },
		authOptional: true,
		ensureSession: doorDashEnsureSession,
		async probeSession({ context }: ProbeSessionArgs): Promise<boolean> {
			const cookies = await context.cookies("https://www.doordash.com/");
			return cookies.some(
				(c) => SESSION_COOKIE.test(c.name) && Boolean(c.value),
			);
		},
		async collect(ctx: BrowserCollectContext): Promise<void> {
			await collectAllStreams(ctx);
		},
	});
}
