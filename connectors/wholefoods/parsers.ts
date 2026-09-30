// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pure parsers for the Whole Foods connector. Kept free of Playwright / Node
// I/O so they can be unit-tested in isolation. Ported from the legacy
// connectors/wholefoods/wholefoods-playwright.js in-browser page.evaluate()
// callbacks into real HTML-string parsers (structure over text, per
// docs/connector-authoring-guide.md §2) using the same `linkedom` DOM parser
// connectors/amazon/parsers.ts uses.

import { parseHTML } from "linkedom";
import type {
	NutritionFacts,
	OrderDetail,
	OrderDetailItem,
	OrderStub,
	UsdaFood,
	UsdaMatchMethod,
	WholeFoodsProfile,
} from "./types.ts";

const CURRENCY_CENTS_MULTIPLIER = 100;
const CURRENCY_THOUSANDS_RE = /[,_\s](?=\d{3}(?:\D|$))/g;
const CURRENCY_NUMBER_RE = /-?(\d+(?:\.\d+)?)/;
const ORDER_ID_FROM_HREF_RE = /orderID=([^&]+)/;
const ORDERED_ON_RE = /Ordered on\s+(.+)/i;
const ASIN_FROM_HREF_RE = /\/(?:dp|gp\/product)\/([A-Z0-9]{10})/;
const REF_PARAM_RE = /[?&]ref_=[^&]*/;
const CUSTOMER_ID_RE = /"customerId":"([A-Z0-9]+)"/;
const WHITESPACE_RE = /\s+/g;
const QTY_RE = /(?:Qty|Quantity)[:\s]*(\d+(?:\.\d+)?)/i;
const PRICE_RE = /\$(\d+(?:\.\d{2})?)/;
const SIZE_SUFFIX_RE =
	/,?\s*(\d+(\.\d+)?\s*)?(oz|lb|lbs|fl oz|gal|ct|pk|count|each)\.?\s*$/i;
const PACK_SUFFIX_RE =
	/,?\s*\d+\s+(Mega\s+)?(Rolls|Bags|Cans|Bottles|Packs?)$/i;
const BRAND_PREFIX_RE = /^(365\s+by\s+)?Whole\s+Foods\s+Market\s*/i;
const GENERIC_PREFIX_RE = /^(Organic|365\s+Everyday\s+Value)\s*/i;
const NUTRITION_HEADING_RE = /nutrition\s*facts/i;
const CALORIES_RE = /Calories[:\s]*(\d+)/i;
const SERVING_SIZE_RE = /Serving [Ss]ize[:\s]*([^\n]+)/;
const SERVINGS_PER_CONTAINER_RE =
	/(\d+(?:\.\d+)?)\s*servings?\s*per\s*container|servings?\s*per\s*container[:\s]*(\d+(?:\.\d+)?)/i;
const NUTRIENT_PATTERN_SOURCE =
	"(Total Fat|Saturated Fat|Trans Fat|Cholesterol|Sodium|Total Carbohydrate|Dietary Fiber|Added Sugars|Sugars|Protein|Potassium|Calcium|Iron|Vitamin D)[:\\s]*(\\d+\\.?\\d*)";

const IN_STORE_ITEM_LIST_SELECTOR = "#f3_food_ItemList";
// "Qty: 1 @ $7.99 each" | "Qty: 2.17 lb @ $6.99/lb"
const IN_STORE_QTY_RE =
	/Qty:\s*(\d+(?:\.\d+)?)(?:\s+([A-Za-z]+))?\s*@\s*\$(\d+(?:\.\d+)?)/i;

/** Elements that show an order-detail page has finished rendering: legacy
 *  item grid, cancelled order, sign-in form, in-store list, or delivery items. */
export const ORDER_DETAIL_READY_SELECTOR =
	'[data-component="purchasedItemsRightGrid"], [data-component="cancelled"], form[name="signIn"], #f3_food_ItemList, #line-items, [id$="-item-grid-row"]';

