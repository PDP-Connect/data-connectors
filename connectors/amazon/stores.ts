// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Amazon stores. Amazon keeps order history per store: the same email and
 * password sign in on amazon.com and on amazon.ca, but a Canadian account's
 * orders are only listed on amazon.ca, and amazon.com shows an empty order
 * list. So the connector reads orders on exactly one store per run, the store
 * the session is signed in to, and builds every URL from it.
 *
 * Pure: no Playwright, no I/O. `resolveAmazonStore` takes what the run can
 * observe (an explicit choice, the page it was handed, the signed-in cookies)
 * and returns one store deterministically, saying where the answer came from.
 */

export interface AmazonStore {
	/** Short id, also the PDPP_AMAZON_STORE value: `com`, `ca`, `co.uk`, ... */
	id: string;
	/** Canonical storefront host. */
	host: string;
	/** `https://${host}` */
	origin: string;
	/** Display name, as Amazon writes it: `amazon.ca`. */
	name: string;
	/** Lowercase ISO alpha-2 of the store's home country. */
	country: string;
	/** `openid.assoc_handle` of the store's own sign-in page. */
	assocHandle: string;
	/** The store's signed-in token cookie: `at-main` on amazon.com, `at-acb<xx>` elsewhere. */
	authCookie: string;
	/** Postal-code shape of the store's country; capture group 1 (and 2 when split) is the code. */
	postal: RegExp;
}

function store(
	id: string,
	country: string,
	assocHandle: string,
	authCookie: string,
	postal: RegExp,
): AmazonStore {
	const host = `www.amazon.${id}`;
	return {
		id,
		host,
		origin: `https://${host}`,
		name: `amazon.${id}`,
		country,
		assocHandle,
		authCookie,
		postal,
	};
}

// Postal codes. Each matches a whole token so street numbers and phone
// numbers on other address lines are not mistaken for one; the address is
// read from its last line upwards (`extractPostalCode`).
const US_ZIP_RE = /\b(\d{5}(?:-\d{4})?)\b/;
const CA_POSTAL_RE =
	/\b([ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z])\s?(\d[ABCEGHJ-NPRSTV-Z]\d)\b/i;
const UK_POSTCODE_RE = /\b([A-Z]{1,2}\d[A-Z\d]?)\s?(\d[A-Z]{2})\b/i;
const FIVE_DIGIT_RE = /\b(\d{5})\b/;
const AU_POSTCODE_RE = /\b(\d{4})\b/;
const JP_POSTAL_RE = /(?:〒\s*)?\b(\d{3})-?(\d{4})\b/;
const IN_PIN_RE = /\b(\d{3})\s?(\d{3})\b/;
const BR_CEP_RE = /\b(\d{5})-?(\d{3})\b/;

export const AMAZON_STORES: readonly AmazonStore[] = Object.freeze([
	store("com", "us", "usflex", "at-main", US_ZIP_RE),
	store("ca", "ca", "caflex", "at-acbca", CA_POSTAL_RE),
	store("co.uk", "gb", "gbflex", "at-acbuk", UK_POSTCODE_RE),
	store("de", "de", "deflex", "at-acbde", FIVE_DIGIT_RE),
	store("fr", "fr", "frflex", "at-acbfr", FIVE_DIGIT_RE),
	store("it", "it", "itflex", "at-acbit", FIVE_DIGIT_RE),
	store("es", "es", "esflex", "at-acbes", FIVE_DIGIT_RE),
	store("com.au", "au", "auflex", "at-acbau", AU_POSTCODE_RE),
	store("co.jp", "jp", "jpflex", "at-acbjp", JP_POSTAL_RE),
	store("in", "in", "inflex", "at-acbin", IN_PIN_RE),
	store("com.mx", "mx", "mxflex", "at-acbmx", FIVE_DIGIT_RE),
	store("com.br", "br", "brflex", "at-acbbr", BR_CEP_RE),
]);

// biome-ignore lint/style/noNonNullAssertion: the table above is a literal whose first row is amazon.com.
export const DEFAULT_AMAZON_STORE: AmazonStore = AMAZON_STORES[0]!;

/** The store a hostname belongs to (`www.amazon.ca`, `amazon.ca`, `smile.amazon.com`), or null. */
export function storeForHost(
	host: string | null | undefined,
): AmazonStore | null {
	const h = String(host ?? "")
		.trim()
		.toLowerCase()
		.replace(/^\./, "");
	if (!h) {
		return null;
	}
	for (const candidate of AMAZON_STORES) {
		const bare = candidate.name;
		if (h === bare || h === candidate.host || h === `smile.${bare}`) {
			return candidate;
		}
	}
	return null;
}

/** The store a URL is on, or null for another host (a sign-in host, about:blank, garbage). */
export function storeForUrl(
	url: string | null | undefined,
): AmazonStore | null {
	if (!url) {
		return null;
	}
	try {
		return storeForHost(new URL(url).hostname);
	} catch {
		return null;
	}
}

/** The store of a run country (`ca` -> amazon.ca), or null when no store serves it. */
export function storeForCountry(
	country: string | null | undefined,
): AmazonStore | null {
	const code = String(country ?? "")
		.trim()
		.toLowerCase();
	return AMAZON_STORES.find((candidate) => candidate.country === code) ?? null;
}

/** A store by its id (`ca`, `co.uk`), its name (`amazon.ca`) or a host/URL on it. */
export function storeById(
	value: string | null | undefined,
): AmazonStore | null {
	const v = String(value ?? "")
		.trim()
		.toLowerCase();
	if (!v) {
		return null;
	}
	return (
		AMAZON_STORES.find(
			(candidate) => candidate.id === v || candidate.name === v,
		) ??
		storeForHost(v) ??
		storeForUrl(v)
	);
}

