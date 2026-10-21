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
const NAV_SIGN_IN_RE = /^\s*hello,\s*sign\s+in\s*$/i;
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
const SERVING_SIZE_RE = /Serving [Ss]ize[:\s]*([^\n]+)/;
const SERVINGS_PER_CONTAINER_RE =
	/(\d+(?:\.\d+)?)\s*servings?\s*per\s*container|servings?\s*per\s*container[:\s]*(\d+(?:\.\d+)?)/i;
type NutritionDetails = Pick<
	NutritionFacts,
	| "addedSugarG"
	| "allergens"
	| "calciumMg"
	| "category"
	| "cholesterolMg"
	| "coreStated"
	| "fdcId"
	| "highlights"
	| "ingredients"
	| "ironMg"
	| "potassiumMg"
	| "rawNutritionText"
	| "saturatedFatG"
	| "transFatG"
	| "upc"
	| "usdaBrand"
	| "usdaDescription"
	| "usdaMatchMethod"
	| "vitaminDMcg"
>;

function emptyNutritionDetails(): NutritionDetails {
	return {
		addedSugarG: null,
		allergens: null,
		calciumMg: null,
		category: [],
		cholesterolMg: null,
		coreStated: [],
		fdcId: null,
		highlights: [],
		ingredients: null,
		ironMg: null,
		potassiumMg: null,
		rawNutritionText: null,
		saturatedFatG: null,
		transFatG: null,
		upc: null,
		usdaBrand: null,
		usdaDescription: null,
		usdaMatchMethod: null,
		vitaminDMcg: null,
	};
}

// ─── Nutrition: units, GTINs and the acceptance rule ──────────────────────

type MassUnit = "g" | "mg" | "mcg";

const MG_PER_UNIT: Record<MassUnit, number> = { g: 1000, mg: 1, mcg: 0.001 };
const MASS_UNIT_ALIASES: Record<string, MassUnit> = {
	g: "g",
	gram: "g",
	grams: "g",
	mg: "mg",
	milligram: "mg",
	milligrams: "mg",
	mcg: "mcg",
	ug: "mcg",
	µg: "mcg",
	μg: "mcg",
	microgram: "mcg",
	micrograms: "mcg",
};
const ENERGY_UNIT_ALIASES = new Set([
	"",
	"cal",
	"calorie",
	"calories",
	"kcal",
	"kilocalorie",
	"kilocalories",
]);
/** A source states a row in one of two ways: an amount, or only an upper
 *  bound ("<1 g"). A bound is a stated row, but it has no amount, so it is
 *  never written as a number. */
type Stated =
	| { readonly bound: "exact"; readonly amount: number }
	| { readonly bound: "less_than"; readonly limit: number };

const amountOf = (stated: Stated | null): number | null =>
	stated?.bound === "exact" ? stated.amount : null;

/** An amount as a panel states it: plain, with a decimal part, or with
 *  thousands separators ("1,200"). A number that runs into more digits or a
 *  further separator ("12,5") is not an amount this reader can trust. */
const AMOUNT_SOURCE =
	"((?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?|\\.\\d+)(?!\\d|[.,]\\d)";
/** `<`, `≤` or "less than", an amount, an optional unit (letters only, so
 *  "2g*" and "10 g." keep their unit), and a percent sign if one follows. */
const STATED_AMOUNT_RE = new RegExp(
	`^[\\s:]*(<|≤|less than\\s)?\\s*${AMOUNT_SOURCE}\\s*([A-Za-zµμ]*)\\s*(%)?`,
	"i",
);
const CALORIES_LABEL_RE = /Calories[:\s]*/gi;
const AMOUNT_AT_START_RE = new RegExp(`^${AMOUNT_SOURCE}`);

const parseAmount = (text: string): number => Number.parseFloat(text.replace(/,/g, ""));

/** The number after a "Calories" label, if it is a clean amount. */
function readCalories(text: string): number | null {
	for (const label of text.matchAll(CALORIES_LABEL_RE)) {
		const amount = AMOUNT_AT_START_RE.exec(
			text.slice(label.index + label[0].length),
		);
		if (amount?.[1]) return parseAmount(amount[1]);
	}
	return null;
}

/** Footnotes under a panel: the daily-value note and the energy table
 *  ("Calories per gram: Fat 9 Carbohydrate 4 Protein 4", "Calories: 2,000
 *  2,500"). None of it is a row of this product. */
const PANEL_FOOTNOTE_RE =
	/Percent Daily Values?|The\s*%\s*Daily Value|Calories\s*per\s*gram|Calories\s*:\s*2,?000/i;
const PANEL_START_RE = /Calories/i;

/** A panel's text up to its structural end: its footnotes, and an
 *  `Ingredients` heading (with or without a colon) once the panel has
 *  started. An ingredients line before the panel is not the panel's end, and
 *  the caller does not take rows from it. */
function cutPanelEnd(text: string): string {
	const footnote = text.search(PANEL_FOOTNOTE_RE);
	const body = footnote === -1 ? text : text.slice(0, footnote);
	const starts = [
		body.search(PANEL_START_RE),
		panelLabels(body)[0]?.index ?? -1,
	].filter((at) => at >= 0);
	if (starts.length === 0) return body;
	const start = Math.min(...starts);
	const heading = body.slice(start).search(/Ingredients?/i);
	return heading === -1 ? body : body.slice(0, start + heading);
}

/** Vitamin D: 1 mcg is 40 IU, the one unambiguous IU factor a panel row uses. */
const VITAMIN_D_IU_PER_MCG = 40;
/** GTIN-8, GTIN-12 (UPC-A), GTIN-13 and GTIN-14 are the only barcode lengths. */
const GTIN_LENGTHS = new Set([8, 12, 13, 14]);

function roundAmount(value: number): number {
	return Math.round(value * 1e6) / 1e6;
}

function convertMass(value: number, from: MassUnit, to: MassUnit): number {
	return roundAmount((value * MG_PER_UNIT[from]) / MG_PER_UNIT[to]);
}

/** Read "<bound> <amount> <unit>" at the start of `text` as the row's own
 *  unit. A bare number is already in that unit. A percentage, or a unit the
 *  row cannot hold, states no amount, so the row is not stated (null) rather
 *  than relabelled. */
