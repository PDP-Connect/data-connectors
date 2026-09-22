// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pure parsers for the GitHub connector. Kept free of fetch / Node I/O so
// they can be unit-tested in isolation (see parsers.test.ts). The HTTP
// client and pagination loops live in index.ts.

import type {
	GitHubContributionsCollection,
	GitHubEvent,
	GitHubGist,
	GitHubIssue,
	GitHubLabelObj,
	GitHubOrgMembership,
	GitHubPinnableItemsConnection,
	GitHubPinnedRepoNode,
	GitHubPullDetail,
	GitHubRepo,
	GitHubStarredEntry,
	GitHubUser,
} from "./types.ts";

// ─── Constants ──────────────────────────────────────────────────────────

export const API_BASE = "https://api.github.com";
const NEXT_LINK_PATTERN = /<([^>]+)>; rel="next"/;
const BODY_MAX_CHARS = 20_000;
const GIST_FILES_CAP = 10;

// ─── Link header parsing ────────────────────────────────────────────────

export function parseNextLink(link: string | null): string | null {
	if (!link) {
		return null;
	}
	const m = NEXT_LINK_PATTERN.exec(link);
	return m?.[1] ? m[1].replace(API_BASE, "") : null;
}

// ─── Small field helpers ────────────────────────────────────────────────

export function labelNames(
	labels: Array<string | GitHubLabelObj> | undefined,
): string[] {
	if (!Array.isArray(labels)) {
		return [];
	}
	const out: string[] = [];
	for (const l of labels) {
		if (typeof l === "string") {
			out.push(l);
		} else if (l?.name) {
			out.push(l.name);
		}
	}
	return out;
}

export function assigneeNames(
	assignees: Array<{ login?: string }> | undefined,
): string[] {
	if (!Array.isArray(assignees)) {
		return [];
	}
	const out: string[] = [];
	for (const a of assignees) {
		if (a.login) {
			out.push(a.login);
		}
	}
	return out;
}

export function reviewerLogins(detail: GitHubPullDetail | null): string[] {
	if (!Array.isArray(detail?.requested_reviewers)) {
		return [];
	}
	const out: string[] = [];
	for (const r of detail.requested_reviewers) {
		if (r.login) {
			out.push(r.login);
		}
	}
	return out;
}

export function repoFullFromUrl(url: string | null | undefined): string | null {
	if (!url) {
		return null;
	}
	return url.replace(`${API_BASE}/repos/`, "");
}

export function truncateBody(body: string | null | undefined): string | null {
	return typeof body === "string" ? body.slice(0, BODY_MAX_CHARS) : null;
}

// ─── Record builders ────────────────────────────────────────────────────

/**
 * User entity record: stable identity and profile fields only.
 * Sampled metrics (followers, following, public_repos, public_gists) are
 * projected into `user_stats` to avoid creating false entity versions when
 * only counts change. See design: split-point-in-time-observation-streams.
 */
export function userRecord(u: GitHubUser): Record<string, unknown> {
	return {
		id: String(u.id),
		login: u.login,
		name: u.name ?? null,
		email: u.email ?? null,
		bio: u.bio ?? null,
		company: u.company ?? null,
		location: u.location ?? null,
		blog: u.blog ?? null,
		twitter_username: u.twitter_username ?? null,
		created_at: u.created_at ?? null,
		updated_at: u.updated_at ?? null,
		avatar_url: u.avatar_url ?? null,
	};
}

/**
 * User stats observation record: sampled metrics keyed by {user_id}:{YYYY-MM-DD}.
 * `observedOn` is the UTC calendar date at the time of the connector run.
 * One record per user per day; same-day re-runs produce the same key (idempotent).
 */
export function userStatsRecord(
	u: GitHubUser,
	observedOn: string,
): Record<string, unknown> {
	return {
		id: `${String(u.id)}:${observedOn}`,
		user_id: String(u.id),
		observed_on: observedOn,
		public_repos: u.public_repos ?? null,
		public_gists: u.public_gists ?? null,
		followers: u.followers ?? null,
		following: u.following ?? null,
	};
}

export function repoRecord(r: GitHubRepo): Record<string, unknown> {
	return {
		id: String(r.id),
		name: r.name,
		full_name: r.full_name,
		owner_login: r.owner?.login ?? null,
		description: r.description ?? null,
		private: r.private,
		fork: r.fork,
		archived: r.archived,
		disabled: r.disabled,
		default_branch: r.default_branch ?? null,
		language: r.language ?? null,
		topics: r.topics ?? [],
		stargazers_count: r.stargazers_count ?? null,
		forks_count: r.forks_count ?? null,
		open_issues_count: r.open_issues_count ?? null,
		watchers_count: r.watchers_count ?? null,
		size_kb: r.size ?? null,
		license_key: r.license?.key ?? null,
		html_url: r.html_url ?? null,
		homepage: r.homepage ?? null,
		created_at: r.created_at ?? null,
		updated_at: r.updated_at ?? null,
		pushed_at: r.pushed_at ?? null,
	};
}

