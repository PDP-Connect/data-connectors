// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Page } from "playwright";
import { collectAllStreams, fetchAllPosts } from "./index.ts";

const NO_DELAY = (): Promise<void> => Promise.resolve();
const FAST_POSTS_CLOCK = { sleep: async (): Promise<void> => undefined };

type RawEnvelope = Record<string, unknown>;
type PostsDecision = "data" | "empty" | "not-proven";

type ScriptedPostsPage = {
	after?: string | null;
	fromCurrentPage?: boolean;
	json: unknown;
	method?: string;
	operationName?: string;
	ownerId?: string;
	postData?: string;
	requestUrl?: string;
	status: number;
	username?: string;
	url?: string;
} | null;

function timelineEnvelope(
	edges: unknown[] | null,
	pageInfo: unknown,
	extras: RawEnvelope = {},
): RawEnvelope {
	return {
		...extras,
		data: {
			xdt_api__v1__feed__user_timeline_graphql_connection: {
				edges,
				page_info: pageInfo,
			},
		},
	};
}

function legacyPostsDecision(raw: unknown): PostsDecision {
	const edges = (
		raw as {
			data?: {
				xdt_api__v1__feed__user_timeline_graphql_connection?: {
					edges?: unknown;
				} | null;
			} | null;
		}
	)?.data?.xdt_api__v1__feed__user_timeline_graphql_connection?.edges;
	if (!Array.isArray(edges)) {
		return "not-proven";
	}
	return edges.length === 0 ? "empty" : "data";
}

type ChallengeDom =
	| "captcha"
	| "email"
	| "verification_code"
	| "challenge_form";

// Text and controls the fake page exposes to the serialized in-page detector.
const CHALLENGE_DOMS: Record<
	ChallengeDom,
	{ controls: string[]; text: string }
> = {
	captcha: { controls: ["[data-sitekey]"], text: "Verify you are human" },
	challenge_form: {
		controls: ['form[action*="/challenge/"]'],
		text: "Help us confirm it's you",
	},
	email: { controls: ['input[type="email"]'], text: "Welcome back" },
	verification_code: {
		controls: ['input[name="verificationCode"]'],
		text: "Enter the code",
	},
};

function makePostsPage(options: {
	challengeUrl?: string;
	challengeDom?: ChallengeDom;
	oldNavigationResponse?: Exclude<ScriptedPostsPage, null>;
	oldDocumentRequestDuringGoto?: Exclude<ScriptedPostsPage, null>;
	/** Ordinary profile text with no challenge controls (username, bio). */
	profileText?: string;
	exposeEmit?: (
		emit: (scripted: Exclude<ScriptedPostsPage, null>) => void,
	) => void;
	postsScript: ScriptedPostsPage[];
}): Page {
	const queue = [...options.postsScript];
	const responseListeners = new Set<(response: unknown) => void>();
	const requestListeners = new Set<(request: unknown) => void>();
	const navigationListeners = new Set<(frame: unknown) => void>();
	let pendingResolve: ((value: unknown) => void) | null = null;
	let pendingPredicate: ((value: unknown) => boolean) | null = null;
	let currentNavigationRequest: unknown = null;
	let frameUrl = options.challengeUrl ?? "https://www.instagram.com/testuser/";
	const mainFrame = {
		page: () => page,
		url: () => frameUrl,
	};

	const page = {
		evaluate: (fn: unknown): Promise<unknown> => {
			if (String(fn).includes("scrollTo")) {
				resolveNextResponse();
			}
			return Promise.resolve(undefined);
		},
		goto: (): Promise<null> => {
			emitNavigationRequest();
			if (options.oldDocumentRequestDuringGoto) {
				frameUrl = "https://www.instagram.com/testuser/";
				for (const listener of navigationListeners) listener(mainFrame);
				emitResponse(options.oldDocumentRequestDuringGoto);
			}
			if (options.oldNavigationResponse) {
				emitResponse(options.oldNavigationResponse, false);
			}
			emitNavigationResponse();
			frameUrl = "https://www.instagram.com/testuser/";
			for (const listener of navigationListeners) listener(mainFrame);
			resolveNextResponse();
			return Promise.resolve(null);
		},
		mainFrame: () => mainFrame,
		off: (event: string, listener: (response: unknown) => void): void => {
			if (event === "response") {
				responseListeners.delete(listener);
			} else if (event === "request") {
				requestListeners.delete(listener);
			} else if (event === "framenavigated") {
				navigationListeners.delete(listener);
			}
		},
		on: (event: string, listener: (response: unknown) => void): void => {
			if (event === "response") {
				responseListeners.add(listener);
			} else if (event === "request") {
				requestListeners.add(listener);
			} else if (event === "framenavigated") {
				navigationListeners.add(listener);
			}
		},
		url: () => options.challengeUrl ?? "https://www.instagram.com/testuser/",
		waitForFunction: (fn: unknown): Promise<unknown> => {
			const dom = options.challengeDom
				? CHALLENGE_DOMS[options.challengeDom]
				: { controls: [], text: options.profileText ?? "" };
			const documentDescriptor = Object.getOwnPropertyDescriptor(
				globalThis,
				"document",
			);
			Object.defineProperty(globalThis, "document", {
				configurable: true,
				value: {
					body: { innerText: dom.text },
					querySelector: (selector: string) =>
						dom.controls.some((control) => selector.includes(control))
							? {}
							: null,
				},
			});
			try {
				return (fn as () => boolean)()
					? Promise.resolve(true)
					: Promise.reject(new Error("challenge not visible"));
			} finally {
				if (documentDescriptor) {
					Object.defineProperty(globalThis, "document", documentDescriptor);
				} else {
					Reflect.deleteProperty(globalThis, "document");
				}
			}
		},
		waitForResponse: (predicate: unknown): Promise<unknown> =>
			new Promise((resolve) => {
				pendingResolve = resolve;
				pendingPredicate =
					typeof predicate === "function"
						? (value: unknown) => Boolean(predicate(value))
						: null;
			}),
	} as unknown as Page;

	function buildResponse(scripted: Exclude<ScriptedPostsPage, null>): unknown {
		const operationName = scripted.operationName ?? "PolarisProfilePostsQuery";
		const postData =
			scripted.postData ??
			new URLSearchParams({
				fb_api_req_friendly_name: operationName,
				variables: JSON.stringify({
					after: scripted.after ?? null,
					user_id: scripted.ownerId ?? "u1",
					username: scripted.username ?? "testuser",
				}),
			}).toString();
		const request = {
			frame: () => mainFrame,
			headers: () => ({ "x-fb-friendly-name": operationName }),
			method: () => scripted.method ?? "POST",
			postData: () => postData,
			url: () => scripted.requestUrl ?? scripted.url ?? "https://www.instagram.com/graphql/query/",
		};
		return {
			json: () => Promise.resolve(scripted.json),
			request: () =>
				scripted.fromCurrentPage === false
					? { ...request, frame: () => ({ page: () => ({}) as Page }) }
					: request,
			status: () => scripted.status,
			url: () => scripted.url ?? "https://www.instagram.com/graphql/query/",
		};
	}

	function emitNavigationRequest(): void {
		const request = {
			frame: () => mainFrame,
			isNavigationRequest: () => true,
			redirectedFrom: () => null,
			url: () => "https://www.instagram.com/testuser/",
		};
		currentNavigationRequest = request;
		for (const listener of requestListeners) listener(request);
	}

	function emitNavigationResponse(): void {
		const response = {
			request: () => currentNavigationRequest,
			status: () => 200,
			url: () => "https://www.instagram.com/testuser/",
		};
		for (const listener of responseListeners) listener(response);
	}

	function emitResponse(
		scripted: Exclude<ScriptedPostsPage, null>,
		includeRequest = true,
	): void {
		const response = buildResponse(scripted);
		if (includeRequest) {
			const request = (response as { request: () => unknown }).request();
			for (const listener of requestListeners) listener(request);
		}
		for (const listener of responseListeners) {
			listener(response);
		}
	}

	function resolveNextResponse(): void {
		const resolve = pendingResolve;
		pendingResolve = null;
		if (!resolve) {
			return;
		}
		const scripted = queue.shift();
		if (scripted === undefined || scripted === null) {
			resolve(null);
			return;
		}
		const response = buildResponse(scripted);
		const request = (response as { request: () => unknown }).request();
		for (const listener of requestListeners) {
			listener(request);
		}
		for (const listener of responseListeners) {
			listener(response);
		}
		resolve(pendingPredicate?.(response) === false ? null : response);
	}

	options.exposeEmit?.(emitResponse);

	return page;
}

