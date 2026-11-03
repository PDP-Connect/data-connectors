// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Goodreads' own GraphQL API (AWS AppSync, the one its book pages call),
 * read with the signed-in member's token.
 *
 * The token: a signed-in book page (`/book/show/<id>`, a Next.js page)
 * carries a JWT for the member in its `__NEXT_DATA__` script, next to the
 * member's customer id. The token lasts five minutes, so it is read again
 * from a fresh page load shortly before it ends, or once after the API
 * refuses it. A `fetch()` of the page does not work (Goodreads answers it
 * with a WAF challenge); a real navigation does.
 *
 * The API is undocumented and its introspection is off. The queries ask only
 * for fields checked against a live library, and an answer without the
 * expected shape stops the stream rather than being guessed at.
 *
 * The in-page functions are self-contained (no inner named functions): the
 * PageShim host serialises them with `Function.prototype.toString`.
 */

import { politeDelay } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import {
	type FetchOutcome,
	type FetchPage,
	navigate,
	RETRY_BASE_DELAY_MS,
	WAF_SETTLE_MS,
} from "./fetcher.ts";
import { ORIGIN } from "./parsers.ts";

export const GRAPHQL_URL =
	"https://kxbwmqov6jgg3daaamb744ycu4.appsync-api.us-east-1.amazonaws.com/graphql";
/** A book page to read the token from when the library has no book to use. */
export const FALLBACK_TOKEN_PAGE = `${ORIGIN}/book/show/1`;
/** Read a new token when the current one has less than this left. */
export const TOKEN_MARGIN_MS = 60_000;
/** The API's page-size ceiling is between 100 and 200. */
export const GRAPHQL_PAGE_SIZE = 100;
const MAX_ATTEMPTS = 3;

type Failure = Extract<FetchOutcome, { ok: false }>;
export type GraphqlOutcome<T> = { ok: true; value: T } | Failure;

/** One book on the member's shelves, as the API describes it. */
export interface GraphqlShelving {
	addedAtMs: number;
	bookId: string;
	genres: string[];
	language: string | null;
	publisher: string | null;
	review: {
		createdAtMs: number | null;
		hasSpoilers: boolean | null;
		rating: number | null;
		updatedAtMs: number | null;
	} | null;
	series: { placement: string | null; title: string }[];
	shelf: string | null;
	tags: string[];
	updatedAtMs: number | null;
}

/** One exclusive shelf or one tag. */
export interface GraphqlShelf {
	displayName: string | null;
	name: string;
	url: string | null;
}

export const SHELVINGS_QUERY = `query GoodreadsShelvings($input: GetUserShelvingsInput!, $pagination: PaginationInput) {
  getUserShelvings(input: $input, pagination: $pagination) {
    totalCount
    pageInfo { hasNextPage nextPageToken }
    edges { node {
      createdAt updatedAt
      shelf { name }
      taggings { tag { name } }
      review { rating createdAt updatedAt spoilerStatus }
      book {
        legacyId
        details { publisher language { name } }
        bookGenres { genre { name } }
        bookSeries { seriesPlacement series { title } }
      }
    } }
  }
}`;

export const SHELVES_QUERY = `query GoodreadsShelves($input: GetUserShelvesInput!, $pagination: PaginationInput) {
  getUserShelves(input: $input, pagination: $pagination) {
    totalCount
    pageInfo { hasNextPage nextPageToken }
    edges { node { name displayName webUrl } }
  }
}`;

export const TAGS_QUERY = `query GoodreadsTags($input: GetUserTagsInput!, $pagination: PaginationInput) {
  getUserTags(input: $input, pagination: $pagination) {
    totalCount
    pageInfo { hasNextPage nextPageToken }
    edges { node { name webUrl } }
  }
}`;

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const textOrNull = (value: unknown): string | null =>
	typeof value === "string" && value.trim() !== "" ? value.trim() : null;

/** Epoch milliseconds, given as a number or a string of digits. */
function epochMs(value: unknown): number | null {
	const n =
		typeof value === "number"
			? value
			: typeof value === "string" && /^\d+$/.test(value)
				? Number(value)
				: Number.NaN;
	return Number.isFinite(n) && n > 0 ? n : null;
}

const names = (
	list: unknown,
	pick: (item: Record<string, unknown>) => unknown,
) =>
	Array.isArray(list)
		? list
				.map((item) => (isObject(item) ? textOrNull(pick(item)) : null))
				.filter((name): name is string => name !== null)
		: [];