function statedMass(text: string, target: MassUnit): Stated | null {
	const match = STATED_AMOUNT_RE.exec(text);
	if (!match?.[2] || match[4]) return null;
	const value = parseAmount(match[2]);
	const unitText = resolveUnit(match[3] ?? "");
	let amount: number;
	if (unitText === "") {
		amount = value;
	} else if (unitText === "iu" && target === "mcg") {
		amount = roundAmount(value / VITAMIN_D_IU_PER_MCG);
	} else {
		const unit = MASS_UNIT_ALIASES[unitText];
		if (!unit) return null;
		amount = convertMass(value, unit, target);
	}
	return match[1] ? { bound: "less_than", limit: amount } : { bound: "exact", amount };
}

/** Units a panel row can state, longest first. */
const PANEL_UNITS = ["mcg", "mg", "µg", "μg", "ug", "iu", "g"] as const;

/** The unit in the letters that follow an amount. Amazon renders the panel
 *  with no separators, so a unit can run into the next word ("3gIngredients"):
 *  a known unit directly followed by a capital is that unit. */
function resolveUnit(letters: string): string {
	const lower = letters.toLowerCase();
	if (lower in MASS_UNIT_ALIASES || lower === "iu" || lower === "") return lower;
	for (const unit of PANEL_UNITS) {
		const next = letters[unit.length];
		if (lower.startsWith(unit) && next !== undefined && /[A-Z]/.test(next)) {
			return unit;
		}
	}
	return lower;
}

/** A structured (JSON-LD) mass value: a number, or the same text a panel row
 *  has. Absent or unreadable means not stated. */
function structuredMass(raw: unknown, target: MassUnit): Stated | null {
	if (typeof raw === "number") {
		return Number.isFinite(raw) ? { bound: "exact", amount: raw } : null;
	}
	return typeof raw === "string" ? statedMass(raw, target) : null;
}

/** Energy as kilocalories. Kilojoules and other units are not stated here.
 *  Energy needs an amount: an upper bound on calories is not a reading. */
function structuredEnergy(raw: unknown): Stated | null {
	if (typeof raw === "number") {
		return Number.isFinite(raw) ? { bound: "exact", amount: raw } : null;
	}
	if (typeof raw !== "string") return null;
	const match = STATED_AMOUNT_RE.exec(raw);
	if (!match?.[2] || match[1] || match[4]) return null;
	return ENERGY_UNIT_ALIASES.has((match[3] ?? "").toLowerCase())
		? { bound: "exact", amount: parseAmount(match[2]) }
		: null;
}

/** A real barcode as digits, or null. Hyphens and spaces are formatting. */
export function normalizeGtin(raw: unknown): string | null {
	if (typeof raw !== "string" && typeof raw !== "number") return null;
	const compact = String(raw).replace(/[\s-]/g, "");
	return /^\d+$/.test(compact) && GTIN_LENGTHS.has(compact.length)
		? compact
		: null;
}

/** Two barcodes name the same product when they agree once padding zeros
 *  (UPC-A inside GTIN-13/14) are ignored. */
export function sameGtin(left: unknown, right: unknown): boolean {
	const a = normalizeGtin(left);
	const b = normalizeGtin(right);
	return a !== null && b !== null && a.replace(/^0+/, "") === b.replace(/^0+/, "");
}

/** Panel rows and the unit each is stored in. Longer labels come first so
 *  "Includes Added Sugars" is never read as "Sugars". */
const PANEL_ROWS: readonly (readonly [label: string, key: string, unit: MassUnit])[] = [
	["Includes Added Sugars", "Includes Added Sugars", "g"],
	["Added Sugars", "Includes Added Sugars", "g"],
	["Total Sugars", "Total Sugars", "g"],
	["Total Fat", "Total Fat", "g"],
	["Saturated Fat", "Saturated Fat", "g"],
	["Trans Fat", "Trans Fat", "g"],
	["Total Carbohydrates", "Total Carbohydrate", "g"],
	["Total Carbohydrate", "Total Carbohydrate", "g"],
	["Dietary Fiber", "Dietary Fiber", "g"],
	["Cholesterol", "Cholesterol", "mg"],
	["Sodium", "Sodium", "mg"],
	["Sugars", "Total Sugars", "g"],
	["Protein", "Protein", "g"],
	["Potassium", "Potassium", "mg"],
	["Calcium", "Calcium", "mg"],
	["Iron", "Iron", "mg"],
	["Vitamin D", "Vitamin D", "mcg"],
];
/** The text before a label ends in an amount and its unit ("5mg", "150kcal"):
 *  the run-together render puts the next label right after it. */
const AFTER_AMOUNT_UNIT_RE = /\d\s*(?:mcg|mg|µg|μg|ug|g|iu|kcal|cal)$/i;
const PANEL_LABEL_RE = new RegExp(
	PANEL_ROWS.map(([label]) => label).join("|"),
	"gi",
);
const PANEL_ROW_BY_LABEL = new Map(
	PANEL_ROWS.map(([label, key, unit]) => [label.toLowerCase(), { key, unit }]),
);

/** Read a rendered nutrition panel one row at a time. Amazon renders the
 *  panel with no separators ("Total Fat12g20%Sodium480mg"), so a row's value
 *  is the text between its label and the next label, never a search across
 *  the whole text. The first occurrence of a row that states an amount wins;
 *  a percentage of daily value states none. */
function readPanelRows(panelText: string): Map<string, Stated> {
	const labels = panelLabels(panelText);
	const rows = new Map<string, Stated>();
	labels.forEach((label, index) => {
		const row = PANEL_ROW_BY_LABEL.get(label[0].toLowerCase());
		if (!row || rows.has(row.key)) return;
		const start = label.index + label[0].length;
		const end = labels[index + 1]?.index ?? panelText.length;
		const stated = statedMass(panelText.slice(start, end), row.unit);
		if (stated) rows.set(row.key, stated);
	});
	return rows;
}

/** Label occurrences that start a row. A label inside a longer word
 *  ("Environ" holds "iron") is not one; in the run-together render a
 *  capitalised label directly after an amount and its unit ("5mgIron",
 *  "150kcalTotal Fat", "80IUProtein") is. */
