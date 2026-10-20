// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { parseHTML } from "linkedom";
import { z } from "zod";
import { eventRecord } from "../github/parsers.ts";
import type { BrowserPageObservation } from "./page-evidence.ts";
import { inspectInventoryEnd } from "./page-evidence.ts";
import type {
	LegacyContributionDay,
	LegacyContributions,
	LegacyEvent,
	LegacyHistoryItem,
	LegacyProfile,
	LegacyRepository,
	LegacyStarredRepository,
} from "./types.ts";

const eventApiSchema = z.object({
	created_at: z.string(),
	id: z.string(),
	payload: z.unknown().optional(),
	public: z.boolean().optional(),
	repo: z.object({ name: z.string() }),
	type: z.string(),
});

function text(node: Element | null | undefined): string {
	return node?.textContent?.replace(/\s+/gu, " ").trim() ?? "";
}

function toInt(raw: string): number {
	const normalized = raw.toLowerCase().replace(/[\s,]/gu, "");
	const compact = /^([0-9]+(?:\.[0-9]+)?)([km])?$/u.exec(normalized);
	if (compact?.[1]) {
		const value = Number(compact[1]);
		if (!Number.isFinite(value)) return 0;
		if (compact[2] === "k") return Math.round(value * 1_000);
		if (compact[2] === "m") return Math.round(value * 1_000_000);
		return Math.round(value);
	}
	const digits = normalized.replace(/[^0-9]/gu, "");
	return digits ? Number.parseInt(digits, 10) : 0;
}

function githubUrl(href: string | null | undefined): string | null {
	if (href === null || href === undefined || href === "") return null;
	try {
		const url = new URL(href, "https://github.com");
		return url.origin === "https://github.com" && !url.username && !url.password
			? url.href
			: null;
	} catch {
		return null;
	}
}

function repositoryName(href: string | null): string | null {
	if (href === null) return null;
	try {
		const absolute = githubUrl(href);
		if (absolute === null) return null;
		const url = new URL(absolute);
		if (url.search || url.hash) return null;
		const parts = url.pathname
			.split("/")
			.filter(Boolean);
		if (parts.length !== 2 || !/^[a-zA-Z0-9-]{1,39}$/u.test(parts[0] ?? "") || !/^[a-zA-Z0-9_.-]+$/u.test(parts[1] ?? "")) return null;
		const blocked = new Set([
			"features",
			"topics",
			"collections",
			"organizations",
			"orgs",
			"users",
			"marketplace",
			"settings",
			"login",
			"logout",
			"notifications",
			"explore",
			"stars",
			"sponsors",
			"search",
			"security",
			"enterprise",
		]);
		return blocked.has(parts[0]?.toLowerCase() ?? "")
			? null
			: `${parts[0]}/${parts[1]}`;
	} catch {
		return null;
	}
}

export function parseLoggedInUsername(html: string): string | null {
	const { document } = parseHTML(html);
	const login = document
		.querySelector('meta[name="user-login"]')
		?.getAttribute("content")
		?.trim();
	return login && /^[a-zA-Z0-9-]{1,39}$/u.test(login) ? login : null;
}


export type ProfileRow = Omit<Partial<LegacyProfile>, "pinnedRepositories" | "organizations" | "achievements"> &
	Pick<LegacyProfile, "username" | "profileUrl"> & {
		pinnedRepositories?: Array<Partial<LegacyProfile["pinnedRepositories"][number]> & { fullName: string }>;
		organizations?: Array<Partial<LegacyProfile["organizations"][number]> & { login: string; url: string }>;
		achievements?: Array<Partial<LegacyProfile["achievements"][number]> & { name: string }>;
	};
export type RepositoryRow = Partial<LegacyRepository> &
	Pick<LegacyRepository, "id" | "name" | "url">;
export type StarredRow = Partial<LegacyStarredRepository> &
	Pick<LegacyStarredRepository, "id" | "fullName" | "url">;
export type EventRow = Partial<LegacyEvent> &
	Pick<LegacyEvent, "id" | "type" | "createdAt" | "repo" | "repoUrl">;
export type HistoryRow = Partial<LegacyHistoryItem> &
	Pick<LegacyHistoryItem, "id" | "type" | "repo" | "repoUrl">;

export interface ParsedItem<T> {
	row: T | null;
	complete: boolean;
	unreadableFields: string[];
}
export interface ParsedInventory<T> {
	// Entry accounting is separate from best-effort row field diagnostics.
	entriesComplete: boolean;
	rows: T[];
	rejectedRows: number;
	rawRows: number;
	complete: boolean;
	unreadableFields: string[];
}

// Menus and dialogs embedded in a row (star-list pickers, filter menus) carry
// their own loading panels and menu items. They are not part of the data.
const OVERLAY_SELECTOR =
	'dialog, [role="dialog"], [role="menu"], [role="listbox"], action-menu, select-panel, details-menu, [popover], template';

function insideOverlay(node: Element, scope: Element): boolean {
	const overlay = node.closest(OVERLAY_SELECTOR);
	return overlay !== null && overlay !== scope && scope.contains(overlay);
}

const PENDING_SELECTOR =
	'[aria-busy="true"], [data-loading="true"], .AnimatedEllipsis, .loading, .skeleton, .Skeleton, .placeholder, include-fragment';

function isUnreadable(node: Element): boolean {
	return (
		node.closest(PENDING_SELECTOR) !== null ||
		Array.from(
			node.querySelectorAll(PENDING_SELECTOR),
		).some((marker) => !insideOverlay(marker, node)) ||
		/^(?:loading(?:\.{3}|…)?|unavailable|failed to load)$/iu.test(text(node))
	);
}

function sourceText(node: Element | null): string | undefined {
	return node === null || isUnreadable(node) ? undefined : text(node);
}

function sourceAttribute(
	node: Element | null,
	attribute: string,
): string | undefined {
	return node === null || isUnreadable(node)
		? undefined
		: (node.getAttribute(attribute) ?? undefined);
}

