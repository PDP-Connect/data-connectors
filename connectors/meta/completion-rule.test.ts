// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import "./ads-dom.test.ts";

import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import type { Frame, Page, Response } from "playwright";
import type { BrowserCollectContext } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { makeRecordingEmit } from "../../packages/polyfill-connectors/src/test-harness.ts";
import { classifyAdsDialogInPage, collectAllStreams } from "./index.ts";
import { validateRecord } from "./schemas.ts";


for (const wantsProfile of [false, true]) {
	for (const { label, user, proven } of [
		{ label: "unobserved", user: null, proven: false },
		{ label: "unknown", user: {}, proven: false },
		{ label: "null", user: { media_count: null }, proven: false },
		{ label: "malformed", user: { media_count: "0" }, proven: false },
		{ label: "negative", user: { media_count: -1 }, proven: false },
		{ label: "fractional", user: { media_count: 0.5 }, proven: false },
		{ label: "different id", user: { id: "other", media_count: 0 }, proven: false },
		{ label: "different username", user: { username: "other", media_count: 0 }, proven: false },
		{ label: "positive", user: { media_count: 3 }, proven: false },
		{ label: "proven zero", user: { media_count: 0 }, proven: true },
	]) {
		test(`empty timeline requires same-identity zero: ${label}, profile requested=${wantsProfile}`, async () => {
			const requested = [...(wantsProfile ? ["profile"] : []), "posts", "post_likes"];
			const { ctx, emitNavigation, emitRequest, emitResponse, failures, harness } = setup(requested);
			let pendingResolve: ((response: Response) => void) | null = null;
			let profileReads = 0;
			ctx.progress = async (message) => {
				if (message === "Fetching Instagram profile counts") profileReads += 1;
			};
			ctx.page.waitForResponse = (() => new Promise<Response>((resolve) => {
				pendingResolve = resolve;
			})) as Page["waitForResponse"];
			ctx.page.goto = (() => {
				emitNavigation();
				if (user !== null) {
					emitResponse({
						url: () => "https://www.instagram.com/api/graphql",
						request: () => ({
							method: () => "POST",
							postData: () => "PolarisProfilePageContentQuery",
						}),
						status: () => 200,
						json: async () => ({ data: { user: {
							id: "u1", username: "testuser", follower_count: 1,
							following_count: 1, is_verified: false, ...user,
						} } }),
					});
				}
				if (pendingResolve) {
					const response = nonterminalPostsResponse([], null, ctx.page);
					response.json = async () => ({ data: {
						xdt_api__v1__feed__user_timeline_graphql_connection: {
							edges: [], page_info: { end_cursor: null, has_next_page: false },
						},
					} });
					emitRequest(response.request());
					pendingResolve(response);
					pendingResolve = null;
				}
				return Promise.resolve(null);
			}) as Page["goto"];
			await collectAllStreams(ctx, async () => undefined, FAST_POSTS_CLOCK, FAST_ADS_CLOCK, FAST_PROFILE_CLOCK);
			for (const stream of ["posts", "post_likes"]) {
				assert.equal(harness.protocolMessages.some(message => message.type === "STATE" && message.stream === stream), proven, `${stream} STATE`);
				assert.equal(failures.includes(stream), !proven, `${stream} failure`);
			}
			assert.equal(profileReads, 1, "profile-count evidence is gathered independently of requested output");
			if (!wantsProfile) {
				assert.equal(failures.includes("profile"), false);
				assert.equal(harness.emitted.some(record => record.stream === "profile"), false);
			}
		});
	}
}
for (const malformed of [{ is_verified: "false" }, { is_private: 1 }, { full_name: {} }, { profile_pic_url: "invalid" }, { pk: 12 }, { username: 12 }]) {
 for (const later of [false, true]) {
  test(`following malformed ${JSON.stringify(malformed)} later=${later} preserves readable rows without STATE`, async () => {
   const terminal = { status: 200, json: { status: "ok", users: [{ pk: "bad", username: "bad", ...malformed }, { pk: "good", username: "good" }], has_more: false, next_max_id: null } };
   const prefix = { status: 200, json: { users: [{ pk: "prefix", username: "prefix" }], has_more: true, next_max_id: "next" } };
   const { ctx, failures, harness } = setup(["following"], later ? [prefix, terminal] : [terminal]);
   await collectAllStreams(ctx, async () => undefined, FAST_POSTS_CLOCK, FAST_ADS_CLOCK, FAST_PROFILE_CLOCK);
   assert.deepEqual(failures, ["following"]);
   assert.deepEqual(harness.emitted.map(record => record.data.username), later ? ["prefix", "good"] : ["good"]);
   assert.equal(harness.protocolMessages.some(message => message.type === "STATE"), false);
  });
 }
}


