// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure parsers for the Goodreads pages this connector reads. They take HTML
 * text and return plain data; they never touch the network or the browser.
 *
 * Pages: the print library list (`/review/list/<id>?print=true`), its
 * sidebar (the same URL without `print`), the public profile
 * (`/user/show/<id>`) and account settings (`/user/edit`).
 *
 * Dates arrive in several shapes ("Aug 27, 2023", "Feb 2022", "2019") and are
 * kept at the precision Goodreads printed: YYYY, YYYY-MM or YYYY-MM-DD.
 */

import { parseHTML } from "linkedom";
import type {
	AnnotatedBook,
	AnnotatedBooksPage,
	BookAuthor,
	ListingPage,
	PrintBookRecord,
	ProfileFacts,
	ReadingNote,
	ReadingNotesPage,
	ReadingSession,
	SettingsFacts,
	VisibilityChoice,
} from "./types.ts";

export const ORIGIN = "https://www.goodreads.com";

// ─── Module-scoped patterns (Biome useTopLevelRegex) ────────────────────────

const NO_MATCH_RE = /No matching items/i;
const USER_SHOW_RE = /\/user\/show\/(\d+)/;
const COMMA_RE = /,/g;
const CR_RE = /\r/g;
const FAVORITES_NAME_RE = /^favorites\[|\]$/g;
const WHITESPACE_RE = /\s+/g;
const MARKS_RE = /[‎‏]/g;
const DIGITS_RE = /(\d[\d,]*)/;
const DECIMAL_RE = /(\d+(?:\.\d+)?)/;
const REVIEW_ID_RE = /^review_(\d+)$/;
const BOOK_PATH_RE = /\/book\/show\/(\d+)/;
const AUTHOR_PATH_RE = /\/author\/show\/(\d+)/;
const LOADED_RE = /([\d,]+)\s+of\s+([\d,]+)\s+loaded/i;
const ALL_COUNT_RE = /^\s*All\s*\(([\d,]+)\)\s*$/i;
const FULL_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_CLASS_RE = /^date_(?:started|read)_(.+)$/;
const SESSION_PREFIX_RE = /^amzn1grreading_sessionv1/;
const HEX32_RE = /^[0-9a-f]{32}$/i;
const SESSION_ONCLICK_RE =
	/reading_session_id:\s*"(?:amzn1\.gr\.reading_session\.v1\.)?([0-9a-f-]{32,36})"/i;
