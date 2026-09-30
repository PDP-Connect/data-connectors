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
	mapUsdaNutrients,
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
		throw new Error(
			`Whole Foods navigation failed with HTTP ${response.status()}`,
		);
	}
	if (readySelector) {
		try {
			await page.locator(readySelector).first().waitFor({
				state: "attached",
				timeout: NAV_READY_WAIT_MS,
			});
		} catch (error) {
			throw new Error(
				`wholefoods_order_page_readiness_timeout after ${String(NAV_READY_WAIT_MS)}ms`,
				{ cause: error },
			);
		}
	}
	await politeDelay(NAV_SETTLE_MS);
	return response?.status() ?? null;
}

// ─── Profile ────────────────────────────────────────────────────────────

async function collectProfile(
	page: Page,
	emitRecord: BrowserCollectContext["emitRecord"],
): Promise<void> {
	await navigateAndSettle(page, AMAZON_ORDER_HISTORY_URL);
	const html = await page.content();
	const { customerId, name } = parseAmazonProfileDom(html);
	// A profile record needs a real primary key. Live evidence (2026-09-22,
	// see the connector's report CONTRACT-CHANGE-REQUEST) showed the
	// capability map's assumed `email` field is not safely obtainable — no
	// reachable page renders it without crossing a re-authentication gate.
	// `customerId` (Amazon's own stable opaque account id, parsed from the
	// page's inline analytics payload) is the real identity used instead.
	// When even that is unavailable there is no honest identity to key a
	// record on; skip rather than invent one (D3: only a real per-entity
	// identity becomes a record).
	if (!customerId) {
		return;
	}
	const record: ProfileRecord = { email: null, id: customerId, name };
	await emitRecord("profile", record);
}

// ─── Orders: discovery ────────────────────────────────────────────────────

async function discoverOrderStubs(
	page: Page,
	progress: BrowserCollectContext["progress"],
): Promise<{ stubs: OrderStub[] }> {
	const stubs: OrderStub[] = [];
	const seen = new Set<string>();
	let previousRowSignature: string | null = null;
	for (let pageNum = 1; pageNum <= MAX_SEARCH_PAGES; pageNum += 1) {
		await navigateAndSettle(
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
			rowSignature,
			selectedPage,
			stubs: pageStubs,
		} = parseOrderSearchPageDom(html);
		if (
			pageStubs.length === 0 &&
			!/no-orders|\b(?:0|no)\s+(?:orders|results)\b/i.test(html)
		) {
			throw new Error(
				"Whole Foods order search returned no recognizable results or empty-state evidence",
			);
		}
		for (const stub of pageStubs) {
			if (seen.has(stub.orderId)) {
				const existing = stubs.find((s) => s.orderId === stub.orderId);
				if (existing) {
					existing.expectedItemCount += stub.expectedItemCount;
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
		if (
			hasNextPage &&
			((selectedPage !== null && selectedPage !== pageNum) ||
				rowSignature === previousRowSignature)
		) {
			throw new Error("Whole Foods order pagination repeated a page");
		}
		if (hasNextPage && pageNum === MAX_SEARCH_PAGES) {
			throw new Error(
				"Whole Foods order search exceeded the page limit before reaching the end",
			);
		}
		if (!hasNextPage) {
			break;
		}
		previousRowSignature = rowSignature;
		await politeDelay(POLITE_DELAY_MS);
	}
	return { stubs };
}

// ─── Orders: detail + record building ─────────────────────────────────────

/** Stable reason code for an order whose detail item count matches neither
 *  the search-card row count nor the detail-row count. Display copy lives in
 *  manifest.json `reason_display_messages`. */
export const ORDER_ITEM_COUNT_UNVERIFIED_REASON =
	"wholefoods_order_item_count_unverified";

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
		orderDetailUnitCount(items) === stub.expectedItemCount ||
		items.length === stub.expectedItemCount
	);
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

/** Fetch, verify and emit every discovered order. Auth and readability
 *  failures still end the run. A detail whose item count cannot be
 *  reconciled with the search count does not: the order and its items are
 *  delivered, and one SKIP_RESULT reports how many orders were unverified. */
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
}): Promise<void> {
	const usdaApiKey = credentials.USDA_API_KEY || USDA_DEMO_KEY;
	let unverifiedCountOrders = 0;
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
		await navigateAndSettle(
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
		if (
			isBlockedPage(html) ||
			/<form[^>]*name=["']signIn["']/i.test(html)
		) {
			throw new Error(
				`Whole Foods order ${stub.orderId} detail was blocked or signed out`,
			);
		}
		if (!hasOrderDetailEvidence(html)) {
			throw new Error(
				`Whole Foods order ${stub.orderId} detail has no item or cancellation evidence`,
			);
		}
		const detail = parseOrderDetailDom(html);
		if (!orderDetailCountsMatch(stub, detail.items)) {
			unverifiedCountOrders += 1;
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
				const record = buildNutritionRecord(
					item.productId,
					item.name,
					facts,
				);
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
		await emit({
			diagnostics: {
				unverified_orders: unverifiedCountOrders,
				total_orders: stubs.length,
			},
			message: `${unverifiedCountOrders} of ${stubs.length} Whole Foods orders were delivered, but their item counts could not be verified against the order search.`,
			recovery_hint: {
				action: "retry_on_connector_upgrade",
				retryable: false,
			},
			reason: ORDER_ITEM_COUNT_UNVERIFIED_REASON,
			stream: "orders",
			type: "SKIP_RESULT",
		});
	}
	if (wantsOrders) {
		await emit({
			cursor: ordersCursor.toState(),
			stream: "orders",
			type: "STATE",
		});
	}
	if (wantsNutrition && nutritionCursor) {
		await progress(
			`Nutrition lookup coverage: ${consideredProductIds.size} products; ${nutritionCoverage.found} Whole Foods, ${nutritionCoverage.foundUSDA} USDA, ${nutritionCoverage.blocked} blocked, ${nutritionCoverage.error} error, ${nutritionCoverage.notFound} not found`,
			{
				count: nutritionCoverage.found + nutritionCoverage.foundUSDA,
				stream: "nutrition",
				total: consideredProductIds.size,
			},
		);
		await emit({
			cursor: nutritionCursor.toState(),
			stream: "nutrition",
			type: "STATE",
		});
	}
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
			requested,
			state,
		}: BrowserCollectContext): Promise<void> {
			const wantsProfile = requested.has("profile");
			const wantsOrders = requested.has("orders");
			const wantsItems = requested.has("order_items");
			const wantsNutrition = requested.has("nutrition");

			if (wantsProfile) {
				await collectProfile(page, emitRecord);
			}

			if (!(wantsOrders || wantsItems || wantsNutrition)) {
				return;
			}

			const ordersCursor = openFingerprintCursor(state.orders);
			const { stubs } = await discoverOrderStubs(page, progress);
			await progress(`Found ${stubs.length} Whole Foods order(s)`, {
				count: stubs.length,
				stream: "orders",
			});

			await collectOrderStubs({
				credentials,
				emit,
				emitRecord,
				ordersCursor,
				page,
				progress,
				state,
				stubs,
				wantsItems,
				wantsNutrition,
				wantsOrders,
			});
		},
	});
}

// Exported for tests — kept free of the isMainModule guard so integration
// tests can call them directly without spawning a subprocess/browser.
export {
	orderDetailCountsMatch,
	buildNutritionRecord,
	buildOrderItemRecord,
	buildOrderRecord,
	collectOrderStubs,
	collectProfile,
	discoverOrderStubs,
	lookupNutritionForProduct,
	lookupUsdaNutrition,
};
