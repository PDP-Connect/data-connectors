// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Page } from "playwright";
import { fetchAllPosts } from "./index.ts";

const NO_DELAY = (): Promise<void> => Promise.resolve();
const FAST_POSTS_CLOCK = { sleep: async (): Promise<void> => undefined };

type RawEnvelope = Record<string, unknown>;
type PostsDecision = "data" | "empty" | "not-proven";

type ScriptedPostsPage = {
	fromCurrentPage?: boolean;
	json: unknown;
	method?: string;
	operationName?: string;
	postData?: string;
	status: number;
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

type ChallengeDom = "captcha" | "email" | "verification_code" | "challenge_form";

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
	/** Ordinary profile text with no challenge controls (username, bio). */
	profileText?: string;
	exposeEmit?: (
		emit: (scripted: Exclude<ScriptedPostsPage, null>) => void,
	) => void;
	postsScript: ScriptedPostsPage[];
}): Page {
	const queue = [...options.postsScript];
	const responseListeners = new Set<(response: unknown) => void>();
	let pendingResolve: ((value: unknown) => void) | null = null;
	let pendingPredicate: ((value: unknown) => boolean) | null = null;

	const page = {
		evaluate: (fn: unknown): Promise<unknown> => {
			if (String(fn).includes("scrollTo")) {
				resolveNextResponse();
			}
			return Promise.resolve(undefined);
		},
		goto: (): Promise<null> => {
			resolveNextResponse();
			return Promise.resolve(null);
		},
		off: (event: string, listener: (response: unknown) => void): void => {
			if (event === "response") {
				responseListeners.delete(listener);
			}
		},
		on: (event: string, listener: (response: unknown) => void): void => {
			if (event === "response") {
				responseListeners.add(listener);
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
			scripted.postData ?? `fb_api_req_friendly_name=${operationName}`;
		return {
			json: () => Promise.resolve(scripted.json),
			request: () => ({
				frame: () => ({
					page: () =>
						scripted.fromCurrentPage === false ? ({} as Page) : page,
				}),
				headers: () => ({ "x-fb-friendly-name": operationName }),
				method: () => scripted.method ?? "POST",
				postData: () => postData,
			}),
			status: () => scripted.status,
			url: () => scripted.url ?? "https://www.instagram.com/graphql/query/",
		};
	}

	function emitResponse(scripted: Exclude<ScriptedPostsPage, null>): void {
		const response = buildResponse(scripted);
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
		return result.sourceEdgeCount === 0 ? "empty" : "not-proven";
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

test("fetchAllPosts: redirect login URL prevents terminal empty completion", async () => {
	await assert.rejects(
		fetchAllPosts(
			makePostsPage({
				challengeUrl: "https://www.instagram.com/accounts/login/",
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
			FAST_POSTS_CLOCK,
		),
		/meta_posts_login_challenge/,
	);
});

for (const challengeDom of [
	"captcha",
	"email",
	"verification_code",
	"challenge_form",
] as const) {
	test(`fetchAllPosts: same-URL ${challengeDom} challenge prevents terminal empty completion`, async () => {
		await assert.rejects(
			fetchAllPosts(
				makePostsPage({
					challengeDom,
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
				FAST_POSTS_CLOCK,
			),
			/meta_posts_login_challenge/,
		);
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
			"challenge_runner",
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
