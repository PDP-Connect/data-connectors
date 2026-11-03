// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Goodreads collection: the order of requests, what each stream is built
 * from, and what a run claims about completeness. Parsing is in parsers.ts,
 * graphql.ts and summary.ts; the page I/O (retry, WAF handling) is in
 * fetcher.ts.
 *
 * Requests, one at a time, with a pause between them:
 *   1. /review/list            owner id, "All (N)" count
 *   2. /user/show/<id>         profile counts            (account_profile)
 *   3. /user/edit              settings                  (account_profile)
 *   4. /review/list/<id>?print=true&per_page=100&page=N  (books, usage_summary)
 *   5. a book page             the session's API token   (books, shelves)
 *   6. getUserShelvings        every shelving, 100 a page (books, shelves)
 *   7. getUserShelves, getUserTags                       (shelves)
 *
 * A book record joins the print list (notes, ownership, reading sessions,
 * position) with the API (instants, genres, series, publisher, language) on
 * book_id. Books are saved only when both lists are complete, name the same
 * books, and agree on each book's shelf, tags and rating: a record with half
 * its fields empty would replace a good stored one.
 *
 * The print listing is complete only when it ended on a last page (or an
 * empty past-the-end page) AND the rows read equal the count Goodreads
 * shows. A first page with no rows while the count is above zero is drift,
 * never an empty library.
 */

import { resourceSet } from "@pdpp/connector-protocol";
import type { BrowserCollectContext } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { politeDelay } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { openFingerprintCursor } from "../../packages/polyfill-connectors/src/fingerprint-cursor.ts";
import { type FetchOutcome, type FetchPage, fetchHtml } from "./fetcher.ts";
import {
	FALLBACK_TOKEN_PAGE,
	type GoodreadsGraphql,
	type GraphqlShelf,
	type GraphqlShelving,
	openGraphql,
	parseShelfNode,
	parseShelvingNode,
	SHELVES_QUERY,
	SHELVINGS_QUERY,
	TAGS_QUERY,
} from "./graphql.ts";
import {
	ORIGIN,
	parseAllCount,
	parseListingPage,
	parseProfile,
	parseSettings,
	tenureMonths,
	userIdFromHtml,
	userIdFromUrl,
} from "./parsers.ts";
import { summarizeLibrary } from "./summary.ts";
import type { BookRecord, PrintBookRecord, ShelfRecord } from "./types.ts";

export const PAGE_DELAY_MIN_MS = 1500;
export const PAGE_DELAY_JITTER_MS = 1000;
export const PER_PAGE = 100;
/** A library of 20,000 books is far past any real one; the cap only stops a loop. */
export const MAX_LISTING_PAGES = 200;

const BOOKS = "books";
const SHELVES = "shelves";
const PROFILE = "account_profile";
const SUMMARY = "usage_summary";

/**
 * The part of the collect context this connector uses. Structural, so the
 * desktop runtime and the PageShim runtime (which has no `context`) both
 * satisfy it.
 */
export interface GoodreadsCollectContext {
	/**
	 * Set by the desktop runtime on every run. PageShim leaves it out: its
	 * host stores each result as the whole stream, so there every record is
	 * emitted and no state is kept.
	 */
	collectionMode?: BrowserCollectContext["collectionMode"];
	emit: BrowserCollectContext["emit"];
	emitRecord: BrowserCollectContext["emitRecord"];
	page: FetchPage;
	progress?: BrowserCollectContext["progress"];
	reportStreamFailure?: BrowserCollectContext["reportStreamFailure"];
	requested: BrowserCollectContext["requested"];
	state?: Record<string, unknown>;
}

type StopReason =
	| Extract<FetchOutcome, { ok: false }>["reason"]
	| "listing_incomplete"
	| "shelf_list_incomplete";