function panelLabels(panelText: string) {
	return [...panelText.matchAll(PANEL_LABEL_RE)].filter((label) => {
		const previous = panelText[label.index - 1];
		if (previous === undefined || !/[A-Za-z]/.test(previous)) return true;
		return (
			/[A-Z]/.test(label[0][0] ?? "") &&
			AFTER_AMOUNT_UNIT_RE.test(panelText.slice(0, label.index))
		);
	});
}

const CORE_ROWS = ["calories", "carbs", "fat", "protein"] as const;
type CoreRow = (typeof CORE_ROWS)[number];

function coreStatedOf(stated: Record<CoreRow, Stated | null>): CoreRow[] {
	return CORE_ROWS.filter((row) => stated[row] !== null);
}

const IN_STORE_ITEM_LIST_SELECTOR = "#f3_food_ItemList";
// "Qty: 1 @ $7.99 each" | "Qty: 2.17 lb @ $6.99/lb"
const IN_STORE_QTY_RE =
	/Qty:\s*(\d+(?:\.\d+)?)(?:\s+([A-Za-z]+))?\s*@\s*\$(\d+(?:\.\d+)?)/i;

/** Elements that show an order-detail page has finished rendering: legacy
 *  item grid, cancelled order, sign-in form, in-store list, or delivery items. */
export const ORDER_DETAIL_READY_SELECTOR =
	'[data-component="purchasedItemsRightGrid"], [data-component="cancelled"], form[name="signIn"], #f3_food_ItemList, #line-items, [id$="-item-grid-row"]';

const ORDER_DETAIL_EVIDENCE_SELECTOR =
	'[data-component="purchasedItemsRightGrid"], [data-component="cancelled"], #f3_food_ItemList, #line-items, [id$="-item-grid-row"]';

/** True when the page is a recognised order-detail page: it renders an item
 *  grid, a cancellation marker, an in-store item list or a delivery item list.
 *  A hidden element, or one inside a hidden ancestor, is not rendered and is
 *  not evidence. This is not proof that the items were read. A container with
 *  no item rows proves nothing; see `isCancelledOrderDetail` for the one
 *  explicit no-items explanation. */
export function hasOrderDetailEvidence(html: string): boolean {
	const { document } = parseHTML(html);
	return renderedFirst(document, ORDER_DETAIL_EVIDENCE_SELECTOR) !== null;
}

/** True when the order-detail page renders Amazon's own cancellation marker
 *  as a visible element (a marker inside a script string, or one the markup
 *  hides, does not count). A cancelled order never renders an item grid, so it
 *  is the only page where zero item rows is the source's statement and not a
 *  missing render. */
export function isCancelledOrderDetail(html: string): boolean {
	const { document } = parseHTML(html);
	return renderedFirst(document, '[data-component="cancelled"]') !== null;
}

/** Units on an order detail, comparable to the search page's row count: a
 *  weighed row is one search row however many lb it weighs. Unknown counted
 *  quantities return null. This heuristic never establishes completeness. */
