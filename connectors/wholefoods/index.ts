#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PDPP Whole Foods Connector.
 *
 * Whole Foods orders are placed through Amazon, so this connector reuses the
 * shared Amazon session library (`../../packages/polyfill-connectors/src/auto-login/amazon.ts` —
 * `ensureAmazonSession`/`AMAZON_LOGIN_FIELDS`, the same module
 * `connectors/amazon/index.ts` uses) rather than re-implementing Amazon
 * sign-in. A connector never imports another connector (see
 * packages/polyfill-connectors/AGENTS.md); this only imports from `src/`.
 *
 * Streams (D8, docs/migration/connector-cutover/CONTRACTS.md):
 *   - profile      — the Amazon account's name/email.
 *   - orders       — Whole-Foods-filtered Amazon orders.
 *   - order_items  — line items within those orders.
 *   - nutrition    — typed nutrition facts per unique product, sourced from
 *                     the Whole Foods product page first, then USDA FDC.
 *
 * Unlike connectors/amazon, this connector does not year-partition or run a
 * cross-run detail-gap-recovery pass: Whole Foods order volume per account is
 * small (the legacy connector paginated a filtered search, not the full order
 * history), so a flat per-order-id fingerprint cursor is enough to avoid
 * re-hydrating unchanged orders every run. Simple over clever, per the
 * code-quality canon — amazon's year-freezing/detail-gap machinery solves a
 * scale problem Whole Foods does not have.
 */

import { isMainModule } from "@pdpp/connector-protocol";
import type { Page } from "playwright";
import { ensureAmazonSession } from "../../packages/polyfill-connectors/src/auto-login/amazon.ts";
import { connectorDiagnostic } from "../../packages/polyfill-connectors/src/connector-diagnostic.ts";
import {
	type BrowserCollectContext,
	politeDelay,
	runConnector,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { openFingerprintCursor } from "../../packages/polyfill-connectors/src/fingerprint-cursor.ts";
import {
	bestUsdaMatch,
	cleanProductName,
	hasOrderDetailEvidence,
	hasOrderSearchEmptyState,
	isCancelledOrderDetail,
	mapUsdaNutrients,
	mergeProductIds,
	ORDER_DETAIL_READY_SELECTOR,
	orderDetailUnitCount,
	parseAmazonProfileDom,
	parseDollarsToCents,
	parseOrderDateIso,
	parseOrderDetailDom,
	parseOrderSearchPageDom,
	parseWholeFoodsProductPageDom,
	parseWholeFoodsSearchResultDom,
} from "./parsers.ts";
import { validateRecord } from "./schemas.ts";
import type {
	NutritionFacts,
	NutritionRecord,
	OrderDetail,
	OrderDetailItem,
	OrderItemRecord,
	OrderRecord,
	OrderStub,
	ProfileRecord,
	UsdaFood,
} from "./types.ts";

const USDA_DEMO_KEY = "DEMO_KEY";
const NAV_TIMEOUT_MS = 30_000;
const NAV_SETTLE_MS = 2500;
const POLITE_DELAY_MS = 800;
// Search pages hold about 10 item rows. A live account (2026-09-28) had 70
// pages, so 50 failed it. 250 pages (~2,500 item rows) gives 3.5x headroom.
// That live walk took ~5.3 s per page (load+settle+delay), so 250 pages take
// ~22 minutes. Desktop kills a run after 15 minutes without a message, so the
// walk sends one progress message per page.
const MAX_SEARCH_PAGES = 250;
const USDA_MIN_TEXT_SCORE = 0.4;
const WHOLE_FOODS_ORIGIN = "https://www.wholefoodsmarket.com";

const AMAZON_ORDER_HISTORY_URL = "https://www.amazon.com/gp/css/homepage.html";
const AMAZON_SEARCH_BASE =
	"https://www.amazon.com/your-orders/search?search=Whole+Foods+Market";
// Content-ready signals for an Amazon your-orders page (list or search
// results). A live capture (2026-09-22) showed `domcontentloaded` +
// `politeDelay` alone can settle before Amazon's client-rendered order
// content paints, so every navigation into your-orders/* waits for one of
// these first. Mirrors connectors/amazon/index.ts's `deepSessionCheck`
// wait list (`form[name="signIn"]` covers a session that quietly expired
// mid-run).
export const ORDERS_PAGE_READY_SELECTOR =
	'form[name="signIn"], .order-card, .js-order-card, .your-orders-content-container, #searchOrdersInput, .hzsearch-results-summary, [class*="no-orders" i]';
const NAV_READY_WAIT_MS = 15_000;

function wholeFoodsSearchUrl(page: number): string {
	return `${AMAZON_SEARCH_BASE}&page=${page}`;
}

/**
 * The order list or an order detail page did not give the source's own
 * evidence of what it contains (or where the list ends). Per Collection
 * Profile §5.5 the affected streams are reported as `stream_collection_failed`
 * and never as complete. Auth and block failures stay plain errors: they are
 * not a statement about the list.
 */
export class OrderEnumerationUnprovenError extends Error {
	/** Orders discovered before the enumeration became unproven. They are real
	 *  source rows, so the caller still delivers them (without a finishing
	 *  STATE) before it reports the failure. */
	partialStubs: readonly OrderStub[] = [];
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "OrderEnumerationUnprovenError";
	}
}

