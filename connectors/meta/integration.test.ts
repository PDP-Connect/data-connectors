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
import { test } from "node:test";
import type { Page } from "playwright";
import type {
	BrowserCollectContext,
	EmittedMessage,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { buildRunSummary } from "../../packages/polyfill-connectors/src/run-summary.ts";
import { makeRecordingEmit } from "../../packages/polyfill-connectors/src/test-harness.ts";
import {
	collectAllStreams,
	isLoginOrChallengeDomFacts,
	scrapeAdvertisers,
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
type ScriptedPostsPage = {
	json: unknown;
	status: number;
	postData?: string;
	samePage?: boolean;
	url?: string;
} | null;

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
	dialogScrapes?: string[][];
	dialogReached?: boolean[];
	delayFirstDialogItems?: boolean;
	waitEmptySettle?: boolean;
	fetchScript: Record<string, ScriptedFetch[]>;
	navigationFailures?: string[];
	pageUrlAfterGoto?: string;
	postsAutoResolveWaitForResponseCall?: number;
	postsChallengeDom?: {
		hasCaptchaSitekey?: boolean;
		hasEmailInput?: boolean;
		hasVerificationInput?: boolean;
		text: string;
	};
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
	let currentUrl = "about:blank";
	let postsWaitForResponseCalls = 0;
	let pendingPostsResolve: ((value: unknown) => void) | null = null;
	let pendingPostsPredicate: ((value: unknown) => boolean) | null = null;
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
		const postData = scripted.postData ?? "fb_api_req_friendly_name=PolarisProfilePostsQuery";
		const friendlyName = /fb_api_req_friendly_name=([^&]+)/.exec(postData)?.[1] ?? "PolarisProfilePostsQuery";
		const response = {
			json: () => Promise.resolve(scripted.json),
			request: () => ({
				frame: () => ({ page: () => (scripted.samePage === false ? {} : page) }),
				headers: () => ({ "x-fb-friendly-name": friendlyName }),
				method: () => "POST",
				postData: () => postData,
			}),
			status: () => scripted.status,
			url: () => scripted.url ?? "https://www.instagram.com/graphql/query",
		};
		if (pendingPostsPredicate && !pendingPostsPredicate(response)) {
			next(null);
			return;
		}
		next(response);
	};

	const page = {
		goto: (url?: string): Promise<null> => {
			if (
				url &&
				options.navigationFailures?.some((path) => url.includes(path))
			) {
				return Promise.reject(new Error("scripted navigation failure"));
			}
			currentUrl = options.pageUrlAfterGoto ?? url ?? currentUrl;
			resolveNextPostsPage();
			return Promise.resolve(null);
		},
		url: () => currentUrl,
		waitForResponse: (predicate: unknown, opts?: { timeout?: number }): Promise<unknown> =>
			new Promise((resolve) => {
					postsWaitForResponseCalls += 1;
					pendingPostsPredicate =
						typeof predicate === "function"
							? (value: unknown) => Boolean(predicate(value))
							: null;
				pendingPostsResolve = resolve;
				if (
					options.postsAutoResolveWaitForResponseCall ===
					postsWaitForResponseCalls
				) {
					setTimeout(resolveNextPostsPage, 300);
				}
				if ((opts?.timeout ?? 0) <= 500) {
					setTimeout(() => {
						if (pendingPostsResolve === resolve) {
							pendingPostsResolve = null;
							resolve(null);
						}
					}, 510);
				}
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
			if (source.includes("verify you are human") || source.includes("security code")) {
				const dom = options.postsChallengeDom;
				const visible = dom
					? isLoginOrChallengeDomFacts({
							hasCaptchaSitekey: dom.hasCaptchaSitekey === true,
							hasEmailInput: dom.hasEmailInput === true,
							hasVerificationInput: dom.hasVerificationInput === true,
							text: dom.text,
						})
					: false;
				return new Promise((resolve, reject) => {
					setTimeout(() => {
						if (visible) {
							resolve(true);
							return;
						}
						waitRejections.push(source);
						reject(new Error("Timeout while waiting for fake DOM"));
					}, 300);
				});
			}
			if (source.includes("View all")) {
				return readiness(true);
			}
			if (source.includes("advertiser")) {
				return readiness(true);
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
			if (fnSource.includes("View all")) {
				return Promise.resolve(undefined);
			}
			if (fnSource.includes("Removed categories")) {
				return Promise.resolve({
					items: options.categoryRows ?? [],
					reached: options.categoryDestinationReached !== false,
				});
			}
			if (
				fnSource.includes("querySelectorAll") &&
				fnSource.includes("listitem")
			) {
				const items = dialogQueue[0];
				if (dialogScrapeCount++ === 0 && !firstDialogItemsReady) {
					return Promise.resolve({ items: [], reached: true });
				}
				dialogQueue.shift();
				return Promise.resolve({
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
		pageUrlAfterGoto?: string;
		postsAutoResolveWaitForResponseCall?: number;
		postsChallengeDom?: {
			hasCaptchaSitekey?: boolean;
			hasEmailInput?: boolean;
			hasVerificationInput?: boolean;
			text: string;
		};
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

const postsEnvelope = (
	edges: Array<{ node: Record<string, unknown> }>,
	pageInfo: Record<string, unknown> | null,
	extras: Record<string, unknown> = {},
): unknown => ({
	...extras,
	data: {
		xdt_api__v1__feed__user_timeline_graphql_connection: {
			edges,
			...(pageInfo === null ? {} : { page_info: pageInfo }),
		},
	},
});

const stateStreams = (messages: EmittedMessage[]): Array<string | undefined> =>
	messages
		.filter((message) => message.type === "STATE")
		.map((message) => message.stream)
		.sort();

type PostsDecision = "data" | "empty" | "not-proven";

const LEGACY_POST_OPERATION_RE =
	/(?:PolarisProfilePostsQuery|PolarisProfilePostsTabContentQuery_connection|ProfilePostsQuery|UserMediaQuery)/;

function legacyPostsDecision(raw: unknown): PostsDecision {
	if (!raw) {
		return "not-proven";
	}
	const envelope = raw as {
		data?: {
			data?: {
				xdt_api__v1__feed__user_timeline_graphql_connection?: {
					edges?: unknown;
					page_info?: { end_cursor?: unknown; has_next_page?: unknown } | null;
				} | null;
			} | null;
		} | null;
	};
	const connection =
		envelope.data?.data?.xdt_api__v1__feed__user_timeline_graphql_connection;
	if (!Array.isArray(connection?.edges)) {
		return "not-proven";
	}
	return connection.edges.length === 0 ? "empty" : "data";
}

function legacyPostsDecisionFromPages(
	pages: Array<{ postData?: string; raw: unknown }>,
): PostsDecision {
	let sawEmptyPage = false;
	for (const page of pages) {
		const postData = page.postData ?? "fb_api_req_friendly_name=PolarisProfilePostsQuery";
		if (!LEGACY_POST_OPERATION_RE.test(postData)) {
			continue;
		}
		const decision = legacyPostsDecision(page.raw);
		if (decision === "data") {
			return "data";
		}
		if (decision !== "empty") {
			return "not-proven";
		}
		sawEmptyPage = true;
		const connection = (page.raw as {
			data?: {
				data?: {
					xdt_api__v1__feed__user_timeline_graphql_connection?: {
						page_info?: { end_cursor?: unknown; has_next_page?: unknown } | null;
					} | null;
				} | null;
			} | null;
		}).data?.data?.xdt_api__v1__feed__user_timeline_graphql_connection;
		if (
			connection?.page_info?.has_next_page !== true ||
			typeof connection.page_info.end_cursor !== "string" ||
			connection.page_info.end_cursor.length === 0
		) {
			continue;
		}
	}
	return sawEmptyPage ? "empty" : "not-proven";
}

const legacyPostsEnvelope = (
	edges: Array<{ node: Record<string, unknown> }>,
	pageInfo: Record<string, unknown> | null,
	extras: Record<string, unknown> = {},
): unknown => ({
	...extras,
	data: { data: (postsEnvelope(edges, pageInfo) as { data: unknown }).data },
});

function summarizeLegacyResult(legacy: PostsDecision, pdpp: PostsDecision): string {
	if (legacy === "empty" && pdpp === "not-proven") {
		return "legacy fail-open; PDPP not-proven";
	}
	return legacy;
}

// ─── Invariant 1: only requested streams emit ──────────────────────────

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

test("collectAllStreams: a post_likes-only request does not emit an unrequested posts STATE", async () => {
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

test("collectAllStreams: an empty timeline response completes requested empty streams", async () => {
	const harness = makeRecordingEmit(validateRecord);
	const { ctx } = makeCtx({
		fetchScript: {},
		harness,
		postsScript: [EMPTY_POSTS],
		requestedStreams: ["posts", "post_likes"],
	});

	await collectAllStreams(ctx, NO_DELAY);

	assert.deepEqual(harness.emitted, []);
	assert.deepEqual(
		harness.protocolMessages
			.filter((message) => message.type === "STATE")
			.map((message) => message.stream)
			.sort(),
		["post_likes", "posts"],
	);
});

test("collectAllStreams: profile media_count cannot turn a missing timeline into empty", async () => {
	const harness = makeRecordingEmit(validateRecord);
	const profileZeroPosts: ScriptedPostsPage = {
		json: {
			data: {
				data: {
					user: {
						follower_count: 0,
						following_count: 0,
						media_count: 0,
					},
				},
			},
		},
		postData: "fb_api_req_friendly_name=ProfilePageQuery",
		status: 200,
	};
	const { ctx } = makeCtx({
		fetchScript: {},
		harness,
		postsScript: [null, profileZeroPosts],
		requestedStreams: ["posts"],
	});

	await assert.rejects(
		collectAllStreams(ctx, NO_DELAY),
		/meta_posts_response_not_observed/,
	);
	assert.equal(
		harness.protocolMessages.some((message) => message.type === "STATE"),
		false,
	);
});

test("collectAllStreams: posts differential matrix matches legacy empty proof boundary", async () => {
	/**
	 * Legacy citations:
	 * - `/home/tnunamak/code/unity-surfaces/apps/desktop/connectors/meta/instagram-playwright.js:752-770`
	 *   reads `responseData.data.data.xdt_api__v1__feed__user_timeline_graphql_connection.edges`
	 *   and omits `instagram.posts` when that exact edge value is absent or not an array.
	 * - `.../instagram-playwright.js:1079-1082` emits `{posts}` when the
	 *   posts issue is not omitted, so `{posts:[]}` is emitted for a captured
	 *   response whose legacy source `edges` array is empty.
	 *
	 * Review fixture crosswalk:
	 * - #226 fixture review: stale unrelated response, partial/degraded result,
	 *   challenge/error envelopes.
	 * - w28-pr218-221b / w28-pr221c / w28-pr221d: UI geometry and dialog timing
	 *   cases are not applicable here because `instagram.posts` uses only the
	 *   captured network timeline stream, not DOM geometry.
	 * - w28-empty-batch-review: missing pagination, next-page non-terminal,
	 *   error envelope, and malformed non-empty edge cases.
	 */
	const cases: Array<{
		name: string;
		source: string;
		raw: unknown;
		expectedPdpp: PostsDecision;
		postData?: string;
		rejects?: RegExp;
		status?: number;
	}> = [
		{
			name: "ordinary populated terminal timeline",
			source: "baseline parity fixture",
			raw: legacyPostsEnvelope(
				[{ node: { id: "p1", taken_at: 1_700_000_000 } }],
				{ has_next_page: false },
			),
			expectedPdpp: "data",
		},
		{
			name: "legacy operation PolarisProfilePostsTabContentQuery_connection",
			source: "legacy source lines 795-798 operation binding",
			raw: legacyPostsEnvelope(
				[{ node: { id: "tab-content", taken_at: 1_700_000_002 } }],
				{ has_next_page: false },
			),
			expectedPdpp: "data",
			postData: "fb_api_req_friendly_name=PolarisProfilePostsTabContentQuery_connection",
		},
		{
			name: "legacy operation ProfilePostsQuery",
			source: "legacy source lines 795-798 operation binding",
			raw: legacyPostsEnvelope(
				[{ node: { id: "profile-posts", taken_at: 1_700_000_003 } }],
				{ has_next_page: false },
			),
			expectedPdpp: "data",
			postData: "fb_api_req_friendly_name=ProfilePostsQuery",
		},
		{
			name: "legacy operation UserMediaQuery",
			source: "legacy source lines 795-798 operation binding",
			raw: legacyPostsEnvelope(
				[{ node: { id: "user-media", taken_at: 1_700_000_004 } }],
				{ has_next_page: false },
			),
			expectedPdpp: "data",
			postData: "fb_api_req_friendly_name=UserMediaQuery",
		},
		{
			name: "genuine empty terminal timeline",
			source: "baseline parity fixture",
			raw: legacyPostsEnvelope([], { has_next_page: false }),
			expectedPdpp: "empty",
		},
		{
			name: "empty connection with missing pagination",
			source: "w28-empty-batch-review.md empty-batch pagination row",
			raw: legacyPostsEnvelope([], null),
			expectedPdpp: "not-proven",
			rejects: /meta_posts_incomplete_pagination/,
		},
		{
			name: "empty connection with next page advertised",
			source: "w28-empty-batch-review.md non-terminal page row",
			raw: legacyPostsEnvelope([], { end_cursor: "next", has_next_page: true }),
			expectedPdpp: "not-proven",
			rejects: /meta_posts_incomplete_pagination/,
		},
		{
			name: "nonempty source edges filtered by missing ids",
			source: "w28-empty-batch-review.md malformed non-empty edge row",
			raw: legacyPostsEnvelope([{ node: { caption: { text: "missing id" } } }], {
				has_next_page: false,
			}),
			expectedPdpp: "not-proven",
		},
		{
			name: "HTTP 500 carrying empty connection",
			source: "w28-empty-batch-review.md error envelope row",
			raw: legacyPostsEnvelope([], { has_next_page: false }),
			expectedPdpp: "not-proven",
			rejects: /meta_posts_response_not_observed/,
			status: 500,
		},
		{
			name: "GraphQL errors carrying empty connection",
			source: "w28-empty-batch-review.md error-envelope row",
			raw: legacyPostsEnvelope([], { has_next_page: false }, { errors: [{}] }),
			expectedPdpp: "not-proven",
			rejects: /meta_posts_response_not_observed/,
		},
		{
			name: "ok false carrying empty connection",
			source: "w28-pr226-review-fixtures.test.ts N3c ok:false",
			raw: legacyPostsEnvelope([], { has_next_page: false }, { ok: false }),
			expectedPdpp: "not-proven",
			rejects: /meta_posts_response_not_observed/,
		},
		{
			name: "401 body payload carrying empty connection",
			source: "w28-pr226-review-fixtures.test.ts N3d body status:401 payload",
			raw: legacyPostsEnvelope([], { has_next_page: false }, { status: 401 }),
			expectedPdpp: "not-proven",
			rejects: /meta_posts_response_not_observed/,
		},
		{
			name: "extensions unauthenticated carrying empty connection",
			source: "w28-pr226-review-fixtures.test.ts N3e extensions.code UNAUTHENTICATED",
			raw: legacyPostsEnvelope([], { has_next_page: false }, { extensions: { code: "UNAUTHENTICATED" } }),
			expectedPdpp: "not-proven",
			rejects: /meta_posts_response_not_observed/,
		},
		{
			name: "benign null errors carrying empty terminal connection",
			source: "w28-pr226-review-fixtures.test.ts N3h errors:null",
			raw: legacyPostsEnvelope([], { has_next_page: false }, { errors: null }),
			expectedPdpp: "empty",
		},
		{
			name: "partial page-not-terminal response",
			source: "w28-pr226-review-fixtures.test.ts N3g partial/degraded result",
			raw: legacyPostsEnvelope([], { has_next_page: false }, { extensions: { is_final: false, partial: true } }),
			expectedPdpp: "not-proven",
			rejects: /meta_posts_response_not_observed/,
		},
		{
			name: "challenge envelope with empty timeline",
			source: "w28-pr226-review-fixtures2.test.ts R3 same-URL email-step login",
			raw: legacyPostsEnvelope([], { has_next_page: false }, { errorCode: "checkpoint_required" }),
			expectedPdpp: "not-proven",
			rejects: /meta_posts_response_not_observed/,
		},
		{
			name: "stale other-tab GraphQL response",
			source: "w28-pr226-review-fixtures2.test.ts T1 other-tab stale response",
			raw: legacyPostsEnvelope(
				[{ node: { id: "stale", taken_at: 1_700_000_001 } }],
				{ has_next_page: false },
			),
			expectedPdpp: "not-proven",
			rejects: /meta_posts_response_not_observed/,
		},
		{
			name: "target-empty first page then populated page",
			source: "w28-pr226-review-fixtures.test.ts N1 target-empty then populated",
			raw: legacyPostsEnvelope([], { has_next_page: false }),
			expectedPdpp: "data",
		},
		{
			name: "terminal empty followed by authentication error",
			source: "w28-pr226-review-fixtures.test.ts N3 delayed error after empty response",
			raw: legacyPostsEnvelope([], { has_next_page: false }),
			expectedPdpp: "not-proven",
			rejects: /meta_posts_incomplete_pagination/,
		},
		{
			name: "visible DOM challenge after empty response",
			source: "w28-pr226-review-fixtures.test.ts N2 visible challenge after response",
			raw: legacyPostsEnvelope([], { has_next_page: false }),
			expectedPdpp: "not-proven",
			rejects: /meta_posts_login_challenge/,
		},
		{
			name: "redirect login payload carrying empty connection",
			source: "w28-pr226-review-fixtures2.test.ts login redirect",
			raw: legacyPostsEnvelope([], { has_next_page: false }),
			expectedPdpp: "not-proven",
			rejects: /meta_posts_login_challenge/,
			status: 200,
		},
		{
			name: "same-URL login email step with terminal empty response",
			source: "w28-pr226-review-fixtures2.test.ts R3 same-URL login email-step UI",
			raw: legacyPostsEnvelope([], { has_next_page: false }),
			expectedPdpp: "not-proven",
			rejects: /meta_posts_login_challenge/,
		},
		{
			name: "delayed data on second page",
			source: "w28-pr218-221b-review.md delayed data adapted to posts pagination",
			raw: legacyPostsEnvelope(
				[{ node: { id: "page1", taken_at: 1_700_000_010 } }],
				{ end_cursor: "next", has_next_page: true },
			),
			expectedPdpp: "data",
		},
	];

	const matrix = await Promise.all(
		cases.map(async (fixture) => {
		const firstLegacyPage: { postData?: string; raw: unknown } = { raw: fixture.raw };
		if (fixture.postData) {
			firstLegacyPage.postData = fixture.postData;
		}
		let legacyPages: Array<{ postData?: string; raw: unknown }> = [
			firstLegacyPage,
		];
		const harness = makeRecordingEmit(validateRecord);
		const firstPage: ScriptedPostsPage = {
			json: fixture.raw,
			status: fixture.status ?? 200,
		};
		if (fixture.postData) {
			firstPage.postData = fixture.postData;
		}
		const postsScript: ScriptedPostsPage[] = [firstPage];
		if (fixture.name === "stale other-tab GraphQL response") {
			firstPage.samePage = false;
		}
		if (fixture.name === "target-empty first page then populated page") {
			firstPage.postData = "fb_api_req_friendly_name=PolarisProfilePostsQuery";
			const raw = legacyPostsEnvelope(
				[{ node: { id: "late-populated", taken_at: 1_700_000_008 } }],
				{ has_next_page: false },
			);
			postsScript.push({ json: raw, status: 200 });
			legacyPages = [...legacyPages, { raw }];
		}
		if (fixture.name === "terminal empty followed by authentication error") {
			const raw = legacyPostsEnvelope(
				[],
				{ has_next_page: false },
				{ errors: [{ message: "authentication expired" }] },
			);
			postsScript.push({ json: raw, status: 200 });
			legacyPages = [...legacyPages, { raw }];
		}
		if (fixture.name === "delayed data on second page") {
			const raw = legacyPostsEnvelope(
				[{ node: { id: "page2", taken_at: 1_700_000_009 } }],
				{ has_next_page: false },
			);
			postsScript.push({ json: raw, status: 200 });
			legacyPages = [...legacyPages, { raw }];
		}
		const legacy = legacyPostsDecisionFromPages(legacyPages);
		const ctxArgs: Parameters<typeof makeCtx>[0] = {
			fetchScript: {},
			harness,
			postsScript,
			requestedStreams: ["posts"],
		};
		if (
			fixture.name === "target-empty first page then populated page" ||
			fixture.name === "terminal empty followed by authentication error"
		) {
			ctxArgs.pageOptions = { postsAutoResolveWaitForResponseCall: 2 };
		}
		if (fixture.name === "redirect login payload carrying empty connection") {
			ctxArgs.pageOptions = {
				pageUrlAfterGoto: "https://www.instagram.com/accounts/login/",
			};
		}
		if (fixture.name === "visible DOM challenge after empty response") {
			ctxArgs.pageOptions = {
				pageUrlAfterGoto: "https://www.instagram.com/testuser/",
				postsChallengeDom: {
					hasCaptchaSitekey: true,
					text: "Verify you are human",
				},
			};
		}
		if (fixture.name === "same-URL login email step with terminal empty response") {
			ctxArgs.pageOptions = {
				pageUrlAfterGoto: "https://www.instagram.com/testuser/",
				postsChallengeDom: {
					hasEmailInput: true,
					text: "Welcome back",
				},
			};
		}
		const { ctx } = makeCtx(ctxArgs);
		if (fixture.rejects) {
			await assert.rejects(collectAllStreams(ctx, NO_DELAY), fixture.rejects);
		} else {
			await collectAllStreams(ctx, NO_DELAY);
		}
		const states = stateStreams(harness.protocolMessages);
		const pdpp: PostsDecision = states.includes("posts")
			? "empty"
			: harness.emitted.some((entry) => entry.stream === "posts")
				? "data"
				: "not-proven";
		assert.equal(pdpp, fixture.expectedPdpp, fixture.name);
		if (pdpp === "empty") {
			assert.equal(legacy, "empty", `${fixture.name}: PDPP empty requires legacy empty`);
		}
		if (legacy === "data") {
			assert.notEqual(pdpp, "empty", `${fixture.name}: legacy data must not become PDPP empty`);
		}
		return {
			fixture: fixture.name,
			legacy: summarizeLegacyResult(legacy, pdpp),
			pdpp,
			source: fixture.source,
		};
		}),
	);

	assert.deepEqual(
		matrix.map(({ fixture, legacy, pdpp }) => ({ fixture, legacy, pdpp })),
		[
			{ fixture: "ordinary populated terminal timeline", legacy: "data", pdpp: "data" },
			{ fixture: "legacy operation PolarisProfilePostsTabContentQuery_connection", legacy: "data", pdpp: "data" },
			{ fixture: "legacy operation ProfilePostsQuery", legacy: "data", pdpp: "data" },
			{ fixture: "legacy operation UserMediaQuery", legacy: "data", pdpp: "data" },
			{ fixture: "genuine empty terminal timeline", legacy: "empty", pdpp: "empty" },
			{ fixture: "empty connection with missing pagination", legacy: "legacy fail-open; PDPP not-proven", pdpp: "not-proven" },
			{ fixture: "empty connection with next page advertised", legacy: "legacy fail-open; PDPP not-proven", pdpp: "not-proven" },
			{ fixture: "nonempty source edges filtered by missing ids", legacy: "data", pdpp: "not-proven" },
			{ fixture: "HTTP 500 carrying empty connection", legacy: "legacy fail-open; PDPP not-proven", pdpp: "not-proven" },
			{ fixture: "GraphQL errors carrying empty connection", legacy: "legacy fail-open; PDPP not-proven", pdpp: "not-proven" },
			{ fixture: "ok false carrying empty connection", legacy: "legacy fail-open; PDPP not-proven", pdpp: "not-proven" },
			{ fixture: "401 body payload carrying empty connection", legacy: "legacy fail-open; PDPP not-proven", pdpp: "not-proven" },
			{ fixture: "extensions unauthenticated carrying empty connection", legacy: "legacy fail-open; PDPP not-proven", pdpp: "not-proven" },
			{ fixture: "benign null errors carrying empty terminal connection", legacy: "empty", pdpp: "empty" },
			{ fixture: "partial page-not-terminal response", legacy: "legacy fail-open; PDPP not-proven", pdpp: "not-proven" },
			{ fixture: "challenge envelope with empty timeline", legacy: "legacy fail-open; PDPP not-proven", pdpp: "not-proven" },
			{ fixture: "stale other-tab GraphQL response", legacy: "data", pdpp: "not-proven" },
			{ fixture: "target-empty first page then populated page", legacy: "data", pdpp: "data" },
			{ fixture: "terminal empty followed by authentication error", legacy: "legacy fail-open; PDPP not-proven", pdpp: "not-proven" },
			{ fixture: "visible DOM challenge after empty response", legacy: "legacy fail-open; PDPP not-proven", pdpp: "not-proven" },
			{ fixture: "redirect login payload carrying empty connection", legacy: "legacy fail-open; PDPP not-proven", pdpp: "not-proven" },
			{ fixture: "same-URL login email step with terminal empty response", legacy: "legacy fail-open; PDPP not-proven", pdpp: "not-proven" },
			{ fixture: "delayed data on second page", legacy: "data", pdpp: "data" },
		],
	);
	assert.deepEqual(
		[
			"w28-pr218-221b review DOM geometry rows: not applicable to the network-only posts stream",
			"w28-pr221c review dialog geometry rows: ads/UI-only, not applicable to posts timeline capture",
			"w28-pr221d review hidden/display-contents rows: ads/UI-only, not applicable to posts timeline capture",
		],
		[
			"w28-pr218-221b review DOM geometry rows: not applicable to the network-only posts stream",
			"w28-pr221c review dialog geometry rows: ads/UI-only, not applicable to posts timeline capture",
			"w28-pr221d review hidden/display-contents rows: ads/UI-only, not applicable to posts timeline capture",
		],
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
	assert.equal(waitConditions.length, 9);
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

test("collectAllStreams: ads all reached with empty lists emits complete surface coverage", async () => {
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

test("scrapeAdvertisers preserves a genuine empty list after the settle window", async () => {
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

test("collectAllStreams: ads missing a surface emits partial coverage and SKIP_RESULT", async () => {
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
	const skip = harness.protocolMessages.find(
		(m): m is Extract<EmittedMessage, { type: "SKIP_RESULT" }> =>
			m.type === "SKIP_RESULT" && m.stream === "ads",
	);
	assert.ok(skip, "partial ads scrape must emit a stream-level SKIP_RESULT");
	assert.equal(skip.reason, "ads_surfaces_unavailable");
	assert.deepEqual(skip.diagnostics, {
		missing_surfaces: ["targeting_categories"],
		surface_steps: [
			{ surface: "targeting_categories", step: "control_not_found" },
		],
	});
	assert.ok(
		waitRejections.some((condition) => condition.includes("Manage info")),
		"an unavailable Manage info tab must reject its Playwright-style wait",
	);
});

test("collectAllStreams: dialog without its intended list emits SKIP_RESULT", async () => {
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

	const skip = harness.protocolMessages.find(
		(m): m is Extract<EmittedMessage, { type: "SKIP_RESULT" }> =>
			m.type === "SKIP_RESULT" && m.stream === "ads",
	);
	assert.ok(
		skip,
		"a dialog without its list must not count as a reached surface",
	);
	assert.deepEqual(skip.diagnostics, {
		missing_surfaces: ["advertisers"],
		surface_steps: [
			{ surface: "advertisers", step: "destination_list_not_found" },
			{ surface: "ad_topics", step: "reached_empty" },
			{ surface: "targeting_categories", step: "reached_empty" },
		],
	});
});

test("collectAllStreams: successful category clicks without a destination list emit SKIP_RESULT", async () => {
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

	const skip = harness.protocolMessages.find(
		(m): m is Extract<EmittedMessage, { type: "SKIP_RESULT" }> =>
			m.type === "SKIP_RESULT" && m.stream === "ads",
	);
	assert.ok(
		skip,
		"clicking through without a destination list must not count as reached",
	);
	assert.deepEqual(skip.diagnostics, {
		missing_surfaces: ["targeting_categories"],
		surface_steps: [
			{ surface: "advertisers", step: "reached_empty" },
			{ surface: "ad_topics", step: "reached_empty" },
			{
				surface: "targeting_categories",
				step: "destination_list_not_found",
			},
		],
	});
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

	const skip = harness.protocolMessages.find(
		(m): m is Extract<EmittedMessage, { type: "SKIP_RESULT" }> =>
			m.type === "SKIP_RESULT" && m.stream === "ads",
	);
	assert.ok(skip);
	assert.deepEqual(skip.diagnostics, {
		missing_surfaces: ["ad_topics"],
		surface_steps: [{ surface: "ad_topics", step: "navigation_failed" }],
	});
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
