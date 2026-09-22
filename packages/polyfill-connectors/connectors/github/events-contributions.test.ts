// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Protocol/collector tests for the four streams added to close capability-map
 * parity gaps for github: events, contributions, pinned_repositories,
 * organizations. Kept in their own file (not connectors/github/index.test.ts)
 * because that file is excluded from scripts/run-tests.mjs — it drives the
 * real reference-implementation ingest pipeline and is not runnable in a
 * sparse checkout or under `pnpm test`. This file has no such dependency
 * (mocked fetch + a minimal StreamCtx, same shape as index.test.ts's
 * `makeCtx`) and runs under the normal `connectors/**\/*.test.ts` glob.
 */

import assert from "node:assert/strict";
import { before, type TestContext, test } from "node:test";
import type { StreamScope } from "../../src/connector-runtime.ts";
import {
	collectContributions,
	collectEvents,
	collectOrganizations,
	collectPinnedRepositories,
	createGithubHttpGovernor,
	resolveContributionWindows,
	type StreamCtx,
} from "./index.ts";

// Same rationale as index.test.ts: resolve pacing waits instantly so these
// fetch-stubbing tests don't pay real wall-clock for the adaptive governor's
// GCRA sleeps. See index.test.ts for the fuller explanation.
const ORIGINAL_SET_TIMEOUT = globalThis.setTimeout;
before(() => {
	globalThis.setTimeout = new Proxy(ORIGINAL_SET_TIMEOUT, {
		apply: (_target, _thisArg, callArgs: unknown[]) => {
			const [handler, , ...args] = callArgs as [
				TimerHandler,
				number?,
				...unknown[],
			];
			if (typeof handler === "function") {
				queueMicrotask(() => (handler as (...a: unknown[]) => void)(...args));
			}
			const handle = ORIGINAL_SET_TIMEOUT(() => undefined, 0);
			clearTimeout(handle);
			return handle;
		},
	});
});

type GithubFetch = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>;

function mockFetch(t: TestContext, implementation: GithubFetch): void {
	t.mock.method(globalThis, "fetch", implementation);
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
	return new Response(JSON.stringify(body), { status: 200, ...init });
}

interface CapturedSkip {
	diagnostics?: unknown;
	message: string;
	reason: string;
	stream: string;
}

interface CapturedCoverage {
	considered: number | undefined;
	covered: number | undefined;
	stream: string;
}

function makeCtx(
	requestedStreams: readonly string[],
	state: Record<string, unknown> = {},
): {
	coverages: CapturedCoverage[];
	ctx: StreamCtx;
	progresses: Array<{ extra?: { phase?: string }; message: string }>;
	records: Array<{ data: Record<string, unknown>; stream: string }>;
	skips: CapturedSkip[];
	states: Array<{ cursor: unknown; stream: string }>;
} {
	const records: Array<{ data: Record<string, unknown>; stream: string }> = [];
	const states: Array<{ cursor: unknown; stream: string }> = [];
	const skips: CapturedSkip[] = [];
	const coverages: CapturedCoverage[] = [];
	const progresses: Array<{ extra?: { phase?: string }; message: string }> = [];
	const requested = new Map<string, StreamScope>(
		requestedStreams.map((name) => [name, { name }]),
	);
	const httpGovernor = createGithubHttpGovernor({});
	return {
		ctx: {
			emit: (msg) => {
				if (msg.type === "SKIP_RESULT") {
					skips.push({
						stream: msg.stream,
						reason: msg.reason,
						message: msg.message,
						diagnostics: msg.diagnostics,
					});
				} else if (msg.type === "DETAIL_COVERAGE") {
					coverages.push({
						stream: msg.stream,
						considered: msg.considered,
						covered: msg.covered,
					});
				} else {
					states.push({ stream: msg.stream, cursor: msg.cursor });
				}
				return Promise.resolve();
			},
			emitRecord: (stream, data) => {
				records.push({ stream, data });
				return Promise.resolve();
			},
			httpGovernor,
			progress: (message, extra) => {
				progresses.push({
					message,
					...(extra?.phase === undefined
						? {}
						: { extra: { phase: extra.phase } }),
				});
				return Promise.resolve();
			},
			requested,
			state,
			token: "fake-token",
		},
		coverages,
		progresses,
		records,
		skips,
		states,
	};
}

