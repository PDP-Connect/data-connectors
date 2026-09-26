// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for the Meta (Instagram) connector's `collect()` layer.
 *
 * No real browser: `page.evaluate` is faked to route each in-page fetch to
 * scripted responses keyed by URL path, mirroring the Reddit connector's
 * `RedditListingFetch` test pattern. DOM-only calls (dialog scraping) are
 * routed by inspecting the evaluate function's source for a distinguishing
 * marker, since those calls take no serializable argument to key off of.
 *
 * Every emitted record is run through the real zod schema the runtime
 * applies in production via `makeRecordingEmit(validateRecord)` — a record
 * that would SKIP_RESULT in production fails here too.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { chromium } from "playwright";
import type { Page } from "playwright";
import type {
	BrowserCollectContext,
	EmittedMessage,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { buildRunSummary } from "../../packages/polyfill-connectors/src/run-summary.ts";
import { makeRecordingEmit } from "../../packages/polyfill-connectors/src/test-harness.ts";
import {
	collectAllStreams,
	scrapeAdTopics,
	scrapeAdvertisers,
	scrapeTargetingCategories,
} from "./index.ts";
import { validateRecord } from "./schemas.ts";

const EMITTED_AT = "2026-09-22T12:00:00.000Z";
const NO_DELAY = (): Promise<void> => Promise.resolve();

interface ScriptedFetch {
	json: unknown;
	status: number;
}

/** One scripted page of the posts timeline connection, as
 *  `fetchAllPosts`'s `waitForResponse`-driven interception would observe it:
 *  a fake Playwright Response exposing `.json()`/`.status()`. `null` means
 *  "the page never triggers this request" (used to prove the
 *  `meta_posts_response_not_observed` failure path). */
type ScriptedPostsPage = { json: unknown; status: number } | null;

/** Build a fake Playwright Page whose `evaluate` serves scripted JSON
 *  fetches keyed by URL path prefix, and scripted DOM-scrape results keyed
 *  by a marker string embedded in the evaluate function's source.
 *  `postsScript`, when provided, drives `waitForResponse`/`goto`/`evaluate`
 *  (scroll) for `fetchAllPosts`'s passive-network-capture pattern: page 1's
 *  response resolves on the `goto` that follows, later pages resolve on the
 *  scroll-triggered `evaluate` call. */
function makeFakePage(options: {
	categoriesAvailable?: boolean;
	categoryDestinationReached?: boolean;
	categoryRows?: Array<{ description: string | null; name: string }>;
	dialogViewAllAfterClick?: "hidden" | "removed" | "stuck";
	dialogScrapes?: string[][];
	dialogReached?: boolean[];
	delayFirstDialogItems?: boolean;
	positiveEmptyMarkers?: boolean;
	waitEmptySettle?: boolean;
	fetchScript: Record<string, ScriptedFetch[]>;
	navigationFailures?: string[];
	postsScript?: ScriptedPostsPage[];
	webInfoUser?: unknown;
}): {
	calls: string[];
	page: Page;
	waitConditions: string[];
	waitRejections: string[];
	waitTimeouts: number[];
} {
	const calls: string[] = [];
	const waitConditions: string[] = [];
	const waitRejections: string[] = [];
	const waitTimeouts: number[] = [];
	const cursors: Record<string, number> = {};
	const dialogQueue = [...(options.dialogScrapes ?? [])];
	const dialogReachedQueue = [...(options.dialogReached ?? [])];
	const postsQueue = [...(options.postsScript ?? [])];
	let pendingPostsResolve: ((value: unknown) => void) | null = null;
	let adsListWait = 0;
	let dialogScrapeCount = 0;
	let firstDialogItemsReady = options.delayFirstDialogItems !== true;
	const resolveReadiness = (ready: boolean): Promise<unknown> =>
		ready
			? Promise.resolve(true)
			: Promise.reject(new Error("Timeout while waiting for fake DOM"));

	const resolveNextPostsPage = (): void => {
		const next = pendingPostsResolve;
		pendingPostsResolve = null;
		if (!next) {
			return;
		}
		const scripted = postsQueue.shift();
		if (scripted === undefined || scripted === null) {
			// Mirrors production: a `waitForResponse` timeout rejects, and
			// `fetchAllPosts` catches that into `null`. Resolving `null`
			// directly here (rather than leaving the promise pending forever)
			// reaches the same code path without a real timeout in tests.
			next(null);
			return;
		}
		next({
			json: () => Promise.resolve(scripted.json),
			request: () => ({ method: () => "POST" }),
			status: () => scripted.status,
			url: () => "https://www.instagram.com/graphql/query",
		});
	};

	const page = {
		goto: (url?: string): Promise<null> => {
			if (url && options.navigationFailures?.some((path) => url.includes(path))) {
				return Promise.reject(new Error("scripted navigation failure"));
			}
			resolveNextPostsPage();
			return Promise.resolve(null);
		},
		waitForResponse: (_predicate: unknown, _opts?: unknown): Promise<unknown> =>
			new Promise((resolve) => {
				pendingPostsResolve = resolve;
			}),
		waitForFunction: (
			condition: unknown,
			_arg?: unknown,
			waitOptions?: { timeout?: number },
		): Promise<unknown> => {
			const source = String(condition);
			waitConditions.push(source);
			if (waitOptions?.timeout !== undefined) {
				waitTimeouts.push(waitOptions.timeout);
			}
			const readiness = (ready: boolean): Promise<unknown> => {
				if (!ready) {
					waitRejections.push(source);
				}
				return resolveReadiness(ready);
			};
			if (source.includes("Manage info")) {
				return readiness(options.categoriesAvailable === true);
			}
			if (source.includes("Categories used to reach you")) {
				return readiness(options.categoriesAvailable === true);
			}
			if (source.includes("View all")) {
				return readiness(options.dialogViewAllAfterClick !== "stuck");
			}
			if (source.includes("advertiser")) {
				return readiness(true);
			}
			if (source.includes("getBoundingClientRect") && source.includes('[role="listitem"]')) {
				const index = adsListWait - 1;
				const ready =
					index < 2
						? (dialogQueue[0]?.some((item) => item.trim().length > 0) ?? false)
						: (options.categoryRows?.length ?? 0) > 0;
				if (index === 0 && ready && options.delayFirstDialogItems) {
					return new Promise((resolve) => {
						setTimeout(() => {
							firstDialogItemsReady = true;
							resolve(true);
						}, 5);
					});
				}
				if (ready) {
					return readiness(true);
				}
				if (options.waitEmptySettle) {
					return new Promise((_, reject) => {
						setTimeout(
							() => reject(new Error("Timeout while waiting for fake DOM")),
							waitOptions?.timeout ?? 0,
						);
					});
				}
				return readiness(false);
			}
			if (source.includes("getBoundingClientRect") && source.includes('[role="list"]')) {
				const index = adsListWait++;
				if (index < 2) {
					const reached = dialogReachedQueue[0];
					const ready = reached ?? dialogQueue[0] !== undefined;
					if (!ready) {
						dialogQueue.shift();
						dialogReachedQueue.shift();
					}
					return readiness(ready);
				}
				return readiness(options.categoryDestinationReached !== false);
			}
			if (
				source.includes('[role="dialog"] [role="list"]') &&
				!source.includes('[role="listitem"]')
			) {
				const index = adsListWait++;
				if (index < 2) {
					const reached = dialogReachedQueue[0];
					const ready = reached ?? dialogQueue[0] !== undefined;
					if (!ready) {
						// A timed-out surface is not scraped, so consume its scripted
						// slot here to keep the next surface aligned with the UI flow.
						dialogQueue.shift();
						dialogReachedQueue.shift();
					}
					return readiness(ready);
				}
				return readiness(options.categoryDestinationReached !== false);
			}
			if (
				source.includes('[role="dialog"] [role="list"]') &&
				source.includes('[role="listitem"]')
			) {
				const index = adsListWait - 1;
				const ready =
					index < 2
						? (dialogQueue[0]?.some((item) => item.trim().length > 0) ?? false)
						: (options.categoryRows?.length ?? 0) > 0;
				if (index === 0 && ready && options.delayFirstDialogItems) {
					return new Promise((resolve) => {
						setTimeout(() => {
							firstDialogItemsReady = true;
							resolve(true);
						}, 5);
					});
				}
				if (ready) {
					return readiness(true);
				}
				if (options.waitEmptySettle) {
					return new Promise((_, reject) => {
						setTimeout(
							() => reject(new Error("Timeout while waiting for fake DOM")),
							waitOptions?.timeout ?? 0,
						);
					});
				}
				return readiness(false);
			}
			return readiness(true);
		},
		evaluate: (fn: unknown, arg?: unknown): Promise<unknown> => {
			const fnSource = String(fn);
			if (fnSource.includes("scrollTo")) {
				resolveNextPostsPage();
				return Promise.resolve(undefined);
			}
			if (fnSource.includes("PolarisViewer")) {
				calls.push("/accounts/web_info/");
				return Promise.resolve(options.webInfoUser ?? null);
			}
			if (
				arg &&
				typeof arg === "object" &&
				"path" in (arg as Record<string, unknown>)
			) {
				const { path } = arg as { path: string };
				calls.push(path);
				const endpoint = path.split("?")[0] ?? path;
				const responses = options.fetchScript[endpoint];
				if (!responses) {
					throw new Error(`no scripted response for ${endpoint}`);
				}
				const i = cursors[endpoint] ?? 0;
				const r = responses[Math.min(i, responses.length - 1)];
				cursors[endpoint] = i + 1;
				if (!r) {
					throw new Error(`scripted response undefined at ${endpoint}#${i}`);
				}
				return Promise.resolve(r);
			}
			// Dialog-scrape / close-dialog calls (no serializable arg). Distinguish
			// "read listitems" from "click Close" by function length in source —
			// simplest robust marker without parsing the closure body.
			if (fnSource.includes("aria-label") && fnSource.includes("advertiser")) {
				return Promise.resolve(true);
			}
			if (fnSource.includes('role="tab"') || fnSource.includes("Manage info")) {
				return Promise.resolve(options.categoriesAvailable === true);
			}
			if (fnSource.includes("Categories used to reach you")) {
				return Promise.resolve(options.categoriesAvailable === true);
			}
			if (fnSource.includes("View all") && fnSource.includes("click")) {
				return Promise.resolve(options.dialogViewAllAfterClick !== undefined);
			}
			if (fnSource.includes("View all")) {
				return Promise.resolve(undefined);
			}
			if (fnSource.includes("hasVerifiedEmpty") && fnSource.includes("hasList")) {
				const hasList = options.categoryDestinationReached !== false;
				return Promise.resolve({
					busy: false,
					hasVerifiedEmpty: (options.categoryRows?.length ?? 0) === 0,
					hasList,
					items: hasList ? (options.categoryRows ?? []) : [],
					reached: hasList,
				});
			}
			if (Array.isArray(arg) && fnSource.includes("dialog?.querySelector('[role=\"list\"]')")) {
				return Promise.resolve(dialogQueue[0] !== undefined);
			}
			if (fnSource.includes("Removed categories")) {
				return Promise.resolve({
					items: options.categoryRows ?? [],
					reached: options.categoryDestinationReached !== false,
				});
			}
			if (
				Array.isArray(arg) &&
				fnSource.includes("labels.includes") &&
				!fnSource.includes("const values")
			) {
				return Promise.resolve(options.positiveEmptyMarkers === true);
			}
			if (fnSource.includes("visibleItems.every")) {
				const items = dialogQueue[0];
				if (items === undefined) {
					return Promise.resolve(false);
				}
				if (items.length === 0) {
					return Promise.resolve(true);
				}
				if (typeof arg === "string") {
					const excluded = new RegExp(arg, "i");
					return Promise.resolve(items.every((item) => excluded.test(item)));
				}
				return Promise.resolve(false);
			}
			if (
				fnSource.includes("querySelectorAll") &&
				fnSource.includes("listitem")
			) {
				const items = dialogQueue[0];
				if (dialogScrapeCount++ === 0 && !firstDialogItemsReady) {
					return Promise.resolve({ hasVerifiedEmpty: false, items: [], reached: false });
				}
				dialogQueue.shift();
				const hasRows = (items?.length ?? 0) > 0;
				const hasVerifiedEmpty = !hasRows || (Array.isArray(arg) && options.positiveEmptyMarkers === true);
				return Promise.resolve({
					hasVerifiedEmpty,
					items: items ?? [],
					reached: dialogReachedQueue.shift() ?? items !== undefined,
				});
			}
			if (fnSource.includes('[role="dialog"] [role="list"]')) {
				return Promise.resolve(true);
			}
			return Promise.resolve(undefined);
		},
	} as unknown as Page;

	return { calls, page, waitConditions, waitRejections, waitTimeouts };
}

const WEB_INFO_USER = {
	biography: "hi",
	fbid: "u1",
	full_name: "Test User",
	id: "u1",
	is_private: false,
	is_verified: false,
	username: "testuser",
};

function makeCtx(args: {
	pageOptions?: {
		categoriesAvailable?: boolean;
		categoryDestinationReached?: boolean;
		categoryRows?: Array<{ description: string | null; name: string }>;
		dialogScrapes?: string[][];
		dialogReached?: boolean[];
		navigationFailures?: string[];
	};
	fetchScript: Record<string, ScriptedFetch[]>;
	harness: ReturnType<typeof makeRecordingEmit>;
	postsScript?: ScriptedPostsPage[];
	requestedStreams: string[];
	webInfoUser?: unknown;
}): { calls: string[]; ctx: BrowserCollectContext } {
	const { calls, page } = makeFakePage({
		...args.pageOptions,
		fetchScript: args.fetchScript,
		...(args.postsScript ? { postsScript: args.postsScript } : {}),
		webInfoUser:
			args.webInfoUser === undefined ? WEB_INFO_USER : args.webInfoUser,
	});
	const requested = new Map(args.requestedStreams.map((s) => [s, { name: s }]));
	const ctx: BrowserCollectContext = {
		assist: async (): Promise<never> => {
			throw new Error("mock assist not implemented");
		},
		capture: null,
		completeAssistance: async () => undefined,
		context: {} as BrowserCollectContext["context"],
		credentials: {},
		detailGaps: [],
		emit: args.harness.emit,
		emitRecord: args.harness.emitRecord,
		emittedAt: EMITTED_AT,
		page,
		progress: async () => undefined,
		requestDetailGapPage: async (): Promise<readonly never[]> => [],
		requested,
		scope: { streams: [] },
		sendInteraction: async (): Promise<never> => {
			throw new Error("mock sendInteraction not implemented");
		},
		state: {},
	};
	return { calls, ctx };
}

const EMPTY_POSTS: ScriptedPostsPage = {
	json: {
		data: {
			xdt_api__v1__feed__user_timeline_graphql_connection: {
				edges: [],
				page_info: { has_next_page: false },
			},
		},
	},
	status: 200,
};

// ─── Invariant 1: only requested streams emit ──────────────────────────

test("Meta browser-bound code does not use eval workarounds", async () => {
	const source = await readFile(new URL("./index.ts", import.meta.url), "utf8");
	assert.equal(source.includes("new Function"), false);
	assert.equal(source.includes("eval("), false);
	assert.equal(source.includes("globalThis.__name"), false);
});

test("collectAllStreams: unrequested streams emit nothing", async () => {
	const harness = makeRecordingEmit(validateRecord);
	const { calls, ctx } = makeCtx({
		fetchScript: {},
		harness,
		requestedStreams: ["profile"],
	});

	await collectAllStreams(ctx, NO_DELAY);

	assert.deepEqual(
		harness.emitted.map((e) => e.stream),
		["profile"],
	);
	assert.deepEqual(
		calls,
		["/accounts/web_info/"],
		"only the profile fetch may run when posts/following are not requested",
	);
	assert.ok(
		calls.every((c) => c.startsWith("/accounts/web_info/")),
		"every observed call must be the web_info path when only profile is requested",
	);
});

test("collectAllStreams: requesting posts+post_likes but not profile emits no profile record", async () => {
	const harness = makeRecordingEmit(validateRecord);
	const { ctx } = makeCtx({
		fetchScript: {},
		harness,
		postsScript: [EMPTY_POSTS],
		requestedStreams: ["posts", "post_likes"],
	});

	await collectAllStreams(ctx, NO_DELAY);

	assert.ok(!harness.emitted.some((e) => e.stream === "profile"));
});

// ─── Invariant 2: profile emits the web_info-derived record ────────────

test("collectAllStreams: profile stream emits one record from web_info", async () => {
	const harness = makeRecordingEmit(validateRecord);
	const { ctx } = makeCtx({
		fetchScript: {},
		harness,
		requestedStreams: ["profile"],
	});

	await collectAllStreams(ctx, NO_DELAY);

	assert.equal(harness.emitted.length, 1);
	assert.equal(harness.emitted[0]?.data.id, "u1");
	assert.equal(harness.emitted[0]?.data.username, "testuser");
	assert.equal(harness.skipped.length, 0);
});

test("collectAllStreams: no logged-in user in web_info is a terminal error", async () => {
	const harness = makeRecordingEmit(validateRecord);
	const { ctx } = makeCtx({
		fetchScript: {},
		harness,
		requestedStreams: ["profile"],
		webInfoUser: null,
	});

	await assert.rejects(collectAllStreams(ctx), /meta_profile_unavailable/);
});

// ─── Invariant 3: posts + post_likes split from one paginated walk ──────

test("collectAllStreams: posts and post_likes both derive from the same timeline walk", async () => {
	const harness = makeRecordingEmit(validateRecord);
	const { ctx } = makeCtx({
		fetchScript: {},
		harness,
		postsScript: [
			{
				json: {
					data: {
						xdt_api__v1__feed__user_timeline_graphql_connection: {
							edges: [
								{
									node: {
										caption: { text: "post one" },
										facepile_top_likers: [
											{
												id: "liker1",
												pk: "liker-pk1",
												profile_pic_url: "https://example.com/alice.jpg",
												username: "alice",
											},
											{ id: "liker2" },
											{ username: "unkeyed" },
										],
										id: "p1",
										image_versions2: {
											candidates: [{ url: "https://example.com/1.jpg" }],
										},
										like_count: 3,
										taken_at: 1_700_000_000,
									},
								},
							],
							page_info: { has_next_page: false },
						},
					},
				},
				status: 200,
			},
		],
		requestedStreams: ["posts", "post_likes"],
	});

	await collectAllStreams(ctx, NO_DELAY);

	const posts = harness.emitted.filter((e) => e.stream === "posts");
	const likes = harness.emitted.filter((e) => e.stream === "post_likes");
	assert.equal(posts.length, 1);
	assert.equal(posts[0]?.data.id, "p1");
	assert.equal(likes.length, 3);
	assert.deepEqual(
		likes.map((like) => like.data),
		[
			{
				liker_ordinal: 0,
				post_id: "p1",
				profile_pic_url: "https://example.com/alice.jpg",
				pk: "liker-pk1",
				id: "liker1",
				user_id: "liker1",
				username: "alice",
			},
			{
				liker_ordinal: 1,
				post_id: "p1",
				profile_pic_url: "",
				pk: "liker2",
				id: "liker2",
				user_id: "liker2",
				username: "",
			},
			{
				liker_ordinal: 2,
				post_id: "p1",
				profile_pic_url: "",
				pk: "",
				id: "",
				user_id: "",
				username: "unkeyed",
			},
		],
	);
	const unkeyedLike = likes.find((e) => e.data.liker_ordinal === 2)?.data;
	assert.ok(unkeyedLike, "an identity-free source liker must be preserved");
	assert.equal(unkeyedLike.user_id, "");
	assert.equal(unkeyedLike.id, "");
	assert.equal(unkeyedLike.pk, "");
	assert.equal(
		harness.protocolMessages.some((m) => m.type === "STATE"),
		false,
		"posts is incremental: false / full_inventory — it must not claim a cursor via STATE",
	);
});

test("collectAllStreams: posts never emits STATE, requested or not", async () => {
	const harness = makeRecordingEmit(validateRecord);
	const { ctx } = makeCtx({
		fetchScript: {},
		harness,
		postsScript: [EMPTY_POSTS],
		requestedStreams: ["post_likes"],
	});

	await collectAllStreams(ctx, NO_DELAY);

	assert.equal(
		harness.protocolMessages.some(
			(m) => m.type === "STATE" && m.stream === "posts",
		),
		false,
	);
});

test("collectAllStreams: posts pagination walks a scroll-triggered second page", async () => {
	const harness = makeRecordingEmit(validateRecord);
	const page1: ScriptedPostsPage = {
		json: {
			data: {
				xdt_api__v1__feed__user_timeline_graphql_connection: {
					edges: [{ node: { id: "p1", taken_at: 100 } }],
					page_info: { end_cursor: "cursor-a", has_next_page: true },
				},
			},
		},
		status: 200,
	};
	const page2: ScriptedPostsPage = {
		json: {
			data: {
				xdt_api__v1__feed__user_timeline_graphql_connection: {
					edges: [{ node: { id: "p2", taken_at: 50 } }],
					page_info: { has_next_page: false },
				},
			},
		},
		status: 200,
	};
	const { ctx } = makeCtx({
		fetchScript: {},
		harness,
		postsScript: [page1, page2],
		requestedStreams: ["posts"],
	});

	await collectAllStreams(ctx, NO_DELAY);

	const posts = harness.emitted.filter((e) => e.stream === "posts");
	assert.deepEqual(
		posts.map((p) => p.data.id),
		["p1", "p2"],
		"a scroll-triggered second page (has_next_page:true → the scroll evaluate call resolves page 2) must be walked and both pages' posts emitted",
	);
});

test("collectAllStreams: posts request never observed is a terminal error, not a silent empty result", async () => {
	const harness = makeRecordingEmit(validateRecord);
	const { ctx } = makeCtx({
		fetchScript: {},
		harness,
		postsScript: [null],
		requestedStreams: ["posts"],
	});

	await assert.rejects(
		collectAllStreams(ctx, NO_DELAY),
		/meta_posts_response_not_observed/,
	);
});

// ─── Invariant 4: following walks to completion or reports honest coverage ──

test("collectAllStreams: following paginates to completion with no truncation SKIP_RESULT", async () => {
	const harness = makeRecordingEmit(validateRecord);
	const { ctx } = makeCtx({
		fetchScript: {
			"/api/v1/friendships/u1/following/": [
				{
					json: {
						next_max_id: "page2",
						users: [{ pk: "f1", username: "followed1" }],
					},
					status: 200,
				},
				{
					json: {
						next_max_id: null,
						users: [{ pk: "f2", username: "followed2" }],
					},
					status: 200,
				},
			],
		},
		harness,
		requestedStreams: ["following"],
	});

	await collectAllStreams(ctx, NO_DELAY);

	const following = harness.emitted.filter((e) => e.stream === "following");
	assert.deepEqual(
		following.map((f) => f.data.username),
		["followed1", "followed2"],
	);
	assert.equal(
		harness.protocolMessages.some(
			(m) =>
				m.type === "SKIP_RESULT" &&
				m.reason === "following_pages_deferred_page_budget",
		),
		false,
	);
});

test("collectAllStreams: following hitting the page ceiling emits an honest SKIP_RESULT instead of silently truncating", async () => {
	const harness = makeRecordingEmit(validateRecord);
	const fetchScript: Record<string, ScriptedFetch[]> = {};
	// Every page reports a next cursor forever — forces the FOLLOWING_MAX_PAGES ceiling.
	fetchScript["/api/v1/friendships/u1/following/"] = [
		{
			json: {
				next_max_id: "always-more",
				users: [{ pk: "f1", username: "followed1" }],
			},
			status: 200,
		},
	];
	const { ctx } = makeCtx({
		fetchScript,
		harness,
		requestedStreams: ["following"],
	});

	await collectAllStreams(ctx, NO_DELAY);

	const skip = harness.protocolMessages.find(
		(m) =>
			m.type === "SKIP_RESULT" &&
			m.reason === "following_pages_deferred_page_budget",
	);
	assert.ok(
		skip,
		"expected a following_pages_deferred_page_budget SKIP_RESULT",
	);
	assert.equal((skip as { stream: string }).stream, "following");
});

// ─── Invariant 5: ads merges three DOM-scraped lists with a kind discriminator ──

test("collectAllStreams: ads stream merges advertisers/topics/categories with kind discriminator", async () => {
	const harness = makeRecordingEmit(validateRecord);
	const { page, waitConditions } = makeFakePage({
		categoriesAvailable: true,
		categoryRows: [{ description: "Music affinity", name: "Music" }],
		dialogScrapes: [["Acme Corp"], ["Sports & Fitness"]],
		fetchScript: {},
		webInfoUser: WEB_INFO_USER,
	});
	const requested = new Map([["ads", { name: "ads" }]]);
	const harnessCtx: BrowserCollectContext = {
		assist: async (): Promise<never> => {
			throw new Error("not implemented");
		},
		capture: null,
		completeAssistance: async () => undefined,
		context: {} as BrowserCollectContext["context"],
		credentials: {},
		detailGaps: [],
		emit: harness.emit,
		emitRecord: harness.emitRecord,
		emittedAt: EMITTED_AT,
		page,
		progress: async () => undefined,
		requestDetailGapPage: async (): Promise<readonly never[]> => [],
		requested,
		scope: { streams: [] },
		sendInteraction: async (): Promise<never> => {
			throw new Error("not implemented");
		},
		state: {},
	};

	await collectAllStreams(harnessCtx, NO_DELAY);

	const ads = harness.emitted.filter((e) => e.stream === "ads");
	const kinds = ads.map((a) => a.data.kind).sort();
	assert.deepEqual(kinds, ["ad_category", "ad_topic", "advertiser"]);
	assert.equal(waitConditions.length, 8);
	assert.ok(
		waitConditions.some((condition) => condition.includes("advertiser")),
	);
	assert.ok(
		waitConditions.some((condition) => condition.includes("Manage info")),
	);
	assert.ok(
		waitConditions.some((condition) =>
			condition.includes("Categories used to reach you"),
		),
	);
	assert.equal(harness.skipped.length, 0);
	assert.deepEqual(
		harness.protocolMessages.find((m) => m.type === "DETAIL_COVERAGE"),
		{
			hydrated_keys: ["advertisers", "ad_topics", "targeting_categories"],
			reference_only: true,
			required_keys: ["advertisers", "ad_topics", "targeting_categories"],
			state_stream: "ads",
			stream: "ads",
			type: "DETAIL_COVERAGE",
		},
	);
	assert.deepEqual(
		buildRunSummary(harness.protocolMessages, {
			connector: "meta",
			finished_at: EMITTED_AT,
			started_at: EMITTED_AT,
			tool_version: "test",
		}).done.coverage,
		{ considered: 3, covered: 3, streams: ["ads"] },
	);
});

test("collectAllStreams: all positively empty ads surfaces complete without records", async () => {
	const harness = makeRecordingEmit(validateRecord);
	const { page } = makeFakePage({
		categoriesAvailable: true,
		categoryRows: [],
		dialogScrapes: [[], []],
		fetchScript: {},
		positiveEmptyMarkers: true,
		waitEmptySettle: true,
		webInfoUser: WEB_INFO_USER,
	});
	const requested = new Map([["ads", { name: "ads" }]]);
	const harnessCtx: BrowserCollectContext = {
		assist: async (): Promise<never> => {
			throw new Error("not implemented");
		},
		capture: null,
		completeAssistance: async () => undefined,
		context: {} as BrowserCollectContext["context"],
		credentials: {},
		detailGaps: [],
		emit: harness.emit,
		emitRecord: harness.emitRecord,
		emittedAt: EMITTED_AT,
		page,
		progress: async () => undefined,
		requestDetailGapPage: async (): Promise<readonly never[]> => [],
		requested,
		scope: { streams: [] },
		sendInteraction: async (): Promise<never> => {
			throw new Error("not implemented");
		},
		state: {},
	};

	await collectAllStreams(harnessCtx, NO_DELAY);

	assert.equal(harness.emitted.length, 0);
	assert.deepEqual(
		harness.protocolMessages.find((m) => m.type === "DETAIL_COVERAGE"),
		{
			hydrated_keys: ["advertisers", "ad_topics", "targeting_categories"],
			reference_only: true,
			required_keys: ["advertisers", "ad_topics", "targeting_categories"],
			state_stream: "ads",
			stream: "ads",
			type: "DETAIL_COVERAGE",
		},
	);
	assert.deepEqual(
		buildRunSummary(harness.protocolMessages, {
			connector: "meta",
			finished_at: EMITTED_AT,
			started_at: EMITTED_AT,
			tool_version: "test",
		}).done.coverage,
		{ considered: 3, covered: 3, streams: ["ads"] },
	);
	assert.equal(
		harness.protocolMessages.some((m) => m.type === "SKIP_RESULT"),
		false,
	);
});


test("collectAllStreams: verified empty ad topics completes ads when other surfaces are unavailable", async () => {
	const harness = makeRecordingEmit(validateRecord);
	const { page } = makeFakePage({
		categoriesAvailable: false,
		dialogReached: [false, true],
		dialogScrapes: [[], []],
		fetchScript: {},
		webInfoUser: WEB_INFO_USER,
	});
	const requested = new Map([["ads", { name: "ads" }]]);
	const harnessCtx: BrowserCollectContext = {
		assist: async (): Promise<never> => {
			throw new Error("not implemented");
		},
		capture: null,
		completeAssistance: async () => undefined,
		context: {} as BrowserCollectContext["context"],
		credentials: {},
		detailGaps: [],
		emit: harness.emit,
		emitRecord: harness.emitRecord,
		emittedAt: EMITTED_AT,
		page,
		progress: async () => undefined,
		requestDetailGapPage: async (): Promise<readonly never[]> => [],
		requested,
		scope: { streams: [] },
		sendInteraction: async (): Promise<never> => {
			throw new Error("not implemented");
		},
		state: {},
	};

	await collectAllStreams(harnessCtx, NO_DELAY);

	assert.equal(harness.emitted.length, 0);
	assert.deepEqual(
		harness.protocolMessages.find((m) => m.type === "DETAIL_COVERAGE"),
		{
			hydrated_keys: ["ad_topics"],
			reference_only: true,
			required_keys: ["advertisers", "ad_topics", "targeting_categories"],
			state_stream: "ads",
			stream: "ads",
			type: "DETAIL_COVERAGE",
		},
	);
	assert.equal(
		harness.protocolMessages.some(
			(m) => m.type === "SKIP_RESULT" && m.stream === "ads",
		),
		false,
	);
});

test("collectAllStreams: settled empty advertiser and ad-topic lists complete as verified empty", async () => {
	const harness = makeRecordingEmit(validateRecord);
	const { page } = makeFakePage({
		categoriesAvailable: true,
		categoryRows: [],
		dialogScrapes: [[], []],
		fetchScript: {},
		webInfoUser: WEB_INFO_USER,
	});
	const requested = new Map([["ads", { name: "ads" }]]);
	const harnessCtx: BrowserCollectContext = {
		assist: async (): Promise<never> => {
			throw new Error("not implemented");
		},
		capture: null,
		completeAssistance: async () => undefined,
		context: {} as BrowserCollectContext["context"],
		credentials: {},
		detailGaps: [],
		emit: harness.emit,
		emitRecord: harness.emitRecord,
		emittedAt: EMITTED_AT,
		page,
		progress: async () => undefined,
		requestDetailGapPage: async (): Promise<readonly never[]> => [],
		requested,
		scope: { streams: [] },
		sendInteraction: async (): Promise<never> => {
			throw new Error("not implemented");
		},
		state: {},
	};

	await collectAllStreams(harnessCtx, NO_DELAY);

	assert.equal(harness.emitted.length, 0);
	assert.deepEqual(
		harness.protocolMessages.find((m) => m.type === "DETAIL_COVERAGE"),
		{
			hydrated_keys: ["advertisers", "ad_topics", "targeting_categories"],
			reference_only: true,
			required_keys: ["advertisers", "ad_topics", "targeting_categories"],
			state_stream: "ads",
			stream: "ads",
			type: "DETAIL_COVERAGE",
		},
	);
	assert.deepEqual(
		buildRunSummary(harness.protocolMessages, {
			connector: "meta",
			finished_at: EMITTED_AT,
			started_at: EMITTED_AT,
			tool_version: "test",
		}).done.coverage,
		{ considered: 3, covered: 3, streams: ["ads"] },
	);
	assert.equal(
		harness.protocolMessages.some((m) => m.type === "SKIP_RESULT"),
		false,
	);
});

test("scrapeAdvertisers waits for items that arrive after the list shell", async () => {
	const { page, waitConditions } = makeFakePage({
		delayFirstDialogItems: true,
		dialogScrapes: [["Acme Corp"]],
		fetchScript: {},
	});

	assert.deepEqual(await scrapeAdvertisers(page), {
		items: ["Acme Corp"],
		reached: true,
		step: null,
		surface: "advertisers",
	});
	assert.ok(
		waitConditions.some((condition) => condition.includes('[role="listitem"]')),
		"the scrape must wait for list items after the dialog list mounts",
	);
});

test("scrapeAdvertisers accepts a settled blank list as verified empty", async () => {
	const { page, waitTimeouts } = makeFakePage({
		dialogScrapes: [[]],
		fetchScript: {},
		waitEmptySettle: true,
	});
	const startedAt = Date.now();

	assert.deepEqual(await scrapeAdvertisers(page), {
		items: [],
		reached: true,
		step: "reached_empty",
		surface: "advertisers",
	});
	assert.ok(Date.now() - startedAt >= 2_500);
	assert.ok(waitTimeouts.includes(2_500));
});

test("scrapeAdvertisers rejects visible rows when an advertiser error is present", async () => {
	const browser = await chromium.launch({ headless: true });
	try {
		const page = await browser.newPage();
		await page.route("https://accountscenter.instagram.com/**", async (route) => {
			await route.fulfill({
				contentType: "text/html",
				body: `
					<html><body>
						<div role="button" aria-label="Advertisers you saw ads from">Advertisers</div>
						<script>
							document.querySelector('[role="button"]').addEventListener('click', () => {
								document.body.insertAdjacentHTML('beforeend', '<div role="dialog"><div role="list"><div role="listitem">Advertiser A</div></div><div role="alert">Some advertisers could not be loaded. Try again.</div></div>');
							});
						</script>
					</body></html>`,
				status: 200,
			});
		});

		assert.deepEqual(await scrapeAdvertisers(page), {
			items: [],
			reached: false,
			step: "destination_list_not_found",
			surface: "advertisers",
		});
	} finally {
		await browser.close();
	}
});

test("scrapeAdvertisers accepts a visible exact empty marker", async () => {
	const browser = await chromium.launch({ headless: true });
	try {
		const page = await browser.newPage();
		await page.route("https://accountscenter.instagram.com/**", async (route) => {
			await route.fulfill({
				contentType: "text/html",
				body: `
					<html><body>
						<div role="button" aria-label="Advertisers you saw ads from">Advertisers</div>
						<script>
							document.querySelector('[role="button"]').addEventListener('click', () => {
								document.body.insertAdjacentHTML('beforeend', '<div role="dialog"><div role="list"></div><div>No advertisers</div></div>');
							});
						</script>
					</body></html>`,
				status: 200,
			});
		});

		assert.deepEqual(await scrapeAdvertisers(page), {
			items: [],
			reached: true,
			step: "reached_empty",
			surface: "advertisers",
		});
	} finally {
		await browser.close();
	}
});

test("scrapeAdTopics accepts a settled blank list as verified empty", async () => {
	const browser = await chromium.launch({ headless: true });
	try {
		const page = await browser.newPage();
		await page.route("https://accountscenter.instagram.com/**", async (route) => {
			await route.fulfill({
				contentType: "text/html",
				body: '<html><body><div role="dialog" style="width:200px;min-height:80px"><div role="list" style="min-height:40px"></div></div></body></html>',
				status: 200,
			});
		});

		assert.deepEqual(await scrapeAdTopics(page), {
			items: [],
			reached: true,
			step: "reached_empty",
			surface: "ad_topics",
		});
	} finally {
		await browser.close();
	}
});

test("scrapeAdTopics ignores hidden list rows and hidden empty marker", async () => {
	const browser = await chromium.launch({ headless: true });
	try {
		const page = await browser.newPage();
		await page.route("https://accountscenter.instagram.com/**", async (route) => {
			await route.fulfill({
				contentType: "text/html",
				body: '<html><body><div role="dialog"><div role="list"><div role="listitem" style="display:none">Hidden Topic</div></div><div><span style="display:none">No ad topics</span></div></div></body></html>',
				status: 200,
			});
		});

		assert.deepEqual(await scrapeAdTopics(page), {
			items: [],
			reached: false,
			step: "destination_list_not_found",
			surface: "ad_topics",
		});
	} finally {
		await browser.close();
	}
});

test("scrapeAdvertisers keeps busy exact empty marker unavailable", async () => {
	const browser = await chromium.launch({ headless: true });
	try {
		const page = await browser.newPage();
		await page.route("https://accountscenter.instagram.com/**", async (route) => {
			await route.fulfill({
				contentType: "text/html",
				body: `
					<html><body>
						<div role="button" aria-label="Advertisers you saw ads from">Advertisers</div>
						<script>
							document.querySelector('[role="button"]').addEventListener('click', () => {
								document.body.insertAdjacentHTML('beforeend', '<div role="dialog" aria-busy="true"><div role="list"></div><div>No advertisers</div></div>');
							});
						</script>
					</body></html>`,
				status: 200,
			});
		});

		assert.deepEqual(await scrapeAdvertisers(page), {
			items: [],
			reached: false,
			step: "destination_list_not_found",
			surface: "advertisers",
		});
	} finally {
		await browser.close();
	}
});

test("scrapeAdvertisers keeps busy rows unavailable", async () => {
	const browser = await chromium.launch({ headless: true });
	try {
		const page = await browser.newPage();
		await page.route("https://accountscenter.instagram.com/**", async (route) => {
			await route.fulfill({
				contentType: "text/html",
				body: `
					<html><body>
						<div role="button" aria-label="Advertisers you saw ads from">Advertisers</div>
						<script>
							document.querySelector('[role="button"]').addEventListener('click', () => {
								document.body.insertAdjacentHTML('beforeend', '<div role="dialog" aria-busy="true"><div role="list"><div role="listitem">Advertiser A</div></div></div>');
							});
						</script>
					</body></html>`,
				status: 200,
			});
		});

		assert.deepEqual(await scrapeAdvertisers(page), {
			items: [],
			reached: false,
			step: "destination_list_not_found",
			surface: "advertisers",
		});
	} finally {
		await browser.close();
	}
});

test("scrapeAdTopics treats settled UI-only rows as verified empty without marker", async () => {
	const browser = await chromium.launch({ headless: true });
	try {
		const page = await browser.newPage();
		await page.route("https://accountscenter.instagram.com/**", async (route) => {
			await route.fulfill({
				contentType: "text/html",
				body: '<html><body><div role="dialog"><div role="list"><div role="listitem">Special topic</div><div role="listitem">See less</div></div></div></body></html>',
				status: 200,
			});
		});

		const startedAt = Date.now();
		assert.deepEqual(await scrapeAdTopics(page), {
			items: [],
			reached: true,
			step: "reached_empty",
			surface: "ad_topics",
		});
		assert.ok(Date.now() - startedAt >= 2_500);
	} finally {
		await browser.close();
	}
});

test("scrapeAdTopics accepts UI-only rows with a visible exact empty marker", async () => {
	const browser = await chromium.launch({ headless: true });
	try {
		const page = await browser.newPage();
		await page.route("https://accountscenter.instagram.com/**", async (route) => {
			await route.fulfill({
				contentType: "text/html",
				body: '<html><body><div role="dialog"><div role="list"><div role="listitem">Special topic</div><div role="listitem">See less</div></div><div>No ad topics</div></div></body></html>',
				status: 200,
			});
		});

		assert.deepEqual(await scrapeAdTopics(page), {
			items: [],
			reached: true,
			step: "reached_empty",
			surface: "ad_topics",
		});
	} finally {
		await browser.close();
	}
});

test("scrapeAdTopics accepts a visible exact empty marker", async () => {
	const browser = await chromium.launch({ headless: true });
	try {
		const page = await browser.newPage();
		await page.route("https://accountscenter.instagram.com/**", async (route) => {
			await route.fulfill({
				contentType: "text/html",
				body: '<html><body><div role="dialog"><div role="list"></div><div>No ad topics</div></div></body></html>',
				status: 200,
			});
		});

		assert.deepEqual(await scrapeAdTopics(page), {
			items: [],
			reached: true,
			step: "reached_empty",
			surface: "ad_topics",
		});
	} finally {
		await browser.close();
	}
});

test("collectAllStreams: ads missing a surface emits partial coverage without SKIP_RESULT", async () => {
	const harness = makeRecordingEmit(validateRecord);
	const { page, waitRejections } = makeFakePage({
		categoriesAvailable: false,
		dialogScrapes: [["Acme Corp"], ["Sports & Fitness"]],
		fetchScript: {},
		webInfoUser: WEB_INFO_USER,
	});
	const requested = new Map([["ads", { name: "ads" }]]);
	const harnessCtx: BrowserCollectContext = {
		assist: async (): Promise<never> => {
			throw new Error("not implemented");
		},
		capture: null,
		completeAssistance: async () => undefined,
		context: {} as BrowserCollectContext["context"],
		credentials: {},
		detailGaps: [],
		emit: harness.emit,
		emitRecord: harness.emitRecord,
		emittedAt: EMITTED_AT,
		page,
		progress: async () => undefined,
		requestDetailGapPage: async (): Promise<readonly never[]> => [],
		requested,
		scope: { streams: [] },
		sendInteraction: async (): Promise<never> => {
			throw new Error("not implemented");
		},
		state: {},
	};

	await collectAllStreams(harnessCtx, NO_DELAY);

	assert.deepEqual(
		harness.protocolMessages.find((m) => m.type === "DETAIL_COVERAGE"),
		{
			hydrated_keys: ["advertisers", "ad_topics"],
			reference_only: true,
			required_keys: ["advertisers", "ad_topics", "targeting_categories"],
			state_stream: "ads",
			stream: "ads",
			type: "DETAIL_COVERAGE",
		},
	);
	assert.deepEqual(
		buildRunSummary(harness.protocolMessages, {
			connector: "meta",
			finished_at: EMITTED_AT,
			started_at: EMITTED_AT,
			tool_version: "test",
		}).done.coverage,
		{ considered: 3, covered: 2, streams: ["ads"] },
	);
	assert.equal(
		harness.protocolMessages.some(
			(m) => m.type === "SKIP_RESULT" && m.stream === "ads",
		),
		false,
	);
	assert.ok(
		waitRejections.some((condition) => condition.includes("Manage info")),
		"an unavailable Manage info tab must reject its Playwright-style wait",
	);
});

test("collectAllStreams: dialog without its intended list reports partial coverage when another ads surface is reached", async () => {
	const harness = makeRecordingEmit(validateRecord);
	const { page } = makeFakePage({
		categoriesAvailable: true,
		categoryRows: [],
		dialogReached: [false, true],
		dialogScrapes: [[], []],
		fetchScript: {},
		webInfoUser: WEB_INFO_USER,
	});
	const harnessCtx: BrowserCollectContext = {
		assist: async (): Promise<never> => {
			throw new Error("not implemented");
		},
		capture: null,
		completeAssistance: async () => undefined,
		context: {} as BrowserCollectContext["context"],
		credentials: {},
		detailGaps: [],
		emit: harness.emit,
		emitRecord: harness.emitRecord,
		emittedAt: EMITTED_AT,
		page,
		progress: async () => undefined,
		requestDetailGapPage: async (): Promise<readonly never[]> => [],
		requested: new Map([["ads", { name: "ads" }]]),
		scope: { streams: [] },
		sendInteraction: async (): Promise<never> => {
			throw new Error("not implemented");
		},
		state: {},
	};

	await collectAllStreams(harnessCtx, NO_DELAY);

	assert.deepEqual(
		harness.protocolMessages.find((m) => m.type === "DETAIL_COVERAGE"),
		{
			hydrated_keys: ["ad_topics", "targeting_categories"],
			reference_only: true,
			required_keys: ["advertisers", "ad_topics", "targeting_categories"],
			state_stream: "ads",
			stream: "ads",
			type: "DETAIL_COVERAGE",
		},
	);
	assert.equal(
		harness.protocolMessages.some(
			(m) => m.type === "SKIP_RESULT" && m.stream === "ads",
		),
		false,
	);
});

test("scrapeTargetingCategories keeps hidden View all without new rows unavailable", async () => {
	const browser = await chromium.launch({ headless: true });
	try {
		const page = await browser.newPage();
		await page.route("https://accountscenter.instagram.com/**", async (route) => {
			await route.fulfill({
				contentType: "text/html",
				body: `
					<html><body>
						<div role="tab">Manage info</div>
						<div role="tabpanel"><div role="link">Categories used to reach you</div></div>
						<button role="button">View all</button>
						<script>
							document.querySelector('[role="tab"]').addEventListener('click', () => {});
							document.querySelector('[role="link"]').addEventListener('click', () => {
								document.body.insertAdjacentHTML('beforeend', '<div role="dialog"><div role="list"><div role="listitem"><span>Category</span><button role="button">Remove</button></div></div><button role="button" id="dialog-view-all">View all</button></div>');
								document.querySelector('#dialog-view-all').addEventListener('click', (event) => {
									event.currentTarget.style.display = 'none';
								});
							});
						</script>
					</body></html>`,
				status: 200,
			});
		});

		const result = await scrapeTargetingCategories(page);

		assert.equal(result.reached, false);
		assert.equal(result.step, "destination_list_not_found");
		assert.equal(result.items.length, 1);
	} finally {
		await browser.close();
	}
});


test("scrapeTargetingCategories collects visible removable rows across all expanded dialog lists", async () => {
	const browser = await chromium.launch({ headless: true });
	try {
		const page = await browser.newPage();
		await page.route("https://accountscenter.instagram.com/**", async (route) => {
			await route.fulfill({
				contentType: "text/html",
				body: `
					<html><body>
						<div role="tab">Manage info</div>
						<div role="tabpanel"><div role="link">Categories used to reach you</div></div>
						<script>
							document.querySelector('[role="link"]').addEventListener('click', () => {
								document.body.insertAdjacentHTML('beforeend', '<div role="dialog"><div role="list"><div role="listitem"><span>Category A</span><button role="button">Remove</button></div></div><button role="button" id="dialog-view-all">View all</button></div>');
								document.querySelector('#dialog-view-all').addEventListener('click', (event) => {
									event.currentTarget.style.display = 'none';
									document.querySelector('[role="dialog"]').insertAdjacentHTML('beforeend', '<div role="list"><div role="listitem"><span>Category B</span><button role="button">Remove</button></div></div><div role="list"><div role="listitem" style="display:none"><span>Hidden Category</span><button role="button">Remove</button></div></div>');
								});
							});
						</script>
					</body></html>`,
				status: 200,
			});
		});

		const result = await scrapeTargetingCategories(page);

		assert.equal(result.reached, true);
		assert.equal(result.items.length, 2);
	} finally {
		await browser.close();
	}
});

test("scrapeTargetingCategories waits for rows appended after View all hides", async () => {
	const browser = await chromium.launch({ headless: true });
	try {
		const page = await browser.newPage();
		await page.route("https://accountscenter.instagram.com/**", async (route) => {
			await route.fulfill({
				contentType: "text/html",
				body: `
					<html><body>
						<div role="tab">Manage info</div>
						<div role="tabpanel"><div role="link">Categories used to reach you</div></div>
						<script>
							document.querySelector('[role="link"]').addEventListener('click', () => {
								document.body.insertAdjacentHTML('beforeend', '<div role="dialog"><div role="list"><div role="listitem"><span>Category A</span><button role="button">Remove</button></div></div><button role="button" id="dialog-view-all">View all</button></div>');
								document.querySelector('#dialog-view-all').addEventListener('click', (event) => {
									event.currentTarget.style.display = 'none';
									setTimeout(() => {
										document.querySelector('[role="dialog"] [role="list"]').insertAdjacentHTML('beforeend', '<div role="listitem"><span>Category B</span><button role="button">Remove</button></div><div role="listitem"><span>Category C</span><button role="button">Remove</button></div>');
									}, 500);
								});
							});
						</script>
					</body></html>`,
				status: 200,
			});
		});

		const result = await scrapeTargetingCategories(page);

		assert.equal(result.reached, true);
		assert.equal(result.items.length, 3);
	} finally {
		await browser.close();
	}
});

test("scrapeTargetingCategories ignores hidden stale dialogs before the active categories dialog", async () => {
	const browser = await chromium.launch({ headless: true });
	try {
		const page = await browser.newPage();
		await page.route("https://accountscenter.instagram.com/**", async (route) => {
			await route.fulfill({
				contentType: "text/html",
				body: `
					<html><body>
						<div role="dialog" style="display:none"><div role="list"><div role="listitem"><span>Stale Category</span><button role="button">Remove</button></div></div></div>
						<div role="tab">Manage info</div>
						<div role="tabpanel"><div role="link">Categories used to reach you</div></div>
						<script>
							document.querySelector('[role="link"]').addEventListener('click', () => {
								document.body.insertAdjacentHTML('beforeend', '<div role="dialog"><div role="list"><div role="listitem"><span>Active Category</span><button role="button">Remove</button></div></div></div>');
							});
						</script>
					</body></html>`,
				status: 200,
			});
		});

		const result = await scrapeTargetingCategories(page);

		assert.equal(result.reached, true);
		assert.equal(result.items.length, 1);
		assert.equal(result.items[0]?.name, "Active Category");
	} finally {
		await browser.close();
	}
});


test("scrapeTargetingCategories returns unavailable when the dialog list is replaced by an error during settle", async () => {
	const browser = await chromium.launch({ headless: true });
	try {
		const page = await browser.newPage();
		await page.route("https://accountscenter.instagram.com/**", async (route) => {
			await route.fulfill({
				contentType: "text/html",
				body: `
					<html><body>
						<div role="tab">Manage info</div>
						<div role="tabpanel"><div role="link">Categories used to reach you</div></div>
						<script>
							document.querySelector('[role="link"]').addEventListener('click', () => {
								document.body.insertAdjacentHTML('beforeend', '<div role="dialog" style="min-height:40px"><div role="list"><div role="listitem"><span>Category A</span><button role="button">Remove</button></div></div></div>');
								setTimeout(() => { document.querySelector('[role="dialog"]').innerHTML = '<div role="alert">Temporarily unavailable</div>'; }, 300);
							});
						</script>
					</body></html>`,
				status: 200,
			});
		});

		const result = await scrapeTargetingCategories(page);

		assert.equal(result.reached, false);
		assert.equal(result.step, "destination_list_not_found");
		assert.equal(result.items.length, 0);
	} finally {
		await browser.close();
	}
});

test("scrapeTargetingCategories does not complete while category rows are still busy", async () => {
	const browser = await chromium.launch({ headless: true });
	try {
		const page = await browser.newPage();
		await page.route("https://accountscenter.instagram.com/**", async (route) => {
			await route.fulfill({
				contentType: "text/html",
				body: `
					<html><body>
						<div role="tab">Manage info</div>
						<div role="tabpanel"><div role="link">Categories used to reach you</div></div>
						<script>
							document.querySelector('[role="link"]').addEventListener('click', () => {
								document.body.insertAdjacentHTML('beforeend', '<div role="dialog" aria-busy="true"><div role="list"><div role="listitem"><span>Category A</span><button role="button">Remove</button></div></div><button role="button" id="dialog-view-all">View all</button></div>');
								document.querySelector('#dialog-view-all').addEventListener('click', (event) => {
									event.currentTarget.style.display = 'none';
									document.querySelector('[role="dialog"] [role="list"]').insertAdjacentHTML('beforeend', '<div role="listitem"><span>Category B</span><button role="button">Remove</button></div>');
									setTimeout(() => {
										document.querySelector('[role="dialog"] [role="list"]').insertAdjacentHTML('beforeend', '<div role="listitem"><span>Category C</span><button role="button">Remove</button></div>');
										document.querySelector('[role="dialog"]').setAttribute('aria-busy', 'false');
									}, 3500);
								});
							});
						</script>
					</body></html>`,
				status: 200,
			});
		});

		const result = await scrapeTargetingCategories(page);

		assert.equal(result.reached, false);
		assert.equal(result.step, "destination_list_not_found");
	} finally {
		await browser.close();
	}
});


test("scrapeTargetingCategories ignores hidden empty categories marker", async () => {
	const browser = await chromium.launch({ headless: true });
	try {
		const page = await browser.newPage();
		await page.route("https://accountscenter.instagram.com/**", async (route) => {
			await route.fulfill({
				contentType: "text/html",
				body: `
					<html><body>
						<div role="tab">Manage info</div>
						<div role="tabpanel"><div role="link">Categories used to reach you</div></div>
						<script>
							document.querySelector('[role="link"]').addEventListener('click', () => {
								document.body.insertAdjacentHTML('beforeend', '<div role="dialog"><div role="list"></div><div style="display:none">No categories</div></div>');
							});
						</script>
					</body></html>`,
				status: 200,
			});
		});

		const result = await scrapeTargetingCategories(page);

		assert.equal(result.reached, false);
		assert.equal(result.step, "destination_list_not_found");
		assert.equal(result.items.length, 0);
	} finally {
		await browser.close();
	}
});

test("scrapeTargetingCategories ignores visible wrapper with hidden empty text", async () => {
	const browser = await chromium.launch({ headless: true });
	try {
		const page = await browser.newPage();
		await page.route("https://accountscenter.instagram.com/**", async (route) => {
			await route.fulfill({
				contentType: "text/html",
				body: `
					<html><body>
						<div role="tab">Manage info</div>
						<div role="tabpanel"><div role="link">Categories used to reach you</div></div>
						<script>
							document.querySelector('[role="link"]').addEventListener('click', () => {
								document.body.insertAdjacentHTML('beforeend', '<div role="dialog"><div role="list"></div><div><span style="display:none">No categories</span></div></div>');
							});
						</script>
					</body></html>`,
				status: 200,
			});
		});

		const result = await scrapeTargetingCategories(page);

		assert.equal(result.reached, false);
		assert.equal(result.step, "destination_list_not_found");
		assert.equal(result.items.length, 0);
	} finally {
		await browser.close();
	}
});

test("scrapeTargetingCategories treats no-categories alert as unavailable", async () => {
	const browser = await chromium.launch({ headless: true });
	try {
		const page = await browser.newPage();
		await page.route("https://accountscenter.instagram.com/**", async (route) => {
			await route.fulfill({
				contentType: "text/html",
				body: `
					<html><body>
						<div role="tab">Manage info</div>
						<div role="tabpanel"><div role="link">Categories used to reach you</div></div>
						<script>
							document.querySelector('[role="link"]').addEventListener('click', () => {
								document.body.insertAdjacentHTML('beforeend', '<div role="dialog"><div role="list"></div><div role="alert">No categories could not be loaded. Try again.</div></div>');
							});
						</script>
					</body></html>`,
				status: 200,
			});
		});

		const result = await scrapeTargetingCategories(page);

		assert.equal(result.reached, false);
		assert.equal(result.step, "destination_list_not_found");
		assert.equal(result.items.length, 0);
	} finally {
		await browser.close();
	}
});

test("scrapeTargetingCategories rejects rows when a visible category error is present", async () => {
	const browser = await chromium.launch({ headless: true });
	try {
		const page = await browser.newPage();
		await page.route("https://accountscenter.instagram.com/**", async (route) => {
			await route.fulfill({
				contentType: "text/html",
				body: `
					<html><body>
						<div role="tab">Manage info</div>
						<div role="tabpanel"><div role="link">Categories used to reach you</div></div>
						<script>
							document.querySelector('[role="link"]').addEventListener('click', () => {
								document.body.insertAdjacentHTML('beforeend', '<div role="dialog"><div role="list"><div role="listitem"><span>Category A</span><button role="button">Remove</button></div></div><div role="alert">Some categories could not be loaded. Try again.</div></div>');
							});
						</script>
					</body></html>`,
				status: 200,
			});
		});

		const result = await scrapeTargetingCategories(page);

		assert.equal(result.reached, false);
		assert.equal(result.step, "destination_list_not_found");
		assert.equal(result.items.length, 0);
	} finally {
		await browser.close();
	}
});

test("scrapeTargetingCategories accepts explicit empty categories marker", async () => {
	const browser = await chromium.launch({ headless: true });
	try {
		const page = await browser.newPage();
		await page.route("https://accountscenter.instagram.com/**", async (route) => {
			await route.fulfill({
				contentType: "text/html",
				body: `
					<html><body>
						<div role="tab">Manage info</div>
						<div role="tabpanel"><div role="link">Categories used to reach you</div></div>
						<script>
							document.querySelector('[role="link"]').addEventListener('click', () => {
								document.body.insertAdjacentHTML('beforeend', '<div role="dialog"><div role="list"></div><div>No categories</div></div>');
							});
						</script>
					</body></html>`,
				status: 200,
			});
		});

		const result = await scrapeTargetingCategories(page);

		assert.equal(result.reached, true);
		assert.equal(result.step, "reached_empty");
		assert.equal(result.items.length, 0);
	} finally {
		await browser.close();
	}
});

test("scrapeTargetingCategories keeps blank categories list without empty marker unavailable", async () => {
	const browser = await chromium.launch({ headless: true });
	try {
		const page = await browser.newPage();
		await page.route("https://accountscenter.instagram.com/**", async (route) => {
			await route.fulfill({
				contentType: "text/html",
				body: `
					<html><body>
						<div role="tab">Manage info</div>
						<div role="tabpanel"><div role="link">Categories used to reach you</div></div>
						<script>
							document.querySelector('[role="link"]').addEventListener('click', () => {
								document.body.insertAdjacentHTML('beforeend', '<div role="dialog" style="width:200px;min-height:80px"><div role="list" style="min-height:40px"></div></div>');
							});
						</script>
					</body></html>`,
				status: 200,
			});
		});

		const result = await scrapeTargetingCategories(page);

		assert.equal(result.reached, false);
		assert.equal(result.step, "destination_list_not_found");
		assert.equal(result.items.length, 0);
	} finally {
		await browser.close();
	}
});

test("collectAllStreams: category View all ignores hidden page-wide buttons after dialog expansion", async () => {
	const harness = makeRecordingEmit(validateRecord);
	const { page } = makeFakePage({
		categoriesAvailable: true,
		categoryRows: [{ description: null, name: "Category" }],
		dialogScrapes: [[], []],
		dialogViewAllAfterClick: "hidden",
		fetchScript: {},
		webInfoUser: WEB_INFO_USER,
	});
	const harnessCtx: BrowserCollectContext = {
		assist: async (): Promise<never> => {
			throw new Error("not implemented");
		},
		capture: null,
		completeAssistance: async () => undefined,
		context: {} as BrowserCollectContext["context"],
		credentials: {},
		detailGaps: [],
		emit: harness.emit,
		emitRecord: harness.emitRecord,
		emittedAt: EMITTED_AT,
		page,
		progress: async () => undefined,
		requestDetailGapPage: async (): Promise<readonly never[]> => [],
		requested: new Map([["ads", { name: "ads" }]]),
		scope: { streams: [] },
		sendInteraction: async (): Promise<never> => {
			throw new Error("not implemented");
		},
		state: {},
	};

	await collectAllStreams(harnessCtx, NO_DELAY);

	assert.deepEqual(
		harness.protocolMessages.find((m) => m.type === "DETAIL_COVERAGE"),
		{
			hydrated_keys: ["advertisers", "ad_topics", "targeting_categories"],
			reference_only: true,
			required_keys: ["advertisers", "ad_topics", "targeting_categories"],
			state_stream: "ads",
			stream: "ads",
			type: "DETAIL_COVERAGE",
		},
	);
	assert.equal(
		harness.protocolMessages.some((m) => m.type === "SKIP_RESULT"),
		false,
	);
	assert.ok(
		harness.emitted.some(
			(record) =>
				record.stream === "ads" && record.data.kind === "ad_category",
		),
	);
});


test("collectAllStreams: category-only ads reach still emits ads unavailable", async () => {
	const harness = makeRecordingEmit(validateRecord);
	const { page } = makeFakePage({
		categoriesAvailable: true,
		categoryRows: [{ description: null, name: "Category" }],
		dialogReached: [false, false],
		dialogScrapes: [[], []],
		dialogViewAllAfterClick: "hidden",
		fetchScript: {},
		webInfoUser: WEB_INFO_USER,
	});
	const harnessCtx: BrowserCollectContext = {
		assist: async (): Promise<never> => {
			throw new Error("not implemented");
		},
		capture: null,
		completeAssistance: async () => undefined,
		context: {} as BrowserCollectContext["context"],
		credentials: {},
		detailGaps: [],
		emit: harness.emit,
		emitRecord: harness.emitRecord,
		emittedAt: EMITTED_AT,
		page,
		progress: async () => undefined,
		requestDetailGapPage: async (): Promise<readonly never[]> => [],
		requested: new Map([["ads", { name: "ads" }]]),
		scope: { streams: [] },
		sendInteraction: async (): Promise<never> => {
			throw new Error("not implemented");
		},
		state: {},
	};

	await collectAllStreams(harnessCtx, NO_DELAY);

	assert.deepEqual(
		harness.protocolMessages.find((m) => m.type === "DETAIL_COVERAGE"),
		{
			hydrated_keys: ["targeting_categories"],
			reference_only: true,
			required_keys: ["advertisers", "ad_topics", "targeting_categories"],
			state_stream: "ads",
			stream: "ads",
			type: "DETAIL_COVERAGE",
		},
	);
	const skip = harness.protocolMessages.find(
		(m): m is Extract<EmittedMessage, { type: "SKIP_RESULT" }> =>
			m.type === "SKIP_RESULT" && m.stream === "ads",
	);
	assert.ok(skip);
	assert.equal(skip.reason, "ads_surfaces_unavailable");
	assert.deepEqual(skip.diagnostics, {
		missing_surfaces: ["advertisers", "ad_topics"],
		surface_steps: [
			{ surface: "advertisers", step: "destination_list_not_found" },
			{ surface: "ad_topics", step: "destination_list_not_found" },
		],
	});
});

test("collectAllStreams: successful core ads surfaces tolerate missing category destination list", async () => {
	const harness = makeRecordingEmit(validateRecord);
	const { page } = makeFakePage({
		categoriesAvailable: true,
		categoryDestinationReached: false,
		categoryRows: [],
		dialogScrapes: [[], []],
		fetchScript: {},
		webInfoUser: WEB_INFO_USER,
	});
	const harnessCtx: BrowserCollectContext = {
		assist: async (): Promise<never> => {
			throw new Error("not implemented");
		},
		capture: null,
		completeAssistance: async () => undefined,
		context: {} as BrowserCollectContext["context"],
		credentials: {},
		detailGaps: [],
		emit: harness.emit,
		emitRecord: harness.emitRecord,
		emittedAt: EMITTED_AT,
		page,
		progress: async () => undefined,
		requestDetailGapPage: async (): Promise<readonly never[]> => [],
		requested: new Map([["ads", { name: "ads" }]]),
		scope: { streams: [] },
		sendInteraction: async (): Promise<never> => {
			throw new Error("not implemented");
		},
		state: {},
	};

	await collectAllStreams(harnessCtx, NO_DELAY);

	assert.deepEqual(
		harness.protocolMessages.find((m) => m.type === "DETAIL_COVERAGE"),
		{
			hydrated_keys: ["advertisers", "ad_topics"],
			reference_only: true,
			required_keys: ["advertisers", "ad_topics", "targeting_categories"],
			state_stream: "ads",
			stream: "ads",
			type: "DETAIL_COVERAGE",
		},
	);
	assert.equal(
		harness.protocolMessages.some(
			(m) => m.type === "SKIP_RESULT" && m.stream === "ads",
		),
		false,
	);
});

test("collectAllStreams: ads navigation failure reports only a bounded surface step", async () => {
	const harness = makeRecordingEmit(validateRecord);
	const { ctx } = makeCtx({
		fetchScript: {},
		harness,
		pageOptions: {
			categoriesAvailable: true,
			categoryRows: [{ description: null, name: "Music" }],
			dialogScrapes: [["Acme"], ["Sports"]],
			navigationFailures: ["/ads/ad_topics/"],
		},
		requestedStreams: ["ads"],
	});

	await collectAllStreams(ctx, NO_DELAY);

	assert.deepEqual(
		harness.protocolMessages.find((m) => m.type === "DETAIL_COVERAGE"),
		{
			hydrated_keys: ["advertisers", "targeting_categories"],
			reference_only: true,
			required_keys: ["advertisers", "ad_topics", "targeting_categories"],
			state_stream: "ads",
			stream: "ads",
			type: "DETAIL_COVERAGE",
		},
	);
	assert.equal(
		harness.protocolMessages.some(
			(m) => m.type === "SKIP_RESULT" && m.stream === "ads",
		),
		false,
	);
	assert.deepEqual(
		harness.emitted.map((record) => record.data.kind),
		["advertiser", "ad_category"],
	);
});

// ─── Invariant 6: shape-check catches a drifted record ──────────────────

test("collectAllStreams: a profile record missing username lands in SKIP_RESULT, not RECORD", async () => {
	const harness = makeRecordingEmit(validateRecord);
	// id present but username absent → profileRecord() itself returns null and
	// nothing is emitted, so this proves the null-guard rather than schema
	// rejection; schema-level drift is covered by synthetic-fixture.test.ts.
	const { ctx } = makeCtx({
		fetchScript: {},
		harness,
		requestedStreams: ["profile"],
		webInfoUser: { id: "u1" },
	});

	await assert.rejects(collectAllStreams(ctx), /meta_profile_unavailable/);
});