const FAST_POSTS_CLOCK = { sleep: async (): Promise<void> => undefined };
const FAST_ADS_CLOCK = {
	now: () => 0,
	sleep: async (): Promise<void> => undefined,
};
const FAST_PROFILE_CLOCK = { sleep: async (): Promise<void> => undefined };

function setup(streams: string[], followingPages: unknown[] = []) {
	const harness = makeRecordingEmit(validateRecord);
	const failures: string[] = [];
	const requestListeners = new Set<(request: unknown) => void>();
	const responseListeners = new Set<(response: unknown) => void>();
	const navigationListeners = new Set<(frame: unknown) => void>();
	let currentUrl = "https://www.instagram.com/testuser/";
	let currentNavigationRequest: unknown = null;
	let page: Partial<Page>;
	const mainFrame = {
		page: () => page as Page,
		url: () => currentUrl,
	};
	const emitNavigation = (): void => {
		currentUrl = "https://www.instagram.com/testuser/";
		currentNavigationRequest = {
			frame: () => mainFrame,
			isNavigationRequest: () => true,
			redirectedFrom: () => null,
			url: () => currentUrl,
		};
		for (const listener of requestListeners) listener(currentNavigationRequest);
		for (const listener of responseListeners) {
			listener({
				request: () => currentNavigationRequest,
				status: () => 200,
				url: () => currentUrl,
			});
		}
		for (const listener of navigationListeners) listener(mainFrame);
	};
	page = {
		url: () => "https://www.instagram.com/testuser/",
		goto: () => {
			emitNavigation();
			return Promise.resolve(null);
		},
		mainFrame: () => mainFrame as Frame,
		waitForResponse: () => Promise.reject(new Error("no response")),
		on: ((event: string, listener: (value: unknown) => void) => {
			if (event === "request") requestListeners.add(listener);
			if (event === "response") responseListeners.add(listener);
			if (event === "framenavigated") navigationListeners.add(listener);
			return page as Page;
		}) as Page["on"],
		off: ((event: string, listener: (value: unknown) => void) => {
			if (event === "request") requestListeners.delete(listener);
			if (event === "response") responseListeners.delete(listener);
			if (event === "framenavigated") navigationListeners.delete(listener);
			return page as Page;
		}) as Page["off"],
		waitForFunction: () => Promise.reject(new Error("no control")),
		evaluate: ((fn: unknown, arg?: unknown) => {
			if (String(fn).includes("PolarisViewer")) {
				return Promise.resolve({ id: "u1", username: "testuser" });
			}
			if (arg && typeof arg === "object" && "path" in arg) {
				return Promise.resolve(followingPages.shift());
			}
			return Promise.resolve(false);
		}) as Page["evaluate"],
	};
	const ctx: BrowserCollectContext = {
		assist: async () => {
			throw new Error("unused assistance");
		},
		capture: null,
		completeAssistance: async () => undefined,
		context: {} as BrowserCollectContext["context"],
		credentials: {},
		detailGaps: [],
		emit: harness.emit,
		emitRecord: harness.emitRecord,
		emittedAt: "2026-09-22T12:00:00.000Z",
		page: page as Page,
		progress: async () => undefined,
		reportStreamFailure: async (stream, message, options) => {
			assert.equal(options?.retryable, true);
			failures.push(stream);
			await harness.emit({
				type: "SKIP_RESULT",
				stream,
				reason: "stream_collection_failed",
				message,
				recovery_hint: { action: "retry_by_runtime", retryable: true },
			});
		},
		requestDetailGapPage: async () => [],
		requested: new Map(streams.map((name) => [name, { name }])),
		scope: { streams: [] },
		sendInteraction: async () => {
			throw new Error("unused interaction");
		},
		state: {},
	};
	return {
		ctx,
		emitNavigation,
		emitResponse: (response: unknown) => {
			for (const listener of responseListeners) listener(response);
		},
		emitRequest: (request: unknown) => {
			for (const listener of requestListeners) listener(request);
		},
		failures,
		harness,
	};
}