/** Order rows are proven but one or more item lists are not. Only the
 *  item-derived streams fail; `orders` has its own end evidence. */
class OrderItemsUnprovenError extends OrderEnumerationUnprovenError {
	constructor(message: string) {
		super(message);
		this.name = "OrderItemsUnprovenError";
	}
}

/** A navigation answered with a non-success HTTP status. */
class NavigationHttpError extends Error {
	readonly status: number;
	constructor(status: number) {
		super(`Whole Foods navigation failed with HTTP ${String(status)}`);
		this.name = "NavigationHttpError";
		this.status = status;
	}
}

/** Navigation and a known page-ready signal must succeed before parsing. */
async function navigateAndSettle(
	page: Page,
	url: string,
	readySelector?: string,
	inspectHttpError = false,
): Promise<number | null> {
	const response = await page.goto(url, {
		timeout: NAV_TIMEOUT_MS,
		waitUntil: "domcontentloaded",
	});
	if (response && !response.ok() && !inspectHttpError) {
		throw new NavigationHttpError(response.status());
	}
	if (readySelector) {
		try {
			await page.locator(readySelector).first().waitFor({
				state: "attached",
				timeout: NAV_READY_WAIT_MS,
			});
		} catch (error) {
			throw new OrderEnumerationUnprovenError(
				`wholefoods_order_page_readiness_timeout after ${String(NAV_READY_WAIT_MS)}ms`,
				{ cause: error },
			);
		}
	}
	await politeDelay(NAV_SETTLE_MS);
	return response?.status() ?? null;
}

/**
 * Navigate to a page of the order enumeration (a search page or an order
 * detail). A timeout, a network error or a non-auth HTTP error is not the
 * source's own evidence about the list, so it is an unproven enumeration.
 * HTTP 401/403 stay plain errors: they are sign-in and block failures, not a
 * statement about the list. The message carries only the error kind, because
 * the browser's own text names the URL, which holds an order id.
 */
async function navigateOrderPage(
	page: Page,
	url: string,
	readySelector: string,
): Promise<void> {
	try {
		await navigateAndSettle(page, url, readySelector);
	} catch (error) {
		if (
			error instanceof OrderEnumerationUnprovenError ||
			(error instanceof NavigationHttpError &&
				(error.status === 401 || error.status === 403))
		) {
			throw error;
		}
		const kind = error instanceof Error ? error.name : "unknown";
		throw new OrderEnumerationUnprovenError(
			`wholefoods_order_navigation_failed: ${kind}`,
			{ cause: error },
		);
	}
}

// ─── Profile ────────────────────────────────────────────────────────────

async function collectProfile(
	page: Page,
	emitRecord: BrowserCollectContext["emitRecord"],
	reportStreamFailure: BrowserCollectContext["reportStreamFailure"],
): Promise<void> {
	await navigateAndSettle(page, AMAZON_ORDER_HISTORY_URL);
	const html = await page.content();
	const { customerId, name } = parseAmazonProfileDom(html);
	// Live evidence (2026-09-22, see the connector's report
	// CONTRACT-CHANGE-REQUEST) showed the capability map's assumed `email`
	// field is not safely obtainable — no reachable page renders it without
	// crossing a re-authentication gate. Prefer Amazon's stable opaque
	// `customerId` when present. If the authenticated nav greeting is the only
	// available identity, emit the legacy singleton profile instead of going
	// silent; this preserves the old connector's `{ name, email }` profile
	// parity for accounts/pages that omit the analytics id.
	if (!(customerId || name)) {
		const message =
			"Whole Foods reached the Amazon account page, but the page did not expose an authenticated account identity.";
		if (!reportStreamFailure) {
			throw new Error(message);
		}
		await reportStreamFailure("profile", message, { retryable: true });
		return;
	}
	const record: ProfileRecord = { email: null, id: customerId ?? "me", name };
	await emitRecord("profile", record);
}

// ─── Orders: discovery ────────────────────────────────────────────────────

async function discoverOrderStubs(
	page: Page,
	progress: BrowserCollectContext["progress"],
): Promise<{ stubs: OrderStub[] }> {
	const stubs: OrderStub[] = [];
	try {
		await walkSearchPages(page, progress, stubs);
	} catch (error) {
		if (error instanceof OrderEnumerationUnprovenError) {
			error.partialStubs = stubs;
		}
		throw error;
	}
	return { stubs };
}

/** Walk the search pages, appending each new order to `stubs`. Throws an
 *  unproven-enumeration error unless the source's own end signal is seen. */
