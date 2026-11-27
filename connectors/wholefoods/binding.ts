// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// The one owner of "is this page, panel, order or barcode about the thing I
// asked for?". Pure: no I/O and no DOM. Parsers read a page into an
// observation that carries ALL the evidence on it; `bindProduct` and
// `bindOrder` decide, and `onSourceSite` says whether a response came from
// the source at all. No other file compares ids, names,
// GTINs, order tokens or origins.
//
// Evidence limits. Every product and order page in the repo is a synthetic
// fixture; no scrubbed real capture of an Amazon /dp page, a Whole Foods
// product page or an order detail exists here. The legacy script trusted the
// ASIN in the URL it navigated to and the `orderID` in the link it followed,
// and never read a content-side id. So a content-side id is a VETO, not a
// requirement: present and different means the page is not the requested
// thing; present and equal is the strongest binding; absent means the final URL
// carries the binding (`via: "url"`), which caps confidence. The selectors
// that read those positions are fixed in `IDENTITY_SELECTORS`, so a real
// capture changes one table.

import type { NutritionFacts } from "./types.ts";

// ─── Result type ───────────────────────────────────────────────────────────

/** What a binding rested on, strongest first. `url` and `name` are the weak
 *  links and cap the confidence of anything built on them. */
export type Via = "content_id" | "gtin" | "url" | "name";

/** Why a page said nothing usable about the requested thing. CONFLICT causes
 *  and the UNBOUND cause are handled identically by every caller (no data may
 *  be taken); only the cause differs. */
export type BindingCause =
	| "untrusted_origin"
	| "asin_mismatch"
	| "asin_sources_disagree"
	| "order_id_mismatch"
	| "order_id_sources_disagree"
	| "ambiguous_main_product"
	| "subject_sources_disagree"
	| "no_identity_evidence";

export type Binding =
	| { readonly kind: "BOUND"; readonly via: Via }
	| { readonly kind: "OTHER" } // consistent evidence of a DIFFERENT thing: a real answer, skip it
	| { readonly kind: "UNKNOWN"; readonly cause: BindingCause };

const bound = (via: Via): Binding => ({ kind: "BOUND", via });
// Typed as literals so they are both a `Binding` and a `ProductBinding`.
const unknown = (cause: BindingCause) => ({ kind: "UNKNOWN", cause }) as const;
const OTHER = { kind: "OTHER" } as const;

const VIA_STRENGTH: Record<Via, number> = {
	content_id: 3,
	gtin: 3,
	url: 1,
	name: 1,
};

/** The weaker of two bindings: a conclusion rests on its weakest link. */
export function weakerVia(left: Via, right: Via | null): Via {
	return right === null || VIA_STRENGTH[left] <= VIA_STRENGTH[right]
		? left
		: right;
}

/** `no_identity_evidence` is the UNBOUND arm; every other cause is a CONFLICT. */
export const isUnbound = (cause: BindingCause): boolean =>
	cause === "no_identity_evidence";

/** Confidence a binding permits: `url` and `name` bind weakly, so a row built
 *  on them is capped at `medium`. */
export function capConfidence(
	confidence: "high" | "medium" | "low",
	via: Via,
): "high" | "medium" | "low" {
	return (via === "url" || via === "name") && confidence === "high"
		? "medium"
		: confidence;
}

// ─── Where identity is read from ───────────────────────────────────────────

/** The positions parsers read identity from. Anything not listed here is never
 *  evidence (ASIN-looking text in scripts, carousels, return URLs, other-order
 *  links). One table, so a real capture changes one place. */
export const IDENTITY_SELECTORS = {
	amazon: {
		/** `<link rel=canonical href=".../dp/ASIN">` */
		canonical: 'link[rel="canonical"]',
		/** `<input id="ASIN" value="ASIN">` */
		input: "input#ASIN",
		/** The main product element's `data-asin`. */
		dataAsin: "#dp[data-asin], #ppd[data-asin]",
		/** A rendered product title: product-page evidence, not identity. */
		title: "#productTitle",
	},
	wholeFoods: {
		canonical: 'link[rel="canonical"]',
		heading: "h1",
	},
	order: {
		/** The order id rendered in the detail header. */
		headerAttribute: "#progress-tracker-refresh-data[data-orderid]",
		headerText: '[data-component="orderId"]',
	},
} as const;

