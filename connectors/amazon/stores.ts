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
 *   2. `page`: the store of the page the run was handed, when the browser holds
 *      a signed-in token for that store (or holds none at all, so there is no
 *      cookie signal to contradict it). On the hosted service the host signs in
 *      on the person's store and hands over its page. A page on a store the
 *      browser is NOT signed in to is where the run happened to start, not
 *      where the person's history is, so it does not win;
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
	const signedIn = signedInStores(cookies);
	if (fromPage && (signedIn.length === 0 || signedIn.includes(fromPage))) {
		return { store: fromPage, from: "page", ...unknown };
	}
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

const ZERO_WIDTH_RE = /[\u200b-\u200f\u2060\ufeff]/g;

/**
 * Postal-code shapes by country (lowercase ISO alpha-2). `loose` is the
 * country's full shape, used when the address names that country or the store
 * is in it. `strict` is a shape no other country's address can be mistaken for
 * (a separator is required), tried on an address that names no country, so a
 * Canadian address on amazon.com still yields its code. Countries whose codes
 * are bare digit runs (US 5, DE/FR/IT/ES/MX 5, AU 4, IN 6) have no strict shape
 * except the US ZIP+4: a bare number is only read when the country is known.
 */
interface PostalShape {
	loose: RegExp;
	strict?: RegExp;
}

const POSTAL_SHAPES: Readonly<Record<string, PostalShape>> = Object.freeze({
	us: {
		loose: /\b(\d{5}(?:-\d{4})?)\b/g,
		strict: /\b(\d{5}-\d{4})\b/g,
	},
	ca: {
		loose:
			/\b([ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z])\s?(\d[ABCEGHJ-NPRSTV-Z]\d)\b/gi,
		strict:
			/\b([ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z])\s?(\d[ABCEGHJ-NPRSTV-Z]\d)\b/gi,
	},
	gb: {
		loose: /\b([A-Z]{1,2}\d[A-Z\d]?)\s?(\d[A-Z]{2})\b/gi,
		// Uppercase only: case-insensitive, "Apt B2 3rd Floor" reads as B2 3RD.
		strict: /\b([A-Z]{1,2}\d[A-Z\d]?)\s?(\d[A-Z]{2})\b/g,
	},
	de: { loose: /\b(\d{5})\b/g },
	fr: { loose: /\b(\d{5})\b/g },
	it: { loose: /\b(\d{5})\b/g },
	es: { loose: /\b(\d{5})\b/g },
	mx: { loose: /\b(\d{5})\b/g },
	au: { loose: /\b(\d{4})\b/g },
	jp: {
		loose: /(?:〒\s*)?\b(\d{3})-?(\d{4})\b/g,
		// Outside Japan a bare 123-4567 is as likely a phone number's tail, so
		// only the 〒 mark makes it a postal code.
		strict: /〒\s*(\d{3})-?(\d{4})\b/g,
	},
	in: { loose: /\b(\d{3})\s?(\d{3})\b/g },
	br: {
		loose: /\b(\d{5})-?(\d{3})\b/g,
		strict: /\b(\d{5})-(\d{3})\b/g,
	},
});

// Tried in this order on an address that names no country; on a tie (two
// shapes ending at the same place) the earlier one wins.
const STRICT_FALLBACK_ORDER = ["ca", "gb", "br", "jp", "us"] as const;

/** A country an address line names, in English or the country's language. */
const COUNTRY_NAMES: readonly (readonly [string, RegExp])[] = [
	["us", /\b(?:United States(?: of America)?|U\.?S\.?A\.?)(?![\w.])/i],
	["ca", /\bCanada\b/i],
	[
		"gb",
		/\b(?:United Kingdom|Great Britain|England|Scotland|Northern Ireland|(?<!South )Wales)\b|\bUK\b/,
	],
	["de", /\b(?:Germany|Deutschland)\b/i],
	["fr", /\bFrance\b/i],
	["it", /\b(?:Italy|Italia)\b/i],
	["es", /\b(?:Spain|Espa[ñn]a)(?![\w])/i],
	["au", /\bAustralia\b/i],
	["jp", /\bJapan\b|日本/i],
	["in", /\bIndia\b/i],
	["mx", /(?<!New )\bM[ée]xico(?![\w])/i],
	["br", /\b(?:Brazil|Brasil)\b/i],
];

// A phone line under the address ("Phone: 416-555-1234", or the bare number)
// holds digit groups shaped like postal codes; it is never read for one.
const PHONE_LINE_RE =
	/\b(?:phone|mobile|mobil|cell|tel|telefon|t[ée]l[ée]phone|telefono|tel[ée]fono|telefone|celular|m[óo]vil|portable|handy)\b|電話|携帯/i;
// A phone number: international (+44 20 7946 0000), North American
// (416-555-1234, (416) 555-1234) or Japanese (03-1234-5678).
const PHONE_NUMBER_RE =
	/\+\d[\d\s().-]{7,}\d|\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b|\b0\d{1,4}-\d{1,4}-\d{4}\b/;
const PHONE_CHARS_ONLY_RE = /^[\d\s().+-]+$/;
const NON_DIGIT_RE = /\D/g;
// A line of only digits and phone separators is a phone number from 10 digits
// on; 9 or fewer is a postal code on its own line (98101-1234, 01310-100).
const MIN_BARE_PHONE_DIGITS = 10;

