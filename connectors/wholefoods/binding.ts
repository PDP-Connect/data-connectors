// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// The one owner of "is this page, panel, order or barcode about the thing I
// asked for?". Pure: no I/O and no DOM. Parsers read a page into an
// observation that carries ALL the identity evidence on it; the two functions
// here, `bindProduct` and `bindOrder`, decide. No other file compares ids,
// names, GTINs or order tokens.
//
// Fuzzy USDA text matching (`bestUsdaMatch`) also compares names. It stays
// outside this module on purpose: it is an approximation, labelled
// `usda_match_method: text`, allowed only when page evidence is `none`, and it
// never writes a `upc`.
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
	| "no_identity_evidence";

export type Binding =
	| { readonly kind: "BOUND"; readonly via: Via }
	| { readonly kind: "OTHER" } // consistent evidence of a DIFFERENT thing: a real answer, skip it
	| { readonly kind: "UNKNOWN"; readonly cause: BindingCause };

const bound = (via: Via): Binding => ({ kind: "BOUND", via });
const unknown = (cause: BindingCause): Binding => ({ kind: "UNKNOWN", cause });
const OTHER: Binding = { kind: "OTHER" };

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
	const url = parseUrl(new URL(href, WHOLE_FOODS_ORIGIN).href);
	return url?.origin === WHOLE_FOODS_ORIGIN ? url : null;
}

function parseUrl(raw: string | null | undefined): URL | null {
	if (!raw) return null;
	try {
		return new URL(raw);
	} catch {
		return null;
	}
}