test("completion rule: unavailable posts and child likes report retryable stream failures", async () => {
	const { ctx, failures, harness } = setup(["posts", "post_likes"]);
	await collectAllStreams(
		ctx,
		async () => undefined,
		FAST_POSTS_CLOCK,
		FAST_ADS_CLOCK,
		FAST_PROFILE_CLOCK,
	);
	assert.deepEqual(failures, ["posts", "post_likes"]);
	assert.equal(
		harness.protocolMessages.some((message) => message.type === "STATE"),
		false,
	);
});

test("completion rule: a context without stream failure reporting cannot return success", async () => {
	const { ctx } = setup(["posts"]);
	delete ctx.reportStreamFailure;
	await assert.rejects(
		collectAllStreams(
			ctx,
			async () => undefined,
			FAST_POSTS_CLOCK,
			FAST_ADS_CLOCK,
			FAST_PROFILE_CLOCK,
		),
		(error: unknown) =>
			error instanceof Error &&
			"code" in error &&
			error.code === "stream_collection_failed",
	);
});

test("completion rule: missing ads controls report a retryable stream failure", async () => {
	const { ctx, failures, harness } = setup(["ads"]);
	await collectAllStreams(
		ctx,
		async () => undefined,
		FAST_POSTS_CLOCK,
		FAST_ADS_CLOCK,
		FAST_PROFILE_CLOCK,
	);
	assert.deepEqual(failures, ["ads"]);
	assert.equal(
		harness.protocolMessages.some((message) => message.type === "STATE"),
		false,
	);
});

test("completion rule: ads cannot claim empty after a positive source count disappears", async () => {
	const { ctx, failures, harness } = setup(["ads"]);
	const page = ctx.page as Partial<Page>;
	const classifierCalls = new Map<string, number>();
	const samples = new Map<string, unknown[]>([
		[
			"No advertisers",
			[
				{ hasPositiveSourceTotal: true, kind: "loading" },
				{ kind: "verified_empty" },
			],
		],
		["No ad topics", [{ kind: "verified_empty" }]],
		["No categories", [{ kind: "verified_empty" }]],
	]);
	page.waitForFunction = (() =>
		Promise.resolve(true)) as unknown as Page["waitForFunction"];
	page.evaluate = ((fn: unknown, arg?: unknown) => {
		if (arg && typeof arg === "object" && "emptyMessage" in arg) {
			const message = String(arg.emptyMessage);
			classifierCalls.set(message, (classifierCalls.get(message) ?? 0) + 1);
			const sequence = samples.get(message) ?? [];
			return Promise.resolve(sequence.shift() ?? { kind: "verified_empty" });
		}
		const source = String(fn);
		if (
			source.includes("advertiser") ||
			source.includes("Manage info") ||
			source.includes("Categories used to reach you")
		) {
			return Promise.resolve(true);
		}
		return Promise.resolve(false);
	}) as Page["evaluate"];
	let now = 0;
	const clock = {
		now: () => now,
		sleep: async (ms: number): Promise<void> => {
			now += ms;
		},
	};

	await collectAllStreams(
		ctx,
		async () => undefined,
		FAST_POSTS_CLOCK,
		clock,
		FAST_PROFILE_CLOCK,
	);
	assert.deepEqual(failures, ["ads"]);
	assert.ok((classifierCalls.get("No advertisers") ?? 0) > 0);
	assert.equal(
		harness.protocolMessages.some((message) => message.type === "STATE"),
		false,
	);
});