/** The SKIP_RESULT reason for each way a stream can stop; literal per branch. */
const SKIP_REASON: Record<StopReason, string> = {
	bot_challenge: "bot_challenge",
	collection_interrupted: "collection_interrupted",
	listing_incomplete: "listing_incomplete",
	shelf_list_incomplete: "shelf_list_incomplete",
	sign_in_required: "sign_in_required",
	source_unreadable: "source_unreadable",
};

interface Stop {
	message: string;
	reason: StopReason;
}

/** Stops that a second run would meet again: Goodreads' pages, not the moment. */
const PERMANENT: ReadonlySet<StopReason> = new Set([
	"shelf_list_incomplete",
	"source_unreadable",
]);

/**
 * Report that a stream could not be finished: a specific reason, and a failed
 * run. Without the failure hook the run would end as succeeded with the
 * stream missing, so a host that lacks it is an error.
 */
async function stopStream(
	ctx: GoodreadsCollectContext,
	stream: string,
	stop: Stop,
	retryable = !PERMANENT.has(stop.reason),
): Promise<void> {
	if (!ctx.reportStreamFailure) {
		throw new Error(
			`goodreads_stream_failure_unreported: ${stream}: ${stop.message}`,
		);
	}
	await ctx.emit({
		type: "SKIP_RESULT",
		stream,
		reason: SKIP_REASON[stop.reason],
		message: stop.message,
	});
	await ctx.reportStreamFailure(stream, stop.message, { retryable });
}

/**
 * The keys kept whatever consent selects: each stream's required keys, and
 * for books the consent time field, which the runtime reads to apply a time
 * range after projection.
 */
const KEPT_KEYS: Record<string, readonly string[]> = {
	[BOOKS]: ["id", "book_id", "added_at"],
	[PROFILE]: ["id", "sources"],
	[SHELVES]: ["id", "name", "exclusive"],
	[SUMMARY]: ["id", "coverage"],
};

/**
 * Keep the fields consent selected, plus the stream's kept keys. All fields
 * when none is named.
 */
export function projectFields<T extends { id: string }>(
	stream: string,
	record: T,
	fields: unknown,
): T {
	if (!Array.isArray(fields) || fields.length === 0) return record;
	const keep = new Set<string>([
		...(KEPT_KEYS[stream] ?? ["id"]),
		...fields.map(String),
	]);
	return Object.fromEntries(
		Object.entries(record).filter(([key]) => keep.has(key)),
	) as T;
}

const pace = (): Promise<void> =>
	politeDelay(
		PAGE_DELAY_MIN_MS + Math.floor(Math.random() * PAGE_DELAY_JITTER_MS),
	);

interface Listing {
	books: PrintBookRecord[];
	complete: boolean;
	pages: number;
	stop: Stop | null;
}

/** The API's view of the library: every shelving, or why it could not be read. */
type ApiLibrary =
	| { ok: true; graphql: GoodreadsGraphql; shelvings: GraphqlShelving[] }
	| { ok: false; stop: Stop };