async function pdppPostsDecision(
	postsScript: ScriptedPostsPage[],
	options: {
		challengeDom?: ChallengeDom;
		challengeUrl?: string;
		oldNavigationResponse?: Exclude<ScriptedPostsPage, null>;
		oldDocumentRequestDuringGoto?: Exclude<ScriptedPostsPage, null>;
		profileText?: string;
	} = {},
): Promise<PostsDecision> {
	try {
		const result = await fetchAllPosts(
			makePostsPage({ ...options, postsScript }),
			"testuser",
			null,
			async () => undefined,
			NO_DELAY,
			FAST_POSTS_CLOCK,
		);
		if (result.edges.length > 0) {
			return "data";
		}
		// Empty is claimed only from the source's own end signal, never from
		// the absence of edges or from how the page looks.
		return result.sourceEdgeCount === 0 && result.sourceEnd
			? "empty"
			: "not-proven";
	} catch (error) {
		assert.ok(error instanceof Error);
		assert.match(error.message, /^meta_posts_/);
		return "not-proven";
	}
}

async function fetchWithTimedLateResponse(options: {
	first: Exclude<ScriptedPostsPage, null>;
	late: Array<{
		atMs: number;
		response: Exclude<ScriptedPostsPage, null>;
	}>;
}): Promise<Awaited<ReturnType<typeof fetchAllPosts>>> {
	let emitLateResponse: (scripted: Exclude<ScriptedPostsPage, null>) => void =
		() => {
			throw new Error("late response emitter not initialized");
		};
	const scheduled = [...options.late].sort((a, b) => a.atMs - b.atMs);
	let now = 0;
	const postsClock = {
		sleep: async (ms: number): Promise<void> => {
			now += ms;
			while (
				scheduled.length > 0 &&
				(scheduled[0]?.atMs ?? Number.POSITIVE_INFINITY) <= now
			) {
				const scheduledResponse = scheduled.shift();
				if (scheduledResponse) {
					emitLateResponse(scheduledResponse.response);
				}
			}
		},
	};

	return fetchAllPosts(
		makePostsPage({
			exposeEmit: (emit) => {
				emitLateResponse = emit;
			},
			postsScript: [options.first],
		}),
		"testuser",
		null,
		async () => undefined,
		NO_DELAY,
		postsClock,
	);
}