/** A shelving node, or null when it has no book id or no date added. */
export function parseShelvingNode(node: unknown): GraphqlShelving | null {
	if (!isObject(node) || !isObject(node.book)) return null;
	const legacyId = node.book.legacyId;
	const bookId =
		typeof legacyId === "number" || typeof legacyId === "string"
			? String(legacyId)
			: "";
	const addedAtMs = epochMs(node.createdAt);
	if (!/^\d+$/.test(bookId) || addedAtMs === null) return null;
	const details = isObject(node.book.details) ? node.book.details : {};
	const review = isObject(node.review) ? node.review : null;
	const rating = review?.rating;
	return {
		addedAtMs,
		bookId,
		genres: names(node.book.bookGenres, (g) =>
			isObject(g.genre) ? g.genre.name : null,
		),
		language: isObject(details.language)
			? textOrNull(details.language.name)
			: null,
		publisher: textOrNull(details.publisher),
		review: review
			? {
					createdAtMs: epochMs(review.createdAt),
					hasSpoilers:
						typeof review.spoilerStatus === "boolean"
							? review.spoilerStatus
							: null,
					rating:
						typeof rating === "number" &&
						Number.isInteger(rating) &&
						rating >= 1 &&
						rating <= 5
							? rating
							: null,
					updatedAtMs: epochMs(review.updatedAt),
				}
			: null,
		series: Array.isArray(node.book.bookSeries)
			? node.book.bookSeries.flatMap((entry) => {
					if (!(isObject(entry) && isObject(entry.series))) return [];
					const title = textOrNull(entry.series.title);
					return title
						? [{ placement: textOrNull(entry.seriesPlacement), title }]
						: [];
				})
			: [],
		shelf: isObject(node.shelf) ? textOrNull(node.shelf.name) : null,
		tags: names(node.taggings, (t) => (isObject(t.tag) ? t.tag.name : null)),
		updatedAtMs: epochMs(node.updatedAt),
	};
}

/** A shelf or tag node, or null when it has no name. */
export function parseShelfNode(node: unknown): GraphqlShelf | null {
	if (!isObject(node)) return null;
	const name = textOrNull(node.name);
	if (!name) return null;
	return {
		displayName: textOrNull(node.displayName),
		name,
		url: textOrNull(node.webUrl),
	};
}

/** A JWT payload, decoded in the page (which always has `atob`), parsed here. */
function parseClaims(text: string | null): Record<string, unknown> | null {
	if (!text) return null;
	try {
		const claims: unknown = JSON.parse(text);
		return isObject(claims) ? claims : null;
	} catch {
		return null;
	}
}

export interface TokenSession {
	customerUri: string;
	expiresAtMs: number;
	/** The numeric member id the token was issued for (the id in /review/list/<id>). */
	memberId: string | null;
	token: string;
}

export type NextDataReading =
	| { kind: "missing" }
	| { kind: "signed_out" }
	| { kind: "session"; session: TokenSession };

/** What a book page's `__NEXT_DATA__` script read in the page. */
export interface NextDataText {
	/** The decoded payload of `props.pageProps.jwtToken`, as JSON text. */
	claims: string | null;
	text: string | null;
}

/** What a book page's `__NEXT_DATA__` says about the session. */
export function readNextData({
	claims: claimsText,
	text,
}: NextDataText): NextDataReading {
	if (!text) return { kind: "missing" };
	let pageProps: unknown;
	try {
		const parsed: unknown = JSON.parse(text);
		pageProps =
			isObject(parsed) && isObject(parsed.props)
				? parsed.props.pageProps
				: null;
	} catch {
		return { kind: "missing" };
	}
	if (!isObject(pageProps)) return { kind: "missing" };
	const auth = isObject(pageProps.authContextParams)
		? pageProps.authContextParams
		: {};
	const token = textOrNull(pageProps.jwtToken);
	const customerId = textOrNull(auth.customerId);
	if (auth.signedIn === false) return { kind: "signed_out" };
	if (!(token && customerId)) return { kind: "missing" };
	const claims = parseClaims(claimsText);
	const exp = claims?.exp;
	if (typeof exp !== "number") return { kind: "missing" };
	const memberId = claims?.user_id;
	return {
		kind: "session",
		session: {
			customerUri: `kca://profile:goodreads/${customerId}`,
			expiresAtMs: exp * 1000,
			memberId:
				typeof memberId === "number" || typeof memberId === "string"
					? String(memberId)
					: null,
			token,
		},
	};
}