function sourceCount(node: Element | null): number | undefined {
	const raw = sourceText(node);
	if (raw === undefined) return undefined;
	const match = /^([0-9]+(?:,[0-9]{3})*(?:\.[0-9]+)?[km]?)(?:\s+(?:followers?|following|repositories|stars?|forks?))?$/iu.exec(raw);
	if (!match?.[1]) return undefined;
	const value = toInt(match[1]);
	return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function sourceTime(node: Element | null): string | undefined {
	const value = sourceAttribute(node, "datetime");
	return value && Number.isFinite(Date.parse(value)) ? value : undefined;
}

function recordField<T extends object, K extends keyof T>(
	row: T,
	key: K,
	value: T[K] | undefined,
	unreadableFields: string[],
): void {
	if (value === undefined) unreadableFields.push(String(key));
	else row[key] = value;
}

// Missing selectors are omissions only when independent row structure proves readiness.
// Residual limit: text-free drift may omit an optional FIELD, never an entry;
// collection accounting must independently reject surviving unaccounted rows.
function recordOptional<T extends object, K extends keyof T>(
	row: T,
	key: K,
	node: Element | null,
	read: (node: Element) => T[K] | undefined,
	unreadableFields: string[],
	omissionProven = false,
): void {
	if (node === null) {
		if (!omissionProven) unreadableFields.push(String(key));
		return;
	}
	recordField(row, key, read(node), unreadableFields);
}

// Site-wide header and footer carry their own deferred fragments and menus.
// They say nothing about the inventory's own continuation.
const SITE_CHROME = '.js-header-wrapper, .header-wrapper, [role="banner"], [role="contentinfo"], footer';

function siteChrome(node: Element, list: Element | null): boolean {
	if (node.closest('main, [role="main"]') !== null || list?.contains(node)) return false;
	const region = node.closest(SITE_CHROME);
	return region !== null && region.closest('main, [role="main"]') === null &&
		(list === null || !region.contains(list)) &&
		region.querySelector('main, [role="main"]') === null;
}

const EMPTY_STATE = ".blankslate, [data-testid='empty-state']";

// An empty-state message that belongs to the list itself: not in a menu or
// dialog, not inside one of the list's rows, and not a feature prompt (a
// "create a list" blankslate carries a button or dialog of its own).
function listEmptyStates(list: Element | null, rows: Element[]): Element[] {
	if (list === null) return [];
	return Array.from(list.querySelectorAll(EMPTY_STATE)).filter((node) =>
		!insideOverlay(node, list) && !rows.some((row) => row.contains(node)) &&
		node.querySelector("button, form, dialog, dialog-helper") === null);
}

const STARRED_CARD_SELECTOR = "div.col-12.d-block.width-full.border-bottom";

// Rows are the entries of the lists inside the container, or list items placed
// directly in a wrapper. Wrappers, toolbars, pagination and empty states
// between them are not rows; an entry that is not an ordinary row still counts,
// so identity-less placeholders are rejected.
function cardRows(roots: Element | null | Array<Element | null>, starred = false): Element[] {
	const rows: Element[] = [];
	const visit = (node: Element, list: Element): void => {
		const isList = node.matches("ul, ol");
		for (const child of Array.from(node.children)) {
			if (child.matches(OVERLAY_SELECTOR) || insideOverlay(child, list)) continue;
			if (child.matches(`${EMPTY_STATE}, .paginate-container, .pagination`)) continue;
			if (starred && child.matches(STARRED_CARD_SELECTOR)) rows.push(child);
			else if (child.matches("ul, ol") || (!isList && !child.matches("li, [role='listitem']"))) visit(child, list);
			else if (child.children.length > 0 &&
				Array.from(child.children).every((entry) => entry.matches(OVERLAY_SELECTOR))) continue;
			else rows.push(child);
		}
	};
	for (const root of Array.isArray(roots) ? roots : [roots]) {
		if (root !== null) visit(root, root);
	}
	return rows;
}

// Account for wrapper text and text-free candidates, not just heading links.
// Empty-state copy is evidence only with zero rows and no surviving entry link.
function unaccountedRepositories(list: Element | null, rows: Element[], entriesOnly = false): number {
	if (list === null) return 0;
	const empty = rows.length === 0 ? listEmptyStates(list, rows) : [];
	// Guard targets conservatively, independently of strict row identity: query
	// strings and fragments do not make an owner/repository path ordinary chrome.
	const repositoryTarget = (link: Element): boolean => {
		if (!link.matches("a[href]")) return false;
		try {
			const url = new URL(link.getAttribute("href") ?? "", "https://github.com");
			return url.origin === "https://github.com" && (entriesOnly
				? repositoryName(url.pathname) !== null : url.pathname.split("/").filter(Boolean).length === 2);
		} catch {
			return true; // An unreadable destination cannot prove entry-free chrome.
		}
	};
	// Include the candidate itself; querySelector only inspects descendants.
	const entryFree = (element: Element): boolean => !element.matches("li, [role='listitem']") &&
		element.querySelector("li, [role='listitem']") === null && !repositoryTarget(element) &&
		!Array.from(element.querySelectorAll("a[href]")).some(repositoryTarget);
	// The list container also holds the page's own search, filter and sort
	// controls, a page-level h1/h2 title and a screen-reader results line. Entry
	// titles are h3 links, so none of these can stand in for a dropped entry.
	const listChrome = `${CONTROL_SELECTOR}, [role="search"], h1, h2, .sr-only, .paginate-container, .pagination, svg, canvas, script, style`;
	const visit = (node: Node): number => {
		if (node.nodeType === 3) return !entriesOnly && (node.textContent ?? "").trim() ? 1 : 0;
		if (node.nodeType !== 1) return 0;
		const element = node as Element;
		if (rows.includes(element) || element.matches(OVERLAY_SELECTOR) || insideOverlay(element, list)) return 0;
		if (empty.includes(element) && entryFree(element)) return 0;
		if (entriesOnly && element.matches(".paginate-container, .pagination") &&
			element.querySelector("h3") === null && !Array.from(element.querySelectorAll("a[href]")).some(repositoryTarget)) return 0;
		if (element !== list && element.matches(listChrome) && entryFree(element)) return 0;
		if (element.matches("li, [role='listitem']") ||
			(element.matches("a[href]") && (!entriesOnly || repositoryTarget(element)))) return 1;
		const children = Array.from(element.childNodes);
		if (children.length === 0 && !element.matches("ul, ol")) return entriesOnly ? 0 : 1;
		return children.reduce((sum, child) => sum + visit(child), 0);
	};
	return list.matches("a[href], li, [role='listitem']") ? visit(list) :
		Array.from(list.childNodes).reduce((sum, node) => sum + visit(node), 0);
}

// Content inside a row is classified, not matched against a layout. Controls,
// icons and presentational markup are chrome. Text we neither read nor
// recognise as a labelled data line is data we do not parse, which vetoes.
const CHROME_SELECTOR = `svg, canvas, script, style, tool-tip, [hidden], ${OVERLAY_SELECTOR}`;
const CONTROL_SELECTOR = 'form, button, input, select, textarea, summary, label, .btn, .Button, [role="button"]';
const ROW_LABEL = /^(?:updated(?: on)?|forked from)$/iu;

interface RowData {
	license?: string;
	forkedFrom?: string;
	unknown: string[];
}

function forkParent(node: Element): string | undefined {
	const link = node.querySelector("a[href]");
	const parent = repositoryName(link?.getAttribute("href") ?? null);
	return parent !== null && link !== null && text(node) === `Forked from ${text(link)}` ? parent : undefined;
}

function licenseLine(node: Element): string | undefined {
	if (!node.matches("span, a, div, p")) return undefined;
	if (Array.from(node.children).some((child) => !child.matches(CHROME_SELECTOR))) return undefined;
	const value = text(node);
	return value.length <= 80 && /\blicen[cs]e\b/iu.test(value) ? value : undefined;
}

function classifyNodes(nodes: Iterable<Node>, isKnown: (node: Element) => boolean): RowData {
	const data: RowData = { unknown: [] };
	const visit = (child: Node): void => {
		if (child.nodeType === 3) {
			const value = (child.textContent ?? "").replace(/\s+/gu, " ").trim();
			if (/[\p{L}\p{N}]/u.test(value) && !ROW_LABEL.test(value)) data.unknown.push(value);
			return;
		}
		if (child.nodeType !== 1) return;
		const node = child as Element;
		if (node.matches(CHROME_SELECTOR)) return;
		if (node.matches(CONTROL_SELECTOR)) {
			if (/\d/u.test(text(node))) data.unknown.push(text(node));
			return;
		}
		// Inspect controls even under a consumed description or other known ancestor.
		if (isKnown(node)) {
			for (const control of Array.from(node.querySelectorAll(CONTROL_SELECTOR))) {
				if (control.closest(CHROME_SELECTOR) === null && /\d/u.test(text(control))) data.unknown.push(text(control));
			}
			return;
		}
		const parent = forkParent(node);
		if (parent !== undefined) {
			data.forkedFrom ??= parent;
			return;
		}
		const license = licenseLine(node);
		if (license !== undefined) {
			data.license ??= license;
			return;
		}
		for (const inner of Array.from(node.childNodes)) visit(inner);
	};
	for (const node of nodes) visit(node);
	return data;
}

const classifyRow = (row: Element, isKnown: (node: Element) => boolean): RowData =>
	classifyNodes(Array.from(row.childNodes), isKnown);

// A fully rendered row has its identity and required fields, no busy marker,
// and no content we neither read nor recognise. Only then may an absent
// optional value be omitted.
function renderedRow(row: Element, required: boolean, data: RowData): boolean {
	return required && !isUnreadable(row) && data.unknown.length === 0;
}

function collectionAccounted(list: Element | null, entries: Element[]): boolean {
	if (list === null || isUnreadable(list)) return false;
	const visit = (node: Element): boolean => Array.from(node.children).every((child) => {
		if (child.matches(OVERLAY_SELECTOR) || insideOverlay(child, list)) return true;
		if (entries.includes(child)) return !isUnreadable(child);
		return child.matches("ul, ol") && visit(child);
	});
	return visit(list);
}

function starredList(document: Document): Element | null {
	return document.querySelector(
		"#user-starred-repos, #user-profile-frame .js-starred-repos, #user-profile-frame [data-testid='starred-repositories']",
	);
}

/**
 * The profile page has several h2.f4.text-normal.mb-2-style headings (for
 * example "Popular repositories"). Only the contribution heading counts.
 */
function contributionHeading(document: Document): Element | null {
	return (
		Array.from(document.querySelectorAll("h2#js-contribution-activity-description")).find(
			(heading) => heading.closest(OVERLAY_SELECTOR) === null) ??
		Array.from(document.querySelectorAll("h2.f4.text-normal.mb-2")).find(
			(heading) => heading.closest(OVERLAY_SELECTOR) === null && /\bcontributions?\b/iu.test(text(heading)),
		) ??
		null
	);
}

const HEADING_SELECTOR = "h1, h2, h3, h4, h5, h6, [role='heading']";

function headingsMatching(document: Document, pattern: RegExp): Element[] {
	return Array.from(document.querySelectorAll(HEADING_SELECTOR)).filter((heading) =>
		pattern.test(text(heading)) && heading.closest(OVERLAY_SELECTOR) === null);
}

// A section is what follows its heading up to the next heading. A heading
// wrapped alone in its own block owns the next blocks of the parent instead.
function sectionNodes(heading: Element): Element[] {
	const following = (from: Element): Element[] => {
		const nodes: Element[] = [];
		for (let node = from.nextElementSibling; node !== null; node = node.nextElementSibling) {
			if (node.matches(HEADING_SELECTOR) || node.querySelector(HEADING_SELECTOR) !== null) break;
			nodes.push(node);
		}
		return nodes;
	};
	const own = following(heading);
	return own.length > 0 || heading.parentElement === null ? own : following(heading.parentElement);
}

function anchorsIn(nodes: Element[], selector: string): Element[] {
	const found = nodes.flatMap((node) => [
		...(node.matches(selector) ? [node] : []),
		...Array.from(node.querySelectorAll(selector)),
	]);
	return found.filter((node, index) => found.indexOf(node) === index &&
		!node.parentElement?.closest(selector));
}

// The profile page proper: username header, avatar and the Overview and
// Repositories tabs. Without it, a missing section may be a different page.
function hasProfileStructure(document: Document): boolean {
	return document.querySelector("img.avatar-user") !== null &&
		document.querySelector("span.p-nickname") !== null &&
		(document.querySelector('a[data-tab-item="overview"]') !== null ||
			Array.from(document.querySelectorAll("a[href]")).some((link) => /^overview$/iu.test(text(link)))) &&
		document.querySelector('a[data-tab-item="repositories"], a[href*="tab=repositories"]') !== null;
}

type Reading<T> = { kind: "read"; value: T } | { kind: "omitted" } | { kind: "unreadable"; value?: T };

// Followers and following exist only as links. No link at all, on a page that
// is recognisably a profile, means the profile shows none.
function followCount(document: Document, kind: "followers" | "following", structure: boolean): Reading<number> {
	const pattern = new RegExp(`(?:/|[?&]tab=)${kind}$`, "u");
	const links = Array.from(document.querySelectorAll("a[href]")).filter((link) =>
		pattern.test(link.getAttribute("href") ?? "") && link.closest(OVERLAY_SELECTOR) === null);
	if (links.length === 0) return structure ? { kind: "omitted" } : { kind: "unreadable" };
	const values = links.map(sourceCount).filter((value): value is number => value !== undefined);
	const distinct = new Set(values);
	if (values.length !== links.length || links.some(isUnreadable) || distinct.size !== 1) return { kind: "unreadable" };
	return { kind: "read", value: values[0] ?? 0 };
}

const ORGANIZATION_HOOKS = 'a[href^="/orgs/"], .avatar-group-item, [itemprop="follows"], .avatar-group, [data-testid="organizations"], [aria-label="Organizations"], a[data-hovercard-type="organization"]';
const ACHIEVEMENT_CARD = '.js-achievement-card, a[href*="/achievements/"], a[href*="achievement="][href*="tab=achievements"]';
const ACHIEVEMENT_HOOKS = `${ACHIEVEMENT_CARD}, img.achievement-badge-sidebar, .profile-achievements, .js-profile-achievements, [data-testid="achievements"]`;

interface Section {
	// Entries found, if the section could be located at all.
	entries: Element[] | null;
	// The section is present but its content cannot be certified.
	unreadable: boolean;
}

// Locate a section by its heading text. Without a heading, leftover markup
// that looks like the section keeps its entries readable but uncertified; with
// no trace of it, only the profile structure decides if it is absent.
function locateSection(
	document: Document,
	heading: RegExp,
	entrySelector: string,
	hooks: string,
	fallbackSelector: string,
	structure: boolean,
): Section {
	const headings = headingsMatching(document, heading);
	if (headings.length === 0) {
		if (document.querySelector(hooks) !== null)
			return { entries: anchorsIn([document.documentElement], fallbackSelector), unreadable: true };
		return { entries: null, unreadable: !structure };
	}
	const nodes = headings.flatMap(sectionNodes);
	const entries = anchorsIn(nodes, entrySelector);
	const leftover = classifyNodes(nodes, (node) => node.matches("a[href]")).unknown;
	// Text-free avatars and badges remain entries when their anchor drifts.
	// Check roots and descendants; consuming an ancestor cannot hide extra images.
	const candidateSelector = 'li, [role="listitem"], .avatar-group-item, img';
	const candidates = nodes.flatMap((node) => [
		...(node.matches(candidateSelector) ? [node] : []),
		...Array.from(node.querySelectorAll(candidateSelector)),
	]);
	const accounted = candidates.every((candidate) => entries.some((entry) => {
		const image = entry.querySelector("img");
		return candidate === entry || candidate.contains(entry) ||
			(image !== null && (candidate === image || candidate.contains(image)));
	}));
	return {
		entries,
		unreadable: nodes.some(isUnreadable) || leftover.length > 0 || !accounted,
	};
}

export function parseProfileHtml(
	html: string,
	profileUrl: string,
): ProfileRow | null {
	return parseProfilePage(html, profileUrl).row;
}

export function parseProfilePage(
	html: string,
	profileUrl: string,
): ParsedItem<ProfileRow> & { rejectedEntries: number } {
	const { document } = parseHTML(html);
	const username = sourceText(document.querySelector("span.p-nickname"));
	const unreadableFields: string[] = [];
	let rejectedEntries = 0;
	if (!username || !/^[a-zA-Z0-9-]{1,39}$/u.test(username))
		return { row: null, complete: false, unreadableFields: ["username"], rejectedEntries };

	const row: ProfileRow = { username, profileUrl };
	const structure = hasProfileStructure(document);
	for (const [key, selector] of [
		["fullName", "span.p-name"],
		["bio", "div.p-note"],
	] as const)
		recordField(row, key, sourceText(document.querySelector(selector)), unreadableFields);
	// GitHub renders company, location and website only when set. A rendered
	// details list with no entries proves none is set; otherwise absence is unreadable.
	const details = document.querySelector("ul.vcard-details");
	const noDetailsSet = details !== null && !isUnreadable(details) && details.children.length === 0;
	if (!noDetailsSet) {
		for (const [key, selector] of [
			["company", '[itemprop="worksFor"]'],
			["location", '[itemprop="homeLocation"]'],
		] as const)
			recordField(row, key, sourceText(document.querySelector(selector)), unreadableFields);
		recordField(row, "website", sourceAttribute(document.querySelector('[itemprop="url"]'), "href"), unreadableFields);
	}
	recordField(row, "avatarUrl", sourceAttribute(document.querySelector("img.avatar-user"), "src"), unreadableFields);
	for (const key of ["followers", "following"] as const) {
		const count = followCount(document, key, structure);
		if (count.kind === "read") row[key] = count.value;
		else if (count.kind === "unreadable") unreadableFields.push(key);
	}
	// The tab shows the count in a counter label plus a visually hidden "(n)" copy.
	const repoCountNode = document.querySelector('[data-tab-item="repositories"] .Counter, a[href*="tab=repositories"] .Counter, [data-tab-item="repositories"] [class*="CounterLabel-CounterLabel"], a[href*="tab=repositories"] [class*="CounterLabel-CounterLabel"]')
		?? document.querySelector('[data-tab-item="repositories"], a[href*="tab=repositories"]');
	recordField(row, "repositoryCount", sourceCount(repoCountNode), unreadableFields);
	const contributionText = sourceText(contributionHeading(document));
	const countMatch = contributionText === undefined ? null : /^([\d,]+)\s+contributions?\b/iu.exec(contributionText);
	recordField(row, "contributionsLastYear", countMatch?.[1] ? toInt(countMatch[1]) : undefined, unreadableFields);

	const pinnedHeadings = headingsMatching(document, /^(?:pinned|popular repositories)\b/iu);
	const pinnedContainer = document.querySelector(".js-pinned-items-reorder-container, ol.pinned-items-reorder-list");
	const pinnedRoots = pinnedHeadings.length > 0
		? pinnedHeadings.flatMap(sectionNodes)
		: pinnedContainer === null ? [] : [pinnedContainer];
	if (pinnedHeadings.length === 0 && (pinnedContainer !== null || !structure))
		unreadableFields.push("pinnedRepositories");
	if (pinnedRoots.some(isUnreadable) && !unreadableFields.includes("pinnedRepositories"))
		unreadableFields.push("pinnedRepositories");
	if (pinnedRoots.length > 0 || pinnedHeadings.length > 0) {
		row.pinnedRepositories = [];
		const pinnedRows = cardRows(pinnedRoots);
		for (const root of pinnedRoots) rejectedEntries += unaccountedRepositories(root, pinnedRows);
		for (const item of pinnedRows) {
			const link = item.querySelector("a[href]");
			const fullName = repositoryName(link?.getAttribute("href") ?? null);
			if (!fullName || !sourceText(link)) {
				rejectedEntries += 1;
				continue;
			}
			const card: NonNullable<ProfileRow["pinnedRepositories"]>[number] = {
				fullName,
				url: `https://github.com/${fullName}`,
			};
			const data = classifyRow(item, (node) => node === link ||
				node.matches('p.pinned-item-desc, [itemprop="programmingLanguage"], a[href$="/stargazers"], a[href$="/forks"], span.Label'));
			const pinnedLayout = renderedRow(item,
				item.matches("li") && (item.matches(".pinned-item-list-item") || item.querySelector(".pinned-item-list-item") !== null) &&
					item.querySelector("p.pinned-item-desc") !== null && item.querySelector("p.f6") !== null,
				data);
			const unreadableSlots: string[] = pinnedLayout ? [] : ["card"];
			recordOptional(card, "description", item.querySelector("p.pinned-item-desc"), sourceText, unreadableSlots, pinnedLayout);
			recordOptional(card, "language", item.querySelector('[itemprop="programmingLanguage"]'), sourceText, unreadableSlots, pinnedLayout);
			recordOptional(card, "stars", item.querySelector('a[href$="/stargazers"]'), sourceCount, unreadableSlots, pinnedLayout);
			recordOptional(card, "forks", item.querySelector('a[href$="/forks"]'), sourceCount, unreadableSlots, pinnedLayout);
			if (data.forkedFrom !== undefined) card.forkedFrom = data.forkedFrom;
			if (unreadableSlots.length > 0) rejectedEntries += 1;
			row.pinnedRepositories?.push(card);
		}
	}

	// Contribution activity links belong to their own sections, not the pins.
	// Renamed pin headings/containers cannot make surviving entries vanish.
	const unclaimedPins = Array.from(document.querySelectorAll("a[href]")).filter((link) =>
		repositoryName(link.getAttribute("href")) !== null && link.closest(OVERLAY_SELECTOR) === null &&
		!siteChrome(link, pinnedContainer) && !pinnedRoots.some((root) => root.contains(link)) &&
		link.closest(".js-yearly-contributions, #js-contribution-activity") === null);
	if (unclaimedPins.length > 0) unreadableFields.push("pinnedRepositories");

	const organizations = locateSection(document, /^organizations?\b/iu, "a[href]", ORGANIZATION_HOOKS, '.avatar-group-item, a[href^="/orgs/"]', structure);
	if (organizations.unreadable) unreadableFields.push("organizations");
	if (organizations.entries !== null) {
		row.organizations = [];
		for (const link of organizations.entries) {
			const href = githubUrl(link.getAttribute("href"));
			const path = href ? new URL(href).pathname : "";
			const login = /^\/(?:orgs\/)?([a-zA-Z0-9-]{1,39})$/u.exec(path)?.[1];
			if (!login || href === null) {
				rejectedEntries += 1;
				continue;
			}
			const image = link.querySelector("img");
			const avatarUrl = sourceAttribute(image, "src");
			const label = sourceAttribute(link, "aria-label") ?? sourceAttribute(image, "alt");
			if (avatarUrl === undefined || label === undefined) rejectedEntries += 1;
			row.organizations.push({
				login,
				url: href,
				...(avatarUrl === undefined ? {} : { avatarUrl }),
				...(label === undefined ? {} : { label }),
			});
		}
	}

	const achievements = locateSection(document, /^achievements?\b/iu, `a[href], ${ACHIEVEMENT_CARD}`, ACHIEVEMENT_HOOKS, ACHIEVEMENT_CARD, structure);
	if (achievements.unreadable) unreadableFields.push("achievements");
	if (achievements.entries !== null) {
		row.achievements = [];
		const seenAchievements = new Set<string>();
		for (const card of achievements.entries) {
			const image = card.querySelector("img");
			const name = sourceAttribute(image, "alt")?.replace(/^Achievement:\s*/iu, "").trim();
			if (!name) {
				rejectedEntries += 1;
				continue;
			}
			// The sidebar renders the same badges once per responsive layout.
			if (seenAchievements.has(name)) continue;
			seenAchievements.add(name);
			const iconUrl = sourceAttribute(image, "src");
			if (iconUrl === undefined) rejectedEntries += 1;
			row.achievements.push({ name, ...(iconUrl === undefined ? {} : { iconUrl }) });
		}
	}
	if (rejectedEntries > 0) unreadableFields.push("collectionEntries");
	return { row, complete: unreadableFields.length === 0, unreadableFields, rejectedEntries };
}

export function parseRepositoriesHtml(html: string): RepositoryRow[] {
	return parseRepositoriesPage(html).rows;
}

export function parseRepositoriesPage(html: string): ParsedInventory<RepositoryRow> {
	const { document } = parseHTML(html);
	const list = document.querySelector("#user-repositories-list");
	const sourceRows = cardRows(list);
	const rows: RepositoryRow[] = [];
	const unreadableFields: string[] = [];
	let rejectedRows = 0;
	const seen = new Set<string>();
	for (const [index, source] of sourceRows.entries()) {
		const link = source.querySelector("h3 a");
		const repo = repositoryName(link?.getAttribute("href") ?? null);
		const name = sourceText(link);
		if (!repo || !name) {
			rejectedRows += 1;
			continue;
		}
		const url = `https://github.com/${repo}`;
		if (seen.has(url)) {
			rejectedRows += 1;
			continue;
		}
		seen.add(url);
		const row: RepositoryRow = { id: url, name, url };
		const data = classifyRow(source, (node) => node.matches(
			'h3 a, p[itemprop="description"], [itemprop="programmingLanguage"], a[href$="/stargazers"], a[href$="/forks"], span.Label, relative-time, a.topic-tag'));
		const layout = renderedRow(source,
			source.matches("li") && source.querySelector("h3 a") !== null &&
				source.querySelector("span.Label") !== null && sourceTime(source.querySelector("relative-time")) !== undefined,
			data);
		const missing: string[] = layout ? [] : ["rowLayout"];
		if (isUnreadable(source)) missing.push("row");
		recordOptional(row, "description", source.querySelector('p[itemprop="description"]'), sourceText, missing, layout);
		recordOptional(row, "language", source.querySelector('[itemprop="programmingLanguage"]'), sourceText, missing, layout);
		recordOptional(row, "stars", source.querySelector('a[href$="/stargazers"]'), sourceCount, missing, layout);
		recordOptional(row, "forks", source.querySelector('a[href$="/forks"]'), sourceCount, missing, layout);
		recordField(row, "visibility", sourceText(source.querySelector("span.Label")), missing);
		recordField(row, "updatedAt", sourceTime(source.querySelector("relative-time")), missing);
		if (data.license !== undefined) row.license = data.license;
		if (data.forkedFrom !== undefined) row.forkedFrom = data.forkedFrom;
		const topics = Array.from(source.querySelectorAll("a.topic-tag"));
		const topicList = source.querySelector(".topics-row-container, [data-testid='repository-topics']");
		if (!layout || (topicList !== null && (isUnreadable(topicList) || !collectionAccounted(topicList, topics)))) {
			missing.push("topics");
		} else if (topics.length > 0 || topicList !== null) {
			row.topics = [];
			for (const topic of topics) {
				const value = sourceText(topic);
				if (value === undefined || value === "") missing.push("topics");
				else row.topics.push(value);
			}
		}
		unreadableFields.push(...missing.map((field) => `${index}.${field}`));
		rows.push(row);
	}
	if (list === null || isUnreadable(list)) unreadableFields.push("list");
	if (sourceRows.length > 0 && listEmptyStates(list, sourceRows).length > 0) unreadableFields.push("emptyStateWithRows");
	rejectedRows += unaccountedRepositories(list, sourceRows, true);
	return { rows, rejectedRows, entriesComplete: list !== null && !unreadableFields.includes("list") && rejectedRows === 0 && !unreadableFields.includes("emptyStateWithRows"), rawRows: sourceRows.length, complete: rejectedRows === 0 && unreadableFields.length === 0, unreadableFields };
}

export function parseStarredHtml(html: string): StarredRow[] {
	return parseStarredPage(html).rows;
}

export function parseStarredPage(html: string): ParsedInventory<StarredRow> {
	const { document } = parseHTML(html);
	const list = starredList(document);
	const sourceRows = cardRows(list, true);
	const rows: StarredRow[] = [];
	const unreadableFields: string[] = [];
	let rejectedRows = 0;
	const seen = new Set<string>();
	for (const [index, source] of sourceRows.entries()) {
		const headings = Array.from(source.querySelectorAll("h3")).filter((node) => !insideOverlay(node, source));
		const links = Array.from(source.querySelectorAll("h3 a[href]")).filter((node) => !insideOverlay(node, source));
		// A card is one entry only when it has one primary identity. Nested
		// cards and extra headings cannot disappear inside an accounted row.
		if (headings.length !== 1 || links.length !== 1 ||
			Array.from(source.querySelectorAll(STARRED_CARD_SELECTOR)).some((node) => !insideOverlay(node, source))) {
			rejectedRows += 1;
			continue;
		}
		const link = links[0] ?? null;
		const repo = repositoryName(link?.getAttribute("href") ?? null);
		const fullName = sourceText(link);
		if (!repo || !fullName) {
			rejectedRows += 1;
			continue;
		}
		const url = `https://github.com/${repo}`;
		if (seen.has(url)) {
			rejectedRows += 1;
			continue;
		}
		seen.add(url);
		const row: StarredRow = { id: url, fullName, url };
		const description = source.querySelector("p");
		const data = classifyRow(source, (node) => node === description || node.matches(
			'h3 a, [itemprop="programmingLanguage"], [data-ga-click*="Repository, language"], a[href$="/stargazers"], a[href$="/forks"], relative-time'));
		const layout = renderedRow(source,
			source.matches(`li, ${STARRED_CARD_SELECTOR}`) && source.querySelector("h3 a") !== null &&
				sourceTime(source.querySelector("relative-time")) !== undefined,
			data);
		const missing: string[] = layout ? [] : ["rowLayout"];
		if (isUnreadable(source)) missing.push("row");
		recordOptional(row, "description", description, sourceText, missing, layout);
		recordOptional(row, "language", source.querySelector('[itemprop="programmingLanguage"], [data-ga-click*="Repository, language"]'), sourceText, missing, layout);
		recordOptional(row, "stars", source.querySelector('a[href$="/stargazers"]'), sourceCount, missing, layout);
		recordOptional(row, "forks", source.querySelector('a[href$="/forks"]'), sourceCount, missing, layout);
		recordField(row, "updatedAt", sourceTime(source.querySelector("relative-time")), missing);
		if (data.license !== undefined) row.license = data.license;
		if (data.forkedFrom !== undefined) row.forkedFrom = data.forkedFrom;
		unreadableFields.push(...missing.map((field) => `${index}.${field}`));
		rows.push(row);
	}
	if (list === null || isUnreadable(list)) unreadableFields.push("list");
	if (sourceRows.length > 0 && listEmptyStates(list, sourceRows).length > 0) unreadableFields.push("emptyStateWithRows");
	rejectedRows += unaccountedRepositories(list, sourceRows, true);
	return { rows, rejectedRows, entriesComplete: list !== null && !unreadableFields.includes("list") && rejectedRows === 0 && !unreadableFields.includes("emptyStateWithRows"), rawRows: sourceRows.length, complete: rejectedRows === 0 && unreadableFields.length === 0, unreadableFields };
}

export function inspectInventoryPage(
	page: BrowserPageObservation,
	stream: "repositories" | "starred",
	username: string,
	pageNumber: number,
	parsedRows: number,
	rejectedRows: number,
	noProgress = false,
): { valid: boolean; complete: boolean; total: number | null; exactTotals: number[]; totalConflict: boolean; nextUrl: string | null; reason: string } {
	const { document } = parseHTML(page.html);
	const tab = stream === "repositories" ? "repositories" : "stars";
	const list = stream === "repositories" ? document.querySelector("#user-repositories-list") : starredList(document);
	// Only the owner's unfiltered tab or All stars link supplies an exact total.
	const counterSelector = '.Counter, [class*="CounterLabel-CounterLabel"]';
	const tabs = Array.from(document.querySelectorAll("a[href]")).filter(link => {
		const href = githubUrl(link.getAttribute("href"));
		if (href === null || link.closest(OVERLAY_SELECTOR) !== null) return false;
		const url = new URL(href);
		if (url.hash) return false;
		const nav = link.closest('nav, [role="navigation"], .UnderlineNav');
		const profileTab = url.pathname === `/${username}` &&
			url.searchParams.get("tab") === tab && Array.from(url.searchParams.keys()).length === 1 &&
			(link.getAttribute("data-tab-item") === tab || nav !== null);
		let allStars = false;
		if (stream === "starred" && url.pathname === `/stars/${username}` && !url.search) {
			const label = link.cloneNode(true) as Element;
			for (const counter of Array.from(label.querySelectorAll(counterSelector))) counter.remove();
			allStars = /^All stars$/iu.test(text(label));
		}
		// GitHub puts the profile tab navigation inside the site header wrapper.
		// Keep excluding generic chrome and footer links; only owner tab-nav is exempt.
		const headerTab = profileTab && nav !== null &&
			link.closest('.js-header-wrapper, .header-wrapper, [role="banner"]') !== null &&
			link.closest('footer, [role="contentinfo"]') === null;
		return (profileTab || allStars) && (!siteChrome(link, list) || headerTab);
	});
	// A rendered counter alone is not proof when its owning navigation is pending.
	const counterComponents = tabs.map(link => link.closest('nav, [role="navigation"], .UnderlineNav') ?? link);
	const countersReady = counterComponents.every(node => !isUnreadable(node));
	const counters = tabs.flatMap(link => Array.from(link.querySelectorAll(counterSelector)))
		.filter(node => node.closest(OVERLAY_SELECTOR) === null);

	const values = counters.map(node => {
		const raw = text(node);
		return /^(?:0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)$/u.test(raw) &&
			Number.isSafeInteger(Number(raw.replaceAll(",", ""))) ? Number(raw.replaceAll(",", "")) : null;
	}).filter((value): value is number => value !== null); // Approximate counters supply no exact evidence.
	const counterAmbiguous = new Set(values).size > 1;
	const total = !countersReady || counterAmbiguous ? null : values[0] ?? null;
	// Select only pagination inside the list or directly following its wrapper.
	// Nested .pagination within .paginate-container is one component, not two.
	const selector = ".paginate-container, .pagination";
	const candidates = new Set<Element>();
	if (list !== null) {
		for (const node of Array.from(list.querySelectorAll(selector))) {
			if (node.closest(OVERLAY_SELECTOR) === null && !cardRows(list, stream === "starred").some(row => row.contains(node)))
				candidates.add(node);
		}
		for (let scope: Element | null = list; scope !== null; scope = scope.parentElement) {
			let sibling = scope.nextElementSibling;
			while (sibling !== null && (tabs.includes(sibling) || sibling.matches(selector))) {
				if (sibling.matches(selector)) candidates.add(sibling);
				sibling = sibling.nextElementSibling;
			}
		}
	}
	const paginators = Array.from(candidates).filter(node =>
		!Array.from(candidates).some(other => other !== node && other.contains(node)));
	const pagination = paginators.length === 1 ? paginators[0] : null;
	const nextControls = Array.from(pagination?.querySelectorAll('[rel~="next"], .next_page') ?? [])
		.filter(node => node.closest(OVERLAY_SELECTOR) === null);
	const next = nextControls[0] ?? null;
	const disabled = next?.matches('[disabled], [aria-disabled="true"], .disabled') ?? false;
	const nextUrl = next !== null && !disabled ? githubUrl(next.getAttribute("href")) : null;
	const foreignPagination = Array.from(pagination?.querySelectorAll("a[href]") ?? []).filter(link =>
		link.closest(OVERLAY_SELECTOR) === null).some(link => {
		const href = githubUrl(link.getAttribute("href"));
		if (href === null) return true;
		const url = new URL(href);
		const starsRoute = stream === "starred" && url.pathname === `/stars/${username}`;
		return !(starsRoute || (url.pathname === `/${username}` && url.searchParams.get("tab") === tab)) ||
			!!url.hash || Array.from(url.searchParams.keys()).some(key =>
				!["tab", "page", "after"].includes(key) || url.searchParams.getAll(key).length !== 1);
	});
	const ambiguous = counterAmbiguous || foreignPagination || paginators.length > 1 || nextControls.length > 1 ||
		(next !== null && !disabled && nextUrl === null);
	const renderComplete = list !== null && !isUnreadable(list) && countersReady &&
		paginators.every(node => !isUnreadable(node));
	const terminal = pagination !== null && (disabled || next === null);
	const result = inspectInventoryEnd({
		page, username, stream, pageNumber, parsedRows, rejectedRows, noProgress,
		explicitEmpty: false, hasRecognizedList: list !== null, renderComplete,
		hasUnknownContinuation: ambiguous,
		terminalProof: total !== null ? (total === parsedRows ? "exact_count" : null)
			: terminal ? "disabled_next" : null,
		nextUrl,
	});
	const trusted = countersReady && result.reason !== "wrong_navigation" && result.reason !== "wrong_owner";
	const exactTotals = trusted ? values.filter((value): value is number => value !== null) : [];
	return { valid: result.complete || result.reason === "remaining_continuation",
		complete: result.complete, total, exactTotals, totalConflict: trusted && counterAmbiguous,
		nextUrl: result.nextUrl, reason: result.reason };
}

export function parseContributionHtml(html: string): {
	days: LegacyContributionDay[];
	rejectedDays: number;
	rawDays: number;
	total: number;
	complete: boolean;
	unreadableFields: string[];
} {
	const { document } = parseHTML(html);
	const days: LegacyContributionDay[] = [];
	let rejectedDays = 0;
	const cells = Array.from(document.querySelectorAll(
		"td.ContributionCalendar-day, rect.day",
	)).filter(node => node.closest(OVERLAY_SELECTOR) === null);
	const unreadableFields: string[] = [];
	const calendars = new Set([
		...Array.from(document.querySelectorAll(".ContributionCalendar, .ContributionCalendar-grid, .js-calendar-graph, .js-yearly-contributions")),
		...cells.map(cell => cell.closest("table, svg") ?? cell),
	].filter(node => node.closest(OVERLAY_SELECTOR) === null));
	if (cells.some(isUnreadable) || Array.from(calendars).some(isUnreadable))
		unreadableFields.push("calendar");
	const seenDates = new Set<string>();
	for (const cell of cells) {
		const date = cell.getAttribute("data-date");
		if (date === null || !/^\d{4}-\d{2}-\d{2}$/u.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) {
			rejectedDays += 1;
			continue;
		}
		const dataCount = cell.getAttribute("data-count");
		let count: number | null =
			dataCount !== null && /^\d+$/u.test(dataCount) ? Number(dataCount) : null;
		if (count === null) {
			const id = cell.getAttribute("id");
			const tooltip = id
				? document.querySelector(`tool-tip[for="${id}"]`)
				: null;
			const tooltipText =
				tooltip === null
					? (cell.getAttribute("aria-label") ?? "")
					: text(tooltip);
			const match = /([\d,]+|No)\s+contribution/iu.exec(tooltipText);
			if (match?.[1])
				count = /^no$/iu.test(match[1])
					? 0
					: Number(match[1].replaceAll(",", ""));
		}
		if (count === null || !Number.isSafeInteger(count)) {
			rejectedDays += 1;
			continue;
		}
		if (seenDates.has(date)) {
			rejectedDays += 1;
			continue;
		}
		seenDates.add(date);
		const rawLevel = cell.getAttribute("data-level");
		const level = rawLevel === null || !/^[0-4]$/u.test(rawLevel) ? null : Number(rawLevel);
		if (level === null) {
			rejectedDays += 1;
			continue;
		}
		days.push({
			count,
			date,
			id: date,
			level,
		});
	}
	const heading = contributionHeading(document);
	if (heading !== null && isUnreadable(heading)) unreadableFields.push("total");
	const headingMatch = /([\d,]+)\s+contribution/iu.exec(
		sourceText(heading) ?? "",
	);
	return {
		days,
		rejectedDays,
		rawDays: cells.length,
		complete: unreadableFields.length === 0 && rejectedDays === 0 && headingMatch?.[1] !== undefined && Number(headingMatch[1].replaceAll(",", "")) === days.reduce((sum, day) => sum + day.count, 0),
		unreadableFields: headingMatch?.[1] || unreadableFields.includes("total") ? unreadableFields : [...unreadableFields, "total"],
		total: headingMatch?.[1]
			? toInt(headingMatch[1])
			: days.reduce((total, day) => total + day.count, 0),
	};
}

export function buildContributionSnapshot(
	graphs: Array<{ days: LegacyContributionDay[]; total: number; year: number; complete?: boolean }>,
	fetchedAt: string,
): LegacyContributions | null {
	const fetchedDate = /^\d{4}-\d{2}-\d{2}/u.exec(fetchedAt)?.[0];
	const fetchedYear = fetchedDate ? Number(fetchedDate.slice(0, 4)) : NaN;
	if (
		!fetchedDate ||
		!Number.isFinite(fetchedYear) ||
		graphs.length !== 4 ||
		new Set(graphs.map((graph) => graph.year)).size !== 4 ||
		graphs.some((graph, index) => graph.year !== fetchedYear - index || graph.complete === false)
	) {
		return null;
	}
	const rollingStart = new Date(`${fetchedDate}T00:00:00Z`);
	rollingStart.setUTCDate(rollingStart.getUTCDate() - 364);
	const rollingStartDate = rollingStart.toISOString().slice(0, 10);
	for (const [index, graph] of graphs.entries()) {
		if (new Set(graph.days.map((day) => day.date)).size !== graph.days.length)
			return null;
		const actualDates = new Set(graph.days.map((day) => day.date));
		let date = index === 0 ? rollingStartDate : `${graph.year}-01-01`;
		const endDate = index === 0 ? fetchedDate : `${graph.year}-12-31`;
		let expectedDays = 0;
		while (date <= endDate) {
			if (!actualDates.has(date)) return null;
			expectedDays += 1;
			const nextDate = new Date(`${date}T00:00:00Z`);
			nextDate.setUTCDate(nextDate.getUTCDate() + 1);
			date = nextDate.toISOString().slice(0, 10);
		}
		if (index !== 0 && actualDates.size !== expectedDays) return null;
	}
	const daysByDate = new Map<string, LegacyContributionDay>();
	for (const [index, graph] of graphs.entries()) {
		for (const day of graph.days) {
			if (
				index === 0 &&
				(day.date < rollingStartDate || day.date > fetchedDate)
			)
				continue;
			if (!daysByDate.has(day.date)) daysByDate.set(day.date, day);
		}
	}
	const days = [...daysByDate.values()].sort((a, b) =>
		a.date.localeCompare(b.date),
	);
	if (days.length === 0) return null;
	const monthTotals = new Map<string, number>();
	for (const day of days) {
		const month = day.date.slice(0, 7);
		monthTotals.set(month, (monthTotals.get(month) ?? 0) + day.count);
	}
	const topDay = days.reduce<LegacyContributionDay | null>(
		(best, day) => (best === null || day.count > best.count ? day : best),
		null,
	);
	const latestYearGraph = graphs[0];
	if (!latestYearGraph) return null;
	return {
		days,
		fetchedAt,
		monthlyTotals: [...monthTotals]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([month, count]) => ({ count, month })),
		topDay:
			topDay && topDay.count > 0
				? { count: topDay.count, date: topDay.date }
				: null,
		totalContributionsLastYear: latestYearGraph.total,
		yearTotals: graphs.map(({ total, year }) => ({ total, year })),
	};
}