export async function collectGoodreads(
	ctx: GoodreadsCollectContext,
): Promise<void> {
	const wants = (stream: string): boolean => ctx.requested.has(stream);
	const wantsPrint = wants(BOOKS) || wants(SUMMARY);
	const wantsApi = wants(BOOKS) || wants(SHELVES);
	if (!(wantsPrint || wantsApi || wants(PROFILE))) return;
	const streams = [BOOKS, SHELVES, PROFILE, SUMMARY].filter(wants);
	const stopAll = async (stop: Stop, only: string[] = streams) => {
		for (const stream of only) await stopStream(ctx, stream, stop);
	};
	let requests = 0;
	const paced = async (): Promise<void> => {
		if (requests > 0) await pace();
		requests += 1;
	};
	const get = async (path: string, label: string): Promise<FetchOutcome> => {
		await paced();
		return fetchHtml(ctx.page, path, label);
	};

	// 1. Who is signed in, and how many books the library page says it has.
	await ctx.progress?.("Opening your Goodreads library");
	const home = await get("/review/list", "your library");
	if (!home.ok) {
		await stopAll(home);
		return;
	}
	const userId = userIdFromUrl(home.url) ?? userIdFromHtml(home.body);
	if (!userId) {
		await stopAll({
			message:
				"Goodreads did not say which account is signed in, so nothing could be read. Goodreads may have changed its site.",
			reason: "source_unreadable",
		});
		return;
	}
	const allCount = parseAllCount(home.body);
	if (wantsPrint && allCount === null) {
		await stopAll(
			{
				message:
					"Goodreads showed your library page without a book count, so the list could not be checked for completeness. Goodreads may have changed its site.",
				reason: "source_unreadable",
			},
			[BOOKS, SUMMARY].filter(wants),
		);
	}

	// 2. The account profile, from two independent pages.
	if (wants(PROFILE)) {
		await collectProfile(ctx, userId, get);
	}

	// 3. The whole print listing, for books and for the summary.
	let listing: Listing | null = null;
	if (wantsPrint && allCount !== null) {
		listing = await readListing(ctx, userId, allCount, get);
		if (wants(SUMMARY)) await finishSummary(ctx, listing);
	}

	// 4. The API's listing of the same library, for books and shelves.
	if (!wantsApi) return;
	if (wants(BOOKS) && listing?.stop) {
		await stopStream(ctx, BOOKS, listing.stop);
		if (!wants(SHELVES)) return;
	}
	const booksReady = wants(BOOKS) && listing?.complete === true;
	if (!(booksReady || wants(SHELVES))) return;
	const api = await readApiLibrary(ctx, userId, listing, paced);
	if (!api.ok) {
		await stopAll(
			api.stop,
			[booksReady ? BOOKS : null, SHELVES].filter(
				(stream): stream is string => stream !== null && wants(stream),
			),
		);
		return;
	}
	if (booksReady && listing) {
		await finishBooks(ctx, listing.books, api.shelvings);
	}
	if (wants(SHELVES)) {
		await finishShelves(ctx, api.graphql, api.shelvings);
	}
}

/**
 * Open the API with a token from a book page (one from the library, else a
 * fixed one), check it is the signed-in owner's, and read every shelving.
 */
async function readApiLibrary(
	ctx: GoodreadsCollectContext,
	userId: string,
	listing: Listing | null,
	paced: () => Promise<void>,
): Promise<ApiLibrary> {
	await ctx.progress?.("Reading your library's details from Goodreads");
	const opened = await openGraphql(ctx.page, {
		maxPages: MAX_LISTING_PAGES,
		pace: paced,
		tokenPageUrl:
			listing?.books.find((book) => book.book_url)?.book_url ??
			FALLBACK_TOKEN_PAGE,
	});
	if (!opened.ok) return { ok: false, stop: opened };
	const graphql = opened.value;
	if (graphql.session().memberId !== userId) {
		return {
			ok: false,
			stop: {
				message:
					"Goodreads issued its API token for a different account than the one whose library is open, so nothing was joined. Sign out of Goodreads and in again, then run collection again.",
				reason: "source_unreadable",
			},
		};
	}
	const read = await graphql.list(
		"library details",
		SHELVINGS_QUERY,
		"getUserShelvings",
		parseShelvingNode,
	);
	if (!read.ok) return { ok: false, stop: read };
	const { items, totalCount } = read.value;
	const ids = new Set(items.map((item) => item.bookId));
	if (items.length !== totalCount || ids.size !== items.length) {
		return {
			ok: false,
			stop: {
				message: `Goodreads' book API listed ${ids.size} different books of the ${totalCount} it reports. A book may have been added or moved while reading; run collection again.`,
				reason: "collection_interrupted",
			},
		};
	}
	return { ok: true, graphql, shelvings: items };
}

const isoOrNull = (ms: number | null | undefined): string | null =>
	typeof ms === "number" ? new Date(ms).toISOString() : null;

