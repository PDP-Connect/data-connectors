// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure parsers for the Mountain Project connector: the two CSV exports
 * (`/user/<id>/<slug>/tick-export`, `/user/<id>/<slug>/todo-export`), the
 * owner's profile page, and the session config every page carries
 * (`window.ap.config`). No browser calls; index.ts fetches the bytes.
 */

import { parseHTML } from "linkedom";
import type {
	ProfileRecord,
	RouteFields,
	SavedRouteRecord,
	TickRecord,
} from "./types.ts";

export const ORIGIN = "https://www.mountainproject.com";

const ROUTE_URL_RE =
	/^https:\/\/www\.mountainproject\.com\/route\/(\d{1,12})(?:\/[^\s?#]*)?$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const INTEGER_RE = /^-?\d+$/;
const NUMBER_RE = /^-?\d+(?:\.\d+)?$/;
// C0 controls except tab and newline; DEL; C1 controls. Carriage returns are
// folded into newlines first (LINE_BREAK_RE), so none is left for this.
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point.
const CONTROL_RE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;
const LINE_BREAK_RE = /\r\n?/g;
const USER_PATH_RE = /^\/user\/(\d{1,12})\/([^/?#]+)\/?$/;
const COUNT_RE = /(\d[\d,]*)/;
const MEMBER_SINCE_RE = /^([A-Z][a-z]{2})[a-z]*\.?\s+(\d{1,2}),\s+(\d{4})$/;
const CONFIG_LOGGED_IN_RE = /['"]isLoggedIn['"]\s*:\s*(\d+)/;
const CONFIG_USER_ID_RE = /['"]userId['"]\s*:\s*['"]?(\d{1,12})['"]?\s*,/;
const WHITESPACE_RE = /\s+/g;

const MONTHS: Record<string, string> = {
	Jan: "01",
	Feb: "02",
	Mar: "03",
	Apr: "04",
	May: "05",
	Jun: "06",
	Jul: "07",
	Aug: "08",
	Sep: "09",
	Oct: "10",
	Nov: "11",
	Dec: "12",
};

/** The columns each export must carry. Extra columns are ignored. */
export const TICK_COLUMNS = [
	"Date",
	"Route",
	"Rating",
	"Notes",
	"URL",
	"Pitches",
	"Location",
	"Avg Stars",
	"Your Stars",
	"Style",
	"Lead Style",
	"Route Type",
	"Your Rating",
	"Length",
	"Rating Code",
] as const;

export const TODO_COLUMNS = [
	"Route",
	"Rating",
	"URL",
	"Pitches",
	"Location",
	"Avg Stars",
	"Your Stars",
	"Route Type",
	"Your Rating",
	"Length",
	"Rating Code",
] as const;

// ─── CSV ────────────────────────────────────────────────────────────────

/**
 * RFC 4180 CSV: quoted fields, doubled quotes, CR/LF/CRLF line ends, and line
 * breaks inside quoted fields (a tick's notes can span lines). A leading BOM
 * is dropped. Throws on an unterminated quote, which means a truncated body.
 */
export function parseCsv(text: string): string[][] {
	const source = text.startsWith("﻿") ? text.slice(1) : text;
	const rows: string[][] = [];
	let row: string[] = [];
	let field = "";
	let quoted = false;
	let fieldStarted = false;
	for (let i = 0; i < source.length; i += 1) {
		const char = source[i];
		if (quoted) {
			if (char === '"') {
				if (source[i + 1] === '"') {
					field += '"';
					i += 1;
				} else {
					quoted = false;
				}
			} else {
				field += char;
			}
			continue;
		}
		if (char === '"' && !fieldStarted) {
			quoted = true;
			fieldStarted = true;
		} else if (char === ",") {
			row.push(field);
			field = "";
			fieldStarted = false;
		} else if (char === "\r" || char === "\n") {
			if (char === "\r" && source[i + 1] === "\n") i += 1;
			row.push(field);
			rows.push(row);
			row = [];
			field = "";
			fieldStarted = false;
		} else {
			field += char;
			fieldStarted = true;
		}
	}
	if (quoted) {
		throw new Error("unterminated quoted field");
	}
	if (fieldStarted || row.length > 0) {
		row.push(field);
		rows.push(row);
	}
	// Blank lines carry no row.
	return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

export type CsvTable =
	| { ok: true; rows: Array<Record<string, string>> }
	| { ok: false; message: string };

/**
 * Parse an export into rows keyed by header name. An empty body is an empty
 * table (the export of an account with nothing in it). A header without one
 * of the required columns, or a body that is not CSV, fails.
 */
export function parseExportTable(
	text: string,
	required: readonly string[],
): CsvTable {
	let table: string[][];
	try {
		table = parseCsv(text);
	} catch (error) {
		return {
			ok: false,
			message: `The export is not readable CSV (${error instanceof Error ? error.message : String(error)}).`,
		};
	}
	if (table.length === 0) {
		return { ok: true, rows: [] };
	}
	const header = (table[0] ?? []).map((name) => name.trim());
	const missing = required.filter((name) => !header.includes(name));
	if (missing.length > 0) {
		return {
			ok: false,
			message: `The export header lacks ${missing.join(", ")}.`,
		};
	}
	const rows = table.slice(1).map((cells) => {
		const row: Record<string, string> = {};
		header.forEach((name, index) => {
			row[name] = cells[index] ?? "";
		});
		return row;
	});
	return { ok: true, rows };
}

// ─── Field helpers ──────────────────────────────────────────────────────

/**
 * Printable text, trimmed, or null when nothing is left. Line breaks inside a
 * field (a tick's notes) come out of the export as CRLF; they are folded to
 * LF so the record does not depend on which line ending the site wrote.
 */
export function cleanText(value: string | undefined): string | null {
	if (value === undefined) return null;
	const text = value
		.replace(LINE_BREAK_RE, "\n")
		.replace(CONTROL_RE, "")
		.trim();
	return text === "" ? null : text;
}

function integerOrNull(value: string | undefined): number | null {
	const text = cleanText(value);
	if (text === null || !INTEGER_RE.test(text)) return null;
	const n = Number(text);
	return Number.isSafeInteger(n) ? n : null;
}

function numberOrNull(value: string | undefined): number | null {
	const text = cleanText(value);
	if (text === null || !NUMBER_RE.test(text)) return null;
	return Number(text);
}

/** "Your Stars" is -1 when the owner gave no stars. */
function starsOrNull(value: string | undefined): number | null {
	const n = numberOrNull(value);
	return n === null || n < 0 ? null : n;
}

function splitList(value: string | undefined, separator: string): string[] {
	const text = cleanText(value);
	if (text === null) return [];
	return text
		.split(separator)
		.map((part) => part.trim())
		.filter((part) => part !== "");
}

function validDate(value: string | undefined): string | null {
	const text = cleanText(value);
	if (text === null) return null;
	const match = DATE_RE.exec(text);
	if (!match) return null;
	const [, y, m, d] = match;
	const date = new Date(`${y}-${m}-${d}T00:00:00Z`);
	return !Number.isNaN(date.getTime()) &&
		date.toISOString().slice(0, 10) === text
		? text
		: null;
}

/** The route id from a Mountain Project route URL, or null. */
export function routeIdFromUrl(value: string | undefined): string | null {
	const text = cleanText(value);
	if (text === null) return null;
	return ROUTE_URL_RE.exec(text)?.[1] ?? null;
}

function routeFields(row: Record<string, string>): RouteFields | null {
	const routeUrl = cleanText(row.URL);
	const routeId = routeIdFromUrl(row.URL);
	const routeName = cleanText(row.Route);
	if (routeUrl === null || routeId === null || routeName === null) {
		return null;
	}
	return {
		route_id: routeId,
		route_name: routeName,
		route_url: routeUrl,
		rating: cleanText(row.Rating),
		rating_code: integerOrNull(row["Rating Code"]),
		location: splitList(row.Location, ">"),
		avg_stars: starsOrNull(row["Avg Stars"]),
		your_stars: starsOrNull(row["Your Stars"]),
		route_type: splitList(row["Route Type"], ","),
		your_rating: cleanText(row["Your Rating"]),
		length_ft: integerOrNull(row.Length),
	};
}

// ─── Ticks ──────────────────────────────────────────────────────────────

export interface BuiltRecords<T> {
	records: T[];
	/** Rows with no usable route URL, route name or date. */
	unreadable: number;
}

/**
 * One record per tick-export row. The export carries no tick id, so a tick is
 * keyed by route, day and its position among that route's ticks on that day
 * in export order (`<route_id>:<date>:<n>`, n from 1). The export lists the
 * newest tick first, so two ticks of the same route on the same day swap or
 * shift keys when one is added or deleted; that is the limit of what the
 * export identifies, and the fingerprint gate in index.ts re-emits the rows
 * whose content moved.
 */
export function buildTickRecords(
	rows: ReadonlyArray<Record<string, string>>,
): BuiltRecords<TickRecord> {
	const seen = new Map<string, number>();
	const records: TickRecord[] = [];
	let unreadable = 0;
	for (const row of rows) {
		const route = routeFields(row);
		const date = validDate(row.Date);
		if (route === null || date === null) {
			unreadable += 1;
			continue;
		}
		const base = `${route.route_id}:${date}`;
		const n = (seen.get(base) ?? 0) + 1;
		seen.set(base, n);
		records.push({
			id: `${base}:${n}`,
			date,
			...route,
			pitches: integerOrNull(row.Pitches),
			style: cleanText(row.Style),
			lead_style: cleanText(row["Lead Style"]),
			notes: cleanText(row.Notes),
		});
	}
	return { records, unreadable };
}

// ─── Saved routes (to-do list) ──────────────────────────────────────────

export interface BuiltSavedRoutes extends BuiltRecords<SavedRouteRecord> {
	/** Rows naming a route already listed earlier in the export. */
	duplicates: number;
}

export function buildSavedRouteRecords(
	rows: ReadonlyArray<Record<string, string>>,
): BuiltSavedRoutes {
	const seen = new Set<string>();
	const records: SavedRouteRecord[] = [];
	let unreadable = 0;
	let duplicates = 0;
	for (const row of rows) {
		const route = routeFields(row);
		if (route === null) {
			unreadable += 1;
			continue;
		}
		if (seen.has(route.route_id)) {
			duplicates += 1;
			continue;
		}
		seen.add(route.route_id);
		records.push({
			id: route.route_id,
			...route,
			pitches: integerOrNull(row.Pitches),
		});
	}
	return { records, unreadable, duplicates };
}

// ─── Session config ─────────────────────────────────────────────────────

export interface SessionConfig {
	loggedIn: boolean;
	userId: string | null;
}

/**
 * Read `window.ap.config` as a page's HTML declares it:
 * `'isLoggedIn': 0|1` and `'userId': <id>|undefined`. Null when the block is
 * absent (not a Mountain Project page).
 */
export function parseSessionConfig(html: string): SessionConfig | null {
	const loggedIn = CONFIG_LOGGED_IN_RE.exec(html);
	if (!loggedIn) return null;
	const userId = CONFIG_USER_ID_RE.exec(html)?.[1] ?? null;
	return { loggedIn: Number(loggedIn[1]) > 0, userId };
}

/** Normalize what `window.ap.config` holds in a live page. */
export function sessionFromConfig(config: unknown): SessionConfig | null {
	if (typeof config !== "object" || config === null) return null;
	const { isLoggedIn, userId } = config as {
		isLoggedIn?: unknown;
		userId?: unknown;
	};
	if (typeof isLoggedIn !== "number" && typeof isLoggedIn !== "string") {
		return null;
	}
	const id =
		typeof userId === "number" && Number.isSafeInteger(userId) && userId > 0
			? String(userId)
			: typeof userId === "string" && /^\d{1,12}$/.test(userId)
				? userId
				: null;
	return { loggedIn: Number(isLoggedIn) > 0, userId: id };
}

// ─── Profile ────────────────────────────────────────────────────────────

/** `/user/<id>/<slug>` from a profile URL, or null. */
export function profilePath(url: string): { id: string; path: string } | null {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return null;
	}
	if (parsed.origin !== ORIGIN) return null;
	const match = USER_PATH_RE.exec(parsed.pathname);
	if (!match?.[1] || !match[2]) return null;
	return { id: match[1], path: `/user/${match[1]}/${match[2]}` };
}

function textOf(node: { textContent: string | null } | null): string | null {
	return node ? cleanText(node.textContent?.replace(WHITESPACE_RE, " ")) : null;
}

function countFrom(text: string | null): number | null {
	const match = text ? COUNT_RE.exec(text) : null;
	if (!match?.[1]) return null;
	const n = Number(match[1].replaceAll(",", ""));
	return Number.isSafeInteger(n) ? n : null;
}

function memberSince(text: string | null): string | null {
	const match = text ? MEMBER_SINCE_RE.exec(text) : null;
	if (!match) return null;
	const [, mon, day, year] = match;
	const month = mon ? MONTHS[mon] : undefined;
	if (!month || !day || !year) return null;
	return validDate(`${year}-${month}-${day.padStart(2, "0")}`);
}

export type ProfileParse =
	| { ok: true; record: ProfileRecord }
	| { ok: false; message: string };

/**
 * The owner's profile from their `/user/<id>/<slug>` page. The page must be
 * the profile of `expectedUserId` (the signed-in user). Display name is
 * required; everything else is null when the page does not show it.
 *
 * The slug comes from the page's own `<link rel="canonical">` when it has
 * one, else from `url` (the response URL, which is the slug URL after the
 * site's 301 from `/user/<id>`). A page that names neither is refused.
 */
export function parseProfilePage(
	html: string,
	url: string,
	expectedUserId: string,
): ProfileParse {
	const { document } = parseHTML(html);
	const canonical = document
		.querySelector('link[rel="canonical"]')
		?.getAttribute("href");
	const path = profilePath(canonical ?? "") ?? profilePath(url);
	if (path === null || path.id !== expectedUserId) {
		return {
			ok: false,
			message: "The profile request did not land on the signed-in user's page.",
		};
	}
	const info = document.querySelector("#user-info");
	const displayName = textOf(info?.querySelector("h2") ?? null);
	if (info === null || displayName === null) {
		return {
			ok: false,
			message: "The profile page has no user name block (#user-info h2).",
		};
	}
	// The line under the name: its own text nodes are the location; the age
	// and gender line nested inside it is left out.
	const locationBlock = info.querySelector("h2 + div");
	let location: string | null = null;
	if (locationBlock) {
		const own = [...locationBlock.childNodes]
			.filter((node) => node.nodeType === 3)
			.map((node) => node.textContent ?? "")
			.join(" ");
		location = cleanText(own.replace(WHITESPACE_RE, " "));
	}
	const avatar = cleanText(
		info.querySelector(".user-img-avatar")?.getAttribute("data-original") ??
			undefined,
	);
	let joined: string | null = null;
	for (const strong of document.querySelectorAll("#user-info strong")) {
		if (textOf(strong) === "Member Since") {
			joined = memberSince(
				textOf(strong.parentElement?.nextElementSibling ?? null),
			);
			break;
		}
	}
	const ticksLink = document.querySelector(
		`a[href$="${path.path}/ticks"], a[href="${ORIGIN}${path.path}/ticks"]`,
	);
	const todoLink = document.querySelector(
		`a[href$="${path.path}/climb-todo-list"]`,
	);
	return {
		ok: true,
		record: {
			id: path.id,
			display_name: displayName,
			profile_url: `${ORIGIN}${path.path}`,
			avatar_url: avatar?.startsWith("https://") ? avatar : null,
			location,
			member_since: joined,
			tick_count: countFrom(textOf(ticksLink)),
			todo_count: countFrom(textOf(todoLink)),
		},
	};
}