test("fetchAllPosts: terminal empty is complete only when legacy would also be empty", async () => {
	const raw = timelineEnvelope([], { has_next_page: false });

	const pdpp = await pdppPostsDecision([{ json: raw, status: 200 }]);

	assert.equal(legacyPostsDecision(raw), "empty");
	assert.equal(pdpp, "empty");
});

test("fetchAllPosts: same-tab response from an earlier navigation cannot prove empty", async () => {
	const pdpp = await pdppPostsDecision([null], {
		oldNavigationResponse: {
			json: timelineEnvelope([], { has_next_page: false }),
			status: 200,
		},
	});

	assert.equal(pdpp, "not-proven");
});

test("fetchAllPosts: old document request during navigation cannot prove empty", async () => {
	const pdpp = await pdppPostsDecision([null], {
		oldDocumentRequestDuringGoto: {
			json: timelineEnvelope([], { has_next_page: false }),
			status: 200,
		},
	});

	assert.equal(pdpp, "not-proven");
});

test("fetchAllPosts: response for another owner cannot prove empty", async () => {
	const pdpp = await pdppPostsDecision([
		{
			json: timelineEnvelope([], { has_next_page: false }),
			status: 200,
			username: "different-user",
		},
	]);

	assert.equal(pdpp, "not-proven");
});

test("fetchAllPosts: continuation-only empty response cannot prove the initial page empty", async () => {
	const pdpp = await pdppPostsDecision([
		{
			after: "continuation-cursor",
			json: timelineEnvelope([], { has_next_page: false }),
			status: 200,
		},
	]);

	assert.equal(pdpp, "not-proven");
});

test("fetchAllPosts: posts parity matrix keeps PDPP empty inside the legacy empty boundary", async () => {
	const cases: Array<{
		expectedPdpp: PostsDecision;
		name: string;
		raw: RawEnvelope;
		status?: number;
	}> = [
		{
			expectedPdpp: "data",
			name: "ordinary populated terminal timeline",
			raw: timelineEnvelope([{ node: { id: "p1", taken_at: 1_700_000_000 } }], {
				has_next_page: false,
			}),
		},
		{
			expectedPdpp: "empty",
			name: "genuine empty terminal timeline",
			raw: timelineEnvelope([], { has_next_page: false }),
		},
		{
			expectedPdpp: "not-proven",
			name: "empty connection with missing pagination",
			raw: timelineEnvelope([], null),
		},
		{
			expectedPdpp: "not-proven",
			name: "HTTP 500 carrying empty connection",
			raw: timelineEnvelope([], { has_next_page: false }),
			status: 500,
		},
		{
			expectedPdpp: "not-proven",
			name: "GraphQL errors carrying empty connection",
			raw: timelineEnvelope([], { has_next_page: false }, { errors: [{}] }),
		},
		{
			expectedPdpp: "not-proven",
			name: "ok false carrying empty connection",
			raw: timelineEnvelope([], { has_next_page: false }, { ok: false }),
		},
		{
			expectedPdpp: "not-proven",
			name: "body status fail carrying empty connection",
			raw: timelineEnvelope([], { has_next_page: false }, { status: "fail" }),
		},
		{
			expectedPdpp: "not-proven",
			name: "401 body payload carrying empty connection",
			raw: timelineEnvelope([], { has_next_page: false }, { status: 401 }),
		},
		{
			expectedPdpp: "not-proven",
			name: "extensions unauthenticated carrying empty connection",
			raw: timelineEnvelope(
				[],
				{ has_next_page: false },
				{
					extensions: { code: "UNAUTHENTICATED" },
				},
			),
		},
		{
			expectedPdpp: "empty",
			name: "benign null errors carrying empty terminal connection",
			raw: timelineEnvelope([], { has_next_page: false }, { errors: null }),
		},
		{
			expectedPdpp: "not-proven",
			name: "partial page-not-terminal response",
			raw: timelineEnvelope(
				[],
				{ has_next_page: false },
				{
					extensions: { is_final: false, partial: true },
				},
			),
		},
		{
			expectedPdpp: "not-proven",
			name: "challenge envelope with empty timeline",
			raw: timelineEnvelope(
				[],
				{ has_next_page: false },
				{
					errorCode: "checkpoint_required",
				},
			),
		},
		{
			expectedPdpp: "not-proven",
			name: "nonempty source edges filtered by missing ids",
			raw: timelineEnvelope([{ node: { caption: { text: "missing id" } } }], {
				has_next_page: false,
			}),
		},
	];

	const actual = await Promise.all(
		cases.map(async (fixture) => {
			const legacy = legacyPostsDecision(fixture.raw);
			const pdpp = await pdppPostsDecision([
				{ json: fixture.raw, status: fixture.status ?? 200 },
			]);
			if (pdpp === "empty") {
				assert.equal(legacy, "empty", fixture.name);
			}
			if (legacy === "data") {
				assert.notEqual(pdpp, "empty", fixture.name);
			}
			assert.equal(pdpp, fixture.expectedPdpp, fixture.name);
			return { fixture: fixture.name, legacy, pdpp };
		}),
	);

	assert.deepEqual(actual, [
		{
			fixture: "ordinary populated terminal timeline",
			legacy: "data",
			pdpp: "data",
		},
		{
			fixture: "genuine empty terminal timeline",
			legacy: "empty",
			pdpp: "empty",
		},
		{
			fixture: "empty connection with missing pagination",
			legacy: "empty",
			pdpp: "not-proven",
		},
		{
			fixture: "HTTP 500 carrying empty connection",
			legacy: "empty",
			pdpp: "not-proven",
		},
		{
			fixture: "GraphQL errors carrying empty connection",
			legacy: "empty",
			pdpp: "not-proven",
		},
		{
			fixture: "ok false carrying empty connection",
			legacy: "empty",
			pdpp: "not-proven",
		},
		{
			fixture: "body status fail carrying empty connection",
			legacy: "empty",
			pdpp: "not-proven",
		},
		{
			fixture: "401 body payload carrying empty connection",
			legacy: "empty",
			pdpp: "not-proven",
		},
		{
			fixture: "extensions unauthenticated carrying empty connection",
			legacy: "empty",
			pdpp: "not-proven",
		},
		{
			fixture: "benign null errors carrying empty terminal connection",
			legacy: "empty",
			pdpp: "empty",
		},
		{
			fixture: "partial page-not-terminal response",
			legacy: "empty",
			pdpp: "not-proven",
		},
		{
			fixture: "challenge envelope with empty timeline",
			legacy: "empty",
			pdpp: "not-proven",
		},
		{
			fixture: "nonempty source edges filtered by missing ids",
			legacy: "data",
			pdpp: "not-proven",
		},
	]);
});