export function parseLegacyEvent(raw: unknown): EventRow | null {
	return parseLegacyEventPageItem(raw).row;
}

export function parseLegacyEventPageItem(raw: unknown): ParsedItem<EventRow> {
	const source = objectValue(raw);
	const publicValue = source.public;
	const hasPayload = typeof source.payload === "object" && source.payload !== null && !Array.isArray(source.payload);
	const value = legacyEventValues({
		...source,
		public: typeof publicValue === "boolean" ? publicValue : undefined,
	});
	if (value === null) return { row: null, complete: false, unreadableFields: ["identity"] };
	const row: EventRow = { ...value };
	const unreadableFields: string[] = [];
	const details = ["action", "title", "body", "url", "branch", "commits"] as const;
	if (typeof publicValue !== "boolean") {
		delete row.isPublic;
		unreadableFields.push("public");
	}
	if (!hasPayload) {
		for (const key of details) delete row[key];
		unreadableFields.push("payload");
		return { row, complete: false, unreadableFields };
	}
	const payload = objectValue(source.payload);
	const pr = objectValue(payload.pull_request);
	const issue = objectValue(payload.issue);
	const comment = objectValue(payload.comment);
	const review = objectValue(payload.review);
	const release = objectValue(payload.release);
	const forkee = objectValue(payload.forkee);
	const nullableText = (input: unknown): boolean => input === null || typeof input === "string";
	const nullableNumber = (input: unknown): boolean => input === null || (typeof input === "number" && Number.isSafeInteger(input) && input >= 0);
	const requireField = (key: typeof details[number], readable: boolean): void => {
		if (!readable) {
			delete row[key];
			unreadableFields.push(key);
		}
	};
	switch (value.type) {
		case "PushEvent": {
			const commits = Array.isArray(payload.commits) ? payload.commits : undefined;
			// GitHub may omit commit details. Legacy represents their absence as null.
			requireField("title", payload.commits === undefined || (commits !== undefined && (commits.length === 0 || typeof objectValue(commits[0]).message === "string")));
			requireField("branch", typeof payload.ref === "string");
			requireField("commits", commits !== undefined
				? commits.every((commit) => typeof objectValue(commit).message === "string")
				: payload.commits === undefined && (payload.size === undefined || nullableNumber(payload.size)));
			break;
		}
		case "PullRequestEvent": {
			const expectedApiUrl = `https://api.github.com/repos/${value.repo}/pulls/${pr.number}`;
			const validNumber = typeof pr.number === "number" && Number.isSafeInteger(pr.number) && pr.number > 0;
			const htmlPrefix = `https://github.com/${value.repo}/pull/`;
			const htmlNumber = typeof pr.html_url === "string" && pr.html_url.startsWith(htmlPrefix)
				? Number(pr.html_url.slice(htmlPrefix.length)) : NaN;
			const matchingHtmlUrl = Number.isSafeInteger(htmlNumber) && htmlNumber > 0 &&
				pr.html_url === `${htmlPrefix}${htmlNumber}` &&
				(pr.number === undefined || pr.number === htmlNumber) &&
				(payload.number === undefined || payload.number === htmlNumber);
			// The Events API also returns a compact PR reference without title/body.
			// Accept that known source shape; arbitrary missing detail still vetoes.
			const compact = pr.title === undefined && pr.body === undefined &&
				typeof pr.id === "number" && Number.isSafeInteger(pr.id) && pr.id > 0 &&
				validNumber &&
				payload.number === pr.number &&
				pr.url === expectedApiUrl &&
				(pr.html_url === undefined || matchingHtmlUrl) &&
				typeof objectValue(pr.head).ref === "string" && objectValue(pr.head).ref !== "" &&
				typeof objectValue(pr.base).ref === "string" && objectValue(pr.base).ref !== "";
			requireField("action", typeof payload.action === "string");
			requireField("title", compact || nullableText(pr.title));
			if (pr.title === null) row.title = null;
			requireField("body", compact || nullableText(pr.body));
			requireField("url", pr.html_url === null || matchingHtmlUrl ||
				(pr.html_url === undefined && validNumber && pr.url === expectedApiUrl));
			if (pr.html_url === null) row.url = null;
			requireField("branch", nullableText(objectValue(pr.head).ref));
			break;
		}
		case "PullRequestReviewEvent":
			requireField("action", typeof review.state === "string");
			requireField("title", nullableText(pr.title));
			requireField("body", nullableText(review.body));
			requireField("url", nullableText(review.html_url));
			break;
		case "PullRequestReviewCommentEvent":
		case "CommitCommentEvent":
			requireField("body", nullableText(comment.body));
			requireField("url", nullableText(comment.html_url));
			break;
		case "IssuesEvent":
			requireField("action", typeof payload.action === "string");
			requireField("title", nullableText(issue.title));
			if (issue.title === null) row.title = null;
			requireField("body", nullableText(issue.body));
			requireField("url", nullableText(issue.html_url));
			break;
		case "IssueCommentEvent":
			requireField("title", nullableText(issue.title));
			requireField("body", nullableText(comment.body));
			requireField("url", nullableText(comment.html_url));
			break;
		case "CreateEvent":
		case "DeleteEvent":
			requireField("action", typeof payload.ref_type === "string");
			requireField("title", nullableText(payload.ref));
			requireField("branch", typeof payload.ref_type === "string" && (payload.ref_type !== "branch" || typeof payload.ref === "string"));
			if (value.type === "CreateEvent") requireField("body", nullableText(payload.description));
			break;
		case "ForkEvent":
			requireField("title", typeof forkee.full_name === "string");
			requireField("url", typeof forkee.html_url === "string");
			break;
		case "WatchEvent":
			requireField("action", typeof payload.action === "string");
			break;
		case "ReleaseEvent":
			requireField("action", typeof payload.action === "string");
			if (release.name === undefined && typeof release.tag_name === "string") unreadableFields.push("title");
			else requireField("title", nullableText(release.name));
			if (release.name === null) row.title = null;
			requireField("body", nullableText(release.body));
			requireField("url", nullableText(release.html_url));
			break;
		case "GollumEvent": {
			const pages = Array.isArray(payload.pages) ? payload.pages : undefined;
			const first = objectValue(pages?.[0]);
			requireField("title", pages !== undefined && (pages.length === 0 || nullableText(first.title)));
			requireField("url", pages !== undefined && (pages.length === 0 || nullableText(first.html_url)));
			requireField("body", pages !== undefined);
			if (pages?.some((page) => typeof page !== "object" || page === null || Array.isArray(page))) unreadableFields.push("pages");
			break;
		}
		default:
			for (const key of ["action", "title", "body", "url"] as const)
				requireField(key, nullableText(payload[key]));
			requireField("branch", nullableText(payload.ref));
			requireField("commits", nullableNumber(payload.size));
	}
	return { row, complete: unreadableFields.length === 0, unreadableFields };
}