test("completion rule: a page script error during ads scraping fails only the ads stream", async () => {
	const { ctx, failures, harness } = setup(["ads"]);
	const page = ctx.page as Partial<Page>;
	const baseEvaluate = page.evaluate as Page["evaluate"];
	page.waitForFunction = (() =>
		Promise.resolve(true)) as unknown as Page["waitForFunction"];
	page.evaluate = ((fn: unknown, arg?: unknown) => {
		if (String(fn).includes("PolarisViewer")) {
			return baseEvaluate(fn as never, arg as never);
		}
		return Promise.reject(
			new Error("page.evaluate: Execution context was destroyed"),
		);
	}) as Page["evaluate"];
	await collectAllStreams(
		ctx,
		async () => undefined,
		FAST_POSTS_CLOCK,
		FAST_ADS_CLOCK,
		FAST_PROFILE_CLOCK,
	);
	assert.deepEqual(failures, ["ads"]);
	assert.equal(
		harness.protocolMessages.some((message) => message.type === "STATE"),
		false,
	);
});

test("completion rule: ads classifier executes after browser serialization without host helpers", () => {
	const result = runInNewContext(
		`(${String(classifyAdsDialogInPage)})({ emptyMessage: "No advertisers" })`,
		{
			document: { querySelectorAll: () => [] },
		},
	);
	assert.equal(result.kind, "unavailable");
});

const failedFollowingPages = [
	{ label: "HTTP failure", page: { json: { users: [] }, status: 503 } },
	{ label: "missing payload", page: { json: null, status: 200 } },
	{
		label: "failure envelope",
		page: { json: { status: "fail", users: [] }, status: 200 },
	},
	{ label: "missing users", page: { json: {}, status: 200 } },
	{ label: "invalid users", page: { json: { users: [null] }, status: 200 } },
	{
		label: "invalid cursor",
		page: { json: { users: [], next_max_id: 42 }, status: 200 },
	},
	{
		label: "contradictory next page",
		page: { json: { users: [], has_more: true }, status: 200 },
	},
	{
		label: "contradictory terminal cursor",
		page: {
			json: { users: [], has_more: false, next_max_id: "next" },
			status: 200,
		},
	},
	{
		label: "string continuation flag",
		page: { json: { users: [], has_more: "true" }, status: 200 },
	},
	{
		label: "number continuation flag",
		page: { json: { users: [], has_more: 1 }, status: 200 },
	},
	{
		label: "null continuation flag",
		page: { json: { users: [], has_more: null }, status: 200 },
	},
	{
		label: "missing terminal flag",
		page: { json: { users: [], next_max_id: null }, status: 200 },
	},
];

for (const { label, page } of failedFollowingPages) {
	test(`completion rule: following ${label} cannot complete as empty`, async () => {
		const { ctx, failures, harness } = setup(["following"], [page]);
		await collectAllStreams(
			ctx,
			async () => undefined,
			FAST_POSTS_CLOCK,
			FAST_ADS_CLOCK,
			FAST_PROFILE_CLOCK,
		);
		assert.deepEqual(failures, ["following"]);
		assert.equal(
			harness.protocolMessages.some((message) => message.type === "STATE"),
			false,
		);
	});
}

test("completion rule: malformed following continuation flag on a later page cannot complete the prefix", async () => {
	const { ctx, failures, harness } = setup(
		["following"],
		[
			{
				json: { users: [{ id: "f1", username: "alice" }], has_more: true, next_max_id: "next" },
				status: 200,
			},
			{ json: { users: [], has_more: "false" }, status: 200 },
		],
	);
	await collectAllStreams(
		ctx,
		async () => undefined,
		FAST_POSTS_CLOCK,
		FAST_ADS_CLOCK,
		FAST_PROFILE_CLOCK,
	);
	assert.deepEqual(failures, ["following"]);
	assert.equal(
		harness.protocolMessages.some((message) => message.type === "STATE"),
		false,
	);
});

test("completion rule: a page evaluation error during following fails only following", async () => {
	const { ctx, failures, harness } = setup(["following"]);
	const page = ctx.page as Partial<Page>;
	const baseEvaluate = page.evaluate as Page["evaluate"];
	page.evaluate = ((fn: unknown, arg?: unknown) => {
		if (arg && typeof arg === "object" && "path" in arg) {
			return Promise.reject(
				new Error("page.evaluate: Execution context was destroyed"),
			);
		}
		return baseEvaluate(fn as never, arg as never);
	}) as Page["evaluate"];
	await collectAllStreams(
		ctx,
		async () => undefined,
		FAST_POSTS_CLOCK,
		FAST_ADS_CLOCK,
		FAST_PROFILE_CLOCK,
	);
	assert.deepEqual(failures, ["following"]);
	assert.deepEqual(
		harness.emitted.map((record) => record.stream),
		[],
	);
	assert.equal(
		harness.protocolMessages.some((message) => message.type === "STATE"),
		false,
	);
});

