// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { BrowserCollectContext } from "../../packages/polyfill-connectors/src/connector-runtime.ts";

export type GitHubBrowserCollectContext = Pick<
	BrowserCollectContext,
	"emit" | "emitRecord" | "progress" | "requested" | "state"
>;

export interface BrowserServices {
	fetchPublicJson(url: string): Promise<unknown>;
	now(): Date;
	openPage(url: string): Promise<string>;
	sleep(ms: number): Promise<void>;
}

export interface LegacyProfile {
	achievements: Array<{ iconUrl: string | null; name: string }>;
	avatarUrl: string;
	bio: string;
	company: string;
	contributionsLastYear: number | null;
	followers: number;
	following: number;
	fullName: string;
	location: string;
	organizations: Array<{
		avatarUrl: string | null;
		label: string;
		login: string;
		url: string;
	}>;
	pinnedRepositories: Array<{
		description: string;
		fullName: string;
		language: string | null;
		stars: number;
		url: string | null;
	}>;
	profileUrl: string;
	repositoryCount: number;
	username: string;
	website: string;
}

export interface LegacyRepository {
	description: string;
	forks: number;
	language: string;
	name: string;
	stars: number;
	topics: string[];
	updatedAt: string | null;
	url: string;
	visibility: string;
}

export interface LegacyStarredRepository {
	description: string;
	fullName: string;
	language: string | null;
	stars: number;
	updatedAt: string | null;
	url: string;
}

export interface LegacyEvent {
	action: string | null;
	body: string | null;
	branch: string | null;
	commits: number | null;
	createdAt: string;
	id: string;
	isPublic: boolean;
	repo: string;
	repoUrl: string;
	title: string | null;
	type: string;
	url: string | null;
}

export interface LegacyContributionDay {
	count: number;
	date: string;
	level: number | null;
}

export interface LegacyContributions {
	days: LegacyContributionDay[];
	fetchedAt: string;
	monthlyTotals: Array<{ count: number; month: string }>;
	topDay: { count: number; date: string } | null;
	totalContributionsLastYear: number;
	yearTotals: Array<{ total: number; year: number }>;
}

export interface LegacyHistoryItem {
	body: string | null;
	closedAt: string | null;
	comments: number;
	createdAt: string | null;
	id: string;
	isDraft: boolean;
	labels: string[];
	mergedAt: string | null;
	number: number | null;
	reactionsTotal: number;
	repo: string;
	repoUrl: string | null;
	state: string | null;
	title: string | null;
	type: "issue" | "pr";
	updatedAt: string | null;
	url: string | null;
}
