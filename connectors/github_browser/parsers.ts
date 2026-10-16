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
	rows: T[];
	rejectedRows: number;
	rawRows: number;
	complete: boolean;
	unreadableFields: string[];
}

// Menus and dialogs embedded in a row (star-list pickers, filter menus) carry
// their own loading panels and menu items. They are not part of the data.
const OVERLAY_SELECTOR =
	'dialog, [role="dialog"], [role="menu"], [role="listbox"], action-menu, select-panel, details-menu, [popover]';

function insideOverlay(node: Element, scope: Element): boolean {
	const overlay = node.closest(OVERLAY_SELECTOR);
	return overlay !== null && overlay !== scope && scope.contains(overlay);
}

function isUnreadable(node: Element): boolean {
	return (
		node.closest('[aria-busy="true"]') !== null ||
		Array.from(
			node.querySelectorAll('[aria-busy="true"], .AnimatedEllipsis, .loading'),
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

function cardRows(list: Element | null): Element[] {
	if (list === null) return [];
	return Array.from(list.querySelectorAll("li")).filter((row) => {
		if (insideOverlay(row, list)) return false;
		const parentRow = row.parentElement?.closest("li");
		return !parentRow || !list.contains(parentRow);
	});
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
		document.querySelector("h2#js-contribution-activity-description") ??
		Array.from(document.querySelectorAll("h2.f4.text-normal.mb-2")).find(
			(heading) => /\bcontributions?\b/iu.test(text(heading)),
		) ??
		null
	);
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
	recordField(row, "followers", sourceCount(document.querySelector('a[href$="?tab=followers"] span, a[href$="?tab=followers"]')), unreadableFields);
	recordField(row, "following", sourceCount(document.querySelector('a[href$="?tab=following"] span, a[href$="?tab=following"]')), unreadableFields);
	// The tab shows the count in a counter label plus a visually hidden "(n)" copy.
	const repoCountNode = document.querySelector('[data-tab-item="repositories"] .Counter, a[href*="tab=repositories"] .Counter, [data-tab-item="repositories"] [class*="CounterLabel-CounterLabel"], a[href*="tab=repositories"] [class*="CounterLabel-CounterLabel"]')
		?? document.querySelector('[data-tab-item="repositories"], a[href*="tab=repositories"]');
	recordField(row, "repositoryCount", sourceCount(repoCountNode), unreadableFields);
	const contributionText = sourceText(contributionHeading(document));
	const countMatch = contributionText === undefined ? null : /^([\d,]+)\s+contributions?\b/iu.exec(contributionText);
	recordField(row, "contributionsLastYear", countMatch?.[1] ? toInt(countMatch[1]) : undefined, unreadableFields);


	const pinnedList = document.querySelector(".js-pinned-items-reorder-container, ol.pinned-items-reorder-list");
	if (pinnedList === null) {
		unreadableFields.push("pinnedRepositories");
	} else {
		const pinnedRows = cardRows(pinnedList);
		if (isUnreadable(pinnedList)) unreadableFields.push("pinnedRepositories");
		if (pinnedRows.length > 0 || !isUnreadable(pinnedList)) row.pinnedRepositories = [];
		for (const item of pinnedRows) {
			const link = item.querySelector("a[href]");
			const fullName = repositoryName(link?.getAttribute("href") ?? null);
			if (!fullName || !sourceText(link)) {
				rejectedEntries += 1;
				continue;
			}
			const description = sourceText(item.querySelector("p.pinned-item-desc"));
			const language = sourceText(item.querySelector('[itemprop="programmingLanguage"]'));
			const stars = sourceCount(item.querySelector('a[href$="/stargazers"]'));
			if (description === undefined || language === undefined || stars === undefined) rejectedEntries += 1;
			row.pinnedRepositories?.push({
				fullName,
				url: `https://github.com/${fullName}`,
				...(description === undefined ? {} : { description }),
				...(language === undefined ? {} : { language }),
				...(stars === undefined ? {} : { stars }),
			});
		}
	}

	const organizations = Array.from(document.querySelectorAll(".avatar-group-item"));
	const orgList = document.querySelector(".avatar-group, [data-testid='organizations'], [aria-label='Organizations']");
	if (orgList !== null && isUnreadable(orgList)) unreadableFields.push("organizations");
	if (organizations.length === 0 && (orgList === null || isUnreadable(orgList))) {
		if (!unreadableFields.includes("organizations")) unreadableFields.push("organizations");
	} else {
		row.organizations = [];
		for (const link of organizations) {
			const href = githubUrl(link.getAttribute("href"));
			const path = href ? new URL(href).pathname : "";
			const login = /^\/([a-zA-Z0-9-]{1,39})$/u.exec(path)?.[1];
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

	const achievementSelector = '.js-achievement-card, a[href*="/achievements/"], a[href*="achievement="][href*="tab=achievements"]';
	const achievementCards = Array.from(document.querySelectorAll(achievementSelector))
		.filter((card) => !card.parentElement?.closest(achievementSelector));
	const achievementList = document.querySelector(".profile-achievements, .js-profile-achievements, [data-testid='achievements']");
	if (achievementList !== null && isUnreadable(achievementList)) unreadableFields.push("achievements");
	if (achievementCards.length === 0 && (achievementList === null || isUnreadable(achievementList))) {
		if (!unreadableFields.includes("achievements")) unreadableFields.push("achievements");
	} else {
		row.achievements = [];
		const seenAchievements = new Set<string>();
		for (const card of achievementCards) {
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
		const missing: string[] = [];
		recordField(row, "description", sourceText(source.querySelector('p[itemprop="description"]')), missing);
		recordField(row, "language", sourceText(source.querySelector('[itemprop="programmingLanguage"]')), missing);
		recordField(row, "stars", sourceCount(source.querySelector('a[href$="/stargazers"]')), missing);
		recordField(row, "forks", sourceCount(source.querySelector('a[href$="/forks"]')), missing);
		recordField(row, "visibility", sourceText(source.querySelector("span.Label")), missing);
		recordField(row, "updatedAt", sourceTime(source.querySelector("relative-time")), missing);
		const topics = Array.from(source.querySelectorAll("a.topic-tag"));
		const topicList = source.querySelector(".topics-row-container, [data-testid='repository-topics']");
		if (topics.length === 0 && (topicList === null || isUnreadable(topicList))) {
			missing.push("topics");
		} else {
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
	return { rows, rejectedRows, rawRows: sourceRows.length, complete: rejectedRows === 0 && unreadableFields.length === 0, unreadableFields };
}

export function parseStarredHtml(html: string): StarredRow[] {
	return parseStarredPage(html).rows;
}

export function parseStarredPage(html: string): ParsedInventory<StarredRow> {
	const { document } = parseHTML(html);
	const list = starredList(document);
	const sourceRows = cardRows(list);
	const rows: StarredRow[] = [];
	const unreadableFields: string[] = [];
	let rejectedRows = 0;
	const seen = new Set<string>();
	for (const [index, source] of sourceRows.entries()) {
		const link = source.querySelector("h3 a[href]");
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
		const missing: string[] = [];
		recordField(row, "description", sourceText(source.querySelector("p")), missing);
		recordField(row, "language", sourceText(source.querySelector('[itemprop="programmingLanguage"], [data-ga-click*="Repository, language"]')), missing);
		recordField(row, "stars", sourceCount(source.querySelector('a[href$="/stargazers"]')), missing);
		recordField(row, "updatedAt", sourceTime(source.querySelector("relative-time")), missing);
		unreadableFields.push(...missing.map((field) => `${index}.${field}`));
		rows.push(row);
	}
	if (list === null || isUnreadable(list)) unreadableFields.push("list");
	return { rows, rejectedRows, rawRows: sourceRows.length, complete: rejectedRows === 0 && unreadableFields.length === 0, unreadableFields };
}

export function inspectInventoryPage(
	page: BrowserPageObservation,
	stream: "repositories" | "starred",
	username: string,
	pageNumber: number,
	parsedRows: number,
	rejectedRows: number,
	noProgress = false,
): { valid: boolean; nextUrl: string | null; reason: string } {
	const { document } = parseHTML(page.html);
	const list =
		stream === "repositories"
			? document.querySelector("#user-repositories-list")
			: starredList(document);
	const emptyScope = list?.querySelector(".blankslate, [data-testid='empty-state']")
		?? (list?.querySelector("li") ? null : list);
	const emptyText = emptyScope?.textContent ?? "";
	const explicitEmpty =
		stream === "repositories"
			? /(?:doesn't have any|has no) (?:public )?repositories yet/iu.test(
					emptyText,
				)
			: /(?:hasn['’]t starred any|has no starred|you don['’]t have any starred) repositories yet/iu.test(
					emptyText,
				);
	const next =
		stream === "starred"
			? document.querySelector(
					'a.next_page[rel="next"], a[rel="next"][href*="page="]',
				)
			: document.querySelector('a.next_page[rel="next"]');
	const href = next?.getAttribute("href") ?? null;
	let nextUrl: string | null = null;
	if (href !== null) {
		try {
			nextUrl = new URL(href, "https://github.com").href;
		} catch {
			nextUrl = href;
		}
	}
	const result = inspectInventoryEnd({
		page,
		username,
		stream,
		pageNumber,
		parsedRows,
		rejectedRows,
		noProgress,
		explicitEmpty,
		hasRecognizedList: list !== null,
		nextUrl,
	});
	const parsed = stream === "repositories" ? parseRepositoriesPage(page.html) : parseStarredPage(page.html);
	if ((result.complete || result.reason === "remaining_continuation") && !parsed.complete)
		return { valid: false, nextUrl: null, reason: "unreadable_fields" };
	return {
		valid: result.complete || result.reason === "remaining_continuation",
		nextUrl: result.nextUrl,
		reason: result.reason,
	};
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
	const cells = document.querySelectorAll(
		"td.ContributionCalendar-day, rect.day",
	);
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
	const headingMatch = /([\d,]+)\s+contribution/iu.exec(
		text(contributionHeading(document)),
	);
	return {
		days,
		rejectedDays,
		rawDays: cells.length,
		complete: rejectedDays === 0 && headingMatch?.[1] !== undefined,
		unreadableFields: headingMatch?.[1] ? [] : ["total"],
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
			requireField("title", commits !== undefined && (commits.length === 0 || typeof objectValue(commits[0]).message === "string"));
			requireField("branch", typeof payload.ref === "string");
			requireField("commits", commits !== undefined
				? commits.every((commit) => typeof objectValue(commit).message === "string")
				: nullableNumber(payload.size));
			break;
		}
		case "PullRequestEvent":
			requireField("action", typeof payload.action === "string");
			requireField("title", nullableText(pr.title));
			if (pr.title === null) row.title = null;
			requireField("body", nullableText(pr.body));
			requireField("url", nullableText(pr.html_url) || typeof pr.url === "string");
			if (pr.html_url === null) row.url = null;
			requireField("branch", nullableText(objectValue(pr.head).ref));
			break;
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
				stringValue(pullRequest.url)?.replace(
					"api.github.com/repos",
					"github.com",
				) ??
				null;
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

