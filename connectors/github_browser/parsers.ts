// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { parseHTML } from "linkedom";
import { z } from "zod";
import { eventRecord } from "../github/parsers.ts";
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
	if (!href) return null;
	try {
		const url = new URL(href, "https://github.com");
		return url.hostname === "github.com" ? url.href : null;
	} catch {
		return null;
	}
}

function repositoryName(href: string | null): string | null {
	if (!href) return null;
	try {
		const parts = new URL(href, "https://github.com").pathname
			.split("/")
			.filter(Boolean);
		if (parts.length !== 2) return null;
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

export function parseProfileHtml(
	html: string,
	profileUrl: string,
): LegacyProfile | null {
	const { document } = parseHTML(html);
	const username = text(document.querySelector("span.p-nickname"));
	if (!/^[a-zA-Z0-9-]{1,39}$/u.test(username)) return null;

	const pinnedRepositories = Array.from(
		document.querySelectorAll(
			".js-pinned-items-reorder-container li, ol.pinned-items-reorder-list li",
		),
	)
		.map((item) => {
			const link = item.querySelector('a[href*="/"]');
			const href = link?.getAttribute("href") ?? null;
			const fullName = repositoryName(href);
			if (!fullName) return null;
			const stars = text(item.querySelector('a[href$="/stargazers"]'));
			const language = text(
				item.querySelector('[itemprop="programmingLanguage"]'),
			);
			return {
				description: text(item.querySelector("p.pinned-item-desc")),
				fullName,
				language: language || null,
				stars: toInt(stars),
				url: `https://github.com/${fullName}`,
			};
		})
		.filter((item): item is NonNullable<typeof item> => item !== null);

	const organizations = Array.from(
		document.querySelectorAll('a.avatar-group-item[href^="/"]'),
	)
		.map((link) => {
			const href = link.getAttribute("href") ?? "";
			const login = href.replace(/^\//u, "").split("/")[0] ?? "";
			if (!login) return null;
			const image = link.querySelector("img");
			return {
				avatarUrl: image?.getAttribute("src") ?? null,
				label:
					link.getAttribute("aria-label") ??
					image?.getAttribute("alt") ??
					login,
				login,
				url: `https://github.com${href}`,
			};
		})
		.filter((item): item is NonNullable<typeof item> => item !== null);

	const achievements = Array.from(
		document.querySelectorAll(
			'.js-achievement-card img, a[href*="/achievements/"] img',
		),
	)
		.map((image) => {
			const name = (image.getAttribute("alt") ?? "")
				.replace(/^Achievement:\s*/iu, "")
				.trim();
			return name ? { iconUrl: image.getAttribute("src"), name } : null;
		})
		.filter((item): item is NonNullable<typeof item> => item !== null);

	const countMatch = /([\d,]+)\s+contribution/iu.exec(
		text(document.querySelector("h2.f4.text-normal.mb-2")),
	);
	const followers = text(
		document.querySelector(
			'a[href$="?tab=followers"] span, a[href$="?tab=followers"]',
		),
	);
	const following = text(
		document.querySelector(
			'a[href$="?tab=following"] span, a[href$="?tab=following"]',
		),
	);
	const repoCountNode =
		document.querySelector(
			'[data-tab-item="repositories"] .Counter, a[href*="tab=repositories"] .Counter',
		) ??
		document.querySelector(
			'[data-tab-item="repositories"], a[href*="tab=repositories"]',
		);
	const blog = document.querySelector('[itemprop="url"]')?.getAttribute("href");

	return {
		achievements,
		avatarUrl:
			document.querySelector("img.avatar-user")?.getAttribute("src") ?? "",
		bio: text(document.querySelector("div.p-note")),
		company: text(document.querySelector('[itemprop="worksFor"]')),
		contributionsLastYear: countMatch?.[1] ? toInt(countMatch[1]) : null,
		followers: toInt(followers),
		following: toInt(following),
		fullName: text(document.querySelector("span.p-name")),
		location: text(document.querySelector('[itemprop="homeLocation"]')),
		organizations,
		pinnedRepositories,
		profileUrl,
		repositoryCount: toInt(text(repoCountNode)),
		username,
		website: blog ?? "",
	};
}

export function parseRepositoriesHtml(html: string): LegacyRepository[] {
	const { document } = parseHTML(html);
	const records: LegacyRepository[] = [];
	for (const row of document.querySelectorAll("#user-repositories-list li")) {
		const link = row.querySelector("h3 a");
		const url = githubUrl(link?.getAttribute("href"));
		if (!link || !url) continue;
		const topics = Array.from(row.querySelectorAll("a.topic-tag"))
			.map((topic) => text(topic))
			.filter(Boolean);
		records.push({
			description: text(row.querySelector('p[itemprop="description"]')),
			forks: toInt(text(row.querySelector('a[href$="/forks"]'))),
			language: text(row.querySelector('[itemprop="programmingLanguage"]')),
			name: text(link),
			stars: toInt(text(row.querySelector('a[href$="/stargazers"]'))),
			topics,
			updatedAt:
				row.querySelector("relative-time")?.getAttribute("datetime") ?? null,
			url,
			visibility: text(row.querySelector("span.Label")) || "Public",
		});
	}
	return records;
}

export function parseStarredHtml(html: string): LegacyStarredRepository[] {
	const { document } = parseHTML(html);
	const records = new Map<string, LegacyStarredRepository>();
	for (const row of document.querySelectorAll(
		"#user-starred-repos li, #user-profile-frame li, main li",
	)) {
		let repo: string | null = null;
		let repoLink: Element | null = null;
		for (const link of row.querySelectorAll("h3 a[href], a[href]")) {
			const candidate = repositoryName(link.getAttribute("href"));
			if (candidate) {
				repo = candidate;
				repoLink = link;
				break;
			}
		}
		if (!repo || !repoLink) continue;
		const url = `https://github.com/${repo}`;
		if (records.has(url)) continue;
		const language = text(
			row.querySelector(
				'[itemprop="programmingLanguage"], [data-ga-click*="Repository, language"]',
			),
		);
		records.set(url, {
			description: text(row.querySelector("p")),
			fullName: text(repoLink) || repo,
			language: language || null,
			stars: toInt(text(row.querySelector('a[href$="/stargazers"]'))),
			updatedAt:
				row.querySelector("relative-time")?.getAttribute("datetime") ?? null,
			url,
		});
	}
	return [...records.values()];
}

export function inspectInventoryPage(
	html: string,
	stream: "repositories" | "starred",
	username: string,
	page: number,
	rowCount: number,
): { valid: boolean; nextUrl: string | null } {
	const { document } = parseHTML(html);
	const list =
		stream === "repositories"
			? document.querySelector("#user-repositories-list")
			: document.querySelector("#user-starred-repos, #user-profile-frame");
	const emptyText = document.querySelector("main")?.textContent ?? "";
	const explicitEmpty =
		stream === "repositories"
			? /(?:doesn't have any|has no) (?:public )?repositories yet/iu.test(
					emptyText,
				)
			: /(?:hasn't starred any|has no starred) repositories yet/iu.test(
					emptyText,
				);
	const next = document.querySelector('a.next_page[rel="next"]');
	if (rowCount === 0 && (!explicitEmpty || page !== 1))
		return { valid: false, nextUrl: null };
	if (rowCount > 0 && !list) return { valid: false, nextUrl: null };
	if (!next) return { valid: rowCount > 0 || explicitEmpty, nextUrl: null };
	const href = next.getAttribute("href");
	if (!href || rowCount === 0) return { valid: false, nextUrl: null };
	let url: URL;
	try {
		url = new URL(href, "https://github.com");
	} catch {
		return { valid: false, nextUrl: null };
	}
	const expectedTab = stream === "repositories" ? "repositories" : "stars";
	const valid =
		url.origin === "https://github.com" &&
		url.pathname === `/${username}` &&
		url.searchParams.get("tab") === expectedTab;
	return {
		valid,
		nextUrl: valid ? url.href : null,
	};
}

export function parseContributionHtml(html: string): {
	days: LegacyContributionDay[];
	total: number;
} {
	const { document } = parseHTML(html);
	const days: LegacyContributionDay[] = [];
	for (const cell of document.querySelectorAll(
		"td.ContributionCalendar-day[data-date], rect.day[data-date]",
	)) {
		const date = cell.getAttribute("data-date");
		if (!date) continue;
		const dataCount = cell.getAttribute("data-count");
		let count: number | null =
			dataCount !== null && /^\d+$/u.test(dataCount) ? Number(dataCount) : null;
		if (count === null) {
			const id = cell.getAttribute("id");
			const tooltip = id
				? document.querySelector(`tool-tip[for="${id}"]`)
				: null;
			const match = /([\d,]+|No)\s+contribution/iu.exec(
				text(tooltip) || cell.getAttribute("aria-label") || "",
			);
			if (match?.[1])
				count = /^no$/iu.test(match[1])
					? 0
					: Number(match[1].replaceAll(",", ""));
		}
		if (count === null || !Number.isSafeInteger(count)) continue;
		const rawLevel = cell.getAttribute("data-level");
		const level = rawLevel === null ? null : Number(rawLevel);
		days.push({
			count,
			date,
			level: level !== null && Number.isFinite(level) ? level : null,
		});
	}
	const headingMatch = /([\d,]+)\s+contribution/iu.exec(
		text(document.querySelector("h2.f4.text-normal.mb-2")),
	);
	return {
		days,
		total: headingMatch?.[1]
			? toInt(headingMatch[1])
			: days.reduce((total, day) => total + day.count, 0),
	};
}

export function buildContributionSnapshot(
	graphs: Array<{ days: LegacyContributionDay[]; total: number; year: number }>,
	fetchedAt: string,
): LegacyContributions | null {
	const fetchedDate = /^\d{4}-\d{2}-\d{2}/u.exec(fetchedAt)?.[0];
	const fetchedYear = fetchedDate ? Number(fetchedDate.slice(0, 4)) : NaN;
	if (
		!fetchedDate ||
		!Number.isFinite(fetchedYear) ||
		graphs.length !== 4 ||
		new Set(graphs.map((graph) => graph.year)).size !== 4 ||
		graphs.some((graph, index) => graph.year !== fetchedYear - index)
	) {
		return null;
	}
	const rollingStart = new Date(`${fetchedDate}T00:00:00Z`);
	rollingStart.setUTCDate(rollingStart.getUTCDate() - 364);
	const rollingStartDate = rollingStart.toISOString().slice(0, 10);
	for (const [index, graph] of graphs.entries()) {
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

export function parseLegacyEvent(raw: unknown): LegacyEvent | null {
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
				? payload.commits.length || numberValue(payload.size)
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
			extras.title =
				stringValue(release.name) ?? stringValue(release.tag_name);
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
): LegacyHistoryItem | null {
	const item = objectValue(raw);
	const repositoryApiUrl = stringValue(item.repository_url);
	const repo = repositoryApiUrl?.replace("https://api.github.com/repos/", "");
	const number = typeof item.number === "number" ? item.number : null;
	const rawId = typeof item.id === "number" ? String(item.id) : null;
	if (!repo || (!rawId && number === null)) return null;
	const pullRequest = objectValue(item.pull_request);
	const reactions = objectValue(item.reactions);
	const labels = Array.isArray(item.labels)
		? item.labels
				.map((label) => stringValue(objectValue(label).name))
				.filter((label): label is string => label !== null)
		: [];
	const createdAt = stringValue(item.created_at);
	const updatedAt = stringValue(item.updated_at);
	const mergedAt = stringValue(pullRequest.merged_at);
	const state = stringValue(item.state);
	const draft =
		type === "pr" &&
		mergedAt === null &&
		state === "open" &&
		item.draft === true;
	return {
		body: stringValue(item.body)?.slice(0, 500) ?? null,
		closedAt: stringValue(item.closed_at),
		comments: typeof item.comments === "number" ? item.comments : 0,
		createdAt,
		id: `gh-${type}-${rawId ?? String(number)}`,
		isDraft: draft,
		labels,
		mergedAt,
		number,
		reactionsTotal:
			typeof reactions.total_count === "number" ? reactions.total_count : 0,
		repo,
		repoUrl: `https://github.com/${repo}`,
		state,
		title: stringValue(item.title),
		type,
		updatedAt,
		url: stringValue(item.html_url),
	};
}
