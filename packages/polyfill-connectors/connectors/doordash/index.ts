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
 * scroll) nears the bottom. Same approach as the legacy scraper: scroll,
 * capture, repeat, stop when a scroll yields no new orders or a page-count
 * ceiling is hit (`MAX_SCROLL_PAGES`, mirrors Reddit's `MAX_PAGES` safety
 * cap pattern from src/page-ceiling.ts).
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
 * run: it walks the order list from the top on every invocation, bounded by
 * `MAX_SCROLL_PAGES`, and does not persist or consult a STATE cursor.
 * `manifests/doordash.json` reflects this (`incremental: false`,
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
 * ## PENDING — no live account access for this lane
 *
 * No DoorDash account has been connected for this lane ("PROFILE READY" has
 * not been sent). Every field-shape decision above comes from the legacy
 * scraper's own response walk and DoorDash's documented public GraphQL money
 * convention, not a live capture. `__fixtures__/synthetic/` is therefore a
 * hand-authored, clearly-labeled SYNTHETIC fixture, not a scrubbed real
 * capture — `fixtures/doordash/scrubbed/pilot-real-shape/` stays absent
 * until a real capture is scrubbed and reviewed (see the cut-doordash lane
 * report for the exact proof-gate status). Whoever gets live access MUST:
 *   1. Run with `PDPP_CAPTURE_FIXTURES=1` and inspect the raw
 *      `getConsumerOrdersWithDetails` response shape.
 *   2. Re-verify every field path in parsers.ts against the real shape
 *      (especially `payment_method_summary`, which this connector currently
 *      always emits null for — no observed source carries it).
 *   3. Decide whether a real incremental cursor exists; if so, replace the
 *      full-refresh design above and update the manifest.
 *
 * CHANGES
 *   v0.2.0 (2026-09-22) — real GraphQL response-capture collector; parsers.ts
 *     extracted and unit-tested against synthetic fixtures; full-refresh
 *     cursor policy (no evidenced incremental cursor).
 *   v0.1.0 (2026-04-19) — scaffold: session reachability probe only,
 *     unconditional SKIP_RESULT.
 */

import { isMainModule } from "@pdpp/connector-protocol";
import type { Page, Response } from "playwright";
import { ensureDoorDashSession } from "../../src/auto-login/doordash.ts";
import {
	type BrowserCollectContext,
	buildDetailCoverageMessage,
	type EnsureSessionArgs,
	type ProbeSessionArgs,
	politeDelay,
	runConnector,
} from "../../src/connector-runtime.ts";
import { walkPagesWithCeiling } from "../../src/page-ceiling.ts";
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

/** Scroll-triggered pagination safety ceiling. Mirrors Reddit's MAX_PAGES —
 *  a generous bound for one run, not a claim about how many pages DoorDash
 *  actually has. See the full-refresh note in the header comment: there is
 *  no evidenced cursor to resume from, so this only bounds a single run's
 *  work, not cross-run continuation. */
export const MAX_SCROLL_PAGES = 20;
const SCROLL_SETTLE_MS = 3000;
const RESPONSE_WAIT_TIMEOUT_MS = 12_000;

export const DOORDASH_RETRYABLE_PATTERN =
	/ECONN|ETIMEDOUT|fetch failed|net::ERR_/i;

// ─── Network capture ─────────────────────────────────────────────────────

/**
 * Wait for the next `getConsumerOrdersWithDetails` response after triggering
 * `action` (a navigation or scroll). Returns `null` on timeout — the caller
 * treats that as "no more pages" rather than an error, since DoorDash simply
 * stops firing the request once the list is exhausted.
 */
export async function waitForOrdersResponse(
	page: Page,
	action: () => Promise<void>,
): Promise<unknown> {
	const responsePromise = page
		.waitForResponse((res: Response) => ORDERS_GRAPHQL_URL_RE.test(res.url()), {
			timeout: RESPONSE_WAIT_TIMEOUT_MS,
		})
		.catch((): null => null);
	await action();
	const response = await responsePromise;
	if (!response) {
		return null;
	}
	try {
		return await response.json();
	} catch {
		return null;
	}
}

// ─── Collect ─────────────────────────────────────────────────────────────

export interface CollectOrdersResult {
	nodes: DoorDashOrderNode[];
	truncated: boolean;
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
	 *  Tests inject a no-op so they don't sleep through MAX_SCROLL_PAGES
	 *  iterations. */
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
			// shape anomaly via SKIP_RESULT rather than swallowing it at this
			// layer. Only an already-seen id is a true duplicate to skip.
			if (id && seen.has(id)) {
				continue;
			}
			if (id) {
				seen.add(id);
			}
			nodes.push(node);
			added += 1;
		}
		return added;
	};

	// Page 1: the orders page's own initial load fires the query.
	const initialBody = await waitForResponseFn(page, async () => {
		await page
			.goto(ORDERS_URL, { waitUntil: "domcontentloaded", timeout: 30_000 })
			.catch((): undefined => undefined);
	});
	if (initialBody) {
		addNodes(parseOrdersResponse(initialBody));
	}
	await progress?.("Fetched DoorDash orders page", {
		phase: "page",
		page_index: 0,
		item_count: nodes.length,
	});

	const walk = await walkPagesWithCeiling({
		maxPages: MAX_SCROLL_PAGES,
		fetchPage: async (pageNumber) => {
			const body = await waitForResponseFn(page, async () => {
				await scrollFn(page);
			});
			if (!body) {
				return false;
			}
			const added = addNodes(parseOrdersResponse(body));
			await progress?.("Fetched DoorDash orders page", {
				phase: "page",
				page_index: pageNumber,
				item_count: nodes.length,
			});
			if (added === 0) {
				// Scroll produced a response with nothing new — end of list.
				return false;
			}
			await delay(SCROLL_SETTLE_MS);
			return true;
		},
	});

	return { nodes, truncated: walk.truncated };
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

	const { nodes, truncated } = await collectOrderNodes({
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
			// silently is wrong here, report it as a shape anomaly via SKIP_RESULT
			// so drift is visible rather than swallowed.
			ordersConsidered += 1;
			if (wantsOrders) {
				await emit({
					type: "SKIP_RESULT",
					stream: "orders",
					reason: "shape_check_failed",
					message: "order node missing orderUuid",
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

	if (truncated) {
		const message = `DoorDash orders stopped at the ${MAX_SCROLL_PAGES}-scroll limit with more history possibly unread`;
		if (wantsOrders) {
			await emit({
				type: "SKIP_RESULT",
				stream: "orders",
				reason: "older_pages_deferred_page_budget",
				message,
				diagnostics: { page_limit: MAX_SCROLL_PAGES, total_seen: nodes.length },
			});
		}
		if (wantsItems) {
			await emit({
				type: "SKIP_RESULT",
				stream: "order_items",
				reason: "older_pages_deferred_page_budget",
				message,
				diagnostics: { page_limit: MAX_SCROLL_PAGES, total_seen: nodes.length },
			});
		}
	}

	if (nodes.length === 0) {
		// Zero orders observed across the whole walk is a drift signal, not
		// necessarily "no data" — the GraphQL response for the order list never
		// arrived (or arrived empty). Report it so a selector/endpoint break is
		// visible instead of looking like a quiet, complete, empty run.
		const reportEmpty = async (stream: string): Promise<void> => {
			await emit({
				type: "SKIP_RESULT",
				stream,
				reason: "doordash_orders_response_not_observed",
				message:
					"No getConsumerOrdersWithDetails response was observed on the orders page; the account may have no orders, or DoorDash's endpoint/shape has changed.",
			});
		};
		if (wantsOrders) {
			await reportEmpty("orders");
		}
		if (wantsItems) {
			await reportEmpty("order_items");
		}
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
		capture: args.capture,
		checkpoint: args.checkpoint,
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
