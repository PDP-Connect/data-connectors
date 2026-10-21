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
	parseUsdaFood,
	readAmazonProductPage,
	readOrderObservation,
	readWholeFoodsProductPage,
	parseWholeFoodsSearchResultDoms,
} from "./parsers.ts";
import {
	type BindingCause,
	bindGtin,
	bindOrder,
	bindProduct,
	capConfidence,
	gtinQueryForms,
	isUnbound,
	mainSubject,
	normalizeName,
	type Via,
} from "./binding.ts";
import {
	type AcceptedNutrition,
	acceptNutrition,
	hasCoreNutrition,
	type NutritionLookup,
	type NutritionNoMatch,
	type PageReadFailure,
	type PageSourceEvidence,
} from "./nutrition-acceptance.ts";
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
	UsdaMatchMethod,
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
		if (rowSignature && rowSignature === previousRowSignature) {
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
	status: OrderRecord["status"] = null,
): OrderRecord {
	return {
		id: stub.orderId,
		item_count: status === "Cancelled" ? 0 : items.length,
		order_date: parseOrderDateIso(orderDateRaw ?? stub.orderDateRaw),
		order_url: stub.orderUrl,
		status,
		total_cents: null,
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
	const id = `${orderId}#${item.sourceLineId ?? item.productId}`;
	return {
		id,
		image_url: item.imageUrl,
		name: item.name,
		order_id: orderId,
		product_id: item.productId,
		product_url: item.productUrl,
		quantity: item.quantity,
		quantity_unit: item.quantityUnit ?? null,
		price_unit: item.priceUnit ?? null,
		line_total_cents: parseDollarsToCents(item.lineTotalDollars),
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
	// Without a source line ID, repeated ASINs are ambiguous: never silently
	// merge distinct charged lines into one last-write-wins record.
	const frequencies = new Map<string, number>();
	for (const item of items) {
		if (item.productId) {
			frequencies.set(
				item.productId,
				(frequencies.get(item.productId) ?? 0) + 1,
			);
		}
	}
	return items
		.filter(
			(item) =>
				item.productId &&
				(item.sourceLineId || frequencies.get(item.productId) === 1),
		)
		.map((item) => buildOrderItemRecord(orderId, item));
}

// ─── Nutrition ─────────────────────────────────────────────────────────────

interface UsdaSearchResponse {
	foods?: unknown[];
}

function isUsdaSearchResponse(value: unknown): value is UsdaSearchResponse {
	return typeof value === "object" && value !== null;
}

/** One USDA search. Each result is validated and normalized here, once, so
 *  nothing downstream sees a food with a missing key. */
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
	return json.foods.flatMap((food) => {
		const parsed = parseUsdaFood(food);
		return parsed ? [parsed] : [];
	});
}

/** Look up USDA nutrition: an exact UPC match first when a UPC is known, then
 *  Branded text search, then Foundation text search (better for produce and
 *  staples). A UPC match counts only when USDA returns that same GTIN. A text
 *  search picks the best-matching food by identity first; that one food is
 *  then accepted or withheld. A less similar food never stands in for it.
 *  Returns null when no confident, complete match exists rather than
 *  guessing. */
async function lookupUsdaNutrition(
	apiKey: string,
	name: string,
	upc: string | null,
	upcVia: Via | null,
): Promise<NutritionFacts | null> {
	const complete = (food: UsdaFood, method: UsdaMatchMethod) => {
		const facts = mapUsdaNutrients(food, method);
		return hasCoreNutrition(facts) ? facts : null;
	};
	if (upc) {
		for (const form of gtinQueryForms(upc)) {
			const exact = await usdaSearch(apiKey, {
				pageSize: "1",
				query: `gtinUpc:${form}`,
			});
			const match = exact[0];
			const facts =
				match && bindGtin(upc, match.gtinUpc).kind === "BOUND"
					? complete(match, "upc")
					: null;
			// An exact hit is only as strong as the binding that supplied the GTIN.
			if (facts) {
				return upcVia === null
					? facts
					: { ...facts, confidence: capConfidence(facts.confidence, upcVia) };
			}
		}
	}
	// A fuzzy text query: the normalized name without "organic", which USDA
	// descriptions rarely carry. This is an approximation, not a binding.
	const cleaned = normalizeName(name).base.replace(/\borganic\b/g, "").trim();
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
		const facts = complete(brandedMatch, "text");
		if (facts) return facts;
	}
	const foundation = await usdaSearch(apiKey, {
		dataType: "Foundation",
		pageSize: "5",
		query: cleaned,
	});
	const foundationMatch = bestUsdaMatch(cleaned, foundation, 0.3);
	return foundationMatch ? complete(foundationMatch, "text") : null;
}

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