// ─── Origins ───────────────────────────────────────────────────────────────

const AMAZON_ORIGIN = "https://www.amazon.com";
export const WHOLE_FOODS_ORIGIN = "https://www.wholefoodsmarket.com";

/** A search-result link as an absolute Whole Foods URL, or null when it
 *  points anywhere else. A link off Whole Foods is not a read of the product
 *  and is dropped where tiles are collected. Two spellings of one path
 *  (relative and absolute) resolve to the same URL, so they are one tile. */
export function resolveWholeFoodsUrl(href: string): URL | null {
	const url = parseUrl(href, WHOLE_FOODS_ORIGIN);
	return url?.origin === WHOLE_FOODS_ORIGIN ? url : null;
}

/** A URL, resolved against `base` when it is relative, or null when it does
 *  not parse. */
function parseUrl(
	raw: string | null | undefined,
	base?: string | null,
): URL | null {
	if (!raw) return null;
	try {
		return new URL(raw, base ?? undefined);
	} catch {
		return null;
	}
}

const pathOf = (
	raw: string | null | undefined,
	base?: string | null,
): string | null => {
	const url = parseUrl(raw, base);
	return url ? url.pathname.replace(/\/+$/, "") : null;
};

// ─── GTINs ─────────────────────────────────────────────────────────────────

/** GTIN-8, GTIN-12 (UPC-A), GTIN-13 and GTIN-14 are the only barcode lengths. */
const GTIN_LENGTHS = new Set([8, 12, 13, 14]);

/** A real barcode as digits, or null. Hyphens and spaces are formatting. */
export function normalizeGtin(raw: unknown): string | null {
	if (typeof raw !== "string" && typeof raw !== "number") return null;
	const compact = String(raw).replace(/[\s-]/g, "");
	return /^\d+$/.test(compact) && GTIN_LENGTHS.has(compact.length)
		? compact
		: null;
}

/** The comparison form: a valid barcode left-padded to 14 digits, so UPC-A,
 *  EAN-13 and GTIN-14 spellings of one product are equal. */
export function gtin14(raw: unknown): string | null {
	const digits = normalizeGtin(raw);
	return digits === null ? null : digits.padStart(14, "0");
}

export function sameGtin(left: unknown, right: unknown): boolean {
	const a = gtin14(left);
	return a !== null && a === gtin14(right);
}

// ─── Names and package sizes ───────────────────────────────────────────────

type Measure = "mass" | "volume";
export interface Size {
	readonly dimension: Measure;
	/** In the dimension's base unit: grams or millilitres. */
	readonly amount: number;
}

/** What a name says about the package, as two independent constraints: how
 *  many units it holds ("6 pack", "12 ct", "1 dozen") and how much one unit
 *  holds ("12 fl oz", "1 lb"). Each list holds every distinct amount the
 *  name states, sorted, so the order a name writes them in does not matter
 *  and one amount written in two units is one amount. */
export interface PackageSize {
	readonly counts: readonly number[];
	readonly quantities: readonly Size[];
}

const SIZE_UNITS: Record<
	string,
	{ dimension: Measure | "count"; factor: number }