async function walkSearchPages(
	page: Page,
	progress: BrowserCollectContext["progress"],
	stubs: OrderStub[],
): Promise<void> {
	const seen = new Set<string>();
	let previousRowSignature: string | null = null;
	for (let pageNum = 1; pageNum <= MAX_SEARCH_PAGES; pageNum += 1) {
		await navigateOrderPage(
			page,
			wholeFoodsSearchUrl(pageNum),
			ORDERS_PAGE_READY_SELECTOR,
		);
		const html = await page.content();
		if (isBlockedPage(html) || /<form[^>]*name=["']signIn["']/i.test(html)) {
			throw new Error("Whole Foods order search was blocked or signed out");
		}
		const {
			hasNextPage,
			isLastPage,
			rowSignature,
			selectedPage,
			stubs: pageStubs,
		} = parseOrderSearchPageDom(html);
		if (pageStubs.length === 0 && !hasOrderSearchEmptyState(html)) {
			throw new OrderEnumerationUnprovenError(
				"Whole Foods order search returned no recognizable results or empty-state evidence",
			);
		}
		for (const stub of pageStubs) {
			if (seen.has(stub.orderId)) {
				const existing = stubs.find((s) => s.orderId === stub.orderId);
				if (existing) {
					existing.expectedItemCount += stub.expectedItemCount;
					existing.searchProductIds = mergeProductIds(
						existing.searchProductIds,
						stub.searchProductIds ?? [],
					);
				}
				continue;
			}
			seen.add(stub.orderId);
			stubs.push(stub);
		}
		await progress(`Scanned Whole Foods search page ${pageNum}`, {
			count: stubs.length,
			stream: "orders",
		});
		// The page served must be the page requested, on the last page too: a
		// terminal page that skipped ahead leaves the pages between unread.
		if (selectedPage !== null && selectedPage !== pageNum) {
			throw new OrderEnumerationUnprovenError(
				"Whole Foods order pagination served a different page than requested",
			);
		}
		if (hasNextPage && rowSignature === previousRowSignature) {
			throw new OrderEnumerationUnprovenError(
				"Whole Foods order pagination repeated a page",
			);
		}
		if (hasNextPage && pageNum === MAX_SEARCH_PAGES) {
			throw new OrderEnumerationUnprovenError(
				"Whole Foods order search exceeded the page limit before reaching the end",
			);
		}
		if (!hasNextPage) {
			// The end needs the source's own signal: Amazon's disabled "Next"
			// control, or an empty-state page with no rows. A page of rows with
			// no next link and no disabled control is not evidence of the end.
			if (pageStubs.length > 0 && !isLastPage) {
				throw new OrderEnumerationUnprovenError(
					"Whole Foods order search ended without a last-page signal",
				);
			}
			break;
		}
		previousRowSignature = rowSignature;
		await politeDelay(POLITE_DELAY_MS);
	}
}

// ─── Orders: detail + record building ─────────────────────────────────────

/** Stable reason code for an order whose detail item count matches neither
 *  the search-card row count nor the detail-row count. Display copy lives in
 *  manifest.json `reason_display_messages`. */
export const ORDER_ITEM_COUNT_UNVERIFIED_REASON =
	"wholefoods_order_item_count_unverified";
export const ORDER_ITEM_ASIN_MISSING_REASON =
	"wholefoods_order_item_asin_missing";

/**
 * True when the order-detail page agrees with the search-page row count.
 *
 * `expectedItemCount` counts search-page ROWS that link the order. The detail
 * side has two honest measures: units (`orderDetailUnitCount`: a repeated
 * product's `Qty: N` is N, a weighed row is 1) and distinct rows
 * (`items.length`). Legacy pages render each unit as its own search row, so
 * units match; an in-store row with `Qty: 3 @ $x each` may be ONE search row,
 * so rows match. Either agreement is a like-with-like match. A count that
 * matches neither means a detail row is missing or extra, and the caller must
 * report the order as unverified.
 */
function orderDetailCountsMatch(
	stub: OrderStub,
	items: readonly OrderDetailItem[],
): boolean {
	return (
		(orderDetailUnitCount(items) === stub.expectedItemCount ||
			items.length === stub.expectedItemCount) &&
		searchProductsAppearInDetail(stub, items)
	);
}

/** Equal counts do not show that no product is missing: a missing product
 *  can be offset by a higher quantity on another. Every distinct product the
 *  search rows link must also be a product on the detail page. A search row
 *  with no product link carries no such evidence, so only the count applies. */
function searchProductsAppearInDetail(
	stub: OrderStub,
	items: readonly OrderDetailItem[],
): boolean {
	const detailProductIds = new Set(items.map((item) => item.productId));
	return (stub.searchProductIds ?? []).every((id) => detailProductIds.has(id));
}

function buildOrderRecord(
	stub: OrderStub,
	orderDateRaw: string | null,
	items: readonly OrderDetailItem[],
): OrderRecord {
	// A stated row total (in-store pages) is the charged amount, so it wins
	// over unit price x quantity, which ignores promotions and weights.
	const rowCents = (item: OrderDetailItem): number | null => {
		const lineCents = parseDollarsToCents(item.lineTotalDollars);
		if (lineCents !== null) {
			return lineCents;
		}
		const cents = parseDollarsToCents(item.unitPriceDollars);
		return cents === null ? null : Math.round(cents * (item.quantity ?? 1));
	};
	const totalCents = items.reduce(
		(sum, item) => sum + (rowCents(item) ?? 0),
		0,
	);
	const hasCompletePrices =
		items.length > 0 && items.every((item) => rowCents(item) !== null);
	return {
		id: stub.orderId,
		item_count: stub.expectedItemCount,
		order_date: parseOrderDateIso(orderDateRaw ?? stub.orderDateRaw),
		order_url: stub.orderUrl,
		status: null,
		total_cents: hasCompletePrices ? totalCents : null,
	};
}

function buildOrderItemRecord(
	orderId: string,
	item: OrderDetailItem,
): OrderItemRecord {
	// Amazon ASINs are globally unique per product but not per order line, so
	// the item id is the (order, product) pair — mirrors connectors/amazon's
	// order_items id shape.
	if (!item.productId) {
		throw new Error(
			`Whole Foods order ${orderId} has an item without a source product ASIN`,
		);
	}
	const id = `${orderId}#${item.productId}`;
	return {
		id,
		image_url: item.imageUrl,
		name: item.name,
		order_id: orderId,
		product_id: item.productId,
		product_url: item.productUrl,
		quantity: item.quantity,
		unit_price_cents: parseDollarsToCents(item.unitPriceDollars),
	};
}

/** Item records for an order. A row without a source ASIN (possible on
 *  in-store pages) has no valid `product_id`, so it gets no record; it still
 *  counts toward the order's item count and total. */
export function buildOrderItemRecords(
	orderId: string,
	items: readonly OrderDetailItem[],
): OrderItemRecord[] {
	return items
		.filter((item) => item.productId)
		.map((item) => buildOrderItemRecord(orderId, item));
}

// ─── Nutrition ─────────────────────────────────────────────────────────────

interface UsdaSearchResponse {
	foods?: UsdaFood[];
}

function isUsdaSearchResponse(value: unknown): value is UsdaSearchResponse {
	return typeof value === "object" && value !== null;
}

async function usdaSearch(
	apiKey: string,
	params: Record<string, string>,
): Promise<UsdaFood[]> {
	const url = new URL("https://api.nal.usda.gov/fdc/v1/foods/search");
	for (const [key, value] of Object.entries(params)) {
		url.searchParams.set(key, value);
	}
	url.searchParams.set("api_key", apiKey);
	const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
	if (!res.ok) {
		throw new Error(`USDA nutrition lookup failed with HTTP ${res.status}`);
	}
	const json: unknown = await res.json();
	if (!isUsdaSearchResponse(json) || !Array.isArray(json.foods)) {
		throw new Error("USDA nutrition lookup returned an invalid response");
	}
	return json.foods;
}

/** Look up USDA nutrition for a product name via Branded text search, then
 *  Foundation text search (better for produce/staples). No UPC is available
 *  at this call site — the Amazon order-detail page never exposes one, only
 *  a UPC recovered from a scraped Whole Foods/USDA response would (the
 *  legacy connector's UPC-first path only ever fired when a prior lookup
 *  had already surfaced one) — so this ports the legacy `lookupUSDA`'s text
 *  fallback path only. Returns null when no confident match exists rather
 *  than guessing. */
async function lookupUsdaNutrition(
	apiKey: string,
	name: string,
): Promise<NutritionFacts | null> {
	const cleaned = cleanProductName(name);
	if (!cleaned || cleaned.length < 3) {
		return null;
	}
	const branded = await usdaSearch(apiKey, {
		dataType: "Branded",
		pageSize: "5",
		query: cleaned,
	});
	const brandedMatch = bestUsdaMatch(cleaned, branded, USDA_MIN_TEXT_SCORE);
	if (brandedMatch) {
		return mapUsdaNutrients(brandedMatch, "text");
	}
	const foundation = await usdaSearch(apiKey, {
		dataType: "Foundation",
		pageSize: "5",
		query: cleaned,
	});
	const foundationMatch = bestUsdaMatch(cleaned, foundation, 0.3);
	if (foundationMatch) {
		return mapUsdaNutrients(foundationMatch, "text");
	}
	return null;
}

/** Try the Whole Foods page first, then USDA FDC. A successful USDA match
 *  can supply facts after a blocked or failed Whole Foods page. Otherwise
 *  retain the observed failure; only confirmed product/no-results pages
 *  plus an empty USDA search produce not_found. The optional API key falls
 *  back to DEMO_KEY at the collect call site, matching the legacy default.
 *  Each result becomes one product-keyed nutrition record. */
type NutritionOutcome = NutritionFacts | "not_found" | "error" | "blocked";

function isBlockedPage(html: string): boolean {
	return /(?:validateCaptcha|captchacharacters|Sorry, we just need to make sure|<title>[^<]*(?:robot|captcha|blocked|denied)[^<]*<\/title>)/i.test(
		html,
	);
}

function hasProductPageEvidence(html: string): boolean {
	return /"@type"\s*:\s*"Product"|itemtype=["'][^"']*schema\.org\/Product|data-testid=["']product-detail/i.test(
		html,
	);
}

async function lookupNutritionForProduct(
	page: Page,
	usdaApiKey: string,
	name: string,
): Promise<NutritionOutcome> {
	const query = cleanProductName(name);
	let sourceOutcome: "not_found" | "error" | "blocked" = "error";
	try {
		if (query.length >= 3) {
			const searchStatus = await navigateAndSettle(
				page,
				`${WHOLE_FOODS_ORIGIN}/search?text=${encodeURIComponent(query)}`,
				undefined,
				true,
			);
			const searchHtml = await page.content();
			if (isBlockedPage(searchHtml)) {
				sourceOutcome = "blocked";
			} else if (searchStatus !== null && searchStatus >= 400) {
				sourceOutcome = "error";
			} else {
				const productUrl = parseWholeFoodsSearchResultDom(searchHtml);
				if (productUrl) {
					const resolvedUrl = new URL(productUrl, WHOLE_FOODS_ORIGIN);
					if (resolvedUrl.origin !== WHOLE_FOODS_ORIGIN) {
						throw new Error(
							"Whole Foods search returned a non-Whole-Foods product URL",
						);
					}
					const productStatus = await navigateAndSettle(
						page,
						resolvedUrl.href,
						undefined,
						true,
					);
					const productHtml = await page.content();
					if (isBlockedPage(productHtml)) {
						sourceOutcome = "blocked";
					} else if (productStatus !== null && productStatus >= 400) {
						sourceOutcome = "error";
					} else {
						const finalUrl = new URL(page.url());
						if (finalUrl.origin !== WHOLE_FOODS_ORIGIN) {
							throw new Error(
								"Whole Foods product navigation left the trusted origin",
							);
						}
						const facts = parseWholeFoodsProductPageDom(productHtml);
						if (facts) return facts;
						sourceOutcome = hasProductPageEvidence(productHtml)
							? "not_found"
							: "error";
					}
				} else if (
					/\b(?:0|no)\s+(?:products|results)\b|no matching products/i.test(
						searchHtml,
					)
				) {
					sourceOutcome = "not_found";
				}
			}
		}
	} catch {
		sourceOutcome = "error";
	}
	try {
		return (await lookupUsdaNutrition(usdaApiKey, name)) ?? sourceOutcome;
	} catch {
		return sourceOutcome === "blocked" ? "blocked" : "error";
	}
}

function buildNutritionRecord(
	productId: string,
	name: string,
	facts: NutritionOutcome,
): NutritionRecord {
	if (typeof facts === "string") {
		return {
			calories: null,
			carbs_g: null,
			confidence: "low",
			fat_g: null,
			fiber_g: null,
			name,
			product_id: productId,
			protein_g: null,
			serving_size: null,
			servings_per_container: null,
			sodium_mg: null,
			source: facts,
			sugar_g: null,
		};
	}
	return {
		calories: facts.calories,
		carbs_g: facts.carbsG,
		confidence: facts.confidence,
		fat_g: facts.fatG,
		fiber_g: facts.fiberG,
		name,
		product_id: productId,
		protein_g: facts.proteinG,
		serving_size: facts.servingSize,
		servings_per_container: facts.servingsPerContainer,
		sodium_mg: facts.sodiumMg,
		source: facts.source,
		sugar_g: facts.sugarG,
	};
}

/** What `collectOrderStubs` could not prove. */
interface OrderCollectionOutcome {
	/** Orders whose detail item list matched neither search count. Their items
	 *  were delivered, but no end of the item list was observed, so
	 *  `order_items` and `nutrition` are not complete. */
	unverifiedCountOrders: number;
	/** The first detail page that gave no readable evidence, with how many
	 *  orders were skipped for that reason. Their records are missing, so no
	 *  stream may finish. The remaining orders were still delivered. */
	unreadable: { count: number; first: OrderEnumerationUnprovenError } | null;
}

/** Parse one order-detail page and require the source's own evidence of its
 *  contents. Throws an unproven-enumeration error when the page shows no
 *  item or cancellation evidence, or an empty item list with no rendered
 *  cancellation marker (the one statement that explains an order with no
 *  items). */
function readOrderDetail(html: string): OrderDetail {
	if (!hasOrderDetailEvidence(html)) {
		throw new OrderEnumerationUnprovenError(
			"Whole Foods order detail has no item or cancellation evidence",
		);
	}
	const detail = parseOrderDetailDom(html);
	if (detail.items.length === 0 && !isCancelledOrderDetail(html)) {
		throw new OrderEnumerationUnprovenError(
			"Whole Foods order detail rendered no items and no cancellation evidence",
		);
	}
	return detail;
}

/** Fetch, verify and emit every discovered order. Auth and readability
 *  failures still end the run. A detail whose item count cannot be
 *  reconciled with the search count does not: the order and its items are
 *  delivered, progress reports how many orders were unverified, and the
 *  caller reports the item-derived streams as failed. */
async function collectOrderStubs({
	credentials,
	emit,
	emitRecord,
	ordersCursor,
	page,
	progress,
	stubs,
	state,
	wantsItems,
	wantsNutrition,
	wantsOrders,
	withFinishingState = true,
}: {
	credentials: BrowserCollectContext["credentials"];
	emit: BrowserCollectContext["emit"];
	emitRecord: BrowserCollectContext["emitRecord"];
	ordersCursor: ReturnType<typeof openFingerprintCursor>;
	page: Page;
	progress: BrowserCollectContext["progress"];
	state: BrowserCollectContext["state"];
	stubs: readonly OrderStub[];
	wantsItems: boolean;
	wantsNutrition: boolean;
	wantsOrders: boolean;
	/** False when the order list has no end evidence: the records are still
	 *  delivered, but neither stream may finish with a STATE. */
	withFinishingState?: boolean;
}): Promise<OrderCollectionOutcome> {
	const usdaApiKey = credentials.USDA_API_KEY || USDA_DEMO_KEY;
	let unverifiedCountOrders = 0;
	let unreadable = null as OrderCollectionOutcome["unreadable"];
	// Every source-backed item is considered. A record for each product
	// makes the legacy coverage counts derivable from outcome rows.
	const consideredProductIds = new Set<string>();
	const nutritionCoverage = {
		blocked: 0,
		found: 0,
		foundUSDA: 0,
		error: 0,
		notFound: 0,
	};
	const nutritionCursor = wantsNutrition
		? openFingerprintCursor(state.nutrition)
		: null;

	let processed = 0;
	for (const stub of stubs) {
		await navigateOrderPage(
			page,
			stub.orderUrl,
			// Confirmed live (2026-09-22, against a real order-detail page):
			// [data-component="purchasedItemsRightGrid"] is the real per-item
			// container; [data-component="cancelled"] covers a cancelled order,
			// which never renders purchasedItemsRightGrid. In-store orders
			// (`/fopo/order-details`, live 2026-09-29) render #f3_food_ItemList.
			ORDER_DETAIL_READY_SELECTOR,
		);
		const html = await page.content();
		if (isBlockedPage(html) || /<form[^>]*name=["']signIn["']/i.test(html)) {
			throw new Error(
				`Whole Foods order ${stub.orderId} detail was blocked or signed out`,
			);
		}
		let detail: OrderDetail;
		try {
			detail = readOrderDetail(html);
		} catch (error) {
			if (!(error instanceof OrderEnumerationUnprovenError)) {
				throw error;
			}
			// One unreadable detail must not strand the orders after it: skip
			// it, deliver the rest, and report the failure at the end.
			unreadable = {
				count: (unreadable?.count ?? 0) + 1,
				first: unreadable?.first ?? error,
			};
			await emit({
				type: "PROGRESS",
				stream: "orders",
				message: "Could not read the items of an order",
			});
			await politeDelay(POLITE_DELAY_MS);
			continue;
		}
		const itemsWithoutAsin = detail.items.filter(
			(item) => !item.productId,
		).length;
		if (itemsWithoutAsin > 0) {
			connectorDiagnostic("wholefoods", "order_item_asin_missing", {
				reason: ORDER_ITEM_ASIN_MISSING_REASON,
				count: itemsWithoutAsin,
				stream: "order_items",
			});
			await emit({
				type: "PROGRESS",
				stream: "orders",
				message: `${itemsWithoutAsin} order item(s) had no product ID and were left out`,
			});
		}
		// A cancelled order with no items is the source's own statement that
		// it has none; everything else needs a count that agrees with search.
		if (
			detail.items.length > 0 &&
			!orderDetailCountsMatch(stub, detail.items)
		) {
			unverifiedCountOrders += 1;
			connectorDiagnostic("wholefoods", "order_item_count_unverified", {
				reason: ORDER_ITEM_COUNT_UNVERIFIED_REASON,
				search_count: stub.expectedItemCount,
				detail_rows: detail.items.length,
				detail_units: orderDetailUnitCount(detail.items),
			});
			await emit({
				type: "PROGRESS",
				stream: "orders",
				message: "Could not confirm the item count for an order",
			});
		}

		if (wantsOrders) {
			const orderRecord = buildOrderRecord(
				stub,
				detail.orderDateRaw,
				detail.items,
			);
			if (ordersCursor.shouldEmit(orderRecord)) {
				await emitRecord("orders", orderRecord);
			}
		}

		if (wantsItems) {
			for (const itemRecord of buildOrderItemRecords(
				stub.orderId,
				detail.items,
			)) {
				await emitRecord("order_items", itemRecord);
			}
		}

		if (wantsNutrition && nutritionCursor) {
			for (const item of detail.items) {
				if (!item.productId || consideredProductIds.has(item.productId)) {
					continue;
				}
				consideredProductIds.add(item.productId);
				const facts = await lookupNutritionForProduct(
					page,
					usdaApiKey,
					item.name,
				);
				if (typeof facts === "string") {
					if (facts === "blocked") nutritionCoverage.blocked += 1;
					else if (facts === "error") nutritionCoverage.error += 1;
					else nutritionCoverage.notFound += 1;
				} else if (facts.source === "usda_fdc")
					nutritionCoverage.foundUSDA += 1;
				else nutritionCoverage.found += 1;
				const record = buildNutritionRecord(item.productId, item.name, facts);
				if (nutritionCursor.shouldEmit(record)) {
					await emitRecord("nutrition", record);
				}
				await politeDelay(POLITE_DELAY_MS);
			}
		}

		processed += 1;
		await progress(`Processed order ${processed}/${stubs.length}`, {
			count: processed,
			stream: "orders",
			total: stubs.length,
		});
		await politeDelay(POLITE_DELAY_MS);
	}

	if (unverifiedCountOrders > 0) {
		connectorDiagnostic("wholefoods", "order_item_counts_unverified_summary", {
			reason: ORDER_ITEM_COUNT_UNVERIFIED_REASON,
			unverified: unverifiedCountOrders,
			total: stubs.length,
		});
		await progress(
			`Item counts could not be checked for ${unverifiedCountOrders} of ${stubs.length} Whole Foods orders`,
			{
				count: unverifiedCountOrders,
				stream: "orders",
				total: stubs.length,
			},
		);
	}
	// A skipped order leaves its order row and items unread, so nothing that
	// depends on the enumeration may finish.
	const finishes = withFinishingState && unreadable === null;
	if (wantsOrders && finishes) {
		await emit({
			cursor: ordersCursor.toState(),
			stream: "orders",
			type: "STATE",
		});
	}
	if (wantsNutrition && nutritionCursor) {
		connectorDiagnostic("wholefoods", "nutrition_lookup_coverage", {
			products: consideredProductIds.size,
			whole_foods: nutritionCoverage.found,
			usda: nutritionCoverage.foundUSDA,
			blocked: nutritionCoverage.blocked,
			error: nutritionCoverage.error,
			not_found: nutritionCoverage.notFound,
		});
		await progress(
			`Looked up nutrition for ${consideredProductIds.size} products (${nutritionCoverage.notFound} not found)`,
			{
				count: nutritionCoverage.found + nutritionCoverage.foundUSDA,
				stream: "nutrition",
				total: consideredProductIds.size,
			},
		);
		// An order whose item list had no end evidence leaves the nutrition
		// enumeration open, so the finishing STATE is withheld.
		if (unverifiedCountOrders === 0 && finishes) {
			await emit({
				cursor: nutritionCursor.toState(),
				stream: "nutrition",
				type: "STATE",
			});
		}
	}
	return { unreadable, unverifiedCountOrders };
}

/** Streams whose completeness depends on the order enumeration. */
const ORDER_DERIVED_STREAMS = ["orders", "order_items", "nutrition"] as const;
const ORDER_ITEM_STREAMS = ["order_items", "nutrition"] as const;

/** Discover and collect orders. When the enumeration cannot be proven
 *  complete, report each requested order-derived stream as failed instead of
 *  letting any of them finish. */
async function collectOrders(
	ctx: Pick<
		BrowserCollectContext,
		| "credentials"
		| "emit"
		| "emitRecord"
		| "page"
		| "progress"
		| "requested"
		| "state"
	> & {
		reportStreamFailure:
			| BrowserCollectContext["reportStreamFailure"]
			| undefined;
	},
): Promise<void> {
	const { requested, reportStreamFailure } = ctx;
	try {
		const ordersCursor = openFingerprintCursor(ctx.state.orders);
		const { stubs } = await discoverOrderStubs(ctx.page, ctx.progress);
		await ctx.progress(`Found ${stubs.length} Whole Foods order(s)`, {
			count: stubs.length,
			stream: "orders",
		});
		const outcome = await collectOrderStubs({
			credentials: ctx.credentials,
			emit: ctx.emit,
			emitRecord: ctx.emitRecord,
			ordersCursor,
			page: ctx.page,
			progress: ctx.progress,
			state: ctx.state,
			stubs,
			wantsItems: requested.has("order_items"),
			wantsNutrition: requested.has("nutrition"),
			wantsOrders: requested.has("orders"),
		});
		if (outcome.unreadable) {
			throw new OrderEnumerationUnprovenError(
				`${outcome.unreadable.first.message} (${outcome.unreadable.count} of ${stubs.length} orders)`,
			);
		}
		if (outcome.unverifiedCountOrders > 0) {
			// The order rows come from the proven search list, so `orders` is
			// complete. The item lists have no end evidence for these orders.
			throw new OrderItemsUnprovenError(
				`Whole Foods order detail item counts could not be reconciled with the search counts for ${outcome.unverifiedCountOrders} of ${stubs.length} orders; the item lists have no end evidence`,
			);
		}
	} catch (error) {
		if (!(error instanceof OrderEnumerationUnprovenError)) {
			throw error;
		}
		if (!reportStreamFailure) {
			throw error;
		}
		// Orders read before the list became unproven are real: deliver them
		// (no finishing STATE) so a capped or interrupted walk keeps its reads.
		// A navigation or readiness failure while delivering them must still
		// reach the stream-failure reporting below, so it is held until then.
		let deliveryError: unknown = null;
		if (error.partialStubs.length > 0) {
			try {
				await deliverPartialStubs(ctx, error.partialStubs);
			} catch (caught) {
				deliveryError = caught;
			}
		}
		const message =
			deliveryError instanceof OrderEnumerationUnprovenError
				? `${error.message}; ${deliveryError.message}`
				: error.message;
		const failedStreams =
			error instanceof OrderItemsUnprovenError
				? ORDER_ITEM_STREAMS
				: ORDER_DERIVED_STREAMS;
		for (const stream of failedStreams) {
			if (requested.has(stream)) {
				await reportStreamFailure(stream, message, { retryable: true });
			}
		}
		// A signed-out or blocked page is not an enumeration verdict: after the
		// streams are reported, it still ends the run as the error it is.
		if (
			deliveryError !== null &&
			!(deliveryError instanceof OrderEnumerationUnprovenError)
		) {
			throw deliveryError;
		}
	}
}

/** Collect the orders read before the list became unproven, without any
 *  finishing STATE. An order whose detail cannot be read is skipped inside
 *  `collectOrderStubs`, so one bad page does not strand the others; the caller
 *  reports every requested stream as failed. */
async function deliverPartialStubs(
	ctx: Parameters<typeof collectOrders>[0],
	stubs: readonly OrderStub[],
): Promise<void> {
	await collectOrderStubs({
		credentials: ctx.credentials,
		emit: ctx.emit,
		emitRecord: ctx.emitRecord,
		ordersCursor: openFingerprintCursor(ctx.state.orders),
		page: ctx.page,
		progress: ctx.progress,
		state: ctx.state,
		stubs,
		wantsItems: ctx.requested.has("order_items"),
		wantsNutrition: ctx.requested.has("nutrition"),
		wantsOrders: ctx.requested.has("orders"),
		withFinishingState: false,
	});
}

// ─── Main ────────────────────────────────────────────────────────────────

// Guarded so `import "./index.ts"` in tests doesn't spin up the runtime and
// block the Node event loop on stdin. Only fires when this module IS the
// process entry point.
if (isMainModule(import.meta.url)) {
	runConnector({
		// USDA_API_KEY is a connection-scoped optional setting (a public API key,
		// not a login credential): `authOptional: true` means an unset key
		// resolves to `{}` instead of raising a `credentials` interaction or
		// failing the run — collect() falls back to the public USDA DEMO_KEY,
		// matching the legacy connector's `process.env.USDA_API_KEY || 'DEMO_KEY'`.
		auth: { kind: "env", required: ["USDA_API_KEY"] },
		authOptional: true,
		// Dedicated persistent profile (shared session story: this profile is
		// expected to already be signed into amazon.com — see the manifest and
		// docs/migration/connector-cutover/CONTRACTS.md D8).
		browser: { profileName: "wholefoods" },
		name: "wholefoods",
		async probeSession({ context }): Promise<boolean> {
			const cookies = await context.cookies("https://www.amazon.com/");
			return cookies.some(
				(c) => /session|at-main/.test(c.name) && Boolean(c.value),
			);
		},
		async ensureSession({
			assist,
			capture,
			checkpoint,
			completeAssistance,
			context,
			credentials,
			onCredentialSubmit,
			page,
			sendInteraction,
		}): Promise<void> {
			// wholefoods declares no AMAZON_USERNAME/AMAZON_PASSWORD credential of
			// its own (no other connector reads another connector's declared
			// secret name — see AGENTS.md "a connector never imports another
			// connector"). `ensureAmazonSession` internally calls
			// `resolveLoginCredentials`, which correctly reports these as absent
			// for this connection, and falls back to its owner-mediated
			// manual-login handoff — the expected path: this connector's browser
			// profile is provisioned already signed into amazon.com (see manifest
			// `display.detail` and the lane brief).
			await ensureAmazonSession({
				assist,
				...(capture ? { capture } : {}),
				checkpoint,
				completeAssistance,
				context,
				credentials,
				onCredentialSubmit,
				page,
				sendInteraction,
			});
		},
		validateRecord,
		async collect({
			credentials,
			emit,
			emitRecord,
			page,
			progress,
			reportStreamFailure,
			requested,
			state,
		}: BrowserCollectContext): Promise<void> {
			const wantsProfile = requested.has("profile");
			const wantsOrders = requested.has("orders");
			const wantsItems = requested.has("order_items");
			const wantsNutrition = requested.has("nutrition");

			if (wantsProfile) {
				await collectProfile(page, emitRecord, reportStreamFailure);
			}

			if (!(wantsOrders || wantsItems || wantsNutrition)) {
				return;
			}

			await collectOrders({
				credentials,
				emit,
				emitRecord,
				page,
				progress,
				reportStreamFailure,
				requested,
				state,
			});
		},
	});
}

// Exported for tests — kept free of the isMainModule guard so integration
// tests can call them directly without spawning a subprocess/browser.
export {
	buildNutritionRecord,
	buildOrderItemRecord,
	buildOrderRecord,
	collectOrders,
	collectOrderStubs,
	collectProfile,
	discoverOrderStubs,
	lookupNutritionForProduct,
	lookupUsdaNutrition,
	orderDetailCountsMatch,
};