interface CookieLike {
	domain?: string;
	name: string;
	value?: string;
}

/**
 * The stores the browser holds a signed-in token for: a cookie named as the
 * store's `authCookie` on that store's own domain. A persistent profile can be
 * signed in to more than one; the caller decides what that means.
 */
export function signedInStores(cookies: readonly CookieLike[]): AmazonStore[] {
	const found: AmazonStore[] = [];
	for (const candidate of AMAZON_STORES) {
		const hit = cookies.some(
			(cookie) =>
				cookie.name === candidate.authCookie &&
				(cookie.value === undefined || cookie.value !== "") &&
				storeForHost(cookie.domain) === candidate,
		);
		if (hit) {
			found.push(candidate);
		}
	}
	return found;
}

export type AmazonStoreSource = "requested" | "page" | "cookies" | "default";

export interface ResolvedAmazonStore {
	store: AmazonStore;
	from: AmazonStoreSource;
	/** A requested value that names no store: reported, never guessed around silently. */
	unknownRequest?: string;
}

/**
 * The store this run reads, first that applies:
 *   1. `requested`: an explicit choice (`PDPP_AMAZON_STORE`), when it names a store;
 *   2. `page`: the store of the page the run was handed. On the hosted service
 *      the host signs in on the person's store and hands over its page, so
 *      this is where the person signed in;
 *   3. `cookies`: the ONE store the browser holds a signed-in token for;
 *   4. `default`: amazon.com.
 * Several signed-in stores and no page or request to choose between them is
 * not guessed at either: amazon.com, as before stores existed.
 */
export function resolveAmazonStore({
	cookies = [],
	pageUrl,
	requested,
}: {
	cookies?: readonly CookieLike[] | undefined;
	pageUrl?: string | null | undefined;
	requested?: string | null | undefined;
}): ResolvedAmazonStore {
	const ask = typeof requested === "string" ? requested.trim() : "";
	const fromRequest = ask ? storeById(ask) : null;
	if (fromRequest) {
		return { store: fromRequest, from: "requested" };
	}
	const unknown = ask ? { unknownRequest: ask } : {};
	const fromPage = storeForUrl(pageUrl);
	if (fromPage) {
		return { store: fromPage, from: "page", ...unknown };
	}
	const signedIn = signedInStores(cookies);
	if (signedIn.length === 1 && signedIn[0]) {
		return { store: signedIn[0], from: "cookies", ...unknown };
	}
	return { store: DEFAULT_AMAZON_STORE, from: "default", ...unknown };
}

// ─── URLs ────────────────────────────────────────────────────────────────

export function ordersUrl(s: AmazonStore = DEFAULT_AMAZON_STORE): string {
	return `${s.origin}/your-orders/orders`;
}

export function ordersListUrl(
	s: AmazonStore,
	year: number,
	startIndex: number,
): string {
	return `${s.origin}/your-orders/orders?timeFilter=year-${year}&startIndex=${startIndex}`;
}

export function orderDetailUrl(s: AmazonStore, orderId: string): string {
	return `${s.origin}/gp/your-account/order-details?orderID=${encodeURIComponent(orderId)}`;
}

/** The store's own sign-in page, returning to its home page (what amazon.com's flow used before stores). */
export function signInUrl(s: AmazonStore = DEFAULT_AMAZON_STORE): string {
	const openid = "http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0";
	const select = `${openid}%2Fidentifier_select`;
	const returnTo = encodeURIComponent(`${s.origin}/`);
	return `${s.origin}/ap/signin?openid.return_to=${returnTo}&openid.assoc_handle=${s.assocHandle}&openid.mode=checkid_setup&openid.ns=${openid}&openid.identity=${select}&openid.claimed_id=${select}`;
}

/** A link from a store page, made absolute on that store. */
export function absoluteStoreUrl(
	s: AmazonStore,
	href: string | null | undefined,
): string | null {
	if (!href) {
		return null;
	}
	if (href.startsWith("//")) {
		return `https:${href}`;
	}
	if (href.startsWith("/")) {
		return `${s.origin}${href}`;
	}
	return href;
}

// ─── Postal codes ────────────────────────────────────────────────────────

const ZERO_WIDTH_RE = /[​-‏⁠﻿]/g;

/** One postal code in `text` in the store country's shape, normalized (`V6B 1A1`, `SW1A 1AA`, `123-4567`), or null. */
export function matchPostalCode(
	text: string | null | undefined,
	s: AmazonStore = DEFAULT_AMAZON_STORE,
): string | null {
	const clean = String(text ?? "")
		.replace(ZERO_WIDTH_RE, "")
		.trim();
	if (!clean) {
		return null;
	}
	const m = s.postal.exec(clean);
	if (!m?.[1]) {
		return null;
	}
	const head = m[1].toUpperCase();
	const tail = m[2]?.toUpperCase();
	if (!tail) {
		return head;
	}
	if (s.id === "co.jp" || s.id === "com.br") {
		return `${head}-${tail}`;
	}
	if (s.id === "in") {
		return `${head}${tail}`;
	}
	return `${head} ${tail}`;
}

/**
 * The postal code of an address given as its lines (recipient first, as Amazon
 * prints it). Read from the LAST line upwards, skipping the recipient line, so
 * the city/postal line wins over a street number that happens to have the same
 * shape (`12345 Main St` above `Seattle, WA 98101`).
 */
export function extractPostalCode(
	lines: readonly string[],
	s: AmazonStore = DEFAULT_AMAZON_STORE,
): string | null {
	for (let index = lines.length - 1; index >= 1; index -= 1) {
		const found = matchPostalCode(lines[index], s);
		if (found) {
			return found;
		}
	}
	return null;
}