test("fetchAllPosts: accepts the four legacy owner-posts operation names", async () => {
	const operations = [
		"PolarisProfilePostsQuery",
		"PolarisProfilePostsTabContentQuery_connection",
		"ProfilePostsQuery",
		"UserMediaQuery",
	];

	await Promise.all(
		operations.map(async (operationName) => {
			const raw = timelineEnvelope(
				[{ node: { id: operationName, taken_at: 1_700_000_000 } }],
				{ has_next_page: false },
			);
			const result = await fetchAllPosts(
				makePostsPage({
					postsScript: [{ json: raw, operationName, status: 200 }],
				}),
				"testuser",
				null,
				async () => undefined,
				NO_DELAY,
				FAST_POSTS_CLOCK,
			);

			assert.equal(result.edges[0]?.node.id, operationName);
		}),
	);
});

test("fetchAllPosts: header-only posts operation is not legacy timeline evidence", async () => {
	const pdpp = await pdppPostsDecision([
		{
			json: timelineEnvelope([], { has_next_page: false }),
			operationName: "PolarisProfilePostsQuery",
			postData: "tracking=1",
			status: 200,
		},
	]);

	assert.equal(pdpp, "not-proven");
});

test("fetchAllPosts: fallback scroll acquires the initial response after legacy polling", async () => {
	const result = await fetchAllPosts(
		makePostsPage({
			postsScript: [
				null,
				{
					json: timelineEnvelope([{ node: { id: "fallback-post" } }], {
						has_next_page: false,
					}),
					status: 200,
				},
			],
		}),
		"testuser",
		null,
		async () => undefined,
		NO_DELAY,
		FAST_POSTS_CLOCK,
	);

	assert.deepEqual(
		result.edges.map((edge) => edge.node.id),
		["fallback-post"],
	);
});

test("fetchAllPosts: walks an empty first page when it advertises a next page", async () => {
	const result = await fetchAllPosts(
		makePostsPage({
			postsScript: [
				{
					json: timelineEnvelope([], {
						end_cursor: "next",
						has_next_page: true,
					}),
					status: 200,
				},
				{
					after: "next",
					json: timelineEnvelope(
						[{ node: { id: "page-2", taken_at: 1_700_000_001 } }],
						{ has_next_page: false },
					),
					status: 200,
				},
			],
		}),
		"testuser",
		null,
		async () => undefined,
		NO_DELAY,
	);

	assert.deepEqual(
		result.edges.map((edge) => edge.node.id),
		["page-2"],
	);
	assert.equal(result.sourceEdgeCount, 1);
});

test("fetchAllPosts: unrecordable source edges fail instead of silently completing", async () => {
	await assert.rejects(
		fetchAllPosts(
			makePostsPage({
				postsScript: [
					{
						json: timelineEnvelope(
							[{ node: { caption: { text: "missing id" } } }],
							{ has_next_page: false },
						),
						status: 200,
					},
				],
			}),
				"testuser",
			null,
			async () => undefined,
			NO_DELAY,
			FAST_POSTS_CLOCK,
		),
		/meta_posts_unrecordable_edges/,
	);
});

for (const atMs of [1_500, 3_500]) {
	test(`fetchAllPosts: initial terminal empty waits for late populated response at ${atMs}ms`, async () => {
		const result = await fetchWithTimedLateResponse({
			first: {
				json: timelineEnvelope([], { has_next_page: false }),
				status: 200,
			},
			late: [
				{
					atMs,
					response: {
						json: timelineEnvelope(
							[
								{
									node: {
										id: `late-populated-${atMs}`,
										taken_at: 1_700_000_002,
									},
								},
							],
							{ has_next_page: false },
						),
						status: 200,
					},
				},
			],
		});

		assert.deepEqual(
			result.edges.map((edge) => edge.node.id),
			[`late-populated-${atMs}`],
		);
	});
}

test("fetchAllPosts: populated then terminal empty at 1500ms is contradictory, not empty proof", async () => {
	// Legacy capture is last-wins and would report empty here. PDPP may be
	// stricter than legacy (PDPP empty must imply legacy empty, not the
	// reverse), and an empty response after posts is not evidence of zero posts.
	await assert.rejects(
		fetchWithTimedLateResponse({
			first: {
				json: timelineEnvelope(
					[{ node: { id: "early-post", taken_at: 1_700_000_001 } }],
					{ has_next_page: false },
				),
				status: 200,
			},
			late: [
				{
					atMs: 1_500,
					response: {
						json: timelineEnvelope([], { has_next_page: false }),
						status: 200,
					},
				},
			],
		}),
		/meta_posts_timeline_contradictory/,
	);
});