> = {
	g: { dimension: "mass", factor: 1 },
	kg: { dimension: "mass", factor: 1000 },
	oz: { dimension: "mass", factor: 28.3495 },
	lb: { dimension: "mass", factor: 453.592 },
	lbs: { dimension: "mass", factor: 453.592 },
	ml: { dimension: "volume", factor: 1 },
	l: { dimension: "volume", factor: 1000 },
	"fl oz": { dimension: "volume", factor: 29.5735 },
	fz: { dimension: "volume", factor: 29.5735 },
	dozen: { dimension: "count", factor: 12 },
	gal: { dimension: "volume", factor: 3785.41 },
	ct: { dimension: "count", factor: 1 },
	count: { dimension: "count", factor: 1 },
	each: { dimension: "count", factor: 1 },
	pk: { dimension: "count", factor: 1 },
	pack: { dimension: "count", factor: 1 },
	packs: { dimension: "count", factor: 1 },
};
const SIZE_RE =
	/(\d+(?:\.\d+)?)\s*(fl\.?\s*oz|fz|oz|lbs?|kg|g|ml|l|gal|ct|count|each|dozen|pk|packs?)\b\.?/gi;
/** Store-brand prefixes, including the comma forms ("Whole Foods Market, ..."). */
const BRAND_PREFIX_RE =
	/^(?:365\s+(?:by\s+)?whole\s+foods\s+market|whole\s+foods\s+market|365\s+everyday\s+value)\s*,?\s*/i;

export interface NormalizedName {
	/** Lowercase words, punctuation and store-brand prefix dropped. "organic"
	 *  is kept: organic and plain are different products. */
	readonly base: string;
	/** Every package size stated in the name. */
	readonly pack: PackageSize;
}

/** The one normalizer for product names, used for both sides of every name
 *  comparison and for search queries. */