const sameSet = (a: readonly string[], b: readonly string[]): boolean => {
	const left = new Set(a);
	const right = new Set(b);
	return left.size === right.size && [...left].every((x) => right.has(x));
};

/**
 * Join the print list and the API's shelvings on book_id. Null fields of
 * the join are never filled in: a book either matches on both sides, with
 * the same shelf, tags and rating, or the join fails with how many did not.
 */
export function joinLibrary(
	print: readonly PrintBookRecord[],
	api: readonly GraphqlShelving[],
): { ok: true; books: BookRecord[] } | { ok: false; message: string } {
	const byBook = new Map(api.map((shelving) => [shelving.bookId, shelving]));
	let missing = 0;
	let differ = 0;
	const books: BookRecord[] = [];
	for (const row of print) {
		const shelving = byBook.get(row.book_id);
		if (!shelving) {
			missing += 1;
			continue;
		}
		const printTags = row.shelves.filter(
			(shelf) => shelf !== row.exclusive_shelf,
		);
		if (
			shelving.shelf !== row.exclusive_shelf ||
			!sameSet(shelving.tags, printTags) ||
			(shelving.review?.rating ?? null) !== row.rating
		) {
			differ += 1;
			continue;
		}
		books.push({
			...row,
			added_at: isoOrNull(shelving.addedAtMs),
			genres: shelving.genres,
			language: shelving.language,
			publisher: shelving.publisher,
			review_created_at: isoOrNull(shelving.review?.createdAtMs),
			review_has_spoilers: shelving.review?.hasSpoilers ?? null,
			review_updated_at: isoOrNull(shelving.review?.updatedAtMs),
			series: shelving.series,
			updated_at: isoOrNull(shelving.updatedAtMs),
		});
	}
	const extra = api.length - (print.length - missing);
	if (missing > 0 || differ > 0 || extra > 0) {
		const parts = [
			missing > 0 ? `${missing} books in the list are not in the API` : null,
			extra > 0 ? `${extra} books in the API are not in the list` : null,
			differ > 0
				? `${differ} books have a different shelf, tags or rating`
				: null,
		].filter(Boolean);
		return {
			ok: false,
			message: `Your Goodreads books were not saved because the library list and Goodreads' book API disagree (${parts.join("; ")}). A book may have been changed while reading; run collection again.`,
		};
	}
	return { ok: true, books };
}

async function finishBooks(
	ctx: GoodreadsCollectContext,
	print: readonly PrintBookRecord[],
	api: readonly GraphqlShelving[],
): Promise<void> {
	const joined = joinLibrary(print, api);
	if (!joined.ok) {
		await stopStream(ctx, BOOKS, {
			message: joined.message,
			reason: "collection_interrupted",
		});
		return;
	}
	const emitted = await emitStream(ctx, BOOKS, joined.books);
	await ctx.progress?.(
		`Finished reading ${joined.books.length} Goodreads books (${emitted} new or changed)`,
		{ count: joined.books.length, stream: BOOKS },
	);
}

/**
 * Read the exclusive shelves and the tags, and save them only when both
 * lists are whole: as long as the totals the API reports, and naming every
 * shelf and tag that a book is on.
 */
async function finishShelves(
	ctx: GoodreadsCollectContext,
	graphql: GoodreadsGraphql,
	shelvings: readonly GraphqlShelving[],
): Promise<void> {
	const shelves = await graphql.list(
		"shelves",
		SHELVES_QUERY,
		"getUserShelves",
		parseShelfNode,
	);
	if (!shelves.ok) {
		await stopStream(ctx, SHELVES, shelves);
		return;
	}
	const tags = await graphql.list(
		"tags",
		TAGS_QUERY,
		"getUserTags",
		parseShelfNode,
	);
	if (!tags.ok) {
		await stopStream(ctx, SHELVES, tags);
		return;
	}
	const problem = shelfListProblem(shelves.value, tags.value, shelvings);
	if (problem) {
		await stopStream(ctx, SHELVES, problem);
		return;
	}
	const counts = new Map<string, number>();
	for (const shelving of shelvings) {
		for (const name of new Set([shelving.shelf, ...shelving.tags])) {
			if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
		}
	}
	const record = (shelf: GraphqlShelf, exclusive: boolean): ShelfRecord => ({
		book_count: counts.get(shelf.name) ?? 0,
		exclusive,
		id: shelf.name,
		name: shelf.displayName ?? shelf.name,
		url: absoluteUrl(shelf.url),
	});
	const records = [
		...shelves.value.items.map((shelf) => record(shelf, true)),
		...tags.value.items.map((tag) => record(tag, false)),
	];
	await emitStream(ctx, SHELVES, records);
	await ctx.progress?.(`Read ${records.length} Goodreads shelves`, {
		count: records.length,
		stream: SHELVES,
	});
}