test("fetchAllPosts: a page the client fetches during the polite delay is walked, not skipped", async () => {
	let emitDuringDelay: (scripted: Exclude<ScriptedPostsPage, null>) => void =
		() => {
			throw new Error("emitter not initialized");
		};
	let delays = 0;
	const result = await fetchAllPosts(
		makePostsPage({
			exposeEmit: (emit) => {
				emitDuringDelay = emit;
			},
			postsScript: [
				{
					json: timelineEnvelope(
						[{ node: { id: "a1", taken_at: 1_700_000_003 } }],
						{ end_cursor: "after-a", has_next_page: true },
					),
					status: 200,
				},
				{
					after: "after-b",
					json: timelineEnvelope(
						[{ node: { id: "c1", taken_at: 1_700_000_001 } }],
						{ has_next_page: false },
					),
					status: 200,
				},
			],
		}),
		"testuser",
		null,
		async () => undefined,
		async () => {
			delays += 1;
			if (delays === 1) {
				// Instagram's own scroll sentinel fetched page 2 while we waited.
				emitDuringDelay({
					after: "after-a",
					json: timelineEnvelope(
						[{ node: { id: "b1", taken_at: 1_700_000_002 } }],
						{ end_cursor: "after-b", has_next_page: true },
					),
					status: 200,
				});
			}
		},
		FAST_POSTS_CLOCK,
	);

	assert.deepEqual(
		result.edges.map((edge) => edge.node.id),
		["a1", "b1", "c1"],
	);
	assert.equal(result.sourceEdgeCount, 3);
	assert.equal(result.truncated, false);
});

test("fetchAllPosts: authentication failure after terminal empty cancels empty completion", async () => {
	let emitLateResponse: (scripted: Exclude<ScriptedPostsPage, null>) => void =
		() => {
			throw new Error("late response emitter not initialized");
		};
	const scheduled = [
		{
			atMs: 1_500,
			response: {
				json: timelineEnvelope(
					[],
					{ has_next_page: false },
					{
						errors: [{ message: "authentication expired" }],
					},
				),
				status: 200,
			},
		},
	];
	let now = 0;
	const postsClock = {
		sleep: async (ms: number): Promise<void> => {
			now += ms;
			while (
				scheduled.length > 0 &&
				(scheduled[0]?.atMs ?? Number.POSITIVE_INFINITY) <= now
			) {
				const scheduledResponse = scheduled.shift();
				if (scheduledResponse) {
					emitLateResponse(scheduledResponse.response);
				}
			}
		},
	};

	await assert.rejects(
		fetchAllPosts(
			makePostsPage({
				exposeEmit: (emit) => {
					emitLateResponse = emit;
				},
				postsScript: [
					{
						json: timelineEnvelope([], { has_next_page: false }),
						status: 200,
					},
				],
			}),
			"testuser",
			null,
			async () => undefined,
			NO_DELAY,
			postsClock,
		),
		/meta_posts_timeline_unavailable/,
	);
});

test("fetchAllPosts: stale other-page empty timeline is not empty proof", async () => {
	const pdpp = await pdppPostsDecision([
		{
			fromCurrentPage: false,
			json: timelineEnvelope([], { has_next_page: false }),
			status: 200,
		},
	]);

	assert.equal(pdpp, "not-proven");
});

test("fetchAllPosts: GET graphqlLegacy URL is deliberately stricter than legacy matching", async () => {
	const pdpp = await pdppPostsDecision([
		{
			json: timelineEnvelope(
				[{ node: { id: "legacy-url-match", taken_at: 1_700_000_003 } }],
				{ has_next_page: false },
			),
			method: "GET",
			postData: "fb_api_req_friendly_name=PolarisProfilePostsQuery",
			status: 200,
			url: "https://www.instagram.com/graphqlLegacy",
		},
	]);

	assert.equal(pdpp, "not-proven");
});

test("fetchAllPosts: a login URL neither proves nor vetoes the source's end signal", async () => {
	const withEnd = await pdppPostsDecision(
		[{ json: timelineEnvelope([], { has_next_page: false }), status: 200 }],
		{ challengeUrl: "https://www.instagram.com/accounts/login/" },
	);
	assert.equal(withEnd, "empty", "explicit source end decides, page layout does not");
	const withoutEnd = await pdppPostsDecision(
		[{ json: timelineEnvelope([], null), status: 200 }],
		{ challengeUrl: "https://www.instagram.com/accounts/login/" },
	);
	assert.equal(withoutEnd, "not-proven", "no source end signal means no completeness");
});

for (const challengeDom of [
	"captcha",
	"email",
	"verification_code",
	"challenge_form",
] as const) {
	test(`fetchAllPosts: same-URL ${challengeDom} challenge neither proves nor vetoes the source's end signal`, async () => {
		const withEnd = await pdppPostsDecision(
			[{ json: timelineEnvelope([], { has_next_page: false }), status: 200 }],
			{ challengeDom },
		);
		assert.equal(withEnd, "empty", "explicit source end decides, page layout does not");
		const withoutEnd = await pdppPostsDecision(
			[{ json: timelineEnvelope([], null), status: 200 }],
			{ challengeDom },
		);
		assert.equal(withoutEnd, "not-proven", "no source end signal means no completeness");
	});
}