/** An ASIN or product URL the site says does not exist. That is an answer
 *  about the product ("no page"), not a failure to answer. */
const isGone = (status: number | null) => status === 404 || status === 410;

/** Most Whole Foods search tiles visited for one product. */
const MAX_WHOLE_FOODS_TILES = 8;

/** A binding that says nothing usable becomes a page-read failure whose cause
 *  tells a conflicting identity from a missing one. */
const unusable = (cause: BindingCause): PageReadFailure => ({
	status: "error",
	cause: isUnbound(cause) ? "identity_unbound" : "identity_conflict",
});

/** Look up one ordered product's nutrition, following the legacy source
 *  order: Amazon product page, Whole Foods product pages, then UPC-first/text
 *  USDA. A page is bound to the request by `binding.ts` before anything on it
 *  (facts, name, UPC) is used. The result is `NutritionLookup`: an accepted
 *  observation, or a status and cause with no facts. Either way the caller
 *  writes the product's one row. Whether an observation may be emitted is
 *  `acceptNutrition`'s decision. */
async function lookupNutritionForProduct(
	page: Page,
	usdaApiKey: string,
	name: string,
	productId = "B012345678",
): Promise<NutritionLookup> {
	const query = normalizeName(name).base;
	const requested = { asin: productId, name, boundGtin: null as string | null };
	// The weakest binding of the facts and the GTIN this lookup rests on.
	let candidateVia: Via | null = null;
	let candidate: NutritionFacts | null = null;
	// What the page sources said about this product's panel (see
	// `PageSourceEvidence`), the one value that gates a fuzzy USDA match. An
	// answer is positive evidence: a bound product page, a 404/410 for a page
	// that does not exist, a page the binding says is a different product, a
	// search result list or its no-results message. A captcha, a 5xx, a thrown
	// error, a page that cannot be bound to the request and a 200 page that
	// shows no product are not answers. `failure` names the strongest one.
	let evidence: PageSourceEvidence = "none";
	let failure: PageReadFailure | null = null;
	const unable = (reason: PageReadFailure) => {
		evidence = "unknown";
		if (failure === null || (failure.status !== "blocked" && reason.status === "blocked")) {
			failure = reason;
		}
	};
	const matched = (facts: AcceptedNutrition): NutritionLookup => ({
		status: "matched",
		facts,
	});
	// Why there is no match: a failed read, a partial panel, or nothing found.
	const noMatch = (usdaFailed: boolean): NutritionNoMatch =>
		failure ??
		(evidence === "partial"
			? { status: "error", cause: "panel_partial" }
			: usdaFailed
				? { status: "error", cause: "usda_request_failed" }
				: { status: "not_found", cause: "no_match" });
	// A source showed some core rows of this product, but not a full panel.
	const sawPartialPanel = (facts: NutritionFacts | null) => {
		if (facts && facts.coreStated.length > 0 && evidence === "none") {
			evidence = "partial";
		}
	};
	// A bound observation's facts, with confidence capped by what bound them.
	const boundFacts = (facts: NutritionFacts, via: Via): NutritionFacts => ({
		...facts,
		confidence: capConfidence(facts.confidence, via),
	});
	try {
		const status = await navigateAndSettle(
			page,
			`https://www.amazon.com/dp/${encodeURIComponent(productId)}`,
			undefined,
			true,
		);
		const amazonHtml = await page.content();
		if (isBlockedPage(amazonHtml)) {
			unable({ status: "blocked", cause: "robot_check" });
		} else if (isGone(status)) {
			// No page for this ASIN: nothing to read, and nothing wrong.
		} else if (status !== null && status >= 400) {
			unable({ status: "error", cause: "http_error" });
		} else {
			const read = readAmazonProductPage(amazonHtml, page.url());
			const binding = bindProduct(requested, {
				source: "amazon",
				obs: read.observation,
			});
			if (binding.kind !== "BOUND") {
				// Another ASIN, or no ASIN, or another origin: nothing on this
				// page, not even a UPC, may be taken.
				unable(unusable(binding.kind === "UNKNOWN" ? binding.cause : "no_identity_evidence"));
			} else {
				candidate = read.facts ? boundFacts(read.facts, binding.via) : null;
				candidateVia = candidate ? binding.via : null;
				const direct = acceptNutrition(candidate, evidence);
				if (direct) return matched(direct);
				sawPartialPanel(candidate);
				if (!(candidate || read.hasProductTitle)) {
					unable({ status: "error", cause: "unrecognized_page" });
				}
			}
		}
	} catch {
		unable({ status: "error", cause: "navigation_failed" });
	}
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
				unable({ status: "blocked", cause: "robot_check" });
			} else if (searchStatus !== null && searchStatus >= 400) {
				unable({ status: "error", cause: "http_error" });
			} else {
				const productUrls = parseWholeFoodsSearchResultDoms(searchHtml).slice(
					0,
					MAX_WHOLE_FOODS_TILES,
				);
				if (productUrls.length) {
					for (const productUrl of productUrls) {
						const resolvedUrl = new URL(productUrl, WHOLE_FOODS_ORIGIN);
						if (resolvedUrl.origin !== WHOLE_FOODS_ORIGIN) {
							// This tile is not ours to open; the others still count.
							unable(unusable("untrusted_origin"));
							continue;
						}
						const productStatus = await navigateAndSettle(
							page,
							resolvedUrl.href,
							undefined,
							true,
						);
						const productHtml = await page.content();
						if (isBlockedPage(productHtml)) {
							unable({ status: "blocked", cause: "robot_check" });
						} else if (isGone(productStatus)) {
							// This tile's page is gone; the other tiles still count.
						} else if (productStatus !== null && productStatus >= 400) {
							unable({ status: "error", cause: "http_error" });
						} else {
							const finalUrl = page.url();
							const observation = readWholeFoodsProductPage(productHtml);
							const binding = bindProduct(
								{ ...requested, boundGtin: candidate?.upc ?? null },
								{ source: "wholefoods", obs: observation, finalUrl },
							);
							if (binding.kind === "UNKNOWN") {
								unable(unusable(binding.cause));
								continue;
							}
							if (binding.kind === "OTHER") {
								// A readable page for another product: an answer.
								continue;
							}
							const subject = mainSubject(observation, finalUrl);
							const facts =
								subject.kind === "SUBJECT" && subject.facts
									? boundFacts(subject.facts, binding.via)
									: null;
							const verified = acceptNutrition(facts, evidence);
							if (verified) return matched(verified);
							if (facts) {
								sawPartialPanel(facts);
								candidate = {
									...facts,
									upc: facts.upc ?? candidate?.upc ?? null,
								};
								candidateVia = binding.via;
							} else if (!hasProductPageEvidence(productHtml)) {
								unable({ status: "error", cause: "unrecognized_page" });
							}
						}
					}
				} else if (
					!/\b(?:0|no)\s+(?:products|results)\b|no matching products/i.test(
						searchHtml,
					)
				) {
					// Neither tiles nor a no-results message: not a search page we know.
					unable({ status: "error", cause: "unrecognized_page" });
				}
			}
		}
	} catch {
		unable({ status: "error", cause: "navigation_failed" });
	}
	try {
		const usda = await lookupUsdaNutrition(
			usdaApiKey,
			name,
			candidate?.upc ?? null,
			candidateVia,
		);
		if (usda) {
			const merged = acceptNutrition(
				{
					...usda,
					allergens: candidate?.allergens ?? null,
					category: candidate?.category ?? [],
					highlights: candidate?.highlights ?? [],
					ingredients: candidate?.ingredients ?? usda.ingredients ?? null,
					rawNutritionText: candidate?.rawNutritionText ?? null,
					upc: candidate?.upc ?? usda.upc,
				},
				evidence,
			);
			if (merged) return matched(merged);
		}
		const own = acceptNutrition(candidate, evidence);
		return own ? matched(own) : noMatch(false);
	} catch {
		const own = acceptNutrition(candidate, evidence);
		return own ? matched(own) : noMatch(true);
	}
}