// ─── collectEvents ────────────────────────────────────────────────────────

function eventItem(
	id: string,
	type: string,
	createdAt: string,
	repoName = "octocat/hello",
): Record<string, unknown> {
	return {
		id,
		type,
		created_at: createdAt,
		repo: { name: repoName },
		public: true,
	};
}

function installEventsFetch(
	t: TestContext,
	pages: Record<string, unknown>[][],
): void {
	mockFetch(t, (input: string | URL | Request) => {
		const url = typeof input === "string" ? input : input.toString();
		if (url.endsWith("/user")) {
			return Promise.resolve(jsonResponse({ id: 42, login: "octocat" }));
		}
		const match = /[?&]page=(\d+)/.exec(url);
		const pageNum = match ? Number(match[1]) : 1;
		const items = pages[pageNum - 1] ?? [];
		return Promise.resolve(jsonResponse(items));
	});
}

test("collectEvents: emits one record per well-formed event and a STATE cursor", async (t: TestContext) => {
	installEventsFetch(t, [
		[
			eventItem("2", "WatchEvent", "2026-06-02T00:00:00Z"),
			eventItem("1", "PushEvent", "2026-06-01T00:00:00Z"),
		],
	]);
	const { ctx, records, states } = makeCtx(["events"]);
	await collectEvents(ctx);

	assert.deepEqual(
		records.map((r) => r.data.id),
		["2", "1"],
	);
	const state = states.find((s) => s.stream === "events");
	assert.deepEqual(state?.cursor, { last_created_at: "2026-06-02T00:00:00Z" });
});

test("collectEvents: stops at the stored cursor without an upstream since param (emit-side incrementality)", async (t: TestContext) => {
	installEventsFetch(t, [
		[
			eventItem("3", "WatchEvent", "2026-06-03T00:00:00Z"),
			eventItem("2", "WatchEvent", "2026-06-02T00:00:00Z"),
			eventItem("1", "PushEvent", "2026-06-01T00:00:00Z"),
		],
	]);
	const { ctx, records } = makeCtx(["events"], {
		events: { last_created_at: "2026-06-02T00:00:00Z" },
	});
	await collectEvents(ctx);

	assert.deepEqual(
		records.map((r) => r.data.id),
		["3"],
	);
});

test("collectEvents: malformed entries are dropped and surfaced as one bounded SKIP_RESULT", async (t: TestContext) => {
	installEventsFetch(t, [
		[
			eventItem("1", "PushEvent", "2026-06-01T00:00:00Z"),
			{ id: "2", type: "PushEvent", created_at: null, repo: { name: "x/y" } },
		],
	]);
	const { ctx, records, skips } = makeCtx(["events"]);
	await collectEvents(ctx);

	assert.equal(records.length, 1);
	const skip = skips.find((s) => s.stream === "events");
	assert.equal(skip?.reason, "github_event_missing_fields");
});

test("collectEvents: stops paginating once a page returns fewer than a full page", async (t: TestContext) => {
	installEventsFetch(t, [
		[eventItem("1", "PushEvent", "2026-06-01T00:00:00Z")],
	]);
	const { ctx, progresses } = makeCtx(["events"]);
	await collectEvents(ctx);

	assert.equal(
		progresses.filter(({ extra }) => extra?.phase === "page").length,
		1,
	);
});

test("collectEvents: declares considered/covered honoring dropped malformed entries", async (t: TestContext) => {
	installEventsFetch(t, [
		[
			eventItem("1", "PushEvent", "2026-06-01T00:00:00Z"),
			{ id: "2", type: "PushEvent", created_at: null, repo: { name: "x/y" } },
		],
	]);
	const { ctx, coverages } = makeCtx(["events"]);
	await collectEvents(ctx);

	const cov = coverages.find((c) => c.stream === "events");
	assert.equal(cov?.considered, 2);
	assert.equal(cov?.covered, 1);
});

// ─── collectContributions ─────────────────────────────────────────────────