for (const profileText of [
	"challenge_runner",
	"I enjoy a challenge",
	"checkpoint tracker. Send me your security code ideas",
	"Welcome back to my page, verify you are human? never",
]) {
	test(`fetchAllPosts: ordinary profile text ${JSON.stringify(profileText)} does not block terminal empty completion`, async () => {
		const result = await fetchAllPosts(
			makePostsPage({
				postsScript: [
					{
						json: timelineEnvelope([], { has_next_page: false }),
						status: 200,
					},
				],
				profileText,
			}),
			"testuser",
			null,
			async () => undefined,
			NO_DELAY,
			FAST_POSTS_CLOCK,
		);
		assert.equal(result.sourceEdgeCount, 0);
		assert.equal(result.truncated, false);
	});
}

for (const mediaCount of [0, 5]) {
	test(`fetchAllPosts: profile media_count ${mediaCount === 0 ? "zero" : "positive"} is deliberately not posts empty proof`, async () => {
		const profileCountOnly = {
			data: {
				data: {
					user: {
						follower_count: 0,
						following_count: 0,
						media_count: mediaCount,
					},
				},
			},
		};
		const pdpp = await pdppPostsDecision([
			{
				json: profileCountOnly,
				operationName: "ProfilePageQuery",
				postData: "fb_api_req_friendly_name=ProfilePageQuery",
				status: 200,
			},
		]);
		assert.equal(pdpp, "not-proven");
	});
}

function settledPost(id: string) {
	return { node: { id, taken_at: 1_700_000_001, like_count: 1,
		facepile_top_likers: [{ id: `liker-${id}`, username: `liker_${id}` }] } };
}

function ownerTimeline(ids: string[]): RawEnvelope {
	const body = timelineEnvelope(ids.map(settledPost), { has_next_page: false });
	(body.data as RawEnvelope).user = { id: "u1", username: "testuser" };
	return body;
}

async function collectWithSettledResponses(responses: Array<Exclude<ScriptedPostsPage, null>>, continuation?: Exclude<ScriptedPostsPage, null>) {
	let emitLate = (_response: Exclude<ScriptedPostsPage, null>): void => {};
	const page = makePostsPage({ postsScript: [responses[0]!, ...(continuation ? [continuation] : [])], exposeEmit: emit => { emitLate = emit; } });
	const goto = page.goto.bind(page);
	const evaluate = page.evaluate.bind(page);
	let fetchingPosts = false;
	let followingReads = 0;
	page.goto = ((...args: Parameters<Page["goto"]>) => fetchingPosts ? goto(...args) : Promise.resolve(null)) as Page["goto"];
	page.evaluate = ((fn: unknown, arg?: unknown) => {
		if (String(fn).includes("PolarisViewer")) return Promise.resolve({ id: "u1", username: "testuser" });
		if (arg && typeof arg === "object" && "path" in arg) {
			followingReads += 1;
			return Promise.resolve({ status: 200, json: { status: "ok", users: [{ pk: "followed", username: "followed" }], has_more: false, next_max_id: null } });
		}
		return evaluate(fn as Parameters<Page["evaluate"]>[0]);
	}) as Page["evaluate"];
	const emitted: Array<{ stream: string; data: Record<string, unknown> }> = [];
	const messages: Array<{ type: string; stream?: string; reason?: string; recovery_hint?: { retryable?: boolean } }> = [];
	const ctx = {
		page, capture: null, requested: new Set(["posts", "post_likes", "following"]),
		progress: async (message: string) => { if (message === "Fetching Instagram posts") fetchingPosts = true; },
		emitRecord: async (stream: string, data: Record<string, unknown>) => { emitted.push({ stream, data }); },
		emit: async (message: typeof messages[number]) => { messages.push(message); },
		// The SKIP_RESULT the runtime's reportStreamFailure emits.
		reportStreamFailure: async (stream: string, _message: string, options?: { retryable?: boolean }) => {
			messages.push({ type: "SKIP_RESULT", stream, reason: "stream_collection_failed",
				recovery_hint: { retryable: options?.retryable === true } });
		},
	} as unknown as Parameters<typeof collectAllStreams>[0];
	const late = responses.slice(1);
	let now = 0;
	let nextResponseAt = 1_500;
	const postsClock = { sleep: async (ms: number) => {
		now += ms;
		if (!continuation && now >= nextResponseAt) {
			const response = late.shift();
			if (response) emitLate(response);
			nextResponseAt += 2_000;
		}
	} };
	await collectAllStreams(ctx, async () => { if (continuation) { for (const response of late.splice(0)) emitLate(response); } }, postsClock, { now: () => 0, sleep: NO_DELAY }, FAST_POSTS_CLOCK);
	return { emitted, messages, followingReads };
}

test("collectAllStreams: POST /api/graphql completes posts and likes like /graphql/query", async () => {
	const results = [];
	for (const path of ["/graphql/query", "/api/graphql"]) {
		const result = await collectWithSettledResponses([{
			json: ownerTimeline(["A"]),
			method: "POST",
			status: 200,
			url: `https://www.instagram.com${path}`,
		}]);
		assert.deepEqual(
			result.emitted.filter(row => row.stream === "posts").map(row => row.data.id),
			["A"],
		);
		assert.deepEqual(
			result.emitted.filter(row => row.stream === "post_likes").map(row => ({
				post_id: row.data.post_id,
				user_id: row.data.user_id,
			})),
			[{ post_id: "A", user_id: "liker-A" }],
		);
		for (const stream of ["posts", "post_likes"]) {
			assert.equal(result.messages.filter(message => message.type === "STATE" && message.stream === stream).length, 1, `${path}: ${stream} completion`);
			assert.equal(result.messages.some(message => message.type === "SKIP_RESULT" && message.stream === stream), false);
		}
		results.push(result);
	}
	assert.deepEqual(results[1]?.emitted, results[0]?.emitted, "both endpoints emit identical records");
});