/** One nutrition row per ordered product. A matched row carries the accepted
 *  observation's facts. Any other outcome carries its status and cause and
 *  no fact at all: every fact field is null (lists empty), and it names the
 *  ordered product only by its own key and name.
 *
 *  The row has the same key whatever its status, and the connector keeps no
 *  per-key state. A store that upserts by key will let a later not_found,
 *  error or blocked row replace an earlier matched row. Consumers MUST apply
 *  fact fields only when `status` is `matched`. */
function buildNutritionRecord(
	productId: string,
	name: string,
	outcome: NutritionLookup,
): NutritionRecord {
	if (outcome.status !== "matched") {
		return {
			added_sugar_g: null,
			allergens: null,
			calcium_mg: null,
			calories: null,
			carbs_g: null,
			category: [],
			cause: outcome.cause,
			cholesterol_mg: null,
			confidence: "low",
			fat_g: null,
			fiber_g: null,
			highlights: [],
			id: productId,
			ingredients: null,
			iron_mg: null,
			name,
			potassium_mg: null,
			product_id: productId,
			protein_g: null,
			raw_nutrition_text: null,
			saturated_fat_g: null,
			serving_size: null,
			servings_per_container: null,
			sodium_mg: null,
			source: outcome.status,
			status: outcome.status,
			sugar_g: null,
			trans_fat_g: null,
			type: "https://schema.org/NutritionInformation",
			upc: null,
			usda_brand: null,
			usda_description: null,
			usda_fdc_id: null,
			usda_match_method: null,
			vitamin_d_mcg: null,
		};
	}
	const facts = outcome.facts;
	return {
		cause: null,
		status: "matched",
		added_sugar_g: facts.addedSugarG,
		allergens: facts.allergens,
		calcium_mg: facts.calciumMg,
		calories: facts.calories,
		carbs_g: facts.carbsG,
		category: facts.category,
		cholesterol_mg: facts.cholesterolMg,
		confidence: facts.confidence,
		fat_g: facts.fatG,
		fiber_g: facts.fiberG,
		highlights: facts.highlights,
		ingredients: facts.ingredients,
		iron_mg: facts.ironMg,
		name,
		id: productId,
		product_id: productId,
		potassium_mg: facts.potassiumMg,
		protein_g: facts.proteinG,
		raw_nutrition_text: facts.rawNutritionText,
		saturated_fat_g: facts.saturatedFatG,
		serving_size: facts.servingSize,
		servings_per_container: facts.servingsPerContainer,
		sodium_mg: facts.sodiumMg,
		source: facts.source,
		sugar_g: facts.sugarG,
		type: "https://schema.org/NutritionInformation",
		trans_fat_g: facts.transFatG,
		upc: facts.upc,
		usda_brand: facts.usdaBrand,
		usda_description: facts.usdaDescription,
		usda_fdc_id: facts.fdcId,
		usda_match_method: facts.usdaMatchMethod,
		vitamin_d_mcg: facts.vitaminDMcg,
	};
}