test("completion rule: a page evaluation error on a later following page keeps the earlier users and fails following", async () => {
	const { ctx, failures, harness } = setup(
		["following"],
		[
			{
				json: { users: [{ id: "f1", username: "alice" }], has_more: true, next_max_id: "next" },
				status: 200,
			},
		],
	);
	const page = ctx.page as Partial<Page>;
	const baseEvaluate = page.evaluate as Page["evaluate"];
	let followingCalls = 0;
	page.evaluate = ((fn: unknown, arg?: unknown) => {
		if (
			arg &&
			typeof arg === "object" &&
			"path" in arg &&
			followingCalls++ > 0
		) {
			return Promise.reject(
				new Error("page.evaluate: Execution context was destroyed"),
			);
		}
		return baseEvaluate(fn as never, arg as never);
	}) as Page["evaluate"];
	await collectAllStreams(
		ctx,
		async () => undefined,
		FAST_POSTS_CLOCK,
		FAST_ADS_CLOCK,
		FAST_PROFILE_CLOCK,
	);
	assert.deepEqual(failures, ["following"]);
	assert.deepEqual(
		harness.emitted.map((record) => `${record.stream}:${record.data.username}`),
		["following:alice"],
	);
});

test("completion rule: a non-meta error inside the posts walk fails posts and post_likes", async () => {
	const { ctx, failures, harness } = setup(["posts", "post_likes"]);
	const response: Partial<Response> = {
		json: async () => ({
			data: {
				xdt_api__v1__feed__user_timeline_graphql_connection: {
					edges: [],
					page_info: { has_next_page: true },
				},
			},
		}),
		status: () => 200,
	};
	ctx.page.waitForResponse = (() =>
		Promise.resolve(response as Response)) as Page["waitForResponse"];
	// The walk paces itself with `delay` after each non-terminal page; any
	// error raised there is not a meta_posts_* proof failure.
	await collectAllStreams(
		ctx,
		async () => {
		throw new Error("page.evaluate: Execution context was destroyed");
		},
		FAST_POSTS_CLOCK,
		FAST_ADS_CLOCK,
		FAST_PROFILE_CLOCK,
	);
	assert.deepEqual(failures, ["posts", "post_likes"]);
	assert.equal(
		harness.protocolMessages.some((message) => message.type === "STATE"),
		false,
	);
});

test("completion rule: explicit empty following payload completes without a failure", async () => {
	const { ctx, failures, harness } = setup(
		["following"],
		[{ json: { users: [], has_more: false, next_max_id: null, status: "ok" }, status: 200 }],
	);
	await collectAllStreams(
		ctx,
		async () => undefined,
		FAST_POSTS_CLOCK,
		FAST_ADS_CLOCK,
		FAST_PROFILE_CLOCK,
	);
	assert.deepEqual(failures, []);
	assert.deepEqual(harness.emitted, []);
	assert.equal(
		harness.protocolMessages.some((message) => message.type === "SKIP_RESULT"),
		false,
	);
	assert.equal(
		harness.protocolMessages.some(
			(message) => message.type === "STATE" && message.stream === "following",
		),
		true,
	);
});

test("completion rule: following without a terminal second page fails and keeps its first page", async () => {
	const { ctx, failures, harness } = setup(
		["following"],
		[
			{
				json: { users: [{ id: "f1", username: "alice" }], has_more: true, next_max_id: "next" },
				status: 200,
			},
			{ json: null, status: 0 },
		],
	);
	await collectAllStreams(
		ctx,
		async () => undefined,
		FAST_POSTS_CLOCK,
		FAST_ADS_CLOCK,
		FAST_PROFILE_CLOCK,
	);
	assert.deepEqual(failures, ["following"]);
	assert.deepEqual(
		harness.emitted.map((record) => record.stream),
		["following"],
	);
});

