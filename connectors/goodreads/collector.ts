// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Goodreads collection: the order of requests, what each stream is built
 * from, and what a run claims about completeness. Parsing is in parsers.ts
 * and summary.ts; the I/O (retry, WAF handling) is in fetcher.ts.
 *
 * Requests, one at a time, with a pause between them:
 *   1. /review/list            owner id, shelf sidebar, "All (N)" count
 *   2. /user/show/<id>         profile counts            (account_profile)
 *   3. /user/edit              settings                  (account_profile)
 *   4. /review/list/<id>?print=true&per_page=100&page=N  (books, usage_summary)
 *
 * The listing is complete only when it ended on a last page (or an empty
 * past-the-end page) AND the rows read equal the count Goodreads shows. A
 * first page with no rows while the count is above zero is drift, never an
 * empty library.
 */

import type { BrowserCollectContext } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { politeDelay } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { type FetchOutcome, type FetchPage, fetchHtml } from "./fetcher.ts";
import {
	parseListingPage,
	parseProfile,
	parseSettings,
	parseSidebar,
	tenureMonths,
	userIdFromHtml,
	userIdFromUrl,
} from "./parsers.ts";
import { summarizeLibrary } from "./summary.ts";
import type { BookRecord, ShelfRecord, SidebarInfo } from "./types.ts";

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

/** The keys each stream's schema requires: kept whatever consent selects. */
const REQUIRED_KEYS: Record<string, readonly string[]> = {
	[BOOKS]: ["id", "book_id"],
	[PROFILE]: ["id", "sources"],
	[SHELVES]: ["id", "name", "exclusive"],
	[SUMMARY]: ["id", "coverage"],
};

/**
 * Keep the fields consent selected, plus the keys the stream's schema
 * requires. All fields when none is named.
 */