function absoluteUrl(url: string | null): string | null {
	if (!url) return null;
	try {
		return new URL(url, ORIGIN).toString();
	} catch {
		return null;
	}
}

type ShelfList = { items: readonly GraphqlShelf[]; totalCount: number };

/**
 * Why the shelves and tags read cannot be shown to be all of them, or null
 * when they can: each list is as long as its reported total, no name is on
 * both lists or twice on one, and every shelf and tag a book is on is there.
 */
export function shelfListProblem(
	shelves: ShelfList,
	tags: ShelfList,
	shelvings: readonly GraphqlShelving[],
): Stop | null {
	if (shelves.items.length === 0) {
		return {
			message:
				"Goodreads listed no shelves for your account, though every account has at least three. Goodreads may have changed its API.",
			reason: "source_unreadable",
		};
	}
	const partial = (detail: string): Stop => ({
		message: `Your Goodreads shelves were not saved because Goodreads listed only part of them (${detail}).`,
		reason: "shelf_list_incomplete",
	});
	for (const [label, list] of [
		["shelves", shelves],
		["tags", tags],
	] as const) {
		if (list.items.length !== list.totalCount) {
			return partial(`${list.items.length} of ${list.totalCount} ${label}`);
		}
	}
	const names = new Set<string>();
	for (const item of [...shelves.items, ...tags.items]) {
		if (names.has(item.name)) return partial(`"${item.name}" is listed twice`);
		names.add(item.name);
	}
	const exclusive = new Set(shelves.items.map((shelf) => shelf.name));
	const missing = new Set<string>();
	for (const shelving of shelvings) {
		if (shelving.shelf && !exclusive.has(shelving.shelf)) {
			missing.add(shelving.shelf);
		}
		for (const tag of shelving.tags) if (!names.has(tag)) missing.add(tag);
	}
	if (missing.size > 0) {
		return partial(`${missing.size} shelves named on books are not in it`);
	}
	return null;
}

/** The ids a stream's saved state says were emitted before, tolerant of any shape. */
function priorIds(state: unknown): string[] {
	const fingerprints =
		typeof state === "object" && state !== null
			? (state as { fingerprints?: unknown }).fingerprints
			: undefined;
	return typeof fingerprints === "object" &&
		fingerprints !== null &&
		!Array.isArray(fingerprints)
		? Object.keys(fingerprints)
		: [];
}

/**
 * Emit a stream's whole list of records, projected to the consent's fields,
 * and return how many were emitted.
 *
 * A desktop run that the consent does not narrow by time range or by
 * resources sees the whole stream, so it keeps state: it emits only records
 * whose fingerprint changed since the last run (all of them on a full
 * refresh), emits a deletion for each record saved before that Goodreads no
 * longer lists, and saves the fingerprints. A narrowed run, or a PageShim
 * run, emits every record it selects and saves no state.
 */