function nonterminalPostsResponse(
	edges: unknown[],
	after: string | null,
	page: Page,
): Response {
	const operation = "PolarisProfilePostsQuery";
	const variables = {
		...(after ? { after } : {}),
		user_id: "u1",
		username: "testuser",
	};
	const request = {
		frame: () => page.mainFrame?.() as never,
		headers: () => ({ "x-fb-friendly-name": operation }),
		method: () => "POST",
		postData: () =>
			`fb_api_req_friendly_name=${operation}&variables=${encodeURIComponent(JSON.stringify(variables))}`,
		url: () => "https://www.instagram.com/graphql/query",
	};
	return {
		request: () => request,
		json: async () => ({
			data: {
				xdt_api__v1__feed__user_timeline_graphql_connection: {
					edges,
					page_info: { end_cursor: "next", has_next_page: true },
				},
			},
		}),
		status: () => 200,
	} as unknown as Response;
}

test("completion rule: a capped posts walk reports both requested streams as failed", async () => {
	const { ctx, emitNavigation, emitRequest, failures, harness } = setup([
		"posts",
		"post_likes",
	]);
	let pendingResolve: ((response: Response) => void) | null = null;
	let pageNumber = 0;
	const respond = (): void => {
		const response = nonterminalPostsResponse(
			[],
			pageNumber === 0 ? null : "next",
			ctx.page,
		);
		pageNumber += 1;
		emitRequest(response.request());
		pendingResolve?.(response);
		pendingResolve = null;
	};
	ctx.page.waitForResponse = (() =>
		new Promise<Response>((resolve) => {
			pendingResolve = resolve;
		})) as Page["waitForResponse"];
	ctx.page.goto = (() => {
		emitNavigation();
		// Profile evidence navigation has no pending timeline response.
		if (pendingResolve) respond();
		return Promise.resolve(null);
	}) as Page["goto"];
	const evaluate = ctx.page.evaluate;
	ctx.page.evaluate = ((fn: unknown, arg?: unknown) => {
		if (String(fn).includes("scrollTo")) respond();
		return evaluate?.(fn as never, arg as never) as ReturnType<
			Page["evaluate"]
		>;
	}) as Page["evaluate"];
	await collectAllStreams(
		ctx,
		async () => undefined,
		FAST_POSTS_CLOCK,
		FAST_ADS_CLOCK,
		FAST_PROFILE_CLOCK,
	);
	assert.deepEqual(failures, ["posts", "post_likes"]);
	assert.deepEqual(
		harness.protocolMessages
			.filter((message) => message.type === "SKIP_RESULT")
			.map((message) => `${message.stream}:${message.reason}`)
			.sort(),
		["post_likes:stream_collection_failed", "posts:stream_collection_failed"],
	);
	assert.equal(
		harness.protocolMessages.some((message) => message.type === "STATE"),
		false,
	);
});

test("completion rule: a capped posts walk keeps emitted records and fails only requested streams", async () => {
	const { ctx, emitNavigation, emitRequest, failures, harness } = setup([
		"posts",
	]);
	let pageNumber = 0;
	let pendingResolve: ((response: Response) => void) | null = null;
	const respond = (): void => {
		const response = nonterminalPostsResponse(
			pageNumber === 0 ? [{ node: { id: "p1", taken_at: 1_700_000_000 } }] : [],
			pageNumber === 0 ? null : "next",
			ctx.page,
		);
		pageNumber += 1;
		emitRequest(response.request());
		pendingResolve?.(response);
		pendingResolve = null;
	};
	ctx.page.waitForResponse = (() =>
		new Promise<Response>((resolve) => {
			pendingResolve = resolve;
		})) as Page["waitForResponse"];
	ctx.page.goto = (() => {
		emitNavigation();
		// Profile evidence navigation has no pending timeline response.
		if (pendingResolve) respond();
		return Promise.resolve(null);
	}) as Page["goto"];
	const evaluate = ctx.page.evaluate;
	ctx.page.evaluate = ((fn: unknown, arg?: unknown) => {
		if (String(fn).includes("scrollTo")) respond();
		return evaluate?.(fn as never, arg as never) as ReturnType<
			Page["evaluate"]
		>;
	}) as Page["evaluate"];
	await collectAllStreams(
		ctx,
		async () => undefined,
		FAST_POSTS_CLOCK,
		FAST_ADS_CLOCK,
		FAST_PROFILE_CLOCK,
	);
	assert.deepEqual(failures, ["posts"]);
	assert.deepEqual(
		harness.emitted.map((record) => record.stream),
		["posts"],
	);
	assert.equal(
		harness.protocolMessages.some((message) => message.type === "STATE"),
		false,
	);
});