export function normalizeName(raw: string | null | undefined): NormalizedName {
	let text = (raw ?? "").replace(BRAND_PREFIX_RE, "");
	const counts: number[] = [];
	const quantities: Size[] = [];
	text = text.replace(SIZE_RE, (_match, amount: string, unit: string) => {
		const key = unit.toLowerCase().replace(/\./g, "").replace(/\s+/g, " ");
		const known = SIZE_UNITS[key];
		if (known?.dimension === "count") {
			counts.push(Number(amount) * known.factor);
		} else if (known) {
			quantities.push({
				dimension: known.dimension,
				amount: Number(amount) * known.factor,
			});
		}
		return " ";
	});
	const base = text
		.toLowerCase()
		.replace(/['’]/g, "")
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
	counts.sort((a, b) => a - b);
	quantities.sort(
		(a, b) => a.dimension.localeCompare(b.dimension) || a.amount - b.amount,
	);
	return {
		base,
		pack: {
			counts: oneOfEach(counts, (a, b) => sameAmount(a, b)),
			quantities: oneOfEach(
				quantities,
				(a, b) => a.dimension === b.dimension && sameAmount(a.amount, b.amount),
			),
		},
	};
}

/** A sorted list reduced to one value per group of equivalent amounts, each
 *  group measured from its first value: "12 fl oz (355 ml)" states one
 *  quantity twice, not two, while 100 g, 102.5 g and 105 g stay two amounts
 *  because rounding tolerance does not chain. */
function oneOfEach<T>(
	sorted: readonly T[],
	same: (a: T, b: T) => boolean,
): T[] {
	const groups: T[] = [];
	for (const value of sorted) {
		const first = groups.at(-1);
		if (first === undefined || !same(first, value)) groups.push(value);
	}
	return groups;
}

/** Two amounts are one amount when they differ by no more than rounding. */
const sameAmount = (left: number, right: number): boolean =>
	left === right || Math.abs(left - right) / Math.max(left, right) <= 0.03;

/** Two packages disagree when both names state the same constraint (the
 *  count, or the per-unit quantity) and the stated amounts differ. A
 *  constraint stated on one side only does not disagree. */
function packagesDisagree(left: PackageSize, right: PackageSize): boolean {
	const countsDiffer =
		left.counts.length > 0 &&
		right.counts.length > 0 &&
		(left.counts.length !== right.counts.length ||
			left.counts.some((count, i) => !sameAmount(count, right.counts[i] ?? 0)));
	const quantitiesDiffer =
		left.quantities.length > 0 &&
		right.quantities.length > 0 &&
		(left.quantities.length !== right.quantities.length ||
			left.quantities.some((size, i) => {
				const other = right.quantities[i];
				return (
					other === undefined ||
					size.dimension !== other.dimension ||
					!sameAmount(size.amount, other.amount)
				);
			}));
	return countsDiffer || quantitiesDiffer;
}

/** Same base name and no package disagreement. */
function sameProductName(
	left: string | null | undefined,
	right: string | null | undefined,
): boolean {
	const a = normalizeName(left);
	const b = normalizeName(right);
	return (
		a.base !== "" && a.base === b.base && !packagesDisagree(a.pack, b.pack)
	);
}

// ─── Observations ──────────────────────────────────────────────────────────
//
// An observation is what one page shows, lossless and unjudged: every subject
// on it (heading, JSON-LD node, rendered panel) with its own scope, and every
// panel as the rows it states, partial panels included. Parsers produce them;
// only this module decides which of it is about the requested product.

/** What a page says about a product besides its panel rows. */
export type ProductDetails = Pick<
	NutritionFacts,
	"allergens" | "category" | "highlights" | "ingredients"
>;

/** Everything an Amazon /dp page says about which ASIN it is, and the
 *  product evidence it shows. The page has one product, so its panel and
 *  barcode belong to whatever ASIN the page binds to. */
export interface AmazonProductObservation {
	readonly finalUrl: string;
	/** `href` of the canonical link. */
	readonly canonical: string | null;
	/** Value of `input#ASIN`. */
	readonly input: string | null;
	/** `data-asin` of the main product element. */
	readonly dataAsin: string | null;
	/** The barcode the page states, normalized, or null. */
	readonly gtin: string | null;
	/** The nutrition panel as the page states it (partial or complete), or
	 *  null when the page states no nutrition row. */
	readonly panel: NutritionFacts | null;
}

/** One Product node of a Whole Foods page's JSON-LD, with its own facts. */
export interface ProductNode {
	readonly name: string | null;
	/** Its `url` and `@id`. */
	readonly urls: readonly string[];
	/** The node's own GTIN, raw. */
	readonly gtin: unknown;
	/** Facts from the node's own `nutrition`, or null. */
	readonly facts: NutritionFacts | null;
}

/** A rendered Nutrition Facts panel and where the page shows it. `scope` is
 *  read from the smallest rendered element that holds the panel and a product
 *  heading:
 *  - `main_heading`: that element holds the page's h1, so the panel is shown
 *    for the h1's product;
 *  - `other_heading`: it holds only another heading (a recommendation card),
 *    so the panel is that product's;
 *  - `no_heading`: no product heading holds it. */
export interface RenderedPanel {
	readonly facts: NutritionFacts;
	readonly scope: Scope;
}
export type Scope = "main_heading" | "other_heading" | "no_heading";

/** One rendered allergen, ingredient or badge statement and where the page
 *  shows it (scoped like a panel). */
export interface ScopedDetail {
	readonly field: "allergens" | "ingredients" | "highlight";
	readonly text: string;
	readonly scope: Scope;
}

/** Everything a Whole Foods product page says about what it is. */
export interface WholeFoodsProductObservation {
	readonly canonicalUrl: string | null;
	/** The rendered h1: what the page shows itself to be. */
	readonly h1: string | null;
	/** Every Product node on the page, recommendations included. */
	readonly products: readonly ProductNode[];
	/** Every rendered Nutrition Facts panel that states a row, with its scope. */
	readonly panels: readonly RenderedPanel[];
	/** Every rendered allergen, ingredient and badge statement, with its scope. */
	readonly details: readonly ScopedDetail[];
	/** The breadcrumb categories the site files the page under. */
	readonly categories: readonly string[];
}

export interface OrderObservation {
	readonly finalUrl: string;
	/** Every order id rendered in the detail header (not incidental tokens). */
	readonly headerIds: readonly string[];
}

/** What the request asks for. The ordered item is the request, never evidence
 *  about a page. `boundGtin` is a GTIN taken from a BOUND Amazon observation
 *  only. */
export interface RequestedProduct {
	readonly asin: string;
	readonly name: string;
	readonly boundGtin: string | null;
	/** What bound `boundGtin`: a conclusion that rests on it is no stronger. */
	readonly boundGtinVia: Via | null;
}

// ─── Main subject of a Whole Foods page ────────────────────────────────────

export interface SubjectIdentity {
	readonly name: string | null;
	readonly gtin: string | null;
}

export type MainSubject =
	| {
			readonly kind: "SUBJECT";
			readonly identity: SubjectIdentity;
			/** Every name the page gives this subject (the h1 and the tied
			 *  node's name). A request binds by name only if it matches each. */
			readonly names: readonly string[];
			/** The h1, when the page has one (may differ from the node's name). */
			readonly heading: string | null;
			/** The name of the node chosen as the page's Product, tied or not. */
			readonly nodeName: string | null;
			/** Every panel that belongs to `identity`: the tied node's own
			 *  nutrition first, then the rendered panels shown for it. Partial
			 *  panels are kept; which one is usable is acceptance's decision. */
			readonly panels: readonly NutritionFacts[];
			/** Rendered panels on the page that are not released to this
			 *  subject. Their owner is unresolved, so the page cannot prove
			 *  this product has no panel. */
			readonly unreleasedPanels: number;
	  }
	| { readonly kind: "AMBIGUOUS"; readonly heading: string | null }
	/** The node tied to the page by URL names another product than the h1:
	 *  the page contradicts itself, so neither may lend the other anything. */
	| { readonly kind: "CONFLICT"; readonly heading: string | null };

/** Choose what a Whole Foods page is about, and which panels and GTIN belong
 *  to it. The main Product node is the one whose `url`/`@id` equals the
 *  canonical or final URL, else the one whose name equals the h1, else the
 *  only Product node; with several and no tie it is AMBIGUOUS. A URL-tied node
 *  whose name is not the h1's is a CONFLICT. A node supplies its GTIN and its
 *  nutrition only if it is tied to the page. A rendered panel belongs to the
 *  h1 subject only when the h1 scopes it; with no h1, a panel no heading
 *  scopes belongs to a URL-tied node, or to the page's unnamed subject when
 *  the page has no node (which binds to nothing: it has no identity).
 *  Nothing is borrowed across subjects.
 *
 *  One relaxation: a sole node on a page with no h1 has nothing
 *  visible to contradict it, so it releases its OWN nutrition (the nutrition
 *  inside that node) and its identity. It never releases a rendered panel, and
 *  a panel with no h1 and no tied node has no subject. */
export function mainSubject(
	obs: WholeFoodsProductObservation,
	finalUrl: string | null = null,
): MainSubject {
	// Relative JSON-LD and canonical URLs are relative to the page.
	const base = finalUrl ?? WHOLE_FOODS_ORIGIN;
	const here = new Set(
		[pathOf(obs.canonicalUrl, base), pathOf(finalUrl)].filter(
			(path): path is string => path !== null,
		),
	);
	const heading = obs.h1;
	const byUrl = obs.products.filter((node) =>
		node.urls.some((url) => {
			const path = pathOf(url, base);
			return path !== null && here.has(path);
		}),
	);
	const byName = obs.products.filter(
		(node) => heading !== null && sameProductName(node.name, heading),
	);
	let node: ProductNode | null = null;
	let tied = true;
	if (byUrl.length === 1) {
		node = byUrl[0] ?? null;
		if (
			heading !== null &&
			node?.name &&
			!sameProductName(node.name, heading)
		) {
			return { kind: "CONFLICT", heading };
		}
	} else if (byUrl.length > 1) return { kind: "AMBIGUOUS", heading };
	else if (byName.length === 1) node = byName[0] ?? null;
	else if (byName.length > 1) return { kind: "AMBIGUOUS", heading };
	else if (obs.products.length === 1) {
		node = obs.products[0] ?? null;
		tied = false;
	} else if (obs.products.length > 1) return { kind: "AMBIGUOUS", heading };

	if (!tied && heading === null && node !== null) {
		const gtin = normalizeGtin(node.gtin);
		// A rendered panel with no h1 and no tied node has no subject.
		const identity =
			node.facts || obs.panels.length === 0
				? { name: node.name, gtin }
				: { name: null, gtin: null };
		return {
			kind: "SUBJECT",
			identity,
			names: identity.name ? [identity.name] : [],
			heading,
			nodeName: node.name,
			panels: node.facts ? [node.facts] : [],
			unreleasedPanels: obs.panels.length,
		};
	}
	const own = tied ? node : null;
	const gtin = own ? normalizeGtin(own.gtin) : null;
	const name = heading ?? own?.name ?? null;
	// What the page shows for this subject: under the h1, or, with no h1,
	// under no heading on a page whose node is tied (or that has no node).
	const releases = (scope: Scope) =>
		heading !== null
			? scope === "main_heading"
			: scope === "no_heading" && (own !== null || obs.products.length === 0);
	const details = subjectDetails(
		own?.facts ?? null,
		obs.details.filter((detail) => releases(detail.scope)),
		obs.categories,
	);
	const released = obs.panels.filter((panel) => releases(panel.scope));
	const shown = released.map((panel) => ({
		...panel.facts,
		allergens: details.allergens,
		category: [...details.category],
		highlights: [...details.highlights],
		ingredients: details.ingredients,
		productName: name,
		upc: gtin,
	}));
	const panels = [...(own?.facts ? [own.facts] : []), ...shown];
	return {
		kind: "SUBJECT",
		identity: { name, gtin },
		names: [heading, own?.name].filter(
			(value): value is string => typeof value === "string" && value !== "",
		),
		heading,
		nodeName: node?.name ?? null,
		panels,
		unreleasedPanels: obs.panels.length - released.length,
	};
}

/** A subject's details: its node's own (ingredients, category), else the
 *  rendered ones released to it and the page's categories. */
function subjectDetails(
	nodeFacts: NutritionFacts | null,
	shown: readonly ScopedDetail[],
	categories: readonly string[],
): ProductDetails {
	const first = (field: ScopedDetail["field"]) =>
		shown.find((detail) => detail.field === field)?.text ?? null;
	const nodeCategory = nodeFacts?.category ?? [];
	return {
		allergens: first("allergens"),
		category: nodeCategory.length > 0 ? nodeCategory : [...categories],
		highlights: shown
			.filter((detail) => detail.field === "highlight")
			.map((detail) => detail.text),
		ingredients: nodeFacts?.ingredients ?? first("ingredients"),
	};
}

// ─── bindProduct ───────────────────────────────────────────────────────────

const ASIN_IN_URL_RE = /\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?![A-Z0-9])/;
const asinOf = (raw: string | null | undefined): string | null =>
	raw ? (ASIN_IN_URL_RE.exec(raw)?.[1] ?? null) : null;

type ProductObservation =
	| { readonly source: "amazon"; readonly obs: AmazonProductObservation }
	| {
			readonly source: "wholefoods";
			readonly obs: WholeFoodsProductObservation;
			readonly finalUrl: string;
	  };

/** What a bound page shows about the requested product, and only that: its
 *  name, its barcode and every panel proven to be its own (partial ones
 *  included), each panel's confidence capped by what bound it. A GTIN here is
 *  the barcode the page states for the product; only a BOUND Amazon page's
 *  GTIN becomes the request's `boundGtin`. */
export interface BoundProduct {
	readonly name: string | null;
	readonly gtin: string | null;
	readonly panels: readonly NutritionFacts[];
	/** Panels the bound page shows whose owner is unresolved: not proven this
	 *  product's, so not used, and not proof that it has none either. */
	readonly unresolvedPanels: number;
}

export type ProductBinding =
	| {
			readonly kind: "BOUND";
			readonly via: Via;
			readonly product: BoundProduct;
	  }
	| { readonly kind: "OTHER" }
	| { readonly kind: "UNKNOWN"; readonly cause: BindingCause };

/** A BOUND result carrying the product, its panels capped by `via`. */
function boundProduct(via: Via, product: BoundProduct): ProductBinding {
	return {
		kind: "BOUND",
		via,
		product: {
			...product,
			panels: product.panels.map((panel) => ({
				...panel,
				confidence: capConfidence(panel.confidence, via),
			})),
		},
	};
}

/** Does this observation describe the requested product? A BOUND result
 *  carries the one value callers may use: the product as the page shows it.
 *
 *  Amazon /dp/<asin> (first match wins)
 *   1 origin is not amazon.com                           UNKNOWN untrusted_origin
 *   2 authoritative ASIN positions disagree              UNKNOWN asin_sources_disagree
 *   3 any authoritative ASIN != requested                UNKNOWN asin_mismatch
 *   4 a content-side ASIN is present and == requested   BOUND content_id
 *   5 no content-side ASIN; final URL ASIN == requested  BOUND url
 *   6 no ASIN position at all                            UNKNOWN no_identity_evidence
 *
 *  Whole Foods tile (first match wins)
 *   1 origin is not wholefoodsmarket.com                 UNKNOWN untrusted_origin
 *   2 main subject AMBIGUOUS or CONFLICT, h1 is not the request  OTHER
 *     main subject AMBIGUOUS otherwise                   UNKNOWN ambiguous_main_product
 *     main subject CONFLICT otherwise                    UNKNOWN subject_sources_disagree
 *   3 node and h1 names differ, h1 is not the request    OTHER
 *   4 both GTINs known, equal                            BOUND gtin (no stronger than the
 *                                                        binding that supplied the request's GTIN)
 *   5 both GTINs known, unequal                          OTHER (beats any name match)
 *   6 at most one GTIN; every name the page gives the
 *     subject has the request's base name and package     BOUND name
 *   7 otherwise a different name                         OTHER
 *   8 no usable name or id                               UNKNOWN no_identity_evidence */
export function bindProduct(
	requested: RequestedProduct,
	observation: ProductObservation,
): ProductBinding {
	return observation.source === "amazon"
		? bindAmazon(requested, observation.obs)
		: bindWholeFoods(requested, observation.obs, observation.finalUrl);
}

function bindAmazon(
	requested: RequestedProduct,
	obs: AmazonProductObservation,
): ProductBinding {
	if (parseUrl(obs.finalUrl)?.origin !== AMAZON_ORIGIN) {
		return unknown("untrusted_origin");
	}
	const fromUrl = asinOf(parseUrl(obs.finalUrl)?.pathname);
	const content = [
		asinOf(obs.canonical),
		obs.input && /^[A-Z0-9]{10}$/.test(obs.input.trim())
			? obs.input.trim()
			: null,
		obs.dataAsin && /^[A-Z0-9]{10}$/.test(obs.dataAsin.trim())
			? obs.dataAsin.trim()
			: null,
	].filter((asin): asin is string => asin !== null);
	const all = [...(fromUrl ? [fromUrl] : []), ...content];
	if (new Set(all).size > 1) return unknown("asin_sources_disagree");
	if (all.length === 0) return unknown("no_identity_evidence");
	if (all[0] !== requested.asin) return unknown("asin_mismatch");
	const gtin = normalizeGtin(obs.gtin);
	return boundProduct(content.length > 0 ? "content_id" : "url", {
		name: null,
		gtin,
		panels: obs.panel ? [{ ...obs.panel, upc: gtin }] : [],
		unresolvedPanels: 0,
	});
}

function bindWholeFoods(
	requested: RequestedProduct,
	obs: WholeFoodsProductObservation,
	finalUrl: string,
): ProductBinding {
	if (parseUrl(finalUrl)?.origin !== WHOLE_FOODS_ORIGIN) {
		return unknown("untrusted_origin");
	}
	const subject = mainSubject(obs, finalUrl);
	if (subject.kind !== "SUBJECT") {
		// An h1 that is not the request settles it before any ambiguity or
		// conflict does: several nodes, or a disagreeing node, under another
		// product's h1 are not this product.
		if (
			subject.heading !== null &&
			!sameProductName(subject.heading, requested.name)
		) {
			return OTHER;
		}
		return unknown(
			subject.kind === "AMBIGUOUS"
				? "ambiguous_main_product"
				: "subject_sources_disagree",
		);
	}
	const { identity, heading, nodeName } = subject;
	// The h1 is what the page shows; a node about something else (a
	// recommendation) does not make the page that something else.
	if (
		heading !== null &&
		nodeName &&
		!sameProductName(nodeName, heading) &&
		!sameProductName(heading, requested.name)
	) {
		return OTHER;
	}
	if (identity.name === null && identity.gtin === null) {
		return unknown("no_identity_evidence");
	}
	const product = {
		...identity,
		panels: subject.panels,
		unresolvedPanels: subject.unreleasedPanels,
	};
	const requestedGtin = gtin14(requested.boundGtin);
	const subjectGtin = gtin14(identity.gtin);
	if (requestedGtin !== null && subjectGtin !== null) {
		// Bound by the barcode, but the barcode itself came from a binding.
		return requestedGtin === subjectGtin
			? boundProduct(weakerVia("gtin", requested.boundGtinVia), product)
			: OTHER;
	}
	if (identity.name === null) return unknown("no_identity_evidence");
	return subject.names.every((name) => sameProductName(name, requested.name))
		? boundProduct("name", product)
		: OTHER;
}

/** Is a response's final URL on the site (or, for `wholefoods_search`, the
 *  search page) it was asked of? A response that ended anywhere else says
 *  nothing about the source, neither what it shows nor that something is
 *  absent. */
export function onSourceSite(
	site: "amazon" | "wholefoods" | "wholefoods_search",
	finalUrl: string,
): boolean {
	const url = parseUrl(finalUrl);
	if (site === "amazon") return url?.origin === AMAZON_ORIGIN;
	return (
		url?.origin === WHOLE_FOODS_ORIGIN &&
		(site === "wholefoods" || url.pathname.replace(/\/+$/, "") === "/search")
	);
}

// ─── bindOrder ─────────────────────────────────────────────────────────────

/** Does this order detail page belong to the requested order?
 *
 *   1 origin is not amazon.com                                  UNKNOWN untrusted_origin
 *   2 URL id and a header id both present and unequal           UNKNOWN order_id_sources_disagree
 *   3 any authoritative id != requested                         UNKNOWN order_id_mismatch
 *   4 a header id present and == requested                      BOUND content_id
 *   5 no header id; URL id == requested                         BOUND url
 *   6 no authoritative id                                       UNKNOWN no_identity_evidence
 *
 *  Authoritative ids are the final URL's `orderID`/`orderId` parameter and the
 *  ids rendered in the detail header. Incidental tokens (scripts, return URLs,
 *  links to other orders) are not read, so a healthy page that mentions other
 *  orders is accepted. */
export function bindOrder(
	requested: { readonly orderId: string },
	obs: OrderObservation,
): Binding {
	const url = parseUrl(obs.finalUrl);
	if (url?.origin !== AMAZON_ORIGIN) return unknown("untrusted_origin");
	const urlId =
		[...url.searchParams].find(
			([key]) => key.toLowerCase() === "orderid",
		)?.[1] ?? null;
	const header = [...new Set(obs.headerIds)];
	if (
		header.length > 1 ||
		(urlId !== null && header.length === 1 && header[0] !== urlId)
	) {
		return unknown("order_id_sources_disagree");
	}
	const authoritative = [...(urlId !== null ? [urlId] : []), ...header];
	if (authoritative.length === 0) return unknown("no_identity_evidence");
	if (authoritative.some((id) => id !== requested.orderId)) {
		return unknown("order_id_mismatch");
	}
	return header.length > 0 ? bound("content_id") : bound("url");
}