function legacyEventValues(raw: unknown): LegacyEvent | null {
	const parsed = eventApiSchema.safeParse(raw);
	if (!parsed.success) return null;
	const current = eventRecord({
		id: parsed.data.id,
		type: parsed.data.type,
		created_at: parsed.data.created_at,
		repo: parsed.data.repo,
		...(parsed.data.public === undefined ? {} : { public: parsed.data.public }),
	});
	if (!current) return null;
	const payload = objectValue(parsed.data.payload);
	const pullRequest = objectValue(payload.pull_request);
	const issue = objectValue(payload.issue);
	const comment = objectValue(payload.comment);
	const review = objectValue(payload.review);
	const release = objectValue(payload.release);
	const forkee = objectValue(payload.forkee);
	const ref = stringValue(payload.ref);
	const branch = (value: unknown): string | null => {
		const rawRef = stringValue(value);
		return rawRef?.startsWith("refs/heads/")
			? rawRef.slice("refs/heads/".length)
			: rawRef;
	};
	const firstCommit = Array.isArray(payload.commits)
		? objectValue(payload.commits[0])
		: {};
	const pages = Array.isArray(payload.pages) ? payload.pages : [];
	const firstPage = objectValue(pages[0]);
	const extras: Partial<LegacyEvent> = {};
	switch (parsed.data.type) {
		case "PushEvent":
			extras.action = "pushed";
			extras.title = stringValue(firstCommit.message)?.split("\n")[0] ?? null;
			extras.branch = branch(ref);
			extras.commits = Array.isArray(payload.commits)
				? payload.commits.length
				: numberValue(payload.size);
			break;
		case "PullRequestEvent": {
			const head = objectValue(pullRequest.head);
			const prBranch = stringValue(head.ref);
			const number = numberValue(pullRequest.number);
			extras.action = stringValue(payload.action);
			extras.title =
				stringValue(pullRequest.title) ??
				(number === null
					? null
					: `PR #${number}${prBranch ? ` (${prBranch})` : ""}`);
			extras.body = stringValue(pullRequest.body)?.slice(0, 280) ?? null;
			extras.url =
				stringValue(pullRequest.html_url) ??
				(pullRequest.url === `https://api.github.com/repos/${parsed.data.repo.name}/pulls/${number}`
					? `https://github.com/${parsed.data.repo.name}/pull/${number}` : null);
			extras.branch = prBranch;
			break;
		}
		case "PullRequestReviewEvent":
			extras.action = stringValue(review.state)?.toLowerCase() ?? null;
			extras.title = stringValue(pullRequest.title);
			extras.body = stringValue(review.body)?.slice(0, 280) ?? null;
			extras.url = stringValue(review.html_url);
			break;
		case "PullRequestReviewCommentEvent":
			extras.action = "review_comment";
			extras.body = stringValue(comment.body)?.slice(0, 280) ?? null;
			extras.url = stringValue(comment.html_url);
			break;
		case "IssuesEvent": {
			const number = numberValue(issue.number);
			extras.action = stringValue(payload.action);
			extras.title =
				stringValue(issue.title) ??
				(number === null ? null : `Issue #${number}`);
			extras.body = stringValue(issue.body)?.slice(0, 280) ?? null;
			extras.url = stringValue(issue.html_url);
			break;
		}
		case "IssueCommentEvent":
			extras.action = "commented";
			extras.title = stringValue(issue.title);
			extras.body = stringValue(comment.body)?.slice(0, 280) ?? null;
			extras.url = stringValue(comment.html_url);
			break;
		case "CreateEvent":
			extras.action = stringValue(payload.ref_type)
				? `created_${stringValue(payload.ref_type)}`
				: "created";
			extras.title = ref;
			extras.body = stringValue(payload.description);
			extras.branch = payload.ref_type === "branch" ? ref : null;
			break;
		case "DeleteEvent":
			extras.action = stringValue(payload.ref_type)
				? `deleted_${stringValue(payload.ref_type)}`
				: "deleted";
			extras.title = ref;
			extras.branch = payload.ref_type === "branch" ? ref : null;
			break;
		case "ForkEvent":
			extras.action = "forked";
			extras.title = stringValue(forkee.full_name);
			extras.url = stringValue(forkee.html_url);
			break;
		case "WatchEvent":
			extras.action = stringValue(payload.action) ?? "starred";
			break;
		case "ReleaseEvent":
			extras.action = stringValue(payload.action);
			extras.title = stringValue(release.name) ?? stringValue(release.tag_name);
			extras.body = stringValue(release.body)?.slice(0, 280) ?? null;
			extras.url = stringValue(release.html_url);
			break;
		case "GollumEvent":
			extras.action = "wiki_edit";
			extras.title = stringValue(firstPage.title);
			extras.body = pages.length > 1 ? `${pages.length} pages edited` : null;
			extras.url = stringValue(firstPage.html_url);
			break;
		case "CommitCommentEvent":
			extras.action = "commit_comment";
			extras.body = stringValue(comment.body)?.slice(0, 280) ?? null;
			extras.url = stringValue(comment.html_url);
			break;
	}
	if (Object.keys(extras).length === 0) {
		extras.action = stringValue(payload.action);
		extras.body = stringValue(payload.body);
		extras.title = stringValue(payload.title);
		extras.url = stringValue(payload.url);
		extras.branch = branch(ref);
		extras.commits = numberValue(payload.size);
	}
	return {
		action: extras.action ?? null,
		body: extras.body ?? null,
		branch: extras.branch ?? null,
		commits: extras.commits ?? null,
		createdAt: parsed.data.created_at,
		id: parsed.data.id,
		isPublic: current.is_public === true,
		repo: parsed.data.repo.name,
		repoUrl: `https://github.com/${parsed.data.repo.name}`,
		title: extras.title ?? null,
		type: parsed.data.type,
		url: extras.url ?? null,
	};
}