export function starredRecord(
	entry: GitHubStarredEntry,
): Record<string, unknown> | null {
	const { repo } = entry;
	if (!repo) {
		return null;
	}
	return {
		id: String(repo.id),
		full_name: repo.full_name,
		description: repo.description ?? null,
		language: repo.language ?? null,
		stargazers_count: repo.stargazers_count ?? null,
		html_url: repo.html_url ?? null,
		starred_at: entry.starred_at ?? null,
	};
}

export function issueRecord(it: GitHubIssue): Record<string, unknown> {
	return {
		id: String(it.id),
		number: it.number ?? null,
		title: it.title ?? null,
		body: truncateBody(it.body),
		state: it.state ?? null,
		state_reason: it.state_reason ?? null,
		user_login: it.user?.login ?? null,
		user_id: it.user?.id === undefined ? null : String(it.user.id),
		assignees: assigneeNames(it.assignees),
		labels: labelNames(it.labels),
		milestone_title: it.milestone?.title ?? null,
		repository_full_name:
			it.repository?.full_name ?? repoFullFromUrl(it.repository_url),
		repository_id:
			it.repository?.id === undefined ? null : String(it.repository.id),
		html_url: it.html_url ?? null,
		comments: it.comments ?? null,
		reactions_total_count: it.reactions?.total_count ?? null,
		created_at: it.created_at ?? null,
		updated_at: it.updated_at ?? null,
		closed_at: it.closed_at ?? null,
		is_pull_request: Boolean(it.pull_request),
		pull_request_url: it.pull_request?.html_url ?? null,
		draft: it.pull_request ? Boolean(it.draft) : null,
	};
}

function pullRequestCoreFields(it: GitHubIssue): Record<string, unknown> {
	return {
		id: String(it.id),
		number: it.number ?? null,
		title: it.title ?? null,
		body: truncateBody(it.body),
		state: it.state ?? null,
		state_reason: it.state_reason ?? null,
		user_login: it.user?.login ?? null,
		user_id: it.user?.id === undefined ? null : String(it.user.id),
		assignees: assigneeNames(it.assignees),
		labels: labelNames(it.labels),
		milestone_title: it.milestone?.title ?? null,
		html_url: it.html_url ?? null,
		comments: it.comments ?? null,
		reactions_total_count: it.reactions?.total_count ?? null,
		created_at: it.created_at ?? null,
		updated_at: it.updated_at ?? null,
		closed_at: it.closed_at ?? null,
	};
}

function pullRequestDetailFields(
	it: GitHubIssue,
	detail: GitHubPullDetail | null,
): Record<string, unknown> {
	return {
		draft: Boolean(it.draft ?? detail?.draft),
		merged_at: detail?.merged_at ?? null,
		merged_by_login: detail?.merged_by?.login ?? null,
		commits_count: detail?.commits ?? null,
		additions: detail?.additions ?? null,
		deletions: detail?.deletions ?? null,
		changed_files: detail?.changed_files ?? null,
		base_ref: detail?.base?.ref ?? null,
		head_ref: detail?.head?.ref ?? null,
		requested_reviewers: reviewerLogins(detail),
		review_comments_count: detail?.review_comments ?? null,
	};
}

export function pullRequestRecord(
	it: GitHubIssue,
	detail: GitHubPullDetail | null,
	repoFull: string | null,
): Record<string, unknown> {
	return {
		...pullRequestCoreFields(it),
		repository_full_name: repoFull,
		repository_id:
			detail?.base?.repo?.id === undefined ? null : String(detail.base.repo.id),
		...pullRequestDetailFields(it, detail),
	};
}

export function gistRecord(g: GitHubGist): Record<string, unknown> {
	const fileEntries =
		g.files && typeof g.files === "object" ? Object.values(g.files) : [];
	const capped = fileEntries.slice(0, GIST_FILES_CAP);
	const files = capped.map((f) => ({
		filename: f.filename ?? null,
		language: f.language ?? null,
		size: typeof f.size === "number" ? f.size : null,
		raw_url: f.raw_url ?? null,
	}));
	return {
		id: String(g.id),
		description: g.description ?? null,
		public: Boolean(g.public),
		html_url: g.html_url ?? null,
		files,
		files_truncated: fileEntries.length > GIST_FILES_CAP,
		files_total_count: fileEntries.length,
		comments_count: g.comments ?? null,
		created_at: g.created_at ?? null,
		updated_at: g.updated_at ?? null,
	};
}