const pathOf = (raw: string | null | undefined): string | null => {
	const url = parseUrl(raw);
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

/** The forms a barcode is queried in, as the legacy lookup did: as read, then
 *  zero-padded to 14 and to 13 digits. */
export function gtinQueryForms(raw: unknown): string[] {
	const digits = normalizeGtin(raw);
	if (digits === null) return [];
	return [
		...new Set([digits, digits.padStart(14, "0"), digits.padStart(13, "0")]),
	];
}

// ─── Names and sizes ───────────────────────────────────────────────────────

type Dimension = "mass" | "volume" | "count";
export interface Size {
	readonly dimension: Dimension;
	/** In the dimension's base unit: grams, millilitres, or units. */
	readonly amount: number;
}

const SIZE_UNITS: Record<string, { dimension: Dimension; factor: number }> = {
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
	/** The last size stated in the name, or null. */
	readonly size: Size | null;
}

/** The one normalizer for product names, used for both sides of every name
 *  comparison and for search queries. */
export function normalizeName(raw: string | null | undefined): NormalizedName {
	let text = (raw ?? "").replace(BRAND_PREFIX_RE, "");
	let size: Size | null = null;
	text = text.replace(SIZE_RE, (_match, amount: string, unit: string) => {
		const key = unit.toLowerCase().replace(/\./g, "").replace(/\s+/g, " ");
		const known = SIZE_UNITS[key];
		if (known) {
			size = { dimension: known.dimension, amount: Number(amount) * known.factor };
		}
		return " ";
	});
	const base = text
		.toLowerCase()
		.replace(/['’]/g, "")
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
	return { base, size };
}

/** Two sizes disagree when both are stated and differ in dimension or by more
 *  than rounding. A size on one side only does not disagree. */
function sizesDisagree(left: Size | null, right: Size | null): boolean {
	if (left === null || right === null) return false;
	if (left.dimension !== right.dimension) return true;
	return Math.abs(left.amount - right.amount) / Math.max(left.amount, right.amount) > 0.03;
}

/** Same base name and no size disagreement. */
function sameProductName(
	left: string | null | undefined,
	right: string | null | undefined,
): boolean {
	const a = normalizeName(left);
	const b = normalizeName(right);
	return a.base !== "" && a.base === b.base && !sizesDisagree(a.size, b.size);
}

// ─── Observations ──────────────────────────────────────────────────────────

/** Everything an Amazon /dp page says about which ASIN it is. */
export interface AmazonProductObservation {
	readonly finalUrl: string;
	/** `href` of the canonical link. */
	readonly canonical: string | null;
	/** Value of `input#ASIN`. */
	readonly input: string | null;
	/** `data-asin` of the main product element. */
	readonly dataAsin: string | null;
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

/** Everything a Whole Foods product page says about what it is. */
export interface WholeFoodsProductObservation {
	readonly canonicalUrl: string | null;
	/** The visible heading: what the rendered panel belongs to. */
	readonly h1: string | null;
	/** Every Product node on the page, recommendations included. */
	readonly products: readonly ProductNode[];
	/** The rendered Nutrition Facts panel, with no identity of its own. */
	readonly panel: NutritionFacts | null;
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
			/** The h1, when the page has one (may differ from the node's name). */
			readonly heading: string | null;
			/** The name of the node chosen as the page's Product, tied or not. */
			readonly nodeName: string | null;
			/** Facts that belong to `identity`, or null when the page has none. */
			readonly facts: NutritionFacts | null;
	  }
	| { readonly kind: "AMBIGUOUS"; readonly heading: string | null };

/** Choose what a Whole Foods page is about, and which facts and GTIN belong to
 *  it. The main Product node is the one whose `url`/`@id` equals the canonical
 *  or final URL, else the one whose name equals the h1, else the only Product
 *  node; with several and no tie
 *  it is AMBIGUOUS. A node supplies its GTIN and its nutrition only if it is
 *  tied to the page by URL or by name. A rendered panel belongs to the h1
 *  subject. Nothing is borrowed across subjects.
 *
 *  One relaxation: a sole node on a page with no h1 has nothing
 *  visible to contradict it, so it releases its OWN nutrition (the nutrition
 *  inside that node) and its identity. It never releases a rendered panel, and
 *  a panel with no h1 and no tied node has no subject. */
export function mainSubject(
	obs: WholeFoodsProductObservation,
	finalUrl: string | null = null,
): MainSubject {
	const here = new Set(
		[pathOf(obs.canonicalUrl), pathOf(finalUrl)].filter(
			(path): path is string => path !== null,
		),
	);
	const heading = obs.h1;
	const byUrl = obs.products.filter((node) =>
		node.urls.some((url) => {
			const path = pathOf(url);
			return path !== null && here.has(path);
		}),
	);
	const byName = obs.products.filter(
		(node) => heading !== null && sameProductName(node.name, heading),
	);
	let node: ProductNode | null = null;
	let tied = true;
	let sole = false;
	if (byUrl.length === 1) node = byUrl[0] ?? null;
	else if (byUrl.length > 1) return { kind: "AMBIGUOUS", heading };
	else if (byName.length === 1) node = byName[0] ?? null;
	else if (byName.length > 1) return { kind: "AMBIGUOUS", heading };
	else if (obs.products.length === 1) {
		node = obs.products[0] ?? null;
		tied = false;
		sole = true;
	} else if (obs.products.length > 1) return { kind: "AMBIGUOUS", heading };

	if (sole && heading === null && node !== null) {
		const gtin = normalizeGtin(node.gtin);
		if (node.facts) {
			return {
				kind: "SUBJECT",
				identity: { name: node.name, gtin },
				heading,
				nodeName: node.name,
				facts: node.facts,
			};
		}
		// A rendered panel with no h1 and no tied node has no subject.
		return {
			kind: "SUBJECT",
			identity: obs.panel ? { name: null, gtin: null } : { name: node.name, gtin },
			heading,
			nodeName: node.name,
			facts: null,
		};
	}
	const gtin = node !== null && tied ? normalizeGtin(node.gtin) : null;
	if (node?.facts && tied) {
		return {
			kind: "SUBJECT",
			identity: { name: node.name ?? heading, gtin },
			heading,
			nodeName: node.name,
			facts: node.facts,
		};
	}
	const name = heading ?? (tied ? (node?.name ?? null) : null);
	return {
		kind: "SUBJECT",
		identity: { name, gtin },
		heading,
		nodeName: node?.name ?? null,
		facts: obs.panel ? { ...obs.panel, productName: name, upc: gtin } : null,
	};
}

// ─── bindProduct ───────────────────────────────────────────────────────────

const ASIN_IN_URL_RE = /\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?![A-Z0-9])/;
const asinOf = (raw: string | null | undefined): string | null =>
	raw ? (ASIN_IN_URL_RE.exec(raw)?.[1] ?? null) : null;

type ProductObservation =
	| { readonly source: "amazon"; readonly obs: AmazonProductObservation }
	| { readonly source: "wholefoods"; readonly obs: WholeFoodsProductObservation; readonly finalUrl: string };

/** Does this observation describe the requested product?
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
 *   2 main subject AMBIGUOUS, h1 is not the request      OTHER
 *     main subject AMBIGUOUS otherwise                   UNKNOWN ambiguous_main_product
 *   3 node and h1 names differ, h1 is not the request    OTHER
 *   4 both GTINs known, equal                            BOUND gtin (no stronger than the
 *                                                        binding that supplied the request's GTIN)
 *   5 both GTINs known, unequal                          OTHER (beats any name match)
 *   6 at most one GTIN; same base name; size compatible  BOUND name
 *   7 otherwise a different name                         OTHER
 *   8 no usable name or id                               UNKNOWN no_identity_evidence */
export function bindProduct(
	requested: RequestedProduct,
	observation: ProductObservation,
): Binding {
	return observation.source === "amazon"
		? bindAmazon(requested, observation.obs)
		: bindWholeFoods(requested, observation.obs, observation.finalUrl);
}

function bindAmazon(
	requested: RequestedProduct,
	obs: AmazonProductObservation,
): Binding {
	if (parseUrl(obs.finalUrl)?.origin !== AMAZON_ORIGIN) {
		return unknown("untrusted_origin");
	}
	const fromUrl = asinOf(parseUrl(obs.finalUrl)?.pathname);
	const content = [
		asinOf(obs.canonical),
		obs.input && /^[A-Z0-9]{10}$/.test(obs.input.trim()) ? obs.input.trim() : null,
		obs.dataAsin && /^[A-Z0-9]{10}$/.test(obs.dataAsin.trim())
			? obs.dataAsin.trim()
			: null,
	].filter((asin): asin is string => asin !== null);
	const all = [...(fromUrl ? [fromUrl] : []), ...content];
	if (new Set(all).size > 1) return unknown("asin_sources_disagree");
	if (all.length === 0) return unknown("no_identity_evidence");
	if (all[0] !== requested.asin) return unknown("asin_mismatch");
	return content.length > 0 ? bound("content_id") : bound("url");
}

function bindWholeFoods(
	requested: RequestedProduct,
	obs: WholeFoodsProductObservation,
	finalUrl: string,
): Binding {
	if (parseUrl(finalUrl)?.origin !== WHOLE_FOODS_ORIGIN) {
		return unknown("untrusted_origin");
	}
	const subject = mainSubject(obs, finalUrl);
	if (subject.kind === "AMBIGUOUS") {
		// An h1 that is not the request settles it before any ambiguity does:
		// several nodes under another product's h1 are not this product.
		return subject.heading !== null &&
			!sameProductName(subject.heading, requested.name)
			? OTHER
			: unknown("ambiguous_main_product");
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
	const requestedGtin = gtin14(requested.boundGtin);
	const subjectGtin = gtin14(identity.gtin);
	if (requestedGtin !== null && subjectGtin !== null) {
		// Bound by the barcode, but the barcode itself came from a binding.
		return requestedGtin === subjectGtin
			? bound(weakerVia("gtin", requested.boundGtinVia))
			: OTHER;
	}
	if (identity.name === null) return unknown("no_identity_evidence");
	return sameProductName(identity.name, requested.name) ? bound("name") : OTHER;
}

/** Does a barcode observed on another record (a USDA food) name the same
 *  product as the one the request is bound to? */
export function bindGtin(requested: unknown, observed: unknown): Binding {
	const wanted = gtin14(requested);
	const seen = gtin14(observed);
	if (wanted === null || seen === null) return unknown("no_identity_evidence");
	return wanted === seen ? bound("gtin") : OTHER;
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
		[...url.searchParams].find(([key]) => key.toLowerCase() === "orderid")?.[1] ??
		null;
	const header = [...new Set(obs.headerIds)];
	if (header.length > 1 || (urlId !== null && header.length === 1 && header[0] !== urlId)) {
		return unknown("order_id_sources_disagree");
	}
	const authoritative = [...(urlId !== null ? [urlId] : []), ...header];
	if (authoritative.length === 0) return unknown("no_identity_evidence");
	if (authoritative.some((id) => id !== requested.orderId)) {
		return unknown("order_id_mismatch");
	}
	return header.length > 0 ? bound("content_id") : bound("url");
}
