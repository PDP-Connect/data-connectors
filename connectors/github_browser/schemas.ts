// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";
import { makeValidateRecord } from "../../packages/polyfill-connectors/src/schema-registry.ts";

const repository = z.object({
	name: z.string(),
	url: z.string(),
	description: z.string(),
	language: z.string(),
	stars: z.number(),
	forks: z.number(),
	visibility: z.string(),
	topics: z.array(z.string()),
	updatedAt: z.string().nullable(),
});
const starred = z.object({
	fullName: z.string(),
	url: z.string(),
	description: z.string(),
	language: z.string().nullable(),
	stars: z.number(),
	updatedAt: z.string().nullable(),
});
const event = z.object({
	id: z.string(),
	type: z.string(),
	createdAt: z.string(),
	repo: z.string(),
	repoUrl: z.string(),
	action: z.string().nullable(),
	title: z.string().nullable(),
	body: z.string().nullable(),
	url: z.string().nullable(),
	branch: z.string().nullable(),
	commits: z.number().nullable(),
	isPublic: z.boolean(),
});
const historyItem = z.object({
	id: z.string(),
	type: z.enum(["issue", "pr"]),
	number: z.number().nullable(),
	title: z.string().nullable(),
	body: z.string().nullable(),
	state: z.string().nullable(),
	createdAt: z.string().nullable(),
	updatedAt: z.string().nullable(),
	closedAt: z.string().nullable(),
	mergedAt: z.string().nullable(),
	url: z.string().nullable(),
	repo: z.string(),
	repoUrl: z.string().nullable(),
	labels: z.array(z.string()),
	comments: z.number(),
	reactionsTotal: z.number(),
	isDraft: z.boolean(),
});
export const schemas = {
	profile: z.object({
		id: z.string(),
		username: z.string(),
		fullName: z.string(),
		bio: z.string(),
		company: z.string(),
		location: z.string(),
		website: z.string(),
		avatarUrl: z.string(),
		followers: z.number(),
		following: z.number(),
		repositoryCount: z.number(),
		profileUrl: z.string(),
		pinnedRepositories: z.array(
			z.object({
				fullName: z.string(),
				url: z.string().nullable(),
				description: z.string(),
				language: z.string().nullable(),
				stars: z.number(),
			}),
		),
		organizations: z.array(
			z.object({
				login: z.string(),
				label: z.string(),
				url: z.string(),
				avatarUrl: z.string().nullable(),
			}),
		),
		achievements: z.array(
			z.object({ name: z.string(), iconUrl: z.string().nullable() }),
		),
		contributionsLastYear: z.number().nullable(),
	}),
	repositories: z.object({ id: z.string(), repositories: z.array(repository) }),
	starred: z.object({ id: z.string(), starred: z.array(starred) }),
	events: z.object({
		id: z.string(),
		events: z.array(event),
		fetchedAt: z.string(),
		windowDescription: z.string(),
	}),
	contributions: z.object({
		id: z.string(),
		days: z.array(
			z.object({
				date: z.string(),
				count: z.number(),
				level: z.number().nullable(),
			}),
		),
		fetchedAt: z.string(),
		totalContributionsLastYear: z.number(),
		yearTotals: z.array(z.object({ year: z.number(), total: z.number() })),
		monthlyTotals: z.array(z.object({ month: z.string(), count: z.number() })),
		topDay: z.object({ date: z.string(), count: z.number() }).nullable(),
	}),
	history: z.object({
		id: z.string(),
		pullRequests: z.array(historyItem),
		issues: z.array(historyItem),
		fetchedAt: z.string(),
		windowDescription: z.string(),
	}),
};

export const validateRecord = makeValidateRecord(schemas);