function numberValue(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function objectValue(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function stringValue(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}


export function parseLegacyHistoryItem(
	raw: unknown,
	type: "issue" | "pr",
): HistoryRow | null {
	return parseLegacyHistoryPageItem(raw, type).row;
}

export function parseLegacyHistoryPageItem(
	raw: unknown,
	type: "issue" | "pr",
): ParsedItem<HistoryRow> {
	const item = objectValue(raw);
	const repositoryApiUrl = stringValue(item.repository_url);
	const repo = repositoryApiUrl?.startsWith("https://api.github.com/repos/")
		? repositoryName(repositoryApiUrl.replace("https://api.github.com/repos/", "https://github.com/"))
		: null;
	const positiveId = (input: unknown): number | undefined =>
		typeof input === "number" && Number.isSafeInteger(input) && input > 0 ? input : undefined;
	const number = positiveId(item.number);
	const rawId = positiveId(item.id);
	if (!repo || (rawId === undefined && number === undefined))
		return { row: null, complete: false, unreadableFields: ["identity"] };
	const row: HistoryRow = {
		id: `gh-${type}-${rawId ?? number}`,
		type,
		repo,
		repoUrl: `https://github.com/${repo}`,
	};
	const unreadableFields: string[] = [];
	const nullableText = (input: unknown): string | null | undefined =>
		input === null || typeof input === "string" ? input : undefined;
	const count = (input: unknown): number | undefined =>
		typeof input === "number" && Number.isSafeInteger(input) && input >= 0 ? input : undefined;
	recordField(row, "number", number, unreadableFields);
	recordField(row, "title", nullableText(item.title), unreadableFields);
	const body = nullableText(item.body);
	recordField(row, "body", typeof body === "string" ? body.slice(0, 500) : body, unreadableFields);
	recordField(row, "state", nullableText(item.state), unreadableFields);
	for (const [key, sourceKey] of [
		["createdAt", "created_at"],
		["updatedAt", "updated_at"],
		["closedAt", "closed_at"],
	] as const) {
		const value = nullableText(item[sourceKey]);
		recordField(row, key, typeof value === "string" && !Number.isFinite(Date.parse(value)) ? undefined : value, unreadableFields);
	}
	recordField(row, "url", nullableText(item.html_url), unreadableFields);
	recordField(row, "comments", count(item.comments), unreadableFields);
	recordField(row, "reactionsTotal", count(objectValue(item.reactions).total_count), unreadableFields);
	if (Array.isArray(item.labels)) {
		row.labels = [];
		for (const label of item.labels) {
			const name = stringValue(objectValue(label).name);
			if (name === null) unreadableFields.push("labels");
			else row.labels.push(name);
		}
	} else unreadableFields.push("labels");
	if (type === "issue") {
		row.mergedAt = null;
		row.isDraft = false;
	} else {
		const merged = nullableText(objectValue(item.pull_request).merged_at);
		recordField(row, "mergedAt", typeof merged === "string" && !Number.isFinite(Date.parse(merged)) ? undefined : merged, unreadableFields);
		if (typeof item.draft === "boolean" && row.mergedAt !== undefined && row.state !== undefined)
			row.isDraft = row.mergedAt === null && row.state === "open" && item.draft;
		else unreadableFields.push("isDraft");
	}
	return { row, complete: unreadableFields.length === 0, unreadableFields };
}