function graphQlContributionsResponse(
	days: Array<{ count: number; date: string }>,
): Record<string, unknown> {
	return {
		data: {
			user: {
				contributionsCollection: {
					contributionCalendar: {
						weeks: [
							{
								contributionDays: days.map((d) => ({
									date: d.date,
									contributionCount: d.count,
								})),
							},
						],
					},
				},
			},
		},
	};
}

function installContributionsFetch(
	t: TestContext,
	byWindow: (variables: Record<string, unknown>) => Record<string, unknown>,
): void {
	mockFetch(t, async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input.toString();
		if (url.endsWith("/user")) {
			return jsonResponse({
				id: 42,
				login: "octocat",
				created_at: "2025-01-01T00:00:00Z",
			});
		}
		if (url.endsWith("/graphql")) {
			const body = JSON.parse(String(init?.body ?? "{}")) as {
				variables: Record<string, unknown>;
			};
			return jsonResponse(byWindow(body.variables));
		}
		return jsonResponse({});
	});
}

test("collectContributions: emits one record per day and a STATE cursor", async (t: TestContext) => {
	installContributionsFetch(t, () =>
		graphQlContributionsResponse([
			{ date: "2026-06-01", count: 3 },
			{ date: "2026-06-02", count: 0 },
		]),
	);
	const { ctx, records, states } = makeCtx(["contributions"], {
		contributions: { last_date: "2025-12-31" },
	});
	await collectContributions(ctx);

	assert.deepEqual(
		records.map((r) => r.data.id),
		["42:2026-06-01", "42:2026-06-02"],
	);
	const state = states.find((s) => s.stream === "contributions");
	assert.deepEqual(state?.cursor, { last_date: "2026-06-02" });
});

test("collectContributions: skips days at or before the stored cursor", async (t: TestContext) => {
	installContributionsFetch(t, () =>
		graphQlContributionsResponse([
			{ date: "2026-06-01", count: 3 },
			{ date: "2026-06-02", count: 5 },
		]),
	);
	const { ctx, records } = makeCtx(["contributions"], {
		contributions: { last_date: "2026-06-01" },
	});
	await collectContributions(ctx);

	assert.deepEqual(
		records.map((r) => r.data.date),
		["2026-06-02"],
	);
});

test("collectContributions: a GraphQL errors[] response fails as a malformed response", async (t: TestContext) => {
	mockFetch(t, async (input: string | URL | Request) => {
		const url = typeof input === "string" ? input : input.toString();
		if (url.endsWith("/user")) {
			return jsonResponse({ id: 42, login: "octocat" });
		}
		return jsonResponse({ errors: [{ message: "field not found" }] });
	});
	const { ctx } = makeCtx(["contributions"], {
		contributions: { last_date: "2026-01-01" },
	});

	await assert.rejects(
		() => collectContributions(ctx),
		(error: unknown) =>
			error instanceof Error &&
			(error as Error & { code?: string }).code ===
				"github_malformed_response" &&
			/field not found/.test(error.message),
	);
});

test("resolveContributionWindows: incremental run (since date) is one window to now", () => {
	const now = new Date("2026-06-15T00:00:00Z");
	const windows = resolveContributionWindows("2026-06-01", null, now);
	assert.deepEqual(windows, [
		{ from: "2026-06-01T00:00:00Z", to: now.toISOString() },
	]);
});

test("resolveContributionWindows: full resync partitions by calendar year back to account creation", () => {
	const now = new Date("2026-06-15T00:00:00Z");
	const windows = resolveContributionWindows(null, "2024-03-01T00:00:00Z", now);
	assert.deepEqual(windows, [
		{ from: "2026-01-01T00:00:00Z", to: "2026-12-31T23:59:59Z" },
		{ from: "2025-01-01T00:00:00Z", to: "2025-12-31T23:59:59Z" },
		{ from: "2024-01-01T00:00:00Z", to: "2024-12-31T23:59:59Z" },
	]);
});

// ─── collectPinnedRepositories ──────────────────────────────────────────────