/**
 * Public event record: GitHub Events API only retains a ~90-day rolling
 * window (undocumented exact retention; GitHub states "recent" events and
 * caps list endpoints at 300 events / 10 pages). `id` is the provider's own
 * stable event id — monotonically increasing, safe as both primary key and
 * dedup key. Returns null for a malformed entry missing a required field
 * (id, type, created_at, repo name) rather than guessing.
 */
export function eventRecord(e: GitHubEvent): Record<string, unknown> | null {
	if (!(e.id && e.type && e.created_at && e.repo?.name)) {
		return null;
	}
	return {
		id: e.id,
		type: e.type,
		created_at: e.created_at,
		repository_full_name: e.repo.name,
		is_public: e.public ?? true,
	};
}

/**
 * Daily contribution-count observation, keyed like `user_stats`
 * ({user_id}:{YYYY-MM-DD}) so re-running the same day is idempotent and a
 * changed day (GitHub backdates commits within its edit window) upserts
 * cleanly rather than accumulating duplicate rows for one calendar date.
 */
export function contributionDayRecord(
	userId: string,
	date: string,
	count: number,
): Record<string, unknown> {
	return {
		id: `${userId}:${date}`,
		user_id: userId,
		date,
		contribution_count: count,
	};
}

/**
 * Flatten the GraphQL `contributionsCollection.contributionCalendar.weeks`
 * shape into a flat list of `{ date, count }`, dropping any day missing a
 * date (defensive against a malformed response) rather than guessing one.
 */
export function flattenContributionDays(
	collection: GitHubContributionsCollection | null | undefined,
): Array<{ count: number; date: string }> {
	const weeks = collection?.contributionCalendar?.weeks ?? [];
	const out: Array<{ count: number; date: string }> = [];
	for (const week of weeks) {
		for (const day of week.contributionDays ?? []) {
			if (typeof day.date === "string" && day.date) {
				out.push({ date: day.date, count: day.contributionCount ?? 0 });
			}
		}
	}
	return out;
}

/**
 * Pinned-repository record: the user's own curated pin list (GraphQL
 * `user.pinnedItems`, filtered to Repository nodes — Gists can also be
 * pinned but are out of scope here). `position` preserves the user's chosen
 * display order (GitHub has no other stable ordering key for pins).
 * Returns null for a node missing its identity (`nameWithOwner`) rather
 * than guessing one.
 */
export function pinnedRepositoryRecord(
	node: GitHubPinnedRepoNode,
	position: number,
): Record<string, unknown> | null {
	if (!node.nameWithOwner) {
		return null;
	}
	const languageNodes = node.languages?.nodes ?? [];
	const languages = languageNodes
		.map((l) => l?.name)
		.filter((name): name is string => Boolean(name));
	return {
		id: node.nameWithOwner,
		full_name: node.nameWithOwner,
		name: node.name ?? null,
		description: node.description ?? null,
		html_url: node.url ?? null,
		languages,
		stargazers_count: node.stargazerCount ?? null,
		forks_count: node.forkCount ?? null,
		position,
	};
}

export function flattenPinnedRepositories(
	connection: GitHubPinnableItemsConnection | null | undefined,
): GitHubPinnedRepoNode[] {
	const nodes = connection?.nodes ?? [];
	return nodes.filter((n): n is GitHubPinnedRepoNode => Boolean(n));
}

/**
 * Organization-membership record: `GET /user/orgs` (needs the `read:org`
 * scope). `id` is the org's own stable numeric id.
 */
export function organizationRecord(
	org: GitHubOrgMembership,
): Record<string, unknown> {
	return {
		id: String(org.id),
		login: org.login,
		description: org.description ?? null,
		avatar_url: org.avatar_url ?? null,
	};
}

// ─── Cursor / incremental helpers ───────────────────────────────────────

export function laterIso(
	a: string | null | undefined,
	b: string | null | undefined,
): string | null {
	if (!a) {
		return b ?? null;
	}
	if (!b) {
		return a;
	}
	return a > b ? a : b;
}

export function isBeforeSince(
	iso: string | null | undefined,
	since: string | null,
): boolean {
	if (!(since && iso)) {
		return false;
	}
	return iso < since;
}

export function isAtOrAfterUntil(
	iso: string | null | undefined,
	until: string | null,
): boolean {
	if (!(until && iso)) {
		return false;
	}
	return iso >= until;
}
