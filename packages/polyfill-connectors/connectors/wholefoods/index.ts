#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PDPP Whole Foods Connector.
 *
 * Whole Foods orders are placed through Amazon, so this connector reuses the
 * shared Amazon session library (`../../src/auto-login/amazon.ts` —
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
import { ensureAmazonSession } from "../../src/auto-login/amazon.ts";
import {
	type BrowserCollectContext,
	politeDelay,
	runConnector,
} from "../../src/connector-runtime.ts";
import { openFingerprintCursor } from "../../src/fingerprint-cursor.ts";
import {
	bestUsdaMatch,
	cleanProductName,
	mapUsdaNutrients,
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
const MAX_SEARCH_PAGES = 50;
const USDA_MIN_TEXT_SCORE = 0.4;
// Per-run cap on nutrition lookups (wholefoodsmarket.com product-page
// navigations + USDA FDC requests). Nutrition is best-effort enrichment, not
// core scope (D8) — a run with hundreds of unique products should not spend
// hundreds of extra navigations/requests polling two external sites every
// run. A capped run reports its coverage (considered vs. looked-up) via
// PROGRESS rather than silently truncating.
const MAX_NUTRITION_LOOKUPS_PER_RUN = 25;

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
const ORDERS_PAGE_READY_SELECTOR =
	'form[name="signIn"], .order-card, .js-order-card, .hzsearch-results-summary, [class*="no-orders" i]';
const NAV_READY_WAIT_MS = 15_000;

function wholeFoodsSearchUrl(page: number): string {
	return `${AMAZON_SEARCH_BASE}&page=${page}`;
}

/** Navigate, then wait for a content-ready signal before treating the page
 *  as settled — best-effort: a page that never matches still falls through
 *  to the fixed politeDelay rather than hanging on waitForSelector's own
 *  timeout. */
async function navigateAndSettle(
	page: Page,
	url: string,
	readySelector?: string,
): Promise<void> {
	await page
		.goto(url, { timeout: NAV_TIMEOUT_MS, waitUntil: "domcontentloaded" })
		.catch((): undefined => undefined);
	if (readySelector) {
		await page
			.locator(readySelector)
			.first()
			.waitFor({ state: "attached", timeout: NAV_READY_WAIT_MS })
			.catch((): undefined => undefined);
	}
	await politeDelay(NAV_SETTLE_MS);
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

async function discoverOrderStubs(page: Page): Promise<{ stubs: OrderStub[] }> {
	const stubs: OrderStub[] = [];
	const seen = new Set<string>();
	for (let pageNum = 1; pageNum <= MAX_SEARCH_PAGES; pageNum += 1) {
		await navigateAndSettle(
			page,
			wholeFoodsSearchUrl(pageNum),
			ORDERS_PAGE_READY_SELECTOR,
		);
		const html = await page.content();
		const { hasNextPage, stubs: pageStubs } = parseOrderSearchPageDom(html);
		let sawNewOrder = false;
		for (const stub of pageStubs) {
			if (seen.has(stub.orderId)) {
				continue;
			}
			seen.add(stub.orderId);
			stubs.push(stub);
			sawNewOrder = true;
		}
		if (!hasNextPage || !sawNewOrder) {
			break;
		}
		await politeDelay(POLITE_DELAY_MS);
	}
	return { stubs };
}

// ─── Orders: detail + record building ─────────────────────────────────────

function buildOrderRecord(
	stub: OrderStub,
	orderDateRaw: string | null,
	items: readonly OrderDetailItem[],
): OrderRecord {
	const totalCents = items.reduce((sum, item) => {
		const cents = parseDollarsToCents(item.unitPriceDollars);
		const qty = item.quantity ?? 1;
		return cents === null ? sum : sum + Math.round(cents * qty);
	}, 0);
	return {
		id: stub.orderId,
		item_count: items.length > 0 ? items.length : null,
		order_date: parseOrderDateIso(orderDateRaw ?? stub.orderDateRaw),
		order_url: stub.orderUrl,
		status: "Completed",
		total_cents: items.length > 0 ? totalCents : null,
	};
}

function buildOrderItemRecord(
	orderId: string,
	item: OrderDetailItem,
): OrderItemRecord {
	// Amazon ASINs are globally unique per product but not per order line, so
	// the item id is the (order, product) pair — mirrors connectors/amazon's
	// order_items id shape.
	const id = item.productId
		? `${orderId}#${item.productId}`
		: `${orderId}#${item.name}`;
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
	const res = await fetch(url, {
		signal: AbortSignal.timeout(10_000),
	}).catch((): null => null);
	if (!res || !res.ok) {
		return [];
	}
	const json: unknown = await res.json().catch((): null => null);
	if (!isUsdaSearchResponse(json) || !Array.isArray(json.foods)) {
		return [];
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

/** Try the Whole Foods product page first; fall back to USDA FDC when the
 *  product page has no nutrition evidence AND a USDA key is configured.
 *  `usdaApiKey` is undefined when the connection has no `USDA_API_KEY`
 *  credential and no default is configured — see index.ts's `auth` block
 *  (optional, via `authOptional: true`) and manifest `setup` — in which case
 *  the public DEMO_KEY (rate-limited but functional) is used, matching the
 *  legacy connector's default. */
async function lookupNutritionForProduct(
	page: Page,
	usdaApiKey: string,
	name: string,
): Promise<NutritionFacts | null> {
	const query = cleanProductName(name);
	if (query.length >= 3) {
		await navigateAndSettle(
			page,
			`https://www.wholefoodsmarket.com/search?text=${encodeURIComponent(query)}`,
		);
		const searchHtml = await page.content();
		const productUrl = parseWholeFoodsSearchResultDom(searchHtml);
		if (productUrl) {
			await navigateAndSettle(page, productUrl);
			const productHtml = await page.content();
			const fromWholeFoods = parseWholeFoodsProductPageDom(productHtml);
			if (fromWholeFoods) {
				return fromWholeFoods;
			}
		}
	}
	return lookupUsdaNutrition(usdaApiKey, name);
}

function buildNutritionRecord(
	productId: string,
	name: string,
	facts: NutritionFacts,
): NutritionRecord {
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
			capture,
			checkpoint,
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
				...(capture ? { capture } : {}),
				checkpoint,
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
			const { stubs } = await discoverOrderStubs(page);
			await progress(`Found ${stubs.length} Whole Foods order(s)`, {
				count: stubs.length,
				stream: "orders",
			});

			const usdaApiKey = credentials.USDA_API_KEY || USDA_DEMO_KEY;
			// `consideredProductIds` is every unique product id this run's orders
			// referenced (the honest denominator); `lookedUpProductIds` is the
			// capped subset actually looked up (the numerator). Reported as
			// PROGRESS, not a record — D3: envelope/coverage counters are run
			// evidence, not entity data.
			const consideredProductIds = new Set<string>();
			const lookedUpProductIds = new Set<string>();
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
					// which never renders purchasedItemsRightGrid.
					'[data-component="purchasedItemsRightGrid"], [data-component="cancelled"], form[name="signIn"]',
				);
				const html = await page.content();
				const detail = parseOrderDetailDom(html);

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
					for (const item of detail.items) {
						await emitRecord(
							"order_items",
							buildOrderItemRecord(stub.orderId, item),
						);
					}
				}

				if (wantsNutrition && nutritionCursor) {
					for (const item of detail.items) {
						if (!item.productId || consideredProductIds.has(item.productId)) {
							continue;
						}
						consideredProductIds.add(item.productId);
						if (lookedUpProductIds.size >= MAX_NUTRITION_LOOKUPS_PER_RUN) {
							continue;
						}
						lookedUpProductIds.add(item.productId);
						const facts = await lookupNutritionForProduct(
							page,
							usdaApiKey,
							item.name,
						);
						if (!facts) {
							continue;
						}
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

			if (wantsOrders) {
				await emit({
					cursor: ordersCursor.toState(),
					stream: "orders",
					type: "STATE",
				});
			}
			if (wantsNutrition && nutritionCursor) {
				await progress(
					`Nutrition lookup coverage: ${lookedUpProductIds.size}/${consideredProductIds.size} unique product(s) looked up (cap ${MAX_NUTRITION_LOOKUPS_PER_RUN} per run)`,
					{
						count: lookedUpProductIds.size,
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
		},
	});
}

// Exported for tests — kept free of the isMainModule guard so integration
// tests can call them directly without spawning a subprocess/browser.
export {
	buildNutritionRecord,
	buildOrderItemRecord,
	buildOrderRecord,
	collectProfile,
	discoverOrderStubs,
	lookupNutritionForProduct,
	lookupUsdaNutrition,
};