export function projectFields<T extends { id: string }>(
	stream: string,
	record: T,
	fields: unknown,
): T {
	if (!Array.isArray(fields) || fields.length === 0) return record;
	const keep = new Set<string>([
		...(REQUIRED_KEYS[stream] ?? ["id"]),
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
	books: BookRecord[];
	complete: boolean;
	pages: number;
	stop: Stop | null;
}

export async function collectGoodreads(
	ctx: GoodreadsCollectContext,
): Promise<void> {
	const wants = (stream: string): boolean => ctx.requested.has(stream);
	const wantsListing = wants(BOOKS) || wants(SHELVES) || wants(SUMMARY);
	if (!(wantsListing || wants(PROFILE))) return;
	const streams = [BOOKS, SHELVES, PROFILE, SUMMARY].filter(wants);
	const stopAll = async (stop: Stop, only: string[] = streams) => {
		for (const stream of only) await stopStream(ctx, stream, stop);
	};
	let requests = 0;
	const get = async (path: string, label: string): Promise<FetchOutcome> => {
		if (requests > 0) await pace();
		requests += 1;
		return fetchHtml(ctx.page, path, label);
	};

	// 1. Who is signed in, and what the sidebar says about the library.
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
	const sidebar = parseSidebar(home.body, userId);
	const sidebarReadable = sidebar.allCount !== null;
	if (wantsListing && !sidebarReadable) {
		await stopAll(
			{
				message:
					"Goodreads showed your library page without a book count, so the list could not be checked for completeness. Goodreads may have changed its site.",
				reason: "source_unreadable",
			},
			[BOOKS, SHELVES, SUMMARY].filter(wants),
		);
	}

	// 2. The account profile, from two independent pages.
	if (wants(PROFILE)) {
		await collectProfile(ctx, userId, get);
	}

	// 3. The whole library listing, for books and for the summary.
	let listing: Listing | null = null;
	if ((wants(BOOKS) || wants(SUMMARY)) && sidebarReadable) {
		listing = await readListing(ctx, userId, sidebar.allCount ?? 0, get);
		if (wants(SUMMARY)) await finishSummary(ctx, listing);
		const undated = undatedInBoundedRun(ctx, listing);
		if (wants(BOOKS) && listing.stop) {
			await stopStream(ctx, BOOKS, listing.stop);
		} else if (undated > 0) {
			await stopStream(ctx, BOOKS, {
				message: `${undated} books in your Goodreads library have no readable date added, so they could not be placed inside the requested date range. Goodreads may have changed its site.`,
				reason: "source_unreadable",
			});
		}
		await ctx.progress?.(
			listing.complete
				? `Finished reading ${listing.books.length} Goodreads books`
				: `Stopped after reading ${listing.books.length} Goodreads books`,
			{
				count: listing.books.length,
				stream: wants(BOOKS) ? BOOKS : SUMMARY,
			},
		);
	}

	// 4. The shelves, checked against the whole library when it was read.
	if (wants(SHELVES) && sidebarReadable) {
		await finishShelves(ctx, sidebar, listing?.complete ? listing.books : null);
	}
}

/**
 * Why the sidebar's shelves cannot be shown to be all of the owner's
 * shelves, or null when they can. Every book is on exactly one exclusive
 * shelf, so the exclusive shelves' counts add up to "All (N)"; every shelf a
 * book in a complete listing names is in the sidebar; and the sidebar shows
 * no link to more shelves.
 */
export function shelfListProblem(
	sidebar: SidebarInfo,
	books: readonly BookRecord[] | null,
): Stop | null {
	if (sidebar.shelves.length === 0) {
		return {
			message:
				"Goodreads showed your library without any shelves, though every account has at least three. Goodreads may have changed its site.",
			reason: "source_unreadable",
		};
	}
	const partial = (detail: string): Stop => ({
		message: `Your Goodreads shelves were not saved because Goodreads showed only part of the list (${detail}).`,
		reason: "shelf_list_incomplete",
	});
	if (sidebar.continues) {
		return partial("the sidebar links to more shelves");
	}
	let exclusiveTotal = 0;
	for (const shelf of sidebar.shelves) {
		if (shelf.exclusive) exclusiveTotal += shelf.book_count ?? Number.NaN;
	}
	if (exclusiveTotal !== sidebar.allCount) {
		return partial(
			`the exclusive shelves hold ${Number.isNaN(exclusiveTotal) ? "an unknown number of" : exclusiveTotal} books, not ${sidebar.allCount}`,
		);
	}
	if (books) {
		const known = new Set(sidebar.shelves.map((shelf) => shelf.id));
		const missing = new Set<string>();
		for (const book of books) {
			for (const slug of book.shelves) if (!known.has(slug)) missing.add(slug);
		}
		if (missing.size > 0) {
			return partial(`${missing.size} shelves named on books are not in it`);
		}
	}
	return null;
}

async function finishShelves(
	ctx: GoodreadsCollectContext,
	sidebar: SidebarInfo,
	books: readonly BookRecord[] | null,
): Promise<void> {
	const problem = shelfListProblem(sidebar, books);
	if (problem) {
		await stopStream(ctx, SHELVES, problem);
		return;
	}
	for (const shelf of sidebar.shelves) {
		await ctx.emitRecord(
			SHELVES,
			projectFields<ShelfRecord>(
				SHELVES,
				shelf,
				ctx.requested.get(SHELVES)?.fields,
			) as unknown as Record<string, unknown>,
		);
	}
	await ctx.progress?.(`Read ${sidebar.shelves.length} Goodreads shelves`, {
		count: sidebar.shelves.length,
		stream: SHELVES,
	});
}

/**
 * In a run bounded by a date range, the runtime keeps a book only when its
 * `added_on` (the consent field) falls inside the range, so a book with no
 * date added is withheld without a word. Count them so the run says so.
 */
function undatedInBoundedRun(
	ctx: GoodreadsCollectContext,
	listing: Listing,
): number {
	if (!ctx.requested.get(BOOKS)?.time_range) return 0;
	return listing.books.filter((book) => book.added_on === null).length;
}

async function readListing(
	ctx: GoodreadsCollectContext,
	userId: string,
	expectedTotal: number,
	get: (path: string, label: string) => Promise<FetchOutcome>,
): Promise<Listing> {
	const emitBooks = ctx.requested.has(BOOKS);
	const fields = ctx.requested.get(BOOKS)?.fields;
	const seen = new Map<string, BookRecord>();
	let pages = 0;
	let endProven = false;
	let stop: Stop | null = null;
	let unreadableRows = 0;

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
			if (seen.has(row.id)) continue;
			seen.set(row.id, row);
			if (emitBooks) {
				await ctx.emitRecord(
					BOOKS,
					projectFields(BOOKS, row, fields) as unknown as Record<
						string,
						unknown
					>,
				);
			}
		}
		await ctx.progress?.(
			`Reading your Goodreads library: ${seen.size} of ${expectedTotal} books`,
			{
				count: seen.size,
				stream: emitBooks ? BOOKS : SUMMARY,
				total: expectedTotal,
			},
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