/** What `collectOrderStubs` could not prove. */
interface OrderCollectionOutcome {
	/** Orders whose detail item list matched neither search count. Neither the
	 *  order nor its items were emitted, because no end of the item list was
	 *  observed, so `orders`, `order_items` and `nutrition` are not complete. */
	unverifiedCountOrders: number;
	/** The first detail page that gave no readable evidence or was not the
	 *  requested order's (a redirect to another order), with how many orders
	 *  were skipped for either reason. Their records are missing, so no stream
	 *  may finish. The remaining orders were still read. */
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
	return isCancelledOrderDetail(html)
		? { ...detail, status: "Cancelled" }
		: detail;
}

/** Fetch, verify and emit every discovered order. Auth failures still end the
 *  run. A detail that is unreadable or not the requested order's is skipped
 *  and counted as unreadable. A detail whose item count cannot be reconciled
 *  with the search count is counted as unverified. Either way the order and
 *  its items are withheld, the rest are still read, and the caller reports the
 *  order-derived streams as failed. */
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
}): Promise<OrderCollectionOutcome> {
	const usdaApiKey = credentials.USDA_API_KEY || USDA_DEMO_KEY;
	let unverifiedCountOrders = 0;
	let unreadable = null as OrderCollectionOutcome["unreadable"];
	// Every source-backed item is considered once per run, and every one gets a
	// nutrition row: matched facts, or an outcome row with status and cause.
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
		let detail: OrderDetail;
		try {
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
			// The page must be the requested order's before any of its rows,
			// dates or cancellation status are read as that order's.
			if (
				bindOrder(
					{ orderId: stub.orderId },
					readOrderObservation(page.url(), html),
				).kind !== "BOUND"
			) {
				throw new OrderEnumerationUnprovenError(
					"Whole Foods order detail was not the requested order",
				);
			}
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
		const orderDetailsVerified = !(
			itemsWithoutAsin > 0 ||
			buildOrderItemRecords(stub.orderId, detail.items).length !==
				detail.items.length ||
			(detail.items.length > 0 && !orderDetailCountsMatch(stub, detail.items))
		);
		if (!orderDetailsVerified) {
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

		if (wantsOrders && orderDetailsVerified) {
			const orderRecord = buildOrderRecord(
				stub,
				detail.orderDateRaw,
				detail.items,
				detail.status ?? null,
			);
			if (ordersCursor.shouldEmit(orderRecord)) {
				await emitRecord("orders", orderRecord);
			}
		}

		if (wantsItems && orderDetailsVerified) {
			for (const itemRecord of buildOrderItemRecords(
				stub.orderId,
				detail.items,
			)) {
				await emitRecord("order_items", itemRecord);
			}
		}

		if (wantsNutrition && nutritionCursor && orderDetailsVerified) {
			for (const item of detail.items) {
				if (!item.productId || consideredProductIds.has(item.productId)) {
					continue;
				}
				consideredProductIds.add(item.productId);
				const outcome = await lookupNutritionForProduct(
					page,
					usdaApiKey,
					item.name,
					item.productId,
				);
				// Every ordered product gets exactly one row, whatever the
				// outcome; the coverage counts below are tallied from the same
				// outcome that builds the row.
				if (outcome.status === "matched") {
					if (outcome.facts.source === "usda_fdc") {
						nutritionCoverage.foundUSDA += 1;
					} else {
						nutritionCoverage.found += 1;
					}
				} else if (outcome.status === "blocked") {
					nutritionCoverage.blocked += 1;
				} else if (outcome.status === "error") {
					nutritionCoverage.error += 1;
				} else {
					nutritionCoverage.notFound += 1;
				}
				const record = buildNutritionRecord(item.productId, item.name, outcome);
				if (nutritionCursor.shouldEmit(record)) {
					await emitRecord("nutrition", record);
				}
				// Per product, not per order: one order can hold many products,
				// each with several page reads.
				await progress(
					`Looked up nutrition for ${consideredProductIds.size} products`,
					{ count: consideredProductIds.size, stream: "nutrition" },
				);
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
	// No inspected source surface supplies owner/response-bound inventory proof.
	// Layout and matching parsed counts never authorize a checkpoint.
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
			`Looked up nutrition for ${consideredProductIds.size} products (${nutritionCoverage.notFound} not found, ${nutritionCoverage.error + nutritionCoverage.blocked} could not be read)`,
			{
				count: nutritionCoverage.found + nutritionCoverage.foundUSDA,
				stream: "nutrition",
				total: consideredProductIds.size,
			},
		);
	}
	return { unreadable, unverifiedCountOrders };
}

/** Streams whose completeness depends on the order enumeration. */
const ORDER_DERIVED_STREAMS = ["orders", "order_items", "nutrition"] as const;

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
			// A count mismatch is evidence the item lists are incomplete.
			// (A wrong-order page is counted as unreadable above, not here.)
			// Search markup never proves the parent inventory complete.
			throw new OrderItemsUnprovenError(
				`Whole Foods order detail item counts could not be reconciled with the search counts for ${outcome.unverifiedCountOrders} of ${stubs.length} orders; the item lists have no end evidence`,
			);
		}
		throw new OrderEnumerationUnprovenError(
			"Whole Foods has no owner-bound source inventory total or end evidence",
		);
	} catch (error) {
		if (!(error instanceof OrderEnumerationUnprovenError)) {
			throw error;
		}
		// Orders read before the list became unproven are real: deliver them
		// (no finishing STATE) so a capped or interrupted walk keeps its reads.
		// A navigation or readiness failure while delivering them must still
		// reach the stream-failure reporting below, so it is held until then.
		let deliveryError: unknown = null;
		if (error.partialStubs.length > 0) {
			try {
				const partial = await deliverPartialStubs(ctx, error.partialStubs);
				deliveryError = partial.unreadable?.first ?? null;
			} catch (caught) {
				deliveryError = caught;
			}
		}
		const message =
			deliveryError instanceof OrderEnumerationUnprovenError
				? `${error.message}; ${deliveryError.message}`
				: error.message;
		const failedStreams = ORDER_DERIVED_STREAMS;
		for (const stream of failedStreams) {
			if (requested.has(stream)) {
				await ctx.emit({
					type: "SKIP_RESULT",
					stream,
					reason: "inventory_not_proven_complete",
					message,
					recovery_hint: { action: "retry_by_runtime", retryable: true },
				});
				if (
					reportStreamFailure &&
					(/navigation_failed|readiness_timeout/.test(message) ||
						(deliveryError !== null &&
							!(deliveryError instanceof OrderEnumerationUnprovenError)))
				) {
					await reportStreamFailure(stream, message, { retryable: true });
				}
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
): Promise<OrderCollectionOutcome> {
	return collectOrderStubs({
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
	collectOrderStubs,
	collectOrders,
	collectProfile,
	discoverOrderStubs,
	lookupNutritionForProduct,
	lookupUsdaNutrition,
	orderDetailCountsMatch,
};