test("completion rule: a capped following walk keeps its users and reports following failed", async () => {
	const pages: unknown[] = [];
	for (let index = 0; index < 500; index += 1) {
		pages.push({
			json: {
				users: [{ id: `f${index}`, username: `user${index}` }],
				has_more: true,
				next_max_id: `cursor${index}`,
			},
			status: 200,
		});
	}
	const { ctx, failures, harness } = setup(["following"], pages);
	await collectAllStreams(
		ctx,
		async () => undefined,
		FAST_POSTS_CLOCK,
		FAST_ADS_CLOCK,
		FAST_PROFILE_CLOCK,
	);
	assert.deepEqual(failures, ["following"]);
	assert.ok(
		harness.emitted.filter((record) => record.stream === "following").length >
			1,
	);
	assert.deepEqual(
		harness.protocolMessages
			.filter((message) => message.type === "SKIP_RESULT")
			.map((message) => message.reason),
		["stream_collection_failed"],
	);
	assert.equal(
		harness.protocolMessages.some((message) => message.type === "STATE"),
		false,
	);
});

for (const malformed of [
 { full_name: { text: "Alice" } }, { biography: 17 },
 { profile_pic_url: false }, { external_url: {} }, { media_count: 1.5 },
 { is_private: "false" }, { is_business_account: 1 },
 { profile_pic_url: "invalid-url" },
]) {
 test(`profile unreadable mapped source retains retryable gap: ${JSON.stringify(malformed)}`, async () => {
  const { ctx, failures, harness, emitResponse } = setup(["profile"]);
  const observed = { id: "u1", username: "testuser", follower_count: 1, following_count: 2, media_count: 3, is_verified: false, ...malformed };
  ctx.page.goto = (() => {
   emitResponse({
    status: () => 200,
    url: () => "https://www.instagram.com/graphql/query/",
    request: () => ({
     headers: () => ({}), method: () => "POST",
     postData: () => "fb_api_req_friendly_name=ProfilePageQuery",
    }),
    json: async () => ({ data: { user: observed } }),
   });
   return Promise.resolve(null);
  }) as Page["goto"];
  await collectAllStreams(ctx, async () => undefined, FAST_POSTS_CLOCK, FAST_ADS_CLOCK, FAST_PROFILE_CLOCK);
  assert.deepEqual(failures, ["profile"]);
  assert.equal(harness.protocolMessages.some(message => message.type === "STATE"), false);
  for (const record of harness.emitted) {
   assert.notEqual(record.data.post_count, 1);
  }
 });
}

test("ads schema-rejected rows preserve readable records and suppress surface coverage", async () => {
 const { ctx, failures, harness } = setup(["ads"]);
 ctx.page.waitForFunction = (() => Promise.resolve(true)) as unknown as Page["waitForFunction"];
 ctx.page.evaluate = ((fn: unknown, arg?: unknown) => {
  if (arg && typeof arg === "object" && "emptyMessage" in arg) {
   return Promise.resolve(arg.emptyMessage === "No advertisers"
    ? { kind: "data", complete: true, items: ["Readable advertiser", "x".repeat(501)] }
    : { kind: "verified_empty" });
  }
  const source = String(fn);
  return Promise.resolve(source.includes("advertiser") || source.includes("Manage info") || source.includes("Categories used to reach you"));
 }) as Page["evaluate"];
 let now = 0;
 await collectAllStreams(ctx, async () => undefined, FAST_POSTS_CLOCK, {
  now: () => now, sleep: async (ms: number) => { now += ms; },
 }, FAST_PROFILE_CLOCK);
 assert.deepEqual(failures, ["ads"]);
 assert.deepEqual(harness.emitted.map(record => record.data.name), ["Readable advertiser"]);
});