async function emitStream<T extends { id: string }>(
	ctx: GoodreadsCollectContext,
	stream: string,
	records: readonly T[],
): Promise<number> {
	const scope = ctx.requested.get(stream);
	const project = (record: T): Record<string, unknown> =>
		projectFields(stream, record, scope?.fields) as unknown as Record<
			string,
			unknown
		>;
	const tracked =
		ctx.collectionMode !== undefined &&
		!scope?.time_range &&
		resourceSet(scope) === null;
	if (!tracked) {
		for (const record of records) await ctx.emitRecord(stream, project(record));
		return records.length;
	}
	const prior = ctx.state?.[stream];
	const cursor = openFingerprintCursor(
		ctx.collectionMode === "full_refresh" ? undefined : prior,
	);
	let emitted = 0;
	for (const record of records) {
		const data = project(record);
		if (!cursor.shouldEmit(data)) continue;
		emitted += 1;
		await ctx.emitRecord(stream, data);
	}
	const current = new Set(records.map((record) => record.id));
	for (const id of priorIds(prior)) {
		if (!current.has(id)) await ctx.emitRecord(stream, { id, deleted: true });
	}
	cursor.dropUnseenIds();
	await ctx.emit({
		type: "STATE",
		stream,
		cursor: { fingerprints: cursor.toState() },
	});
	return emitted;
}

async function readListing(
	ctx: GoodreadsCollectContext,
	userId: string,
	expectedTotal: number,
	get: (path: string, label: string) => Promise<FetchOutcome>,
): Promise<Listing> {
	const seen = new Map<string, PrintBookRecord>();
	let pages = 0;
	let endProven = false;
	let stop: Stop | null = null;
	let unreadableRows = 0;
	const stream = ctx.requested.has(BOOKS) ? BOOKS : SUMMARY;

	for (
		let page = 1;
		page <= MAX_LISTING_PAGES && !endProven && !stop;
		page += 1
	) {
		const query = `shelf=%23ALL%23&per_page=${PER_PAGE}&page=${page}&print=true&sort=date_added&order=d`;
		const response = await get(
			`/review/list/${userId}?${query}`,
			`page ${page} of your library`,
		);
		if (!response.ok) {
			stop = response;
			break;
		}
		pages += 1;
		const parsed = parseListingPage(response.body);
		if (!parsed.recognised) {
			stop = {
				message: `Goodreads answered page ${page} of your library with a page this connector does not recognise. Goodreads may have changed its site.`,
				reason: "source_unreadable",
			};
			break;
		}
		unreadableRows += parsed.unreadableRows;
		if (parsed.rows.length === 0) {
			if (page === 1 && expectedTotal > 0) {
				stop = {
					message: `Goodreads reports ${expectedTotal} books but printed none on the first page of your library. Goodreads may have changed its site.`,
					reason: "source_unreadable",
				};
			} else if (page === 1 && !parsed.noMatchingItems) {
				stop = {
					message:
						"Goodreads printed an empty first page of your library without saying it is empty. Goodreads may have changed its site.",
					reason: "source_unreadable",
				};
			} else {
				endProven = true;
			}
			break;
		}
		for (const row of parsed.rows) {
			if (!seen.has(row.id)) seen.set(row.id, row);
		}
		await ctx.progress?.(
			`Reading your Goodreads library: ${seen.size} of ${expectedTotal} books`,
			{ count: seen.size, stream, total: expectedTotal },
		);
		endProven = !parsed.hasNextPage;
	}

	if (!(endProven || stop)) {
		stop = {
			message: `Your Goodreads library has more than ${MAX_LISTING_PAGES} pages; reading stopped at the page limit.`,
			reason: "source_unreadable",
		};
	}
	const books = [...seen.values()];
	let complete =
		endProven && books.length === expectedTotal && unreadableRows === 0;
	if (endProven && !complete && !stop) {
		stop =
			unreadableRows > 0
				? {
						message: `Goodreads printed ${unreadableRows} rows of your library that this connector could not read. Goodreads may have changed its site.`,
						reason: "source_unreadable",
					}
				: {
						message: `The Goodreads library list ended, but not every book was read (read ${books.length} of ${expectedTotal}). A book may have been added or moved while reading; run collection again.`,
						reason: "collection_interrupted",
					};
	}
	complete = complete && stop === null;
	return { books, complete, pages, stop };
}