const ORDER_DETAIL_EVIDENCE_RE =
	/data-component=["'](?:purchasedItemsRightGrid|cancelled)["']|id=["'](?:f3_food_ItemList|line-items)["']|id=["'][^"']+-item-grid-row["']/i;

/** True when the page carries item, cancellation or in-store item-list
 *  evidence, so an empty parse is a real result and not a blank page. */
export function hasOrderDetailEvidence(html: string): boolean {
	return ORDER_DETAIL_EVIDENCE_RE.test(html);
}

/** Units on an order detail, comparable to the search page's row count: a
 *  weighed row is one search row however many lb it weighs. */
export function orderDetailUnitCount(
	items: readonly OrderDetailItem[],
): number {
	return items.reduce(
		(sum, item) => sum + (item.quantityUnit ? 1 : (item.quantity ?? 1)),
		0,
	);
}

/** Strip Amazon's `ref_=...` attribution query param and resolve a relative
 *  href to an absolute amazon.com URL. */
function absoluteAmazonUrl(href: string): string {
	const stripped = href.replace(REF_PARAM_RE, "");
	return stripped.startsWith("/")
		? `https://www.amazon.com${stripped}`
		: stripped;
}

function textOf(el: Element | null | undefined): string {
	if (!el) {
		return "";
	}
	const maybe = (el as { innerText?: string }).innerText;
	return typeof maybe === "string" ? maybe : (el.textContent ?? "");
}

// ─── Profile ────────────────────────────────────────────────────────────

/**
 * Parse an Amazon page for the signed-in account's name and stable customer
 * id.
 *
 * GROUND-TRUTH CORRECTION (live capture 2026-09-22, `/gp/css/homepage.html`):
 * the legacy connector's profile selectors (`#ya-myab-display-name`,
 * `.ya-card__data-display`, `[data-testid="ya-myab-*"]`) do not exist on the
 * modern "Your Account" page at all — it is a settings card grid with no
 * name/email display. The one confirmed-real, reliably-present source is the
 * header greeting (`#nav-link-accountList-nav-line-1`, text "Hello,
 * <name>"), present on every authenticated Amazon page (this was already the
 * legacy code's fallback selector, just never its primary one). Email is NOT
 * extracted: the only candidate page found this session
 * (`/account/manageaccount`) 404'd, and the one page that plausibly shows it
 * (`Login & security`) sits behind an `/ap/cnep` re-authentication gate this
 * connector must not cross (the live-run protocol requires stopping on any
 * login/challenge page, never automating one) — see the connector's report
 * for the resulting CONTRACT-CHANGE-REQUEST. `customerId` is Amazon's own
 * stable opaque account identifier, present in an inline `cpsData` JSON
 * blob Amazon injects into every page for its own analytics — a more
 * durable identity than any card selector, and not personally identifying
 * by itself.
 */
export function parseAmazonProfileDom(html: string): WholeFoodsProfile {
	const { document } = parseHTML(html);
	const name =
		textOf(document.querySelector("#nav-link-accountList-nav-line-1"))
			.replace(/^hello,\s*/i, "")
			.trim() || null;
	const customerId = CUSTOMER_ID_RE.exec(html)?.[1] ?? null;
	return { customerId, name };
}

// ─── Order search / list page ────────────────────────────────────────────

/**
 * Parse one page of Amazon's Whole-Foods-filtered order search results
 * (`/your-orders/search?search=Whole+Foods+Market`). The search surface
 * lists ITEMS, not orders — each result row carries a "View order details"
 * link with the order id. Callers dedupe across pages by `orderId`.
 */
export function parseOrderSearchPageDom(html: string): {
	hasNextPage: boolean;
	rowSignature: string;
	selectedPage: number | null;
	stubs: OrderStub[];
} {
	const { document } = parseHTML(html);
	const seen = new Set<string>();
	const stubs: OrderStub[] = [];
	// The search page paginates ITEM rows (about 10 per page), not orders: a
	// large order's rows continue across several pages, so a page with no new
	// order id is normal. Repetition is detected on the row signature instead.
	const rowKeys: string[] = [];
	for (const grid of document.querySelectorAll<HTMLElement>(
		".a-fixed-left-grid",
	)) {
		const link = grid.querySelector<HTMLAnchorElement>(
			'a[title="View order details"], a[href*="order-details"]',
		);
		const href = link?.getAttribute("href") ?? "";
		const orderId = ORDER_ID_FROM_HREF_RE.exec(href)?.[1];
		if (!orderId) {
			continue;
		}
		rowKeys.push(
			[...grid.querySelectorAll<HTMLAnchorElement>("a[href]")]
				.map((a) => a.getAttribute("href") ?? "")
				.join(" "),
		);
		if (seen.has(orderId)) {
			const existing = stubs.find((stub) => stub.orderId === orderId);
			if (existing) {
				existing.expectedItemCount += 1;
			}
			continue;
		}
		seen.add(orderId);
		const row = link?.closest<HTMLElement>(".a-row");
		let orderDateRaw: string | null = null;
		for (const span of row?.querySelectorAll<HTMLElement>("span") ?? []) {
			const m = ORDERED_ON_RE.exec(textOf(span));
			if (m?.[1]) {
				orderDateRaw = m[1].trim();
				break;
			}
		}
		// Use the real href Amazon rendered rather than reconstructing a guessed
		// URL: a live capture (2026-09-22) showed the modern search page links to
		// `/your-orders/order-details?orderID=...`, not the legacy
		// `/uff/your-account/order-details` path this connector's prior art
		// assumed.
		stubs.push({
			expectedItemCount: 1,
			orderDateRaw,
			orderId,
			orderUrl: absoluteAmazonUrl(href),
		});
	}
	const hasNextPage = Boolean(
		document.querySelector("ul.a-pagination li.a-last a"),
	);
	const selectedText = textOf(
		document.querySelector<HTMLElement>("ul.a-pagination li.a-selected"),
	);
	const selectedPage = /^\d+$/.test(selectedText) ? Number(selectedText) : null;
	return { hasNextPage, rowSignature: rowKeys.join("\n"), selectedPage, stubs };
}

// ─── Order detail page ────────────────────────────────────────────────────

/**
 * Parse one Whole Foods order's Amazon order-detail page.
 *
 * GROUND-TRUTH CORRECTION (live capture 2026-09-22 against a Canon order —
 * the account's Whole Foods orders, if any, were not observed this session,
 * see the connector's report): the legacy scraper's ghost-item filter
 * (`href.includes("almBrandId")`) is backwards. `almBrandId` is Amazon's
 * SITE-WIDE "Whole Foods" storefront nav link marker
 * (`/alm/storefront?almBrandId=...`) — it appears once in the page's global
 * navigation on EVERY order-detail page regardless of content, and never on
 * a real line item's own product link. Filtering FOR it, as the legacy code
 * did, would have excluded every genuine line item and kept only the nav
 * link — the opposite of the intended behavior. This connector instead
 * scopes extraction to the real per-order-item structural container Amazon
 * renders (`[data-component="purchasedItemsRightGrid"]`, the same
 * `data-component` contract connectors/amazon's order-detail parser already
 * relies on — see that file's header comment), which structurally excludes
 * the global nav and footer/cross-sell ad links (`ref_=footer_...`,
 * `plattr=...`) without needing a brand-specific marker at all.
 */
export function parseOrderDetailDom(html: string): OrderDetail {
	const { document } = parseHTML(html);
	const deliveryItems = parseDeliveryOrderItems(document);
	if (deliveryItems) {
		return { items: deliveryItems, orderDateRaw: detailOrderDate(document) };
	}
	const inStoreItems = parseInStoreItems(document);
	if (inStoreItems) {
		return { items: inStoreItems, orderDateRaw: detailOrderDate(document) };
	}
	const items: OrderDetailItem[] = [];
	const seenHrefs = new Set<string>();
	for (const itemRow of document.querySelectorAll<HTMLElement>(
		'[data-component="purchasedItemsRightGrid"]',
	)) {
		const anchor = itemRow.querySelector<HTMLAnchorElement>(
			'a[href*="/dp/"], a[href*="/gp/product/"]',
		);
		const href = anchor?.getAttribute("href") ?? "";
		const name = textOf(anchor).trim();
		const productId = ASIN_FROM_HREF_RE.exec(href)?.[1] ?? null;
		// The legacy orders scope requires productId for every item. A row
		// without a source ASIN cannot be projected, so never discard it or
		// replace its identity with a name-derived key.
		if (!(anchor && name && productId) || name.length < 3) {
			throw new Error("Whole Foods order item has no source product ASIN");
		}
		if (seenHrefs.has(href)) {
			continue;
		}
		seenHrefs.add(href);
		const rowText = textOf(itemRow);
		const quantity = QTY_RE.exec(rowText)?.[1];
		const price = PRICE_RE.exec(rowText)?.[1];
		const img = itemRow.querySelector<HTMLImageElement>(
			'img[src*="images-amazon"], img[src*="m.media-amazon"]',
		);
		items.push({
			imageUrl: img?.getAttribute("src") ?? null,
			name,
			productId,
			productUrl: absoluteAmazonUrl(href),
			quantity: quantity ? Number(quantity) : 1,
			unitPriceDollars: price ? Number(price) : null,
		});
	}
	return { items, orderDateRaw: detailOrderDate(document) };
}

/**
 * Delivery orders at `/uff/your-account/order-details` use `#line-items` and
 * one `*-item-grid-row` element per search row. The captured rows have a
 * `/dp/ASIN` link and an image. Their row text may include `Qty: N`; the
 * existing online-order behavior defaults a row without Qty to one. The
 * capture also exposes a dollar price in row text, which uses PRICE_RE.
 * Rows without a product link remain in order accounting but cannot produce
 * an order_items record without a source ASIN.
 */
function parseDeliveryOrderItems(document: Document): OrderDetailItem[] | null {
	const container = document.querySelector<HTMLElement>("#line-items");
	const rows = container
		? container.querySelectorAll<HTMLElement>('[id$="-item-grid-row"]')
		: document.querySelectorAll<HTMLElement>('[id$="-item-grid-row"]');
	if (!container && rows.length === 0) {
		return null;
	}

	return [...rows].map((row) => {
		const anchor = row.querySelector<HTMLAnchorElement>('a[href*="/dp/"]');
		const href = anchor?.getAttribute("href") ?? "";
		const productId = ASIN_FROM_HREF_RE.exec(href)?.[1] ?? null;
		const linkedName = textOf(anchor).replace(WHITESPACE_RE, " ").trim();
		if (productId && !linkedName) {
			throw new Error("Whole Foods delivery item has no source product name");
		}
		const rowText = textOf(row).replace(WHITESPACE_RE, " ");
		const quantity = QTY_RE.exec(rowText)?.[1];
		const price = PRICE_RE.exec(rowText)?.[1];
		const image = row.querySelector<HTMLImageElement>("img");

		return {
			imageUrl: image?.getAttribute("src") ?? null,
			name: linkedName || "Unlinked Whole Foods item",
			productId,
			productUrl: productId ? absoluteAmazonUrl(href) : null,
			quantity: quantity ? Number(quantity) : 1,
			unitPriceDollars: price ? Number(price) : null,
		};
	});
}

function detailOrderDate(document: Document): string | null {
	const pageText = textOf(document.querySelector("body"));
	const dateMatch =
		/(?:Order Placed|Ordered|Order placed)[:\s]*([A-Z][a-z]+ \d+, \d{4})/i.exec(
			pageText,
		) ?? /([A-Z][a-z]+ \d+, \d{4})/.exec(pageText);
	return dateMatch?.[1] ?? null;
}

/**
 * In-store purchases open on `/fopo/order-details`, which renders none of the
 * `data-component` markers. Live capture 2026-09-29: the items sit in
 * `#f3_food_ItemList`, one `.a-row.a-spacing-base` per row (the widget title
 * row has no `.a-column.a-span2`). A row reads
 * `<img class="ufpo-itemListWidget-image"> | <a href="/dp/ASIN">name</a> $line-total`
 * then `Qty: N @ $unit each`, or `Qty: 2.17 lb @ $6.99/lb` for a weighed item.
 *
 * Rules: a weighed row keeps the weight as `quantity`, its unit as
 * `quantityUnit`, and the per-weight price as `unitPriceDollars`. The row's
 * own price is `lineTotalDollars`, the charged amount after promotions. A row
 * without a product link keeps its name and prices but gets `productId: null`;
 * no id is derived from the name.
 */
function parseInStoreItems(document: Document): OrderDetailItem[] | null {
	const container = document.querySelector<HTMLElement>(
		IN_STORE_ITEM_LIST_SELECTOR,
	);
	if (!container) {
		return null;
	}
	const items: OrderDetailItem[] = [];
	const seenHrefs = new Set<string>();
	for (const row of container.querySelectorAll<HTMLElement>(
		".a-row.a-spacing-base",
	)) {
		const titleColumn = row.querySelector<HTMLElement>(
			".a-column.a-span10 .a-column.a-span10",
		);
		if (!(row.querySelector(".a-column.a-span2") && titleColumn)) {
			continue;
		}
		const anchor = titleColumn.querySelector<HTMLAnchorElement>(
			'a[href*="/dp/"], a[href*="/gp/product/"]',
		);
		const href = anchor?.getAttribute("href") ?? "";
		const productId = ASIN_FROM_HREF_RE.exec(href)?.[1] ?? null;
		const name = textOf(anchor ?? titleColumn)
			.replace(WHITESPACE_RE, " ")
			.trim();
		if (name.length < 3) {
			throw new Error("Whole Foods in-store order row has no item name");
		}
		if (productId) {
			if (seenHrefs.has(href)) {
				continue;
			}
			seenHrefs.add(href);
		}
		const rowText = textOf(row).replace(WHITESPACE_RE, " ");
		const qty = IN_STORE_QTY_RE.exec(rowText);
		const img = row.querySelector<HTMLImageElement>(
			'img[src*="images-amazon"], img[src*="m.media-amazon"]',
		);
		const lineTotal = PRICE_RE.exec(
			textOf(row.querySelector(".a-column.a-span2.a-span-last")),
		)?.[1];
		const unitPrice = qty?.[3];
		items.push({
			imageUrl: img?.getAttribute("src") ?? null,
			lineTotalDollars: lineTotal ? Number(lineTotal) : null,
			name,
			productId,
			productUrl: productId ? absoluteAmazonUrl(href) : null,
			quantity: qty?.[1] ? Number(qty[1]) : 1,
			quantityUnit: qty?.[2] ?? null,
			unitPriceDollars: unitPrice ? Number(unitPrice) : null,
		});
	}
	return items;
}

// ─── Shared value parsing (D4: values, no invented precision) ────────────

/** Parse a free-text order date into an ISO-8601 date (`YYYY-MM-DD`), the
 *  real precision the source offers — never a fabricated time-of-day. Null
 *  when unparseable, per D4 (an unparseable value is null, never guessed). */
export function parseOrderDateIso(
	raw: string | null | undefined,
): string | null {
	if (!raw) {
		return null;
	}
	const d = new Date(raw);
	if (Number.isNaN(d.getTime())) {
		return null;
	}
	return d.toISOString().slice(0, 10);
}

/** Parse a dollar amount (e.g. "$42.99") into integer cents, per D4. */
export function parseDollarsToCents(
	raw: number | string | null | undefined,
): number | null {
	if (raw === null || raw === undefined) {
		return null;
	}
	if (typeof raw === "number") {
		return Number.isFinite(raw)
			? Math.round(raw * CURRENCY_CENTS_MULTIPLIER)
			: null;
	}
	const stripped = raw.replace(CURRENCY_THOUSANDS_RE, "");
	const m = CURRENCY_NUMBER_RE.exec(stripped);
	if (!m?.[1]) {
		return null;
	}
	return Math.round(Number(m[1]) * CURRENCY_CENTS_MULTIPLIER);
}

// ─── Nutrition: name cleaning + USDA fuzzy match (pure) ───────────────────

/** Strip Whole Foods brand prefixes and trailing size/pack descriptors so
 *  the cleaned name is a better USDA FDC search query. Ported verbatim
 *  (semantics preserved) from the legacy `cleanProductName`. */
export function cleanProductName(name: string): string {
	return name
		.replace(BRAND_PREFIX_RE, "")
		.replace(GENERIC_PREFIX_RE, "")
		.replace(SIZE_SUFFIX_RE, "")
		.replace(PACK_SUFFIX_RE, "")
		.trim();
}

/** Fraction (0-1) of the query's significant words (length > 2) that appear
 *  in a USDA food's description + brand. Ported from the legacy
 *  `scoreMatch`. */
export function scoreUsdaMatch(query: string, food: UsdaFood): number {
	const qWords = query
		.toLowerCase()
		.split(WHITESPACE_RE)
		.filter((w) => w.length > 2);
	if (qWords.length === 0) {
		return 0;
	}
	const haystack =
		`${food.description} ${food.brandName ?? food.brandOwner ?? ""}`.toLowerCase();
	const hits = qWords.filter((w) => haystack.includes(w)).length;
	return hits / qWords.length;
}

/** Pick the best-scoring USDA food above `minScore`, or null. Ported from
 *  the legacy `bestMatch`. */
export function bestUsdaMatch(
	query: string,
	foods: readonly UsdaFood[],
	minScore = 0.4,
): UsdaFood | null {
	let best: UsdaFood | null = null;
	let bestScore = 0;
	for (const food of foods) {
		const s = scoreUsdaMatch(query, food);
		if (s > bestScore) {
			best = food;
			bestScore = s;
		}
	}
	return bestScore >= minScore ? best : null;
}

// USDA nutrient ids (FoodData Central's fixed vocabulary).
const USDA_NUTRIENT_ID = {
	calories: 1008,
	carbs: 1005,
	fat: 1004,
	fiber: 1079,
	protein: 1003,
	sodium: 1093,
	sugar: 2000,
} as const;

/** Map a matched USDA food's nutrients to the connector's typed nutrition
 *  shape. USDA branded-food nutrients are per 100g; scaled to per-serving
 *  using the food's own `servingSize`, same as the legacy `mapUSDANutrients`.
 *  A food with no `servingSize` reports per-100g (scale 1) rather than
 *  guessing a serving size. */
export function mapUsdaNutrients(
	food: UsdaFood,
	matchMethod: UsdaMatchMethod,
): NutritionFacts {
	const servingG = food.servingSize ?? 100;
	const scale = servingG / 100;
	const getRaw = (id: number): number | null => {
		const n = food.foodNutrients.find((fn) => fn.nutrientId === id);
		return n ? n.value : null;
	};
	const get = (id: number): number | null => {
		const raw = getRaw(id);
		return raw === null ? null : Math.round(raw * scale * 100) / 100;
	};
	return {
		calories: get(USDA_NUTRIENT_ID.calories),
		carbsG: get(USDA_NUTRIENT_ID.carbs),
		confidence: matchMethod === "upc" ? "high" : "medium",
		fatG: get(USDA_NUTRIENT_ID.fat),
		fiberG: get(USDA_NUTRIENT_ID.fiber),
		proteinG: get(USDA_NUTRIENT_ID.protein),
		servingSize: food.servingSize
			? `${food.servingSize}${food.servingSizeUnit ?? "g"}`
			: null,
		servingsPerContainer: null,
		sodiumMg: get(USDA_NUTRIENT_ID.sodium),
		source: "usda_fdc",
		sugarG: get(USDA_NUTRIENT_ID.sugar),
		upc: food.gtinUpc,
	};
}

// ─── Nutrition: Whole Foods product page ──────────────────────────────────

interface JsonLdNode {
	[key: string]: unknown;
}

function findInJsonLd<T>(
	node: unknown,
	predicate: (n: JsonLdNode) => T | null,
): T | null {
	if (!node || typeof node !== "object") {
		return null;
	}
	if (Array.isArray(node)) {
		for (const item of node) {
			const found = findInJsonLd(item, predicate);
			if (found !== null) {
				return found;
			}
		}
		return null;
	}
	const obj = node as JsonLdNode;
	const direct = predicate(obj);
	if (direct !== null) {
		return direct;
	}
	for (const value of Object.values(obj)) {
		if (value && typeof value === "object") {
			const found = findInJsonLd(value, predicate);
			if (found !== null) {
				return found;
			}
		}
	}
	return null;
}

function parseJsonLdScripts(document: Document): unknown[] {
	const parsed: unknown[] = [];
	for (const script of document.querySelectorAll(
		'script[type="application/ld+json"]',
	)) {
		try {
			parsed.push(JSON.parse(script.textContent ?? ""));
		} catch {
			// Malformed JSON-LD on the page; skip it rather than throw. Structure
			// over text — an unparseable block just yields no evidence, same as
			// an absent one.
		}
	}
	return parsed;
}

function numOrNull(v: unknown): number | null {
	if (v === null || v === undefined) {
		return null;
	}
	const n =
		typeof v === "number"
			? v
			: Number.parseFloat(String(v).replace(/[^\d.]/g, ""));
	return Number.isFinite(n) ? n : null;
}

/**
 * Parse a Whole Foods product page for nutrition facts. Tries JSON-LD
 * `NutritionInformation` structured data first (high confidence, machine
 * readable); falls back to a text-pattern parse of the rendered
 * "Nutrition Facts" panel (medium-to-high confidence — page copy, not
 * structured data). Returns null when neither surface has nutrition
 * evidence — the caller decides whether to fall back to USDA.
 */
export function parseWholeFoodsProductPageDom(
	html: string,
): NutritionFacts | null {
	const { document } = parseHTML(html);
	const ldNodes = parseJsonLdScripts(document);
	const ldNutrition = findInJsonLd(ldNodes, (n) => {
		if (n["@type"] === "NutritionInformation" || n.nutrition) {
			return (n.nutrition ?? n) as JsonLdNode;
		}
		return null;
	});
	if (ldNutrition) {
		return {
			calories: numOrNull(ldNutrition.calories),
			carbsG: numOrNull(ldNutrition.carbohydrateContent),
			confidence: "high",
			fatG: numOrNull(ldNutrition.fatContent),
			fiberG: numOrNull(ldNutrition.fiberContent),
			proteinG: numOrNull(ldNutrition.proteinContent),
			servingSize:
				typeof ldNutrition.servingSize === "string"
					? ldNutrition.servingSize
					: null,
			servingsPerContainer: null,
			sodiumMg: numOrNull(ldNutrition.sodiumContent),
			source: "wholefoods_product_page",
			sugarG: numOrNull(ldNutrition.sugarContent),
			upc: null,
		};
	}

	const headings = [...document.querySelectorAll("h2, h3, h4, span, div")];
	const nutritionHeading = headings.find((el) =>
		NUTRITION_HEADING_RE.test(textOf(el).trim()),
	);
	if (!nutritionHeading) {
		return null;
	}
	const container =
		nutritionHeading.closest("div, section, article") ??
		nutritionHeading.parentElement;
	const allText = container ? textOf(container) : "";
	const caloriesMatch = CALORIES_RE.exec(allText);
	if (!caloriesMatch) {
		return null;
	}
	const nutrients = new Map<string, number>();
	const nutrientPattern = new RegExp(NUTRIENT_PATTERN_SOURCE, "gi");
	let m: RegExpExecArray | null = nutrientPattern.exec(allText);
	while (m) {
		let key = m[1] ?? "";
		if (/^sugars$/i.test(key)) {
			key = "Total Sugars";
		}
		if (!nutrients.has(key) && m[2]) {
			nutrients.set(key, Number.parseFloat(m[2]));
		}
		m = nutrientPattern.exec(allText);
	}
	const servingSizeMatch = SERVING_SIZE_RE.exec(allText);
	const servingsMatch = SERVINGS_PER_CONTAINER_RE.exec(allText);
	const servingsPerContainerRaw = servingsMatch?.[1] ?? servingsMatch?.[2];
	return {
		calories: Number.parseInt(caloriesMatch[1] ?? "", 10),
		carbsG: nutrients.get("Total Carbohydrate") ?? null,
		confidence: "high",
		fatG: nutrients.get("Total Fat") ?? null,
		fiberG: nutrients.get("Dietary Fiber") ?? null,
		proteinG: nutrients.get("Protein") ?? null,
		servingSize: servingSizeMatch?.[1]?.trim() ?? null,
		servingsPerContainer: servingsPerContainerRaw
			? Number.parseFloat(servingsPerContainerRaw)
			: null,
		sodiumMg: nutrients.get("Sodium") ?? null,
		source: "wholefoods_product_page",
		sugarG: nutrients.get("Total Sugars") ?? null,
		upc: null,
	};
}

/** Extract a candidate Whole Foods product page URL from a
 *  wholefoodsmarket.com search-results page for `productName`. Returns null
 *  when the results page has no recognizable product tile. */
export function parseWholeFoodsSearchResultDom(html: string): string | null {
	const { document } = parseHTML(html);
	const link = document.querySelector<HTMLAnchorElement>(
		'a[href*="/product/"], a[href*="/products/"], [data-testid="product-tile"] a, .w-pie--product-tile a',
	);
	return link?.getAttribute("href") ?? null;
}