function isPhoneLine(line: string): boolean {
	return (
		PHONE_LINE_RE.test(line) ||
		PHONE_NUMBER_RE.test(line) ||
		(PHONE_CHARS_ONLY_RE.test(line) &&
			line.replace(NON_DIGIT_RE, "").length >= MIN_BARE_PHONE_DIGITS)
	);
}

function cleanText(text: string | null | undefined): string {
	return String(text ?? "")
		.replace(ZERO_WIDTH_RE, "")
		.trim();
}

function normalizePostal(country: string, m: RegExpExecArray): string | null {
	const head = m[1]?.toUpperCase();
	if (!head) {
		return null;
	}
	const tail = m[2]?.toUpperCase();
	if (!tail) {
		return head;
	}
	if (country === "jp" || country === "br") {
		return `${head}-${tail}`;
	}
	if (country === "in") {
		return `${head}${tail}`;
	}
	return `${head} ${tail}`;
}

interface PostalHit {
	code: string;
	end: number;
}

/** The rightmost match of `re` in `text`: the code sits after the street and city, never before them. */
function lastMatch(
	text: string,
	re: RegExp,
	country: string,
): PostalHit | null {
	const pattern = new RegExp(
		re.source,
		re.flags.includes("g") ? re.flags : `${re.flags}g`,
	);
	let best: PostalHit | null = null;
	for (const m of text.matchAll(pattern)) {
		const code = normalizePostal(country, m);
		if (code) {
			best = { code, end: (m.index ?? 0) + m[0].length };
		}
	}
	return best;
}

/** The rightmost code in `text` among the given (country, shape) pairs; earlier pairs win a tie. */
function bestInLine(
	text: string,
	shapes: readonly (readonly [string, RegExp])[],
): string | null {
	let best: PostalHit | null = null;
	for (const [country, re] of shapes) {
		const hit = lastMatch(text, re, country);
		if (hit && (!best || hit.end > best.end)) {
			best = hit;
		}
	}
	return best?.code ?? null;
}

/**
 * The country the address names on its LAST line (a phone line below it is
 * passed over), and that line. Amazon prints the country last; a country word
 * on a street line ("12345 France St") is a street name, never the country.
 */
function addressCountry(
	lines: readonly string[],
	first: number,
): { country: string; line: number } | null {
	for (let index = lines.length - 1; index >= first; index -= 1) {
		const line = lines[index] ?? "";
		if (!line || isPhoneLine(line)) {
			continue;
		}
		for (const [country, re] of COUNTRY_NAMES) {
			if (re.test(line)) {
				return { country, line: index };
			}
		}
		return null;
	}
	return null;
}

function scanLines(
	lines: readonly string[],
	from: number,
	first: number,
	shapes: readonly (readonly [string, RegExp])[],
): string | null {
	for (let index = from; index >= first; index -= 1) {
		const line = lines[index] ?? "";
		if (!line || isPhoneLine(line)) {
			continue;
		}
		const found = bestInLine(line, shapes);
		if (found) {
			return found;
		}
	}
	return null;
}

/**
 * The postal code of an address given as its lines, in the shape of the
 * country the address is IN, which need not be the store's: an amazon.com
 * order can ship to Toronto. Read from the last line upwards so the city/postal
 * line wins over a street number of the same shape, and rightmost within a
 * line (`12345 Main St Seattle, WA 98101` is 98101).
 *
 *   1. The address's last line names a country (`Canada`, `Deutschland`):
 *      that country's shape, from that line upwards.
 *   2. Otherwise the store country's shape, together with every shape that
 *      cannot be mistaken for another country's (A1A 1A1, SW1A 1AA,
 *      12345-678, 〒123-4567, 12345-6789).
 *
 * `skipFirst` skips line 0, the recipient on an order's shipping address.
 */
export function parsePostalCode(
	lines: readonly string[],
	s: AmazonStore = DEFAULT_AMAZON_STORE,
	{ skipFirst = true }: { skipFirst?: boolean } = {},
): string | null {
	const clean = lines.map(cleanText);
	const first = skipFirst ? 1 : 0;
	if (clean.length <= first) {
		return null;
	}
	const named = addressCountry(clean, first);
	if (named) {
		const shape = POSTAL_SHAPES[named.country];
		if (shape) {
			const found = scanLines(clean, named.line, first, [
				[named.country, shape.loose],
			]);
			if (found) {
				return found;
			}
		}
	}
	const own = POSTAL_SHAPES[s.country];
	const shapes: [string, RegExp][] = own ? [[s.country, own.loose]] : [];
	for (const country of STRICT_FALLBACK_ORDER) {
		const strict = POSTAL_SHAPES[country]?.strict;
		if (strict && country !== s.country) {
			shapes.push([country, strict]);
		}
	}
	return scanLines(clean, clean.length - 1, first, shapes);
}

/** One postal code in `text` in the store country's shape, normalized (`V6B 1A1`, `SW1A 1AA`, `123-4567`), or null. */
export function matchPostalCode(
	text: string | null | undefined,
	s: AmazonStore = DEFAULT_AMAZON_STORE,
): string | null {
	const clean = cleanText(text);
	if (!clean) {
		return null;
	}
	const m = new RegExp(s.postal.source, s.postal.flags.replace("g", "")).exec(
		clean,
	);
	return m ? normalizePostal(s.country, m) : null;
}

/**
 * The postal code of an order's shipping address given as its lines
 * (recipient first, as Amazon prints it). See `parsePostalCode`.
 */
export function extractPostalCode(
	lines: readonly string[],
	s: AmazonStore = DEFAULT_AMAZON_STORE,
): string | null {
	return parsePostalCode(lines, s, { skipFirst: true });
}