function installPinnedFetch(
	t: TestContext,
	nodes: Array<Record<string, unknown> | null>,
): void {
	mockFetch(t, async (input: string | URL | Request) => {
		const url = typeof input === "string" ? input : input.toString();
		if (url.endsWith("/user")) {
			return jsonResponse({ id: 42, login: "octocat" });
		}
		if (url.endsWith("/graphql")) {
			return jsonResponse({ data: { user: { pinnedItems: { nodes } } } });
		}
		return jsonResponse({});
	});
}

test("collectPinnedRepositories: emits one record per pinned repo, in position order", async (t: TestContext) => {
	installPinnedFetch(t, [
		{ nameWithOwner: "octocat/hello", name: "hello" },
		{ nameWithOwner: "octocat/world", name: "world" },
	]);
	const { ctx, records, states } = makeCtx(["pinned_repositories"]);
	await collectPinnedRepositories(ctx);

	assert.deepEqual(
		records.map((r) => r.data.id),
		["octocat/hello", "octocat/world"],
	);
	assert.deepEqual(
		records.map((r) => r.data.position),
		[0, 1],
	);
	assert.ok(states.find((s) => s.stream === "pinned_repositories"));
});

test("collectPinnedRepositories: a node missing identity is dropped and surfaced as SKIP_RESULT", async (t: TestContext) => {
	installPinnedFetch(t, [
		{ nameWithOwner: "octocat/hello" },
		{ name: "no-owner" },
	]);
	const { ctx, records, skips } = makeCtx(["pinned_repositories"]);
	await collectPinnedRepositories(ctx);

	assert.equal(records.length, 1);
	const skip = skips.find((s) => s.stream === "pinned_repositories");
	assert.equal(skip?.reason, "github_pinned_item_missing_identity");
});

test("collectPinnedRepositories: empty pin list emits no records and no SKIP_RESULT", async (t: TestContext) => {
	installPinnedFetch(t, []);
	const { ctx, records, skips } = makeCtx(["pinned_repositories"]);
	await collectPinnedRepositories(ctx);

	assert.equal(records.length, 0);
	assert.equal(
		skips.filter((s) => s.stream === "pinned_repositories").length,
		0,
	);
});

// ─── collectOrganizations ───────────────────────────────────────────────────

function orgItem(id: number, login: string): Record<string, unknown> {
	return { id, login, description: null, avatar_url: null };
}

test("collectOrganizations: emits one record per org membership", async (t: TestContext) => {
	mockFetch(t, () =>
		Promise.resolve(
			jsonResponse([orgItem(1, "octo-org"), orgItem(2, "other-org")]),
		),
	);
	const { ctx, records, states } = makeCtx(["organizations"]);
	await collectOrganizations(ctx);

	assert.deepEqual(
		records.map((r) => r.data.login),
		["octo-org", "other-org"],
	);
	assert.ok(states.find((s) => s.stream === "organizations"));
});

test("collectOrganizations: paginates via the Link header", async (t: TestContext) => {
	mockFetch(t, (input: string | URL | Request) => {
		const url = typeof input === "string" ? input : input.toString();
		if (url.includes("page=2") || url.includes("&page=") === false) {
			// First request has no page param.
		}
		if (!url.includes("cursor=next")) {
			return Promise.resolve(
				jsonResponse([orgItem(1, "octo-org")], {
					headers: {
						link: '<https://api.github.com/user/orgs?per_page=100&cursor=next>; rel="next"',
					},
				}),
			);
		}
		return Promise.resolve(jsonResponse([orgItem(2, "other-org")]));
	});
	const { ctx, records } = makeCtx(["organizations"]);
	await collectOrganizations(ctx);

	assert.deepEqual(
		records.map((r) => r.data.login),
		["octo-org", "other-org"],
	);
});

test("collectOrganizations: empty membership emits no records", async (t: TestContext) => {
	mockFetch(t, () => Promise.resolve(jsonResponse([])));
	const { ctx, records, coverages } = makeCtx(["organizations"]);
	await collectOrganizations(ctx);

	assert.equal(records.length, 0);
	const cov = coverages.find((c) => c.stream === "organizations");
	assert.equal(cov?.considered, 0);
});
