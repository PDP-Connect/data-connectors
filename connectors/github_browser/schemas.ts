// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";
import { resolveGitHubRecordId } from "./identity.ts";
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
}).partial().required({ name: true, url: true });
const starred = z.object({
	fullName: z.string(),
	url: z.string(),
	description: z.string(),
	language: z.string().nullable(),
	stars: z.number(),
	updatedAt: z.string().nullable(),
}).partial().required({ fullName: true, url: true });
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
}).partial().required({ id: true, type: true, repo: true });
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
}).partial().required({ id: true, type: true, repo: true });
const schemas = {
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
			}).partial().required({ fullName: true }),
		),
		organizations: z.array(
			z.object({
				login: z.string(),
				label: z.string(),
				url: z.string(),
				avatarUrl: z.string().nullable(),
			}).partial().required({ login: true, url: true }),
		),
		achievements: z.array(
			z.object({ name: z.string(), iconUrl: z.string().nullable().optional() }),
		),
		contributionsLastYear: z.number().nullable(),
	}).partial().required({ id: true, username: true, profileUrl: true }),
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
	}).partial().required({ id: true, days: true, fetchedAt: true }),
	history: z.object({
		id: z.string(),
		pullRequests: z.array(historyItem),
		issues: z.array(historyItem),
		fetchedAt: z.string(),
		windowDescription: z.string(),
	}),
};

export const SCHEMAS = {
	profile: schemas.profile,
	repositories: schemas.repositories,
	starred: schemas.starred,
	events: schemas.events,
	contributions: schemas.contributions,
	history: schemas.history,
};

const validateSnapshot = makeValidateRecord(SCHEMAS);
export const validateRecord: typeof validateSnapshot = (stream, data) => {
	const id = resolveGitHubRecordId(stream, data);
	if (id === null || id !== data.id)
		return { ok: false, issues: [{ path: "id", message: "does not match legacy snapshot identity" }] };
	return validateSnapshot(stream, data);
};
export const resolveRecordId = resolveGitHubRecordId;

// These are ingestion schemas; parser evidence, not optionality, controls completion.
export const validateEntity = makeValidateRecord({
	profile: schemas.profile,
	repositories: repository.extend({ id: z.string() }),
	starred: starred.extend({ id: z.string() }),
	events: event,
	history: historyItem,
	contributions: z.discriminatedUnion("recordType", [
		z.object({ recordType: z.literal("day"), id: z.string(), date: z.string(), count: z.number(), level: z.number().nullable() }),
		z.object({
			recordType: z.literal("summary"), id: z.string(), username: z.string(),
			fetchedAt: z.string(), totalContributionsLastYear: z.number(),
			yearTotals: z.array(z.object({ year: z.number(), total: z.number() })),
			monthlyTotals: z.array(z.object({ month: z.string(), count: z.number() })),
			topDay: z.object({ date: z.string(), count: z.number() }).nullable(),
		}),
	]),
});