export function orderDetailUnitCount(
	items: readonly OrderDetailItem[],
): number | null {
	if (items.some((item) => item.quantity === null)) return null;
	return items.reduce(
		(sum, item) =>
			sum +
			(item.quantityUnit && item.quantityUnit !== "each"
				? 1
				: (item.quantity ?? 0)),
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
	const greeting = textOf(
		document.querySelector("#nav-link-accountList-nav-line-1"),
	);
	const name =
		greeting && !NAV_SIGN_IN_RE.test(greeting)
			? greeting.replace(/^hello,\s*/i, "").trim() || null
			: null;
	const customerId = CUSTOMER_ID_RE.exec(html)?.[1] ?? null;
	return { customerId, name };
}

// ─── Order search / list page ────────────────────────────────────────────

// Text Amazon's order pages render for an account with no matching orders:
// the year filter's `<span class="num-orders">0 orders</span>` (captured live
// 2026-04-23, scrubbed), and the empty-history copy the Amazon connector
// already treats as its empty state.
const EMPTY_ORDERS_TEXT_RE =
	/^\s*0\s+orders\b|\b(?:no|0)\s+(?:orders|results)\b|you have not placed any orders|no orders found|looks like you didn['\u2019]t place an order/i;
const EMPTY_STATE_SCOPE_SELECTOR =
	".num-orders, .hzsearch-results-summary, .your-orders-content-container, #ordersContainer";
const EMPTY_STATE_ELEMENT_SELECTOR = '#no-orders, [class*="no-orders" i]';

const HIDDEN_STYLE_RE = /display\s*:\s*none|visibility\s*:\s*hidden/i;
// Amazon's own hiding classes.
const HIDDEN_CLASS_RE = /(?:^|\s)(?:a-hidden|aok-hidden|hidden)(?:\s|$)/i;

/** True when the element's own markup hides it: the `hidden` attribute,
 *  `aria-hidden="true"`, an inline `display:none`/`visibility:hidden`, or one
 *  of Amazon's hiding classes. Stylesheet rules cannot be seen here, so this is
 *  the evidence the markup itself carries. */
function isMarkedHidden(el: Element): boolean {
	return (
		el.hasAttribute("hidden") ||
		el.getAttribute("aria-hidden")?.toLowerCase() === "true" ||
		HIDDEN_STYLE_RE.test(el.getAttribute("style") ?? "") ||
		HIDDEN_CLASS_RE.test(el.getAttribute("class") ?? "")
	);
}

/** Elements whose descendants a scripting-enabled browser never renders:
 *  Linkedom still exposes them as ordinary elements. */
const INERT_TAGS = new Set(["NOSCRIPT", "SCRIPT", "STYLE", "TEMPLATE"]);

/** True when the element and every ancestor are rendered. This is the one
 *  visibility test for every piece of source evidence (empty state,
 *  cancellation, pagination, result and item rows): an element counts as
 *  observed only when nothing in its ancestry hides it or makes it inert. */
function isRendered(el: Element): boolean {
	for (let node: Element | null = el; node; node = node.parentElement) {
		if (INERT_TAGS.has(node.tagName.toUpperCase()) || isMarkedHidden(node)) {
			return false;
		}
	}
	return true;
}

/** `querySelectorAll` limited to rendered elements. */
function renderedAll<T extends Element = HTMLElement>(
	root: ParentNode,
	selector: string,
): T[] {
	return [...root.querySelectorAll<T>(selector)].filter(isRendered);
}

/** `querySelector` limited to rendered elements. */
function renderedFirst<T extends Element = HTMLElement>(
	root: ParentNode,
	selector: string,
): T | null {
	return renderedAll<T>(root, selector)[0] ?? null;
}

/**
 * True when an order-search page with no result rows shows the source's own
 * empty-state renderer: a rendered empty-orders element, or an order count or
 * summary element whose text says zero. Text in a script, style or template
 * (a class name in a bundle, an inert string) is not a rendered empty state,
 * nor is an element the markup hides (`hidden`, `aria-hidden`, inline
 * `display:none`, `a-hidden`), and neither is the bare search scaffold
 * (`#searchOrdersInput`) that a page shows before its results load.
 */
export function hasOrderSearchEmptyState(html: string): boolean {
	const { document } = parseHTML(html);
	for (const inert of document.querySelectorAll(
		"script, style, template, noscript",
	)) {
		inert.remove();
	}
	// Removing a hidden element removes its descendants, so no text under a
	// hidden ancestor survives either.
	for (const el of [...document.querySelectorAll<HTMLElement>("*")]) {
		if (isMarkedHidden(el)) {
			el.remove();
		}
	}
	for (const el of document.querySelectorAll<HTMLElement>(
		EMPTY_STATE_ELEMENT_SELECTOR,
	)) {
		if (textOf(el).trim().length > 0) {
			return true;
		}
	}
	for (const el of document.querySelectorAll<HTMLElement>(
		EMPTY_STATE_SCOPE_SELECTOR,
	)) {
		if (EMPTY_ORDERS_TEXT_RE.test(textOf(el))) {
			return true;
		}
	}
	return false;
}

/** Union of two product-ASIN lists, in first-seen order. */
export function mergeProductIds(
	left: readonly string[] | undefined,
	right: readonly string[],
): string[] {
	return [...new Set([...(left ?? []), ...right])];
}

/**
 * Parse one page of Amazon's Whole-Foods-filtered order search results
 * (`/your-orders/search?search=Whole+Foods+Market`). The search surface
 * lists ITEMS, not orders — each result row carries a "View order details"
 * link with the order id. Callers dedupe across pages by `orderId`.
 */
export function parseOrderSearchPageDom(html: string): {
	hasNextPage: boolean;
	isLastPage: boolean;
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
	for (const grid of renderedAll(document, ".a-fixed-left-grid")) {
		const link = renderedFirst<HTMLAnchorElement>(
			grid,
			'a[title="View order details"], a[href*="order-details"]',
		);
		const href = link?.getAttribute("href") ?? "";
		const orderId = ORDER_ID_FROM_HREF_RE.exec(href)?.[1];
		if (!orderId) {
			continue;
		}
		const rowHrefs = [
			...grid.querySelectorAll<HTMLAnchorElement>("a[href]"),
		].map((a) => a.getAttribute("href") ?? "");
		rowKeys.push(rowHrefs.join(" "));
		const rowProductIds = rowHrefs.flatMap((rowHref) => {
			const asin = ASIN_FROM_HREF_RE.exec(rowHref)?.[1];
			return asin ? [asin] : [];
		});
		if (seen.has(orderId)) {
			const existing = stubs.find((stub) => stub.orderId === orderId);
			if (existing) {
				existing.expectedItemCount += 1;
				existing.searchProductIds = mergeProductIds(
					existing.searchProductIds,
					rowProductIds,
				);
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
			searchProductIds: mergeProductIds(undefined, rowProductIds),
		});
	}
	// Pagination counts only when it is rendered: hidden markup is not the
	// source's statement about where the list ends.
	const hasNextPage =
		renderedFirst(document, "ul.a-pagination li.a-last a") !== null;
	// Amazon renders the final page's "Next" control as a disabled `li`. That
	// control, not the absence of a next link, is the source's last-page signal.
	const isLastPage =
		!hasNextPage &&
		renderedFirst(document, "ul.a-pagination li.a-last.a-disabled") !== null;
	const selectedText = textOf(
		renderedFirst(document, "ul.a-pagination li.a-selected"),
	);
	const selectedPage = /^\d+$/.test(selectedText) ? Number(selectedText) : null;
	return {
		hasNextPage,
		isLastPage,
		rowSignature: rowKeys.join("\n"),
		selectedPage,
		stubs,
	};
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
	for (const itemRow of renderedAll(
		document,
		'[data-component="purchasedItemsRightGrid"]',
	)) {
		const title = itemRow.querySelector<HTMLElement>(
			'[data-component="itemTitle"]',
		);
		const anchor =
			itemRow.querySelector<HTMLAnchorElement>(
				'a[href*="/dp/"], a[href*="/gp/product/"]',
			) ?? title?.querySelector<HTMLAnchorElement>("a");
		const href = anchor?.getAttribute("href") ?? "";
		const sourceName = textOf(anchor ?? title).trim();
		const productId = ASIN_FROM_HREF_RE.exec(href)?.[1] ?? null;
		if (productId && sourceName.length < 3) {
			throw new Error("Whole Foods order item has no source product name");
		}
		// A grid container with no title and no link is an empty shell, not a
		// row: counting it would fabricate an item and hide that nothing was read.
		if (!sourceName) {
			continue;
		}
		// Keep an ASIN-less row for its parent order's item count. The legacy
		// order_items schema requires a source product id, so the data connector
		// reports it and omits only that item record.
		const rowText = textOf(itemRow);
		const quantity = QTY_RE.exec(rowText)?.[1];
		const price = PRICE_RE.exec(rowText)?.[1];
		const img = itemRow.querySelector<HTMLImageElement>(
			'img[src*="images-amazon"], img[src*="m.media-amazon"]',
		);
		items.push({
			imageUrl: img?.getAttribute("src") ?? null,
			name: sourceName,
			productId,
			productUrl: productId ? absoluteAmazonUrl(href) : null,
			quantity: quantity ? Number(quantity) : null,
			unitPriceDollars: price ? Number(price) : null,
		});
	}
	return { items, orderDateRaw: detailOrderDate(document) };
}

const ORDER_ID_TOKEN_RE = /\b\d{3}-\d{7}-\d{7}\b/g;
const AMAZON_ORIGIN = "https://www.amazon.com";

/** The one rule that ties a fetched order-detail page to the order that was
 *  requested. The final URL must be on https://www.amazon.com (a redirect to
 *  any other host, bare amazon.com included, fails closed). Then:
 *  - a URL that names another order rejects the page;
 *  - a URL that names the requested order accepts it, provided the page does
 *    not show order ids that exclude it;
 *  - a URL that names no order accepts the page only if every order id the
 *    page shows is the requested one.
 *  A page with no order id on either surface is unbound and is rejected: a
 *  redirect to another order, or to a cancellation page, must never be read as
 *  this order. */
export function orderDetailBelongsTo(
	orderId: string,
	finalUrl: string,
	html: string,
): boolean {
	let url: URL;
	try {
		url = new URL(finalUrl);
	} catch {
		return false;
	}
	if (url.origin !== AMAZON_ORIGIN) return false;
	const urlOrderId = [...url.searchParams].find(
		([key]) => key.toLowerCase() === "orderid",
	)?.[1];
	if (urlOrderId !== undefined && urlOrderId !== orderId) return false;
	const shownIds: string[] = html.match(ORDER_ID_TOKEN_RE) ?? [];
	if (shownIds.length > 0 && !shownIds.includes(orderId)) return false;
	if (urlOrderId === orderId) return true;
	return shownIds.length > 0 && shownIds.every((id) => id === orderId);
}

/**
 * Delivery orders at `/uff/your-account/order-details` use `#line-items` and
 * one `*-item-grid-row` element per search row. The captured rows have a
 * `/dp/ASIN` link and an image. Their row text may include `Qty: N`; the
 * quantity stays unknown when no Qty is supplied. The
 * capture also exposes a dollar price in row text, which uses PRICE_RE.
 * Rows without a product link remain in order accounting but cannot produce
 * an order_items record without a source ASIN.
 */
function parseDeliveryOrderItems(document: Document): OrderDetailItem[] | null {
	const container = renderedFirst(document, "#line-items");
	const rows = renderedAll(container ?? document, '[id$="-item-grid-row"]');
	if (!container && rows.length === 0) {
		return null;
	}

	const items: OrderDetailItem[] = [];
	for (const row of rows) {
		const anchor = row.querySelector<HTMLAnchorElement>('a[href*="/dp/"]');
		const href = anchor?.getAttribute("href") ?? "";
		const productId = ASIN_FROM_HREF_RE.exec(href)?.[1] ?? null;
		const linkedName = textOf(anchor).replace(WHITESPACE_RE, " ").trim();
		if (productId && !linkedName) {
			throw new Error("Whole Foods delivery item has no source product name");
		}
		const rowText = textOf(row).replace(WHITESPACE_RE, " ").trim();
		// An empty row element is a shell, not an item.
		if (!(linkedName || rowText)) {
			continue;
		}
		const quantity = QTY_RE.exec(rowText)?.[1];
		const price = PRICE_RE.exec(rowText)?.[1];
		const image = row.querySelector<HTMLImageElement>("img");

		items.push({
			imageUrl: image?.getAttribute("src") ?? null,
			name: linkedName || "Unlinked Whole Foods item",
			productId,
			productUrl: productId ? absoluteAmazonUrl(href) : null,
			quantity: quantity ? Number(quantity) : null,
			unitPriceDollars: price ? Number(price) : null,
		});
	}
	return items;
}

function detailOrderDate(document: Document): string | null {
	const pageText = textOf(document.querySelector("body"));
	const dateMatch =
		/(?:Order Placed|Ordered|Order placed)[:\s]*([A-Z][a-z]+ \d+, \d{4})/i.exec(
			pageText,
		) ??
		/Purchased on\s+(?:[A-Z][a-z]+,\s*)?([A-Z][a-z]+ \d+, \d{4})/i.exec(
			textOf(renderedFirst(document, "#ufpo-order-status-secondary")),
		);
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
	const container = renderedFirst(document, IN_STORE_ITEM_LIST_SELECTOR);
	if (!container) {
		return null;
	}
	const items: OrderDetailItem[] = [];
	for (const row of renderedAll(container, ".a-row.a-spacing-base")) {
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
			quantity: qty?.[1] ? Number(qty[1]) : null,
			quantityUnit: qty?.[2] ?? (/\beach\b/i.test(rowText) ? "each" : null),
			priceUnit:
				/\/(lb|oz|kg|g)\b/i.exec(rowText)?.[1]?.toLowerCase() ??
				(/\beach\b/i.test(rowText) ? "each" : null),
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
	addedSugar: 1235,
	calcium: 1087,
	calories: 1008,
	carbs: 1005,
	cholesterol: 1253,
	fat: 1004,
	fiber: 1079,
	iron: 1089,
	potassium: 1092,
	protein: 1003,
	saturatedFat: 1258,
	sodium: 1093,
	sugar: 2000,
	transFat: 1257,
	vitaminD: 1114,
} as const;

/** One USDA search result as the connector uses it, from the wire shape.
 *  Foundation foods omit `servingSize`, `servingSizeUnit`, `gtinUpc` and
 *  `brandOwner` entirely, so an absent key becomes null here and nowhere
 *  else. A result that is not a food with an id and a description, and any
 *  nutrient entry without a numeric id and value, is dropped. */
export function parseUsdaFood(raw: unknown): UsdaFood | null {
	if (typeof raw !== "object" || raw === null) return null;
	const food = raw as Record<string, unknown>;
	if (typeof food.fdcId !== "number" || typeof food.description !== "string") {
		return null;
	}
	const text = (value: unknown) => (typeof value === "string" ? value : null);
	const nutrients = Array.isArray(food.foodNutrients) ? food.foodNutrients : [];
	return {
		brandName: text(food.brandName),
		brandOwner: text(food.brandOwner),
		description: food.description,
		fdcId: food.fdcId,
		foodNutrients: nutrients.flatMap((entry: unknown) => {
			const nutrient = entry as Record<string, unknown> | null;
			return typeof nutrient?.nutrientId === "number" &&
				typeof nutrient.value === "number" &&
				Number.isFinite(nutrient.value)
				? [{ nutrientId: nutrient.nutrientId, value: nutrient.value }]
				: [];
		}),
		gtinUpc: text(food.gtinUpc),
		ingredients: text(food.ingredients),
		servingSize:
			typeof food.servingSize === "number" && food.servingSize > 0
				? food.servingSize
				: null,
		servingSizeUnit: text(food.servingSizeUnit),
	};
}

/** FoodData Central energy: Branded and most Foundation foods report 1008;
 *  Foundation foods that derive energy report only 2047 or 2048 (Atwater). */
const USDA_ENERGY_IDS = [1008, 2047, 2048] as const;
/** USDA nutrient values are per 100 g, or per 100 ml for a food whose serving
 *  is stated in millilitres. */
const USDA_SERVING_BASIS: Record<string, "g" | "ml"> = {
	g: "g",
	grm: "g",
	ml: "ml",
	mlt: "ml",
};

/** Map a matched USDA food's nutrients to the connector's typed nutrition
 *  shape. A serving stated in grams or millilitres scales the per-100 values
 *  to that serving, as the legacy `mapUSDANutrients` did for grams. With no
 *  such serving the values stay per 100 g and say so in the serving label,
 *  so no source leaves "per 100" to be inferred from a null. A nutrient the
 *  food does not report is not stated; it is never read as zero. */
export function mapUsdaNutrients(
	food: UsdaFood,
	matchMethod: UsdaMatchMethod,
): NutritionFacts {
	const basis =
		food.servingSize !== null && food.servingSizeUnit !== null
			? USDA_SERVING_BASIS[food.servingSizeUnit.toLowerCase()]
			: undefined;
	const scale = basis && food.servingSize !== null ? food.servingSize / 100 : 1;
	const reported = (id: number): number | null =>
		food.foodNutrients.find((nutrient) => nutrient.nutrientId === id)?.value ??
		null;
	const get = (id: number): number | null => {
		const raw = reported(id);
		return raw === null ? null : Math.round(raw * scale * 100) / 100;
	};
	const energyId = USDA_ENERGY_IDS.find((id) => reported(id) !== null);
	const calories = energyId === undefined ? null : get(energyId);
	const fat = get(USDA_NUTRIENT_ID.fat);
	const carbs = get(USDA_NUTRIENT_ID.carbs);
	const protein = get(USDA_NUTRIENT_ID.protein);
	const stated = (value: number | null): Stated | null =>
		value === null ? null : { bound: "exact", amount: value };
	return {
		...emptyNutritionDetails(),
		addedSugarG: get(USDA_NUTRIENT_ID.addedSugar),
		allergens: null,
		calciumMg: get(USDA_NUTRIENT_ID.calcium),
		calories,
		carbsG: carbs,
		category: [],
		cholesterolMg: get(USDA_NUTRIENT_ID.cholesterol),
		confidence: matchMethod === "upc" ? "high" : "medium",
		coreStated: coreStatedOf({
			calories: stated(calories),
			carbs: stated(carbs),
			fat: stated(fat),
			protein: stated(protein),
		}),
		fdcId: food.fdcId,
		fatG: fat,
		fiberG: get(USDA_NUTRIENT_ID.fiber),
		highlights: [],
		ingredients: food.ingredients || null,
		ironMg: get(USDA_NUTRIENT_ID.iron),
		potassiumMg: get(USDA_NUTRIENT_ID.potassium),
		proteinG: protein,
		rawNutritionText: null,
		saturatedFatG: get(USDA_NUTRIENT_ID.saturatedFat),
		servingSize:
			basis && food.servingSize !== null
				? `${food.servingSize}${basis}`
				: food.servingSizeUnit === null
					? "per 100 g"
					: "per 100 g or 100 ml",
		servingsPerContainer: null,
		sodiumMg: get(USDA_NUTRIENT_ID.sodium),
		source: "usda_fdc",
		sugarG: get(USDA_NUTRIENT_ID.sugar),
		transFatG: get(USDA_NUTRIENT_ID.transFat),
		// A text match is another product: its GTIN is not this product's.
		upc: matchMethod === "upc" ? normalizeGtin(food.gtinUpc) : null,
		usdaBrand: food.brandOwner,
		usdaDescription: food.description,
		usdaMatchMethod: matchMethod,
		vitaminDMcg: get(USDA_NUTRIENT_ID.vitaminD),
	};
}

// ─── Nutrition: Whole Foods product page ──────────────────────────────────

interface JsonLdNode {
	[key: string]: unknown;
}

/** Every object in a JSON-LD document, containers (arrays, `@graph`) and
 *  nested values included, in document order. */
function jsonLdObjects(node: unknown, out: JsonLdNode[] = []): JsonLdNode[] {
	if (!node || typeof node !== "object") return out;
	if (Array.isArray(node)) {
		for (const item of node) jsonLdObjects(item, out);
		return out;
	}
	out.push(node as JsonLdNode);
	for (const value of Object.values(node)) jsonLdObjects(value, out);
	return out;
}

function jsonLdTypes(node: JsonLdNode): string[] {
	const type = node["@type"];
	return (Array.isArray(type) ? type : [type]).flatMap((entry) =>
		typeof entry === "string" ? [entry.replace(/^.*[/:]/, "")] : [],
	);
}

/** The `nutrition` object a Product node carries itself. */
function nutritionOf(product: JsonLdNode): JsonLdNode | null {
	const nutrition = product.nutrition;
	const candidate = Array.isArray(nutrition) ? nutrition[0] : nutrition;
	return candidate && typeof candidate === "object"
		? (candidate as JsonLdNode)
		: null;
}

/** The one Product node a page's structured data speaks for. The nutrition,
 *  name, GTIN, category and ingredients all come from this node, so they
 *  describe one entity. A node holding nutrition is preferred; with none,
 *  the first Product still names the page for the rendered panel. A document
 *  with no Product but a single standalone NutritionInformation node keeps
 *  that nutrition with no identity. */
function selectProductEvidence(documents: unknown[]): {
	product: JsonLdNode | null;
	nutrition: JsonLdNode | null;
} {
	const objects = documents.flatMap((doc) => jsonLdObjects(doc));
	const products = objects.filter((node) => jsonLdTypes(node).includes("Product"));
	const withNutrition = products.find((node) => nutritionOf(node) !== null);
	if (withNutrition) {
		return { product: withNutrition, nutrition: nutritionOf(withNutrition) };
	}
	if (products.length > 0) {
		return { product: products[0] ?? null, nutrition: null };
	}
	const standalone = objects.filter((node) =>
		jsonLdTypes(node).includes("NutritionInformation"),
	);
	return {
		product: null,
		nutrition: standalone.length === 1 ? (standalone[0] ?? null) : null,
	};
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
	const { product: productInfo, nutrition: ldNutrition } =
		selectProductEvidence(parseJsonLdScripts(document));
	const productUpc = productInfo
		? normalizeGtin(
				productInfo.gtin12 ??
					productInfo.gtin13 ??
					productInfo.gtin14 ??
					productInfo.gtin ??
					productInfo.gtin8,
			)
		: null;
	const headings = [...document.querySelectorAll("h2, h3, h4, span, div")];
	const productName =
		typeof productInfo?.name === "string"
			? productInfo.name
			: textOf(document.querySelector("h1")).trim() || null;
	const productCategory = productInfo?.category;
	const category = Array.isArray(productCategory)
		? productCategory.filter(
				(value): value is string => typeof value === "string",
			)
		: typeof productCategory === "string" && productCategory
			? [productCategory]
			: [];
	const productIngredients =
		typeof productInfo?.ingredients === "string"
			? productInfo.ingredients
			: null;
	const nutritionHeading = headings.find((el) =>
		NUTRITION_HEADING_RE.test(textOf(el).trim()),
	);
	const structuredFacts = (): NutritionFacts | null => {
		if (!ldNutrition) return null;
		const mass = (field: string, unit: MassUnit) =>
			structuredMass(ldNutrition[field], unit);
		const calories = structuredEnergy(ldNutrition.calories);
		const carbs = mass("carbohydrateContent", "g");
		const fat = mass("fatContent", "g");
		const protein = mass("proteinContent", "g");
		return {
			...emptyNutritionDetails(),
			calciumMg: amountOf(mass("calciumContent", "mg")),
			calories: amountOf(calories),
			carbsG: amountOf(carbs),
			category,
			cholesterolMg: amountOf(mass("cholesterolContent", "mg")),
			confidence: "high",
			coreStated: coreStatedOf({ calories, carbs, fat, protein }),
			fatG: amountOf(fat),
			fiberG: amountOf(mass("fiberContent", "g")),
			ingredients: productIngredients,
			ironMg: amountOf(mass("ironContent", "mg")),
			potassiumMg: amountOf(mass("potassiumContent", "mg")),
			productName,
			proteinG: amountOf(protein),
			saturatedFatG: amountOf(mass("saturatedFatContent", "g")),
			servingSize:
				typeof ldNutrition.servingSize === "string"
					? ldNutrition.servingSize
					: null,
			servingsPerContainer: null,
			sodiumMg: amountOf(mass("sodiumContent", "mg")),
			source: "wholefoods_structured_data",
			sugarG: amountOf(mass("sugarContent", "g")),
			transFatG: amountOf(mass("transFatContent", "g")),
			upc: productUpc,
			vitaminDMcg: amountOf(mass("vitaminDContent", "mcg")),
		};
	};
	if (ldNutrition && !nutritionHeading) {
		return structuredFacts();
	}

	if (!nutritionHeading) {
		return null;
	}
	const container =
		nutritionHeading.closest("div, section, article") ??
		nutritionHeading.parentElement;
	const containerText = container ? textOf(container) : "";
	const headingAt = containerText.search(NUTRITION_HEADING_RE);
	const allText = cutPanelEnd(
		headingAt === -1 ? containerText : containerText.slice(headingAt),
	);
	const calories = readCalories(allText);
	if (calories === null) {
		return structuredFacts();
	}
	const rows = readPanelRows(allText);
	const servingSizeMatch = SERVING_SIZE_RE.exec(allText);
	const servingsMatch = SERVINGS_PER_CONTAINER_RE.exec(allText);
	const servingsPerContainerRaw = servingsMatch?.[1] ?? servingsMatch?.[2];
	const nutrient = (key: string): number | null =>
		amountOf(rows.get(key) ?? null);
	const sectionText = (heading: RegExp): string | null => {
		const el = headings.find((candidate) =>
			heading.test(textOf(candidate).trim()),
		);
		return (
			textOf(el?.nextElementSibling).trim() ||
			textOf(el?.parentElement?.querySelector("p, div:last-child")).trim() ||
			null
		);
	};
	const highlights = [
		...document.querySelectorAll<HTMLElement>(
			'[class*="badge"], [class*="diet"], [data-testid*="badge"]',
		),
	].flatMap((element) => {
		const label = textOf(element).trim();
		return /organic|gluten.?free|vegan|non.?gmo|kosher|paleo|keto/i.test(label)
			? [label]
			: [];
	});
	const breadcrumbCategory = [
		...document.querySelectorAll<HTMLElement>(
			'nav[aria-label*="breadcrumb" i] a, .breadcrumb a',
		),
	].flatMap((element) => {
		const label = textOf(element).trim();
		return label && !/home|whole foods/i.test(label) ? [label] : [];
	});
	return {
		...emptyNutritionDetails(),
		addedSugarG: nutrient("Includes Added Sugars"),
		allergens: sectionText(/allergen|contains/i),
		calciumMg: nutrient("Calcium"),
		calories,
		carbsG: nutrient("Total Carbohydrate"),
		category: breadcrumbCategory,
		cholesterolMg: nutrient("Cholesterol"),
		confidence: "high",
		coreStated: coreStatedOf({
			calories: { bound: "exact", amount: calories },
			carbs: rows.get("Total Carbohydrate") ?? null,
			fat: rows.get("Total Fat") ?? null,
			protein: rows.get("Protein") ?? null,
		}),
		fatG: nutrient("Total Fat"),
		fiberG: nutrient("Dietary Fiber"),
		highlights,
		ingredients: sectionText(/^ingredients$/i),
		ironMg: nutrient("Iron"),
		potassiumMg: nutrient("Potassium"),
		proteinG: nutrient("Protein"),
		rawNutritionText: allText.slice(0, 1000),
		saturatedFatG: nutrient("Saturated Fat"),
		servingSize: servingSizeMatch?.[1]?.trim() ?? null,
		servingsPerContainer: servingsPerContainerRaw
			? Number.parseFloat(servingsPerContainerRaw)
			: null,
		sodiumMg: nutrient("Sodium"),
		source: "wholefoods_product_page",
		sugarG: nutrient("Total Sugars"),
		transFatG: nutrient("Trans Fat"),
		upc: productUpc,
		vitaminDMcg: nutrient("Vitamin D"),
		productName,
	};
}

/** The text of a panel container without its ingredient and important-
 *  information sections. */
function panelText(container: Element | null): string {
	if (!container) return "";
	const copy = container.cloneNode(true) as Element;
	for (const section of copy.querySelectorAll(
		'#ingredients_feature_div, [data-component="ingredients"], #importantInformation, #important-information',
	)) {
		section.remove();
	}
	return textOf(copy);
}

/** Port of the frozen legacy data connector's Amazon product-page nutrition
 *  parser. Callers supply captured HTML in tests; this function has no I/O. */
export function parseAmazonProductNutritionDom(
	html: string,
): NutritionFacts | null {
	const { document } = parseHTML(html);
	const bodyText = textOf(document.body);
	const table = document.querySelector(
		'#nic-nutrition-facts, #nutritionFacts, #nutritionalInformation_feature_div, [data-component="nutritionFacts"]',
	);
	const important = document.querySelector(
		"#importantInformation, #important-information",
	);
	// #nic-nutrition-facts holds the nutrient rows only; Calories and the
	// serving size sit in the enclosing expander, so that is the panel's scope
	// (the legacy script widens it the same way).
	const panel =
		table?.closest('.a-expander-content, [class*="nicSection"]') ?? table;
	// Rows come from the nutrient table itself; the enclosing expander can
	// hold ingredient prose before or after it. Calories and the serving size
	// are in the expander when the table has none.
	const rowsText = cutPanelEnd(panelText(table ?? important));
	const allText = cutPanelEnd(panelText(panel ?? important));
	const calories = readCalories(rowsText) ?? readCalories(allText);
	const upcMatch = /(?:UPC|ASIN|GTIN)[:\s]*([\d-]{8,14})/i.exec(
		textOf(
			document.querySelector(
				"#detailBullets_feature_div, #prodDetails, .content",
			),
		),
	);
	const amazonUpc = normalizeGtin(upcMatch?.[1]);
	if (calories === null && !amazonUpc) return null;
	const rows = readPanelRows(rowsText);
	const get = (key: string): number | null => amountOf(rows.get(key) ?? null);
	const ingredientsNode = document.querySelector(
		'#ingredients_feature_div, [data-component="ingredients"]',
	);
	const ingredients = ingredientsNode
		? textOf(ingredientsNode)
				.replace(/^Ingredients[:\s]*/i, "")
				.trim() || null
		: null;
	const allergenMatch =
		/Contains[:\s]*([^.\n]+(?:wheat|milk|soy|eggs?|fish|shellfish|tree nuts?|peanuts?|sesame)[^.\n]*)/i.exec(
			bodyText,
		);
	const serving = /Serving size[:\s]*([^\n]+?)(?=\s*Calories|\n|$)/i
		.exec(allText)?.[1]
		?.trim();
	const servings = /(\d+\.?\d*)\s*servings?\s*per/i.exec(allText)?.[1];
	return {
		...emptyNutritionDetails(),
		addedSugarG: get("Includes Added Sugars"),
		allergens: allergenMatch?.[1]?.trim() ?? null,
		calciumMg: get("Calcium"),
		calories,
		carbsG: get("Total Carbohydrate"),
		cholesterolMg: get("Cholesterol"),
		confidence: "medium",
		coreStated: coreStatedOf({
			calories: calories === null ? null : { bound: "exact", amount: calories },
			carbs: rows.get("Total Carbohydrate") ?? null,
			fat: rows.get("Total Fat") ?? null,
			protein: rows.get("Protein") ?? null,
		}),
		fatG: get("Total Fat"),
		fiberG: get("Dietary Fiber"),
		ingredients,
		ironMg: get("Iron"),
		potassiumMg: get("Potassium"),
		proteinG: get("Protein"),
		rawNutritionText: allText.slice(0, 1000),
		saturatedFatG: get("Saturated Fat"),
		servingSize: serving ?? null,
		servingsPerContainer: servings ? Number.parseFloat(servings) : null,
		sodiumMg: get("Sodium"),
		source: "amazon_product_page",
		sugarG: get("Total Sugars"),
		transFatG: get("Trans Fat"),
		upc: amazonUpc,
		vitaminDMcg: get("Vitamin D"),
	};
}

/** Extract a candidate Whole Foods product page URL from a
 *  wholefoodsmarket.com search-results page for `productName`. Returns null
 *  when the results page has no recognizable product tile. */
export function parseWholeFoodsSearchResultDom(html: string): string | null {
	return parseWholeFoodsSearchResultDoms(html)[0] ?? null;
}

/** Return product links in document order so callers can verify each page's
 * identity and continue past related products. */
export function parseWholeFoodsSearchResultDoms(html: string): string[] {
	const { document } = parseHTML(html);
	const links = document.querySelectorAll<HTMLAnchorElement>(
		'a[href*="/product/"], a[href*="/products/"], [data-testid="product-tile"] a, .w-pie--product-tile a',
	);
	return [...links].flatMap((link) => {
		const href = link.getAttribute("href");
		return href ? [href] : [];
	});
}