async function readNextDataText(page: FetchPage): Promise<NextDataText> {
	const result = (await page.evaluate(() => {
		const script = document.getElementById("__NEXT_DATA__");
		const text = script ? script.textContent : null;
		let claims: string | null = null;
		try {
			const token = JSON.parse(text ?? "").props.pageProps.jwtToken;
			const part = (String(token).split(".")[1] ?? "")
				.replace(/-/g, "+")
				.replace(/_/g, "/");
			claims = atob(part.padEnd(Math.ceil(part.length / 4) * 4, "="));
		} catch {
			claims = null;
		}
		return { claims, text };
	})) as NextDataText | null;
	return result ?? { claims: null, text: null };
}

type RawGraphqlResponse =
	| { kind: "network_error"; message: string }
	| { kind: "response"; status: number; body: string };

async function rawPost(
	page: FetchPage,
	token: string,
	body: string,
): Promise<RawGraphqlResponse> {
	const result = await page.evaluate(
		async ({ url, token, body }) => {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), 45_000);
			try {
				const response = await fetch(url, {
					method: "POST",
					headers: {
						authorization: token,
						"content-type": "application/json",
					},
					body,
					signal: controller.signal,
				});
				return {
					kind: "response",
					status: response.status,
					body: await response.text(),
				};
			} catch (error) {
				return {
					kind: "network_error",
					message: error instanceof Error ? error.message : String(error),
				};
			} finally {
				clearTimeout(timer);
			}
		},
		{ url: GRAPHQL_URL, token, body },
	);
	return (
		(result as RawGraphqlResponse | null) ?? {
			kind: "network_error",
			message: "the page did not return a result",
		}
	);
}

const unreadable = (message: string): Failure => ({
	ok: false,
	reason: "source_unreadable",
	message,
});

export interface GoodreadsGraphql {
	/**
	 * Every node of a paginated list, and the total the API reports for it.
	 * `onPage`, when given, hears how many nodes have been read after each
	 * page, out of the total the first page reported.
	 */
	list<T>(
		label: string,
		query: string,
		field: string,
		parse: (node: unknown) => T | null,
		onPage?: (read: number, total: number) => Promise<void>,
	): Promise<GraphqlOutcome<{ items: T[]; totalCount: number }>>;
	session(): TokenSession;
}

export interface GraphqlOptions {
	/** Waits between requests; shared with the page reads so the pace is one. */
	pace: () => Promise<void>;
	now?: () => number;
	/** A signed-in book page to read the token from. */
	tokenPageUrl: string;
	/** The most pages one list may have before reading stops. */
	maxPages: number;
}

/**
 * Read a token from a book page, then return a client for the member's
 * lists. Fails when the page has no token (a site change, or a check the
 * browser did not pass) or says the member is signed out.
 */