for (const path of ["/api/graphqlx", "/notgraphql/"]) {
	for (const rejectedUrl of ["request", "response"] as const) {
		test(`collectAllStreams: POST ${path} ${rejectedUrl} is not a posts timeline`, async () => {
			// Keep the other URL valid so each guard is exercised independently.
			const validUrl = "https://www.instagram.com/api/graphql";
			const lookalikeUrl = `https://www.instagram.com${path}`;
			const { emitted, messages } = await collectWithSettledResponses([{
				json: ownerTimeline(["A"]),
				method: "POST",
				requestUrl: rejectedUrl === "request" ? lookalikeUrl : validUrl,
				status: 200,
				url: rejectedUrl === "response" ? lookalikeUrl : validUrl,
			}]);
			for (const stream of ["posts", "post_likes"]) {
				assert.deepEqual(emitted.filter(row => row.stream === stream), []);
				assert.equal(messages.some(message => message.type === "STATE" && message.stream === stream), false);
				const skips = messages.filter(message => message.type === "SKIP_RESULT" && message.stream === stream);
				assert.equal(skips.length, 1);
				// No timeline response was observed: the read failed.
				assert.equal(skips[0]?.reason, "stream_collection_failed");
				assert.equal(skips[0]?.recovery_hint?.retryable, true);
			}
		});
	}
}

for (const { label, late, expected, complete } of [
	{ label: "shrinking terminal", late: [{ status: 200, json: ownerTimeline(["A"]) }], expected: ["A", "B"], complete: false },
	{ label: "empty terminal", late: [{ status: 200, json: ownerTimeline([]) }], expected: ["A", "B"], complete: false },
	{ label: "HTTP failure", late: [{ status: 500, json: {} }], expected: ["A", "B"], complete: false },
	{ label: "malformed envelope", late: [{ status: 200, json: { data: {} } }], expected: ["A", "B"], complete: false },
	{ label: "error envelope", late: [{ status: 200, json: { ...ownerTimeline(["A"]), errors: [{ message: "failed" }] } }], expected: ["A", "B"], complete: false },
	{ label: "intermediate inventory then shrink", late: [{ status: 200, json: ownerTimeline(["A", "B", "C"]) }, { status: 200, json: ownerTimeline(["A", "B"]) }], expected: ["A", "B", "C"], complete: false },
	{ label: "intermediate inventory then failure", late: [{ status: 200, json: ownerTimeline(["A", "B", "C"]) }, { status: 500, json: {} }], expected: ["A", "B", "C"], complete: false },
	{ label: "stable terminal control", late: [{ status: 200, json: ownerTimeline(["A", "B"]) }], expected: ["A", "B"], complete: true },
	{ label: "growing terminal control", late: [{ status: 200, json: ownerTimeline(["A", "B", "C"]) }], expected: ["A", "B", "C"], complete: true },
]) {
	test(`collectAllStreams: settle ${label} preserves validated posts and likes with unknown profile count`, async () => {
		const { emitted, messages, followingReads } = await collectWithSettledResponses([{ status: 200, json: ownerTimeline(["A", "B"]) }, ...late]);
		assert.deepEqual(emitted.filter(row => row.stream === "posts").map(row => row.data.id), expected);
		assert.deepEqual(emitted.filter(row => row.stream === "post_likes").map(row => row.data.post_id), expected);
		for (const stream of ["posts", "post_likes"]) {
			assert.equal(messages.some(message => message.type === "STATE" && message.stream === stream), complete, `${stream} completion`);
			const skip = messages.find(message => message.type === "SKIP_RESULT" && message.stream === stream);
			assert.equal(Boolean(skip), !complete);
			if (!complete) {
				// An unsuccessful or unreadable late page is a failed read; a
				// readable page that contradicts the list leaves it unproven.
				assert.equal(skip?.reason, /HTTP failure|envelope|then failure/.test(label)
					? "stream_collection_failed" : "inventory_not_proven_complete");
				assert.equal(skip?.recovery_hint?.retryable, true);
			}
		}
		assert.equal(followingReads, 1, "later requested stream still runs");
		assert.ok(emitted.some(row => row.stream === "following" && row.data.id === "followed"));
	});
}

function versionTimeline(node: Record<string, unknown>): RawEnvelope {
	const body = timelineEnvelope([{ node }], { has_next_page: false });
	(body.data as RawEnvelope).user = { id: "u1", username: "testuser" };
	return body;
}