const USER_PATH_RE = /\/(?:review\/list|user\/show)\/(\d+)/;
const MONTH_DAY_YEAR_RE = /^([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})$/;
const MONTH_YEAR_RE = /^([A-Za-z]+)\.?,?\s+(\d{4})$/;
const YEAR_RE = /^(\d{4})$/;
const ISO_FULL_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_MONTH_RE = /^(\d{4})-(\d{2})$/;
const RATINGS_RE = /([\d,]+)\s+ratings?\b/i;
const AVG_RE = /\((\d+(?:\.\d+)?)\s+avg\)/i;
const REVIEWS_RE = /([\d,]+)\s+reviews?\b/i;
const JOINED_RE = /Joined\s+in\s+([A-Za-z]+)\s+(\d{4})/i;
const LAST_ACTIVE_RE = /last\s+active\s+([^,]+?)\s*$/i;
const PAREN_COUNT_RE = /\(([\d,]+)\)/;
const NEWLINE_RUNS_RE = /\n{3,}/g;
const TRAILING_SPACE_RE = /[ \t]+\n/g;
const NONE_NOTE_RE = /^(?:none|notes are private!?)$/i;
const NOT_OWNED_RE = /^(?:0|no|false|not owned)$/i;
const EDIT_BRACKET_RE = /\s*\[edit\]\s*/gi;
const NOTES_PATH_RE =
	/^(?:https:\/\/www\.goodreads\.com)?(\/notes\/\d+[^/?#]*\/\d+[^/?#]*)/;
/** An annotation pair id, decoded: `<highlight id>|-0-|<note id>`, either side may be empty. */
const PAIR_SEPARATOR_RE = /\|-\d+-\|/;
const PERCENT_RE = /^(\d{1,3})%$/;

const MONTHS: Record<string, number> = {
	jan: 1,
	january: 1,
	feb: 2,
	february: 2,
	mar: 3,
	march: 3,
	apr: 4,
	april: 4,
	may: 5,
	jun: 6,
	june: 6,
	jul: 7,
	july: 7,
	aug: 8,
	august: 8,
	sep: 9,
	sept: 9,
	september: 9,
	oct: 10,
	october: 10,
	nov: 11,
	november: 11,
	dec: 12,
	december: 12,
};

// A minimal view of the DOM nodes linkedom hands back. Typed here so the
// parsers do not depend on the DOM lib being in the compile target.
interface Nd {
	childNodes: ArrayLike<Nd>;
	nodeType: number;
	textContent: string | null;
}
interface El extends Nd {
	children: ArrayLike<El>;
	classList: { contains(name: string): boolean };
	cloneNode(deep: boolean): El;
	closest(selector: string): El | null;
	getAttribute(name: string): string | null;
	hasAttribute(name: string): boolean;
	nextElementSibling: El | null;
	querySelector(selector: string): El | null;
	querySelectorAll(selector: string): ArrayLike<El>;
	remove(): void;
	tagName: string;
}
interface Doc {
	body: El | null;
	querySelector(selector: string): El | null;
	querySelectorAll(selector: string): ArrayLike<El>;
}

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

function parse(html: string): Doc {
	return parseHTML(html).document as unknown as Doc;
}

function all(root: Doc | El, selector: string): El[] {
	return Array.from(root.querySelectorAll(selector));
}

/** Collapse whitespace and drop the left-to-right marks Goodreads adds to counts. */
function squash(text: string | null | undefined): string {
	return (text ?? "").replace(MARKS_RE, "").replace(WHITESPACE_RE, " ").trim();
}

function textOf(element: El | null): string {
	return element ? squash(element.textContent) : "";
}

function orNull(text: string): string | null {
	return text === "" ? null : text;
}

function toInt(text: string | null | undefined): number | null {
	const match = DIGITS_RE.exec(text ?? "");
	return match
		? Number.parseInt((match[1] ?? "").replace(COMMA_RE, ""), 10)
		: null;
}

function toDecimal(text: string | null | undefined): number | null {
	const match = DECIMAL_RE.exec(text ?? "");
	return match ? Number.parseFloat(match[1] ?? "") : null;
}

/**
 * Text of a node with `<br>` turned into newlines and every other tag
 * dropped. Used for the review and the private notes, where the line breaks
 * carry meaning.
 */
function textWithBreaks(node: Nd): string {
	let out = "";
	for (const child of Array.from(node.childNodes)) {
		if (child.nodeType === TEXT_NODE) {
			out += child.textContent ?? "";
		} else if (child.nodeType === ELEMENT_NODE) {
			const element = child as El;
			out +=
				element.tagName.toLowerCase() === "br" ? "\n" : textWithBreaks(element);
		}
	}
	return out;
}

function tidyMultiline(text: string): string {
	return text
		.replace(MARKS_RE, "")
		.replace(CR_RE, "")
		.replace(TRAILING_SPACE_RE, "\n")
		.replace(NEWLINE_RUNS_RE, "\n\n")
		.trim();
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/**
 * "Aug 27, 2023" -> "2023-08-27", "February 2022" -> "2022-02", "2019" ->
 * "2019". Anything else ("unknown", "not set", empty) -> null. Already-ISO
 * input passes through so the function is safe to apply twice.
 */
export function normalizePartialDate(
	text: string | null | undefined,
): string | null {
	const value = squash(text);
	if (value === "") return null;
	const iso = ISO_FULL_RE.exec(value);
	if (iso) return value;
	if (ISO_MONTH_RE.test(value)) return value;
	const full = MONTH_DAY_YEAR_RE.exec(value);
	if (full) {
		const month = MONTHS[(full[1] ?? "").toLowerCase()];
		const day = Number.parseInt(full[2] ?? "", 10);
		if (month && day >= 1 && day <= 31) {
			return `${full[3]}-${pad2(month)}-${pad2(day)}`;
		}
		return null;
	}
	const monthYear = MONTH_YEAR_RE.exec(value);
	if (monthYear) {
		const month = MONTHS[(monthYear[1] ?? "").toLowerCase()];
		return month ? `${monthYear[2]}-${pad2(month)}` : null;
	}
	const year = YEAR_RE.exec(value);
	return year ? (year[1] ?? null) : null;
}

// ─── Library list ────────────────────────────────────────────────────────

function cell(row: El, name: string): El | null {
	return row.querySelector(`td.field.${name} > div.value`);
}

/** A query parameter of a Goodreads link, whether it is absolute or relative. */
function queryParam(href: string, name: string): string | null {
	try {
		return new URL(href, ORIGIN).searchParams.get(name);
	} catch {
		return null;
	}
}

/** Format 32 hex digits as a lowercase UUID; anything else is not a session id. */
function formatUuid(raw: string): string | null {
	const hex = raw.replace(/-/g, "").toLowerCase();
	if (!HEX32_RE.test(hex)) return null;
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function sessionKeyOf(editable: El): string | null {
	const classes = (editable.getAttribute("class") ?? "").split(WHITESPACE_RE);
	for (const name of classes) {
		const match = DATE_CLASS_RE.exec(name);
		if (match) return match[1] ?? null;
	}
	return null;
}

function sessionIdOf(editable: El, key: string): string | null {
	const fromKey = formatUuid(key.replace(SESSION_PREFIX_RE, ""));
	if (fromKey) return fromKey;
	for (const link of all(editable, "a[onclick]")) {
		const match = SESSION_ONCLICK_RE.exec(link.getAttribute("onclick") ?? "");
		if (match) return formatUuid(match[1] ?? "");
	}
	return null;
}

interface DateEntry {
	date: string | null;
	key: string;
	sessionId: string | null;
}

/** One entry per reading session in a date_started or date_read cell. */
function dateEntries(value: El | null, valueClass: string): DateEntry[] {
	if (!value) return [];
	const entries: DateEntry[] = [];
	let unsaved = 0;
	for (const editable of all(value, "div.editable_date")) {
		const rawKey = sessionKeyOf(editable);
		if (rawKey === null) continue;
		const isNew = rawKey === "new";
		const key = isNew ? `new:${unsaved++}` : rawKey;
		entries.push({
			date: normalizePartialDate(textOf(editable.querySelector(valueClass))),
			key,
			sessionId: isNew ? null : sessionIdOf(editable, rawKey),
		});
	}
	return entries;
}

/** Pair the started and finished cells by session key; drop empty sessions. */
function readingSessions(row: El): ReadingSession[] {
	const started = dateEntries(
		cell(row, "date_started"),
		"span.date_started_value",
	);
	const finished = dateEntries(cell(row, "date_read"), "span.date_read_value");
	const order: string[] = [];
	const byKey = new Map<string, ReadingSession>();
	const touch = (entry: DateEntry): ReadingSession => {
		let session = byKey.get(entry.key);
		if (!session) {
			session = {
				finished_on: null,
				session_id: entry.sessionId,
				started_on: null,
			};
			byKey.set(entry.key, session);
			order.push(entry.key);
		}
		return session;
	};
	for (const entry of started) touch(entry).started_on = entry.date;
	for (const entry of finished) touch(entry).finished_on = entry.date;
	const sessions: ReadingSession[] = [];
	for (const key of order) {
		const session = byKey.get(key);
		if (session && (session.started_on || session.finished_on)) {
			sessions.push(session);
		}
	}
	return sessions;
}

/** A partial date when it names a whole day, else null: the filterable form. */
function fullDay(date: string | null): string | null {
	return date !== null && FULL_DAY_RE.test(date) ? date : null;
}

function latest(values: (string | null)[]): string | null {
	let best: string | null = null;
	for (const value of values) {
		if (value && (best === null || value > best)) best = value;
	}
	return best;
}

function parseAuthors(value: El | null): BookAuthor[] {
	if (!value) return [];
	const authors: BookAuthor[] = [];
	for (const link of all(value, 'a[href*="/author/show/"]')) {
		const name = textOf(link);
		if (name === "") continue;
		const marker = link.nextElementSibling;
		authors.push({
			author_id:
				AUTHOR_PATH_RE.exec(link.getAttribute("href") ?? "")?.[1] ?? null,
			is_goodreads_author:
				marker !== null &&
				(marker.getAttribute("title") ?? "")
					.toLowerCase()
					.includes("goodreads author"),
			name,
		});
	}
	return authors;
}

function parseRating(value: El | null): number | null {
	if (!value) return null;
	const stars = value.querySelector(".stars[data-rating]");
	if (stars) {
		const rating = Math.round(
			Number.parseFloat(stars.getAttribute("data-rating") ?? "0"),
		);
		return rating >= 1 && rating <= 5 ? rating : null;
	}
	// Another member's list prints static stars instead.
	const full = all(value, ".readOnlyStar.full").length;
	return full >= 1 && full <= 5 ? full : null;
}

interface ShelfLink {
	exclusive: boolean;
	slug: string;
}

function shelfLinks(row: El): ShelfLink[] {
	const links: ShelfLink[] = [];
	for (const link of all(row, "td.field.shelves a.shelfLink")) {
		const href = link.getAttribute("href") ?? "";
		const shelf = queryParam(href, "shelf");
		const tag = queryParam(href, "tag");
		const slug = shelf ?? tag ?? textOf(link);
		if (slug !== "") links.push({ exclusive: shelf !== null, slug });
	}
	return links;
}

function parseReview(row: El): string | null {
	const value = cell(row, "review");
	if (!value) return null;
	// The full text sits in a hidden span; a short review has only the visible one.
	const full =
		value.querySelector('span[id^="freeTextreview"]') ??
		value.querySelector('span[id^="freeTextContainerreview"]');
	if (!full) return null;
	return orNull(tidyMultiline(textWithBreaks(full)));
}

function parseNotes(row: El): string | null {
	const value = cell(row, "notes");
	if (!value) return null;
	const copy = value.cloneNode(true);
	for (const link of all(copy, "a.floatingBoxLink")) link.remove();
	const text = tidyMultiline(textWithBreaks(copy)).replace(EDIT_BRACKET_RE, "");
	const trimmed = text.trim();
	return trimmed === "" || NONE_NOTE_RE.test(trimmed) ? null : trimmed;
}

function parseOwned(row: El): boolean | null {
	const value = cell(row, "owned");
	if (!value) return null;
	const text = textOf(value);
	return text !== "" && !NOT_OWNED_RE.test(text);
}

function parseFormat(row: El): string | null {
	const value = cell(row, "format");
	if (!value) return null;
	const copy = value.cloneNode(true);
	for (const link of all(copy, "a")) link.remove();
	return orNull(textOf(copy).replace(EDIT_BRACKET_RE, " ").trim());
}

function parseAddedOn(row: El): string | null {
	const value = cell(row, "date_added");
	if (!value) return null;
	const titled = value.querySelector("span[title]");
	return (
		normalizePartialDate(titled?.getAttribute("title")) ??
		normalizePartialDate(textOf(value))
	);
}

function publicationDate(row: El, name: string): string | null {
	return normalizePartialDate(textOf(cell(row, name)));
}

function linkCount(row: El, name: string): number | null {
	return toInt(textOf(cell(row, name)));
}

/** One `tr.review` row -> a record, or null when it lacks a review id or a book id. */
export function parseBookRow(row: El): PrintBookRecord | null {
	const id = REVIEW_ID_RE.exec(row.getAttribute("id") ?? "")?.[1];
	if (!id) return null;
	const titleLink =
		row.querySelector("td.field.title a[href]") ??
		row.querySelector('td.field.cover a[href*="/book/show/"]');
	const bookPath = titleLink?.getAttribute("href") ?? null;
	const bookId =
		BOOK_PATH_RE.exec(bookPath ?? "")?.[1] ??
		row
			.querySelector(".tooltipTrigger[data-resource-id]")
			?.getAttribute("data-resource-id") ??
		null;
	if (!bookId) return null;

	const authors = parseAuthors(cell(row, "author"));
	const links = shelfLinks(row);
	const exclusive = links.find((link) => link.exclusive)?.slug ?? null;
	const shelves = [
		...new Set([
			...links.filter((link) => link.exclusive).map((link) => link.slug),
			...links.filter((link) => !link.exclusive).map((link) => link.slug),
		]),
	];
	const reviewText = parseReview(row);
	const sessions = readingSessions(row);
	const finishedOn = latest(sessions.map((session) => session.finished_on));
	const startedOn = latest(sessions.map((session) => session.started_on));

	return {
		added_on: parseAddedOn(row),
		asin: orNull(textOf(cell(row, "asin"))),
		author: authors[0]?.name ?? null,
		authors,
		average_rating: toDecimal(textOf(cell(row, "avg_rating"))),
		book_id: bookId,
		book_url: bookPath?.startsWith("/book/show/")
			? `${ORIGIN}${bookPath}`
			: null,
		comments_count: linkCount(row, "comments"),
		cover_url:
			row.querySelector("td.field.cover img[src]")?.getAttribute("src") ?? null,
		edition_publication_date: publicationDate(row, "date_pub_edition"),
		exclusive_shelf: exclusive,
		finished_date: fullDay(finishedOn),
		finished_on: finishedOn,
		format: parseFormat(row),
		has_review: reviewText !== null,
		id,
		isbn: orNull(textOf(cell(row, "isbn"))),
		isbn13: orNull(textOf(cell(row, "isbn13"))),
		likes_count: linkCount(row, "votes"),
		// Goodreads prints "0 pp" for an edition with no page count.
		num_pages: toInt(textOf(cell(row, "num_pages"))) || null,
		original_publication_date: publicationDate(row, "date_pub"),
		owned: parseOwned(row),
		position: toInt(textOf(cell(row, "position"))),
		private_notes: parseNotes(row),
		rating: parseRating(cell(row, "rating")),
		ratings_count: toInt(textOf(cell(row, "num_ratings"))),
		read_count: toInt(textOf(cell(row, "read_count"))),
		reading_sessions: sessions,
		review_text: reviewText,
		shelves,
		started_date: fullDay(startedOn),
		started_on: startedOn,
		title:
			orNull(squash(titleLink?.getAttribute("title"))) ??
			orNull(textOf(titleLink)),
	};
}

/**
 * One page of the print library list. `recognised` is false for any page
 * without the library table, so a changed or foreign page is never mistaken
 * for an empty library.
 */
export function parseListingPage(html: string): ListingPage {
	const doc = parse(html);
	const body = doc.querySelector("tbody#booksBody");
	const rows: PrintBookRecord[] = [];
	let unreadableRows = 0;
	if (body) {
		for (const row of all(body, "tr.review")) {
			const record = parseBookRow(row);
			if (record) rows.push(record);
			else unreadableRows += 1;
		}
	}
	const status = LOADED_RE.exec(textOf(doc.querySelector("#infiniteStatus")));
	return {
		hasNextPage: doc.querySelector("#reviewPagination a.next_page") !== null,
		loaded: status ? toInt(status[1]) : null,
		noMatchingItems: NO_MATCH_RE.test(textOf(doc.querySelector(".nocontent"))),
		recognised: body !== null,
		rows,
		total: status ? toInt(status[2]) : null,
		unreadableRows,
	};
}

// ─── Sidebar and identity ────────────────────────────────────────────────

/** The owner's id from a `/review/list/<id>-<slug>` or `/user/show/<id>` URL or path. */
export function userIdFromUrl(url: string): string | null {
	return USER_PATH_RE.exec(url)?.[1] ?? null;
}

/**
 * The owner's id from a signed-in page: the header's profile link, else a
 * link to the owner's own list. Null for a signed-out page.
 */
export function userIdFromHtml(html: string): string | null {
	const doc = parse(html);
	if (doc.querySelector('a[href*="/user/sign_out"]') === null) return null;
	for (const link of all(doc, 'a[href*="/user/show/"]')) {
		const id = USER_SHOW_RE.exec(link.getAttribute("href") ?? "")?.[1];
		if (id) return id;
	}
	return null;
}

/** The "All (N)" book count from the non-print library page's sidebar. */
export function parseAllCount(html: string): number | null {
	const doc = parse(html);
	for (const link of [
		doc.querySelector("a.selectedShelf"),
		...all(doc, 'a[href*="shelf=%23ALL%23"]'),
	]) {
		const match = ALL_COUNT_RE.exec(textOf(link));
		if (match) return toInt(match[1]);
	}
	return null;
}

// ─── Profile ────────────────────────────────────────────────────────────

export function parseProfile(html: string): ProfileFacts | null {
	const doc = parse(html);
	const stats = textOf(doc.querySelector(".profilePageUserStatsInfo"));
	let activity = "";
	for (const title of all(doc, ".infoBoxRowTitle")) {
		if (textOf(title).toLowerCase() === "activity") {
			activity = textOf(title.nextElementSibling);
		}
	}
	const joined = JOINED_RE.exec(activity);
	if (stats === "" && !joined) return null;

	const month = joined ? MONTHS[(joined[1] ?? "").toLowerCase()] : undefined;
	const friends = PAREN_COUNT_RE.exec(
		textOf(doc.querySelector('h2.brownBackground a[href="/friend"]')),
	);
	const shelfLinks = all(doc, "a.userShowPageShelfListItem");
	let booksCount: number | null = null;
	for (const link of shelfLinks) {
		const exclusive = queryParam(link.getAttribute("href") ?? "", "shelf");
		const count = PAREN_COUNT_RE.exec(textOf(link));
		if (exclusive !== null && count) {
			booksCount = (booksCount ?? 0) + (toInt(count[1]) ?? 0);
		}
	}
	return {
		average_rating: toDecimal(AVG_RE.exec(stats)?.[1]),
		books_count: booksCount,
		friends_count: friends ? toInt(friends[1]) : null,
		joined_on: joined && month ? `${joined[2]}-${pad2(month)}` : null,
		last_active: orNull(LAST_ACTIVE_RE.exec(activity)?.[1] ?? ""),
		ratings_count: toInt(RATINGS_RE.exec(stats)?.[1]),
		reviews_count: toInt(REVIEWS_RE.exec(stats)?.[1]),
		shelves_count: shelfLinks.length > 0 ? shelfLinks.length : null,
	};
}

/** Whole months from a YYYY-MM to the month of `now`; null when `joined` is null. */
export function tenureMonths(joined: string | null, now: Date): number | null {
	const match = ISO_MONTH_RE.exec(joined ?? "");
	if (!match) return null;
	const months =
		(now.getUTCFullYear() - Number.parseInt(match[1] ?? "", 10)) * 12 +
		(now.getUTCMonth() + 1 - Number.parseInt(match[2] ?? "", 10));
	return months >= 0 ? months : null;
}

// ─── Account settings ────────────────────────────────────────────────────

const VISIBILITY: Record<string, VisibilityChoice> = {
	E: "everyone",
	M: "members",
	P: "friends",
};

function selectedValue(doc: Doc, name: string): string | null {
	// Settings print two country selects; take the first one with a real choice.
	for (const option of all(doc, `select[name="${name}"] option[selected]`)) {
		const value = (option.getAttribute("value") ?? "").trim();
		if (value !== "") return value;
	}
	return null;
}

/** A checkbox's state, read from its attributes (inline scripts also say "checked"). */
function checkbox(doc: Doc, name: string): boolean | null {
	const box = doc.querySelector(`input[type="checkbox"][name="${name}"]`);
	if (!box) return null;
	if (box.hasAttribute("disabled")) return null;
	return box.hasAttribute("checked");
}

function linkedProvider(page: string, provider: string): boolean | null {
	if (
		new RegExp(`Your ${provider} account is linked`, "i").test(page) ||
		new RegExp(`Disconnect ${provider} Account`, "i").test(page)
	) {
		return true;
	}
	return new RegExp(`Connect ${provider} Account`, "i").test(page)
		? false
		: null;
}

export function parseSettings(html: string): SettingsFacts | null {
	const doc = parse(html);
	const radios = all(
		doc,
		'input[type="radio"][name="user_preference[visibility]"]',
	);
	const country = doc.querySelector('select[name="user[country_code]"]');
	if (radios.length === 0 && country === null) return null;

	const checked = radios.find((radio) => radio.hasAttribute("checked"));
	const inputValues = all(doc, "input[value]")
		.map((input) => input.getAttribute("value") ?? "")
		.join(" ");
	const page = `${squash(doc.body?.textContent)} ${inputValues}`;
	const favorites = all(doc, 'input[type="checkbox"][name^="favorites["]')
		.filter((box) => box.hasAttribute("checked"))
		.map(
			(box) =>
				box.getAttribute("data-genre") ??
				(box.getAttribute("name") ?? "").replace(FAVORITES_NAME_RE, ""),
		)
		.filter((genre) => genre !== "");
	return {
		allow_followers: checkbox(doc, "user_preference[allow_followers]"),
		allow_nonfriend_review_comments: checkbox(
			doc,
			"user[allow_nonfriend_review_comments]",
		),
		country: selectedValue(doc, "user[country_code]"),
		favorite_genres: favorites,
		linked_sign_in: {
			amazon: linkedProvider(page, "Amazon"),
			apple: linkedProvider(page, "Apple"),
			google: linkedProvider(page, "Google"),
		},
		locale: selectedValue(doc, "user[locale]"),
		profile_visibility: checked
			? (VISIBILITY[checked.getAttribute("value") ?? ""] ?? null)
			: null,
		searchable_by_email: checkbox(doc, "user[searchable_by_email]"),
	};
}

// ─── Kindle notes and highlights ─────────────────────────────────────────

const stringOrNull = (value: unknown): string | null =>
	typeof value === "string" && squash(value) !== "" ? squash(value) : null;

/**
 * One page of the owner's Kindle notes list, the JSON `/notes/<id>/load_more`
 * answers. Null for any other shape, and for a book without a notes page
 * link, so a changed answer is never read as a short list.
 */
export function parseAnnotatedBooksPage(
	body: string,
): AnnotatedBooksPage | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	const { annotated_books_collection: items, next_token: nextToken } =
		parsed as Record<string, unknown>;
	if (!Array.isArray(items)) return null;
	if (!(nextToken === null || typeof nextToken === "string")) return null;
	const books: AnnotatedBook[] = [];
	for (const item of items) {
		if (typeof item !== "object" || item === null) return null;
		const fields = item as Record<string, unknown>;
		const url = fields.readingNotesUrl;
		const path =
			typeof url === "string" ? NOTES_PATH_RE.exec(url)?.[1] : undefined;
		if (!path) return null;
		books.push({
			asin: stringOrNull(fields.asin),
			author: stringOrNull(fields.authorName),
			notesPath: path,
			title: stringOrNull(fields.title),
		});
	}
	return { books, nextToken: nextToken === "" ? null : nextToken };
}

const flagAttr = (element: El, name: string): boolean | null => {
	const value = element.getAttribute(name);
	if (value === "true") return true;
	if (value === "false") return false;
	return null;
};

const multilineOrNull = (element: El | null): string | null =>
	element ? orNull(tidyMultiline(textWithBreaks(element))) : null;

/**
 * One item of a notes page, or null when it cannot be read as one. A
 * highlight may come with no text: Goodreads shows an empty card for a
 * highlight whose text Amazon does not share (live 2026-11-04). It is kept,
 * with null text, when the card has its usual layout.
 */
function parseReadingNote(item: El, bookId: string): ReadingNote | null {
	if (item.getAttribute("data-book-id") !== bookId) return null;
	if (!item.querySelector(".noteHighlightTextContainer")) return null;
	let pair: string;
	try {
		pair = decodeURIComponent(
			item.getAttribute("data-annotation-pair-id") ?? "",
		);
	} catch {
		return null;
	}
	const halves = pair.split(PAIR_SEPARATOR_RE);
	if (halves.length !== 2) return null;
	const highlightId = orNull(halves[0] ?? "");
	const noteId = orNull(halves[1] ?? "");
	const highlightText = multilineOrNull(
		item.querySelector(".noteHighlightTextContainer__highlightText"),
	);
	const noteText = multilineOrNull(item.querySelector(".js-noteText"));
	const hasNote = flagAttr(item, "data-has-note");
	if (
		!(highlightId || noteId) ||
		!(highlightText || noteText || highlightId) ||
		(hasNote === true) !== (noteText !== null)
	) {
		return null;
	}
	const location = orNull(
		textOf(item.querySelector(".noteHighlightContainer__location")),
	);
	const percent = PERCENT_RE.exec(location ?? "")?.[1];
	return {
		highlight_id: highlightId,
		highlight_text: highlightText,
		location,
		location_percent: percent === undefined ? null : Number(percent),
		note_id: noteId,
		note_text: noteText,
		shared: flagAttr(item, "data-visible"),
		spoiler: flagAttr(item, "data-is-spoiler"),
	};
}

/**
 * One book's notes page (`/notes/<book id>/<owner id>`): every highlight
 * and note of the book, in the page's order, with the banner's count of
 * them. `recognised` is false for a page without the notes column or the
 * banner, so a changed page is never read as a book without notes.
 */
export function parseReadingNotesPage(html: string): ReadingNotesPage {
	const doc = parse(html);
	const banner = doc.querySelector("#readingNotesBanner");
	const column = doc.querySelector("#allHighlightsAndNotes");
	const bookId = orNull(squash(banner?.getAttribute("data-book-id")));
	const details = doc.querySelector(".readingNotesBookDetailsContainer");
	const notes: ReadingNote[] = [];
	let unreadable = 0;
	if (column && bookId) {
		for (const item of all(column, ".js-readingNote")) {
			const note = parseReadingNote(item, bookId);
			if (note) notes.push(note);
			else unreadable += 1;
		}
	}
	const total = banner?.getAttribute("data-total-count");
	return {
		author: details
			? orNull(textOf(details.querySelector('a[href*="/author/show/"]')))
			: null,
		bookId,
		bookTitle: details
			? orNull(textOf(details.querySelector('a[href*="/book/show/"]')))
			: null,
		notes,
		recognised: Boolean(banner && column && bookId),
		total: total === null || total === undefined ? null : toInt(total),
		unreadable,
	};
}