async function finishSummary(
	ctx: GoodreadsCollectContext,
	listing: Listing,
): Promise<void> {
	if (!listing.complete) {
		const cause = listing.stop;
		await stopStream(
			ctx,
			SUMMARY,
			{
				message:
					`Your Goodreads reading summary was not saved because the library list was not read in full (${listing.books.length} books read). ${cause?.message ?? ""}`.trim(),
				reason: "listing_incomplete",
			},
			cause ? !PERMANENT.has(cause.reason) : true,
		);
		return;
	}
	const summary = summarizeLibrary(listing.books, {
		listPages: listing.pages,
		listingComplete: true,
	});
	await ctx.emitRecord(
		SUMMARY,
		projectFields(
			SUMMARY,
			summary,
			ctx.requested.get(SUMMARY)?.fields,
		) as unknown as Record<string, unknown>,
	);
}

async function collectProfile(
	ctx: GoodreadsCollectContext,
	userId: string,
	get: (path: string, label: string) => Promise<FetchOutcome>,
): Promise<void> {
	const profilePage = await get(`/user/show/${userId}`, "your profile");
	const profile = profilePage.ok ? parseProfile(profilePage.body) : null;
	const settingsPage = await get("/user/edit", "your account settings");
	const settings = settingsPage.ok ? parseSettings(settingsPage.body) : null;
	// A page that did not answer this time (a challenge, sign-in, an outage)
	// stops the stream: a record with that half empty would replace a good
	// stored one. Only a page that answered and could not be read (a site
	// change, which a retry would meet again) leaves a partial record.
	const unanswered = [profilePage, settingsPage].find(
		(outcome) => !outcome.ok && outcome.reason !== "source_unreadable",
	);
	if (unanswered && !unanswered.ok) {
		await stopStream(ctx, PROFILE, unanswered);
		return;
	}
	if (!(profile || settings)) {
		const failure = [profilePage, settingsPage].find((outcome) => !outcome.ok);
		await stopStream(
			ctx,
			PROFILE,
			failure && !failure.ok
				? failure
				: {
						message:
							"Goodreads answered with profile and settings pages this connector does not recognise. Goodreads may have changed its site.",
						reason: "source_unreadable",
					},
		);
		return;
	}
	const record = {
		allow_followers: settings?.allow_followers ?? null,
		allow_nonfriend_review_comments:
			settings?.allow_nonfriend_review_comments ?? null,
		average_rating: profile?.average_rating ?? null,
		books_count: profile?.books_count ?? null,
		country: settings?.country ?? null,
		favorite_genres: settings?.favorite_genres ?? null,
		friends_count: profile?.friends_count ?? null,
		id: "account_profile",
		joined_on: profile?.joined_on ?? null,
		last_active: profile?.last_active ?? null,
		linked_sign_in: settings?.linked_sign_in ?? null,
		locale: settings?.locale ?? null,
		profile_visibility: settings?.profile_visibility ?? null,
		ratings_count: profile?.ratings_count ?? null,
		reviews_count: profile?.reviews_count ?? null,
		searchable_by_email: settings?.searchable_by_email ?? null,
		shelves_count: profile?.shelves_count ?? null,
		sources: {
			profile: profile ? "read" : "failed",
			settings: settings ? "read" : "failed",
		},
		tenure_months: tenureMonths(profile?.joined_on ?? null, new Date()),
	};
	await ctx.emitRecord(
		PROFILE,
		projectFields(
			PROFILE,
			record,
			ctx.requested.get(PROFILE)?.fields,
		) as unknown as Record<string, unknown>,
	);
	if (!(profile && settings)) {
		await ctx.progress?.(
			`Read your Goodreads account, but the ${profile ? "settings" : "profile"} page could not be read`,
			{ stream: PROFILE },
		);
	}
}