for (const scenario of [
	{ label: "growing likers", later: { like_count: 2, facepile_top_likers: [{ id: "L1" }, { id: "L2" }] }, caption: "first", count: 2, likes: ["L1", "L2"], complete: false },
	{ label: "changed caption", later: { caption: { text: "latest" } }, caption: "latest", count: 1, likes: ["L1"], complete: false },
	{ label: "changed unmapped field", later: { source_extra: "changed" }, caption: "first", count: 1, likes: ["L1"], complete: false },
	{ label: "malformed later post", later: { taken_at: "bad" }, caption: "first", count: 1, likes: ["L1"], complete: false },
	{ label: "malformed later likers", later: { facepile_top_likers: [null, { id: "L2" }] }, caption: "first", count: 1, likes: ["L1", "L2"], complete: false },
	{ label: "replacement liker sample", later: { facepile_top_likers: [{ id: "L2" }] }, caption: "first", count: 1, likes: ["L1", "L2"], complete: false },
	{ label: "identical repeat", later: {}, caption: "first", count: 1, likes: ["L1"], complete: true },
]) {
	test(`collectAllStreams: same post version ${scenario.label}`, async () => {
		const first = { id: "A", taken_at: 1_700_000_001, caption: { text: "first" }, like_count: 1, facepile_top_likers: [{ id: "L1" }] };
		const { emitted, messages } = await collectWithSettledResponses([
			{ status: 200, json: versionTimeline(first) },
			{ status: 200, json: versionTimeline({ ...first, ...scenario.later }) },
		]);
		const posts = emitted.filter(row => row.stream === "posts");
		assert.equal(posts.length, 1);
		assert.equal(posts[0]?.data.caption, scenario.caption);
		assert.equal(posts[0]?.data.like_count, scenario.count);
		const likes = emitted.filter(row => row.stream === "post_likes");
		assert.deepEqual(likes.map(row => row.data.user_id), scenario.likes);
		assert.deepEqual(likes.map(row => row.data.liker_ordinal), scenario.likes.map((_, i) => i));
		for (const stream of ["posts", "post_likes"]) {
			assert.equal(messages.some(message => message.type === "STATE" && message.stream === stream), scenario.complete, `${stream} completion`);
			const skips = messages.filter(message => message.type === "SKIP_RESULT" && message.stream === stream);
			assert.equal(skips.length, scenario.complete ? 0 : 1);
			if (!scenario.complete) {
				assert.equal(skips[0]?.reason, "inventory_not_proven_complete");
				assert.equal(skips[0]?.recovery_hint?.retryable, true);
			}
		}
	});
}

for (const kind of ["changed", "unreadable", "identical"] as const) {
	test(`fetchAllPosts: paginated duplicate is validated before deduplication (${kind})`, async () => {
		const first = { id: "A", taken_at: 1_700_000_001, like_count: 1, facepile_top_likers: [{ id: "L1" }] };
		const later = kind === "changed" ? { ...first, like_count: 2, facepile_top_likers: [{ id: "L2" }] }
			: kind === "unreadable" ? { ...first, taken_at: "bad" } : { ...first };
		const read = fetchAllPosts(makePostsPage({ postsScript: [
			{ status: 200, json: timelineEnvelope([{ node: first }], { has_next_page: true, end_cursor: "next" }) },
			{ status: 200, after: "next", json: timelineEnvelope([{ node: later }], { has_next_page: false }) },
		] }), "testuser", null, undefined, NO_DELAY, FAST_POSTS_CLOCK);
		if (kind === "identical") {
			const result = await read;
			assert.equal(result.edges.length, 1);
			assert.equal(result.sourceEnd, true);
		} else {
			await assert.rejects(read, (error: unknown) => {
				const failure = error as Error & { partial: Array<{ node: typeof first }> };
				assert.match(failure.message, /meta_posts_timeline_contradictory/);
				assert.equal(failure.partial.length, 1);
				assert.equal(failure.partial[0]?.node.like_count, kind === "changed" ? 2 : 1);
				assert.deepEqual(failure.partial[0]?.node.facepile_top_likers.map(liker => liker.id), kind === "changed" ? ["L1", "L2"] : ["L1"]);
				return true;
			});
		}
	});
}


for (const kind of ["changed", "unreadable", "failed", "identical"] as const) {
	test(`collectAllStreams: consumed cursor repeat during pagination delay (${kind})`, async () => {
		const first = { id: "A", taken_at: 1_700_000_001, caption: { text: "first" }, like_count: 1, facepile_top_likers: [{ id: "L1" }] };
		const later = kind === "changed" ? { ...first, caption: { text: "latest" }, like_count: 2, facepile_top_likers: [{ id: "L2" }] }
			: kind === "unreadable" ? { ...first, taken_at: "bad", facepile_top_likers: [{ id: "L2" }] } : first;
		const firstPage = (node: Record<string, unknown>) => {
			const body = versionTimeline(node);
			((body.data as RawEnvelope).xdt_api__v1__feed__user_timeline_graphql_connection as RawEnvelope).page_info = { has_next_page: true, end_cursor: "next" };
			return body;
		};
		const { emitted, messages } = await collectWithSettledResponses([
			{ status: 200, json: firstPage(first) },
			{ status: kind === "failed" ? 500 : 200, json: firstPage(later) },
		], { status: 200, after: "next", json: ownerTimeline(["B"]) });
		const post = emitted.find(row => row.stream === "posts" && row.data.id === "A");
		assert.equal(post?.data.caption, kind === "changed" ? "latest" : "first");
		assert.equal(post?.data.like_count, kind === "changed" ? 2 : 1);
		assert.deepEqual(emitted.filter(row => row.stream === "post_likes" && row.data.post_id === "A").map(row => row.data.user_id),
			kind === "changed" || kind === "unreadable" ? ["L1", "L2"] : ["L1"]);
		assert.ok(emitted.some(row => row.stream === "posts" && row.data.id === "B"), "pagination still advances");
		for (const stream of ["posts", "post_likes"]) {
			assert.equal(messages.some(m => m.type === "STATE" && m.stream === stream), kind === "identical", `${stream} STATE`);
			assert.equal(messages.some(m => m.type === "SKIP_RESULT" && m.stream === stream), kind !== "identical");
		}
	});
}