export async function openGraphql(
	page: FetchPage,
	options: GraphqlOptions,
): Promise<GraphqlOutcome<GoodreadsGraphql>> {
	const now = options.now ?? Date.now;
	const acquire = async (): Promise<GraphqlOutcome<TokenSession>> => {
		let reading: NextDataReading = { kind: "missing" };
		for (
			let attempt = 1;
			attempt <= 2 && reading.kind === "missing";
			attempt++
		) {
			await options.pace();
			if (!(await navigate(page, options.tokenPageUrl))) {
				return {
					ok: false,
					reason: "collection_interrupted",
					message:
						"The browser could not open a Goodreads book page to read your library's details.",
				};
			}
			reading = readNextData(await readNextDataText(page));
			// A WAF challenge reloads into the real page once its script ran.
			if (reading.kind === "missing") {
				await politeDelay(WAF_SETTLE_MS);
				reading = readNextData(await readNextDataText(page));
			}
		}
		if (reading.kind === "signed_out") {
			return {
				ok: false,
				reason: "sign_in_required",
				message:
					"Goodreads showed a book page as signed out, so your library's details could not be read.",
			};
		}
		if (reading.kind === "missing") {
			return unreadable(
				"A Goodreads book page did not carry the sign-in token this connector reads your library's details with. Goodreads may have changed its site, or asked the browser for a check it did not pass.",
			);
		}
		return { ok: true, value: reading.session };
	};

	const first = await acquire();
	if (!first.ok) return first;
	let session = first.value;

	const post = async (
		label: string,
		body: string,
	): Promise<GraphqlOutcome<Record<string, unknown>>> => {
		let failures = 0;
		let refreshed = false;
		for (;;) {
			if (now() > session.expiresAtMs - TOKEN_MARGIN_MS) {
				const next = await acquire();
				if (!next.ok) return next;
				session = next.value;
			}
			await options.pace();
			const raw = await rawPost(page, session.token, body);
			if (
				raw.kind === "network_error" ||
				raw.status === 429 ||
				raw.status >= 500
			) {
				failures += 1;
				if (failures >= MAX_ATTEMPTS) {
					return {
						ok: false,
						reason: "collection_interrupted",
						message:
							raw.kind === "network_error"
								? `Goodreads' book API could not be reached while reading ${label}.`
								: `Goodreads' book API kept answering with an error (${raw.status}) while reading ${label}.`,
					};
				}
				await politeDelay(RETRY_BASE_DELAY_MS * 2 ** (failures - 1));
				continue;
			}
			let parsed: unknown = null;
			try {
				parsed = JSON.parse(raw.body);
			} catch {
				// Classified below with the status.
			}
			const errors =
				isObject(parsed) && Array.isArray(parsed.errors) ? parsed.errors : [];
			const refused =
				raw.status === 401 ||
				raw.status === 403 ||
				errors.some(
					(e) =>
						isObject(e) &&
						typeof e.errorType === "string" &&
						/unauthori[sz]ed/i.test(e.errorType),
				);
			if (refused) {
				if (refreshed) {
					return unreadable(
						`Goodreads' book API refused the token Goodreads itself issued while reading ${label}. Goodreads may have changed how its site signs in.`,
					);
				}
				refreshed = true;
				session = { ...session, expiresAtMs: 0 };
				continue;
			}
			if (raw.status !== 200 || !isObject(parsed)) {
				return unreadable(
					`Goodreads' book API answered ${label} with HTTP ${raw.status}, not an answer this connector can read.`,
				);
			}
			if (errors.length > 0 || !isObject(parsed.data)) {
				return unreadable(
					`Goodreads' book API rejected the request for ${label}. Goodreads may have changed its API.`,
				);
			}
			return { ok: true, value: parsed.data };
		}
	};

	return {
		ok: true,
		value: {
			session: () => session,
			async list(label, query, field, parse, onPage) {
				const items: ReturnType<typeof parse>[] = [];
				const tokens = new Set<string>();
				let after: string | undefined;
				let totalCount: number | null = null;
				for (let pageNo = 1; ; pageNo++) {
					if (pageNo > options.maxPages) {
						return unreadable(
							`Your ${label} have more than ${options.maxPages} pages; reading stopped at the page limit.`,
						);
					}
					const answer = await post(
						label,
						JSON.stringify({
							query,
							variables: {
								input: { userId: session.customerUri },
								pagination: { limit: GRAPHQL_PAGE_SIZE, after },
							},
						}),
					);
					if (!answer.ok) return answer;
					const connection = answer.value[field];
					const pageInfo = isObject(connection) ? connection.pageInfo : null;
					if (
						!(
							isObject(connection) &&
							Array.isArray(connection.edges) &&
							typeof connection.totalCount === "number" &&
							isObject(pageInfo) &&
							typeof pageInfo.hasNextPage === "boolean"
						)
					) {
						return unreadable(
							`Goodreads' book API answered ${label} in a shape this connector does not recognise. Goodreads may have changed its API.`,
						);
					}
					totalCount ??= connection.totalCount;
					for (const edge of connection.edges) {
						const item = parse(isObject(edge) ? edge.node : null);
						if (item === null) {
							return unreadable(
								`Goodreads' book API listed an entry in ${label} without the details this connector needs. Goodreads may have changed its API.`,
							);
						}
						items.push(item);
					}
					await onPage?.(items.length, totalCount);
					if (!pageInfo.hasNextPage) break;
					const next = textOrNull(pageInfo.nextPageToken);
					if (!next || tokens.has(next)) {
						return unreadable(
							`Goodreads' book API offered another page of ${label} without a new way to ask for it.`,
						);
					}
					tokens.add(next);
					after = next;
				}
				return {
					ok: true,
					value: { items: items as never[], totalCount: totalCount ?? 0 },
				};
			},
		},
	};
}
