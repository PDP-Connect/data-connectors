// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	activityUrl,
	type CollectorContext,
	collectFacebook,
	type FacebookServices,
	type GraphqlCall,
	HEARTBEAT_MS,
	type PageDeadlines,
	type PageGraphqlResult,
	type PageSnapshot,
} from "./collect.ts";
import {
	evaluateInMainWorld,
	graphqlPageCall,
	PAGE_FUNCTIONS,
	probeFacebookSession,
} from "./index.ts";
import {
	type CapturedOperation,
	GRAPHQL_PATH,
	type JsonRecord,
	operationMatches,
} from "./parsers.ts";
import { validateRecord } from "./schemas.ts";
import {
	ACTIVITY,
	FRIENDS,
	loadFixture,
	TIMELINE,
	TIMELINE_VIEWER,
} from "./test-helpers.ts";

const VIEWER_SCRIPT = JSON.stringify({
	define: [
		[
			"CurrentUserInitialData",
			[],
			{ USER_ID: TIMELINE_VIEWER, NAME: "Ada Example" },
			270,
		],
	],
});

function preloaded(id: string, result: unknown): string {
	return JSON.stringify({
		require: [
			[
				"ScheduledServerJS",
				"handle",
				null,
				[
					{
						__bbox: {
							require: [
								[
									"RelayPrefetchedStreamCache",
									"next",
									[],
									[id, { __bbox: { result, sequence_number: 0 } }],
								],
							],
						},
					},
				],
			],
		],
	});
}

/** The friends fixture with its ids shifted, so a second page holds new friends. */
function friendsPage(
	shift: number,
	pageInfo: { end_cursor: string | null; has_next_page: boolean },
): JsonRecord {
	const payload = loadFixture(FRIENDS);
	const items = ((payload.data as JsonRecord).node as JsonRecord)
		.pageItems as JsonRecord;
	for (const edge of items.edges as JsonRecord[]) {
		const node = edge.node as JsonRecord;
		const inner = node.node as JsonRecord;
		inner.id = String(Number(inner.id) + shift);
		node.id = `${String(node.id)}-${shift}`;
	}
	items.page_info = pageInfo;
	return payload;
}

function response(body: unknown, status = 200): PageGraphqlResult {
	return {
		kind: "response",
		status,
		url: `https://www.facebook.com${GRAPHQL_PATH}`,
		contentType: "text/html; charset=utf-8",
		mitigated: null,
		text: `for (;;);${typeof body === "string" ? body : JSON.stringify(body)}`,
	};
}

interface Harness {
	calls: GraphqlCall[];
	ctx: CollectorContext;
	emitted: { message: unknown; type: string }[];
	failures: { message: string; stream: string }[];
	opened: string[];
	progress: string[];
	records: { data: Record<string, unknown>; stream: string }[];
	scrolls: number;
	services: FacebookServices;
	tickers: { ms: number; stopped: boolean; tick: () => void }[];
}

function harness(args: {
	captured?: CapturedOperation[];
	moduleDocIds?: Record<string, string>;
	pages: Record<string, PageSnapshot>;
	replies: PageGraphqlResult[];
	state?: Record<string, unknown>;
	streams: string[];
}): Harness {
	const h: Harness = {
		progress: [],
		tickers: [],
		calls: [],
		emitted: [],
		failures: [],
		opened: [],
		records: [],
		scrolls: 0,
		ctx: {
			emit: async (message) => {
				h.emitted.push({ type: message.type, message });
			},
			emitRecord: async (stream, data) => {
				const check = validateRecord(stream, data);
				assert.equal(check.ok, true, `${stream} record validates`);
				h.records.push({ stream, data });
				h.emitted.push({ type: "RECORD", message: { stream } });
			},
			progress: async (message) => {
				h.progress.push(message);
			},
			reportStreamFailure: async (stream, message) => {
				h.failures.push({ stream, message });
			},
			requested: new Map(args.streams.map((stream) => [stream, {} as never])),
			state: args.state ?? {},
		},
		services: {
			open: async (url) => {
				h.opened.push(url);
				const page = args.pages[url];
				if (!page) throw new Error(`unexpected navigation to ${url}`);
				return page;
			},
			scroll: async () => {
				h.scrolls += 1;
			},
			takeCaptured: (spec) =>
				args.captured?.find((op) => operationMatches(spec, op.friendlyName)) ??
				null,
			resolveModule: async (name) => ({
				docId: args.moduleDocIds?.[name] ?? null,
				provided: {},
			}),
			graphql: async (call) => {
				const { path } = graphqlPageCall(call);
				if (!(path === "/api/graphql/"))
					throw new Error(`unexpected request path ${path}`);
				h.calls.push(call);
				const reply = args.replies.shift();
				if (!reply) throw new Error("no more replies");
				return reply;
			},
			sleep: async () => undefined,
			random: () => 0.5,
			observesRequests: true,
			every: (ms, tick) => {
				const ticker = { ms, tick, stopped: false };
				h.tickers.push(ticker);
				return () => {
					ticker.stopped = true;
				};
			},
		},
	};
	return h;
}

const ME = "https://www.facebook.com/me";
const FRIENDS_URL = "https://www.facebook.com/me/friends_all";
const INTRO_SCRIPT = preloaded("adp_profile", {
	data: {
		user: {
			id: TIMELINE_VIEWER,
			profile_intro_card: {
				bio: { text: "Swimmer." },
				context_items: { nodes: [] },
			},
		},
	},
});
const meSnapshot: PageSnapshot = {
	landedUrl: "https://www.facebook.com/ada.example",
	scripts: [VIEWER_SCRIPT, INTRO_SCRIPT],
};
const FRIENDS_OP: CapturedOperation = {
	friendlyName:
		"ProfileCometAppCollectionSelfFriendsListRendererPaginationQuery",
	docId: "24123456789012345",
	variables: {
		count: 8,
		cursor: "from-page",
		scale: 2,
		search: null,
		id: "YXBwX2NvbGxlY3Rpb246MQ==",
	},
	asbdId: null,
};

function stateFor(h: Harness, stream: string): unknown {
	return h.emitted.find(
		(entry) =>
			entry.type === "STATE" &&
			(entry.message as { stream: string }).stream === stream,
	)?.message;
}

describe("collectFacebook", () => {
	it("walks friends from the preloaded first page to the source's end signal", async () => {
		const first = friendsPage(0, {
			end_cursor: "cursor-1",
			has_next_page: true,
		});
		const h = harness({
			streams: ["friends"],
			pages: {
				[ME]: meSnapshot,
				[FRIENDS_URL]: {
					landedUrl: FRIENDS_URL,
					scripts: [VIEWER_SCRIPT, preloaded("adp_f", { data: first.data })],
				},
			},
			captured: [FRIENDS_OP],
			replies: [
				response(
					friendsPage(1000, { end_cursor: "cursor-2", has_next_page: false }),
				),
			],
		});
		await collectFacebook(h.ctx, h.services);
		assert.deepEqual(h.failures, []);
		assert.equal(h.records.length, 6);
		assert.equal(h.calls.length, 1);
		const call = h.calls[0];
		assert.ok(call);
		assert.equal(call.docId, FRIENDS_OP.docId);
		assert.equal(graphqlPageCall(call).path, "/api/graphql/");
		assert.deepEqual(JSON.parse(call.variables), {
			...FRIENDS_OP.variables,
			cursor: "cursor-1",
		});
		assert.doesNotMatch(call.variables, /fb_dtsg|lsd/);
		const types = h.emitted.map((entry) => entry.type);
		assert.deepEqual(types.slice(-2), ["DETAIL_COVERAGE", "STATE"]);
		assert.deepEqual(stateFor(h, "friends"), {
			type: "STATE",
			stream: "friends",
			cursor: {},
		});
	});

	it("fails the stream as an outdated query when the page reveals no query, after scrolling for one", async () => {
		const h = harness({
			streams: ["friends"],
			pages: {
				[ME]: meSnapshot,
				[FRIENDS_URL]: {
					landedUrl: FRIENDS_URL,
					scripts: [
						preloaded("adp_f", {
							data: friendsPage(0, { end_cursor: "c1", has_next_page: true })
								.data,
						}),
					],
				},
			},
			replies: [],
		});
		await collectFacebook(h.ctx, h.services);
		assert.equal(h.failures.length, 1);
		assert.match(h.failures[0]?.message ?? "", /^facebook_query_outdated/);
		assert.equal(h.scrolls, 4);
		assert.equal(stateFor(h, "friends"), undefined);
		assert.equal(h.calls.length, 0);
	});

	it("does not claim completion when the cursor repeats", async () => {
		const h = harness({
			streams: ["friends"],
			pages: {
				[ME]: meSnapshot,
				[FRIENDS_URL]: {
					landedUrl: FRIENDS_URL,
					scripts: [
						preloaded("adp_f", {
							data: friendsPage(0, { end_cursor: "c1", has_next_page: true })
								.data,
						}),
					],
				},
			},
			captured: [FRIENDS_OP],
			replies: [
				response(friendsPage(1000, { end_cursor: "c1", has_next_page: true })),
			],
		});
		await collectFacebook(h.ctx, h.services);
		assert.match(
			h.failures[0]?.message ?? "",
			/^facebook_list_not_proven_complete: friends: the list repeated its cursor/,
		);
		assert.equal(stateFor(h, "friends"), undefined);
	});

	it("does not claim completion when a page lacks page_info", async () => {
		const page = friendsPage(1000, { end_cursor: "c2", has_next_page: false });
		delete (
			((page.data as JsonRecord).node as JsonRecord).pageItems as JsonRecord
		).page_info;
		const h = harness({
			streams: ["friends"],
			pages: {
				[ME]: meSnapshot,
				[FRIENDS_URL]: { landedUrl: FRIENDS_URL, scripts: [] },
			},
			captured: [FRIENDS_OP],
			replies: [response(page)],
		});
		await collectFacebook(h.ctx, h.services);
		assert.match(h.failures[0]?.message ?? "", /without an end signal/);
		assert.equal(stateFor(h, "friends"), undefined);
	});

	it("reads posts with a module-resolved query, keeps only the viewer's own, and saves the newest time", async () => {
		const timeline = loadFixture(TIMELINE);
		const units = ((timeline.data as JsonRecord).node as JsonRecord)
			.timeline_list_feed_units as JsonRecord;
		units.page_info = { end_cursor: null, has_next_page: false };
		const h = harness({
			streams: ["profile", "posts"],
			pages: { [ME]: meSnapshot },
			moduleDocIds: { ProfileCometTimelineFeedRefetchQuery: "9876543210123" },
			replies: [response(timeline)],
		});
		await collectFacebook(h.ctx, h.services);
		assert.deepEqual(h.failures, []);
		assert.deepEqual(
			h.records.map((record) => record.stream),
			["profile", "posts"],
		);
		const variables = JSON.parse(h.calls[0]?.variables ?? "{}") as JsonRecord;
		assert.equal(variables.id, TIMELINE_VIEWER);
		assert.equal(variables.cursor, null);
		assert.deepEqual(stateFor(h, "posts"), {
			type: "STATE",
			stream: "posts",
			cursor: { newest_create_time: "2022-03-04T15:07:37.000Z" },
		});
	});

	it("restarts from the top when the preloaded timeline has no end signal, without counting the first page twice", async () => {
		const first = loadFixture(TIMELINE);
		const page1 = loadFixture(TIMELINE);
		const units1 = ((page1.data as JsonRecord).node as JsonRecord)
			.timeline_list_feed_units as JsonRecord;
		units1.page_info = { end_cursor: "t1", has_next_page: true };
		const page2 = loadFixture(TIMELINE);
		const units2 = ((page2.data as JsonRecord).node as JsonRecord)
			.timeline_list_feed_units as JsonRecord;
		const node2 = ((units2.edges as JsonRecord[])[0] as JsonRecord)
			.node as JsonRecord;
		node2.post_id = "100012";
		node2.id = "UzpfSTEwMDAxMg==";
		node2.creation_time = 1_646_500_000;
		units2.page_info = { end_cursor: "t2", has_next_page: false };
		const h = harness({
			streams: ["posts"],
			pages: {
				[ME]: {
					...meSnapshot,
					scripts: [VIEWER_SCRIPT, preloaded("adp_tl", { data: first.data })],
				},
			},
			moduleDocIds: { ProfileCometTimelineFeedRefetchQuery: "9876543210123" },
			replies: [response(page1), response(page2)],
		});
		await collectFacebook(h.ctx, h.services);
		assert.deepEqual(h.failures, []);
		assert.deepEqual(
			h.records.map((record) => record.data.id),
			["100011", "100012"],
		);
		assert.deepEqual(
			h.calls.map((call) => (JSON.parse(call.variables) as JsonRecord).cursor),
			[null, "t1"],
		);
		assert.deepEqual(stateFor(h, "posts"), {
			type: "STATE",
			stream: "posts",
			cursor: { newest_create_time: "2022-03-05T17:06:40.000Z" },
		});
	});

	it("walks the activity log to its end even when a saved time is newer than the page (finding 1)", async () => {
		const page1 = loadFixture(ACTIVITY);
		const stories1 = ((page1.data as JsonRecord).node as JsonRecord)
			.activity_log_stories as JsonRecord;
		for (const [index, edge] of (stories1.edges as JsonRecord[]).entries()) {
			(edge.node as JsonRecord).id = `S:_I1:VK:${index}`;
		}
		stories1.page_info = { end_cursor: "a1", has_next_page: true };
		const page2 = loadFixture(ACTIVITY);
		const stories2 = ((page2.data as JsonRecord).node as JsonRecord)
			.activity_log_stories as JsonRecord;
		for (const [index, edge] of (stories2.edges as JsonRecord[]).entries()) {
			(edge.node as JsonRecord).id = `S:_I1:VK:${10 + index}`;
		}
		stories2.page_info = { end_cursor: "a2", has_next_page: false };
		const url = activityUrl(TIMELINE_VIEWER, "reaction");
		const h = harness({
			streams: ["reactions"],
			state: { reactions: { newest_time: "2030-01-01T00:00:00.000Z" } },
			pages: { [ME]: meSnapshot, [url]: { landedUrl: url, scripts: [] } },
			moduleDocIds: {
				CometActivityLogStoriesListPaginationQuery: "5555555555",
			},
			replies: [response(page1), response(page2)],
		});
		await collectFacebook(h.ctx, h.services);
		assert.deepEqual(h.failures, []);
		assert.equal(h.records.length, 6);
		assert.equal(
			h.calls.length,
			2,
			"followed has_next_page past the saved time",
		);
		assert.equal(
			(JSON.parse(h.calls[0]?.variables ?? "{}") as JsonRecord).category_key,
			"LIKEDPOSTS",
		);
		assert.deepEqual(stateFor(h, "reactions"), {
			type: "STATE",
			stream: "reactions",
			cursor: { newest_time: "2022-03-30T21:20:59.000Z" },
		});
	});

	it("re-reads old posts every run, so an edit to an old post is collected (finding 2)", async () => {
		const newer = loadFixture(TIMELINE);
		const newerUnits = ((newer.data as JsonRecord).node as JsonRecord)
			.timeline_list_feed_units as JsonRecord;
		newerUnits.page_info = { end_cursor: "t1", has_next_page: true };
		const older = loadFixture(TIMELINE);
		const olderUnits = ((older.data as JsonRecord).node as JsonRecord)
			.timeline_list_feed_units as JsonRecord;
		const node = ((olderUnits.edges as JsonRecord[])[0] as JsonRecord)
			.node as JsonRecord;
		node.post_id = "100012";
		node.id = "UzpfSTEwMDAxMg==";
		node.creation_time = 1_600_000_000;
		const story = ((node.comet_sections as JsonRecord).content as JsonRecord)
			.story as JsonRecord;
		story.post_id = "100012";
		story.message = { text: "Edited words" };
		olderUnits.page_info = { end_cursor: "t2", has_next_page: false };
		const h = harness({
			streams: ["posts"],
			state: { posts: { newest_create_time: "2022-03-20T00:00:00.000Z" } },
			pages: { [ME]: meSnapshot },
			moduleDocIds: { ProfileCometTimelineFeedRefetchQuery: "9876543210123" },
			replies: [response(newer), response(older)],
		});
		await collectFacebook(h.ctx, h.services);
		assert.deepEqual(h.failures, []);
		assert.equal(h.calls.length, 2, "walked past the saved creation time");
		assert.equal(
			h.records.find((record) => record.data.id === "100012")?.data.text,
			"Edited words",
		);
	});

	it("ends the whole run on a rate limit", async () => {
		const h = harness({
			streams: ["friends", "groups"],
			pages: {
				[ME]: meSnapshot,
				[FRIENDS_URL]: { landedUrl: FRIENDS_URL, scripts: [] },
			},
			captured: [FRIENDS_OP],
			replies: [response("", 429)],
		});
		await assert.rejects(
			collectFacebook(h.ctx, h.services),
			/^Error: facebook_rate_limited/,
		);
		assert.equal(
			h.opened.includes("https://www.facebook.com/groups/joins/"),
			false,
		);
	});

	it("fails as signed out when the page shows no person", async () => {
		const h = harness({
			streams: ["profile"],
			pages: { [ME]: { landedUrl: ME, scripts: [] } },
			replies: [],
		});
		await assert.rejects(
			collectFacebook(h.ctx, h.services),
			/^Error: facebook_auth_failed/,
		);
	});
});

describe("mobile host", () => {
	it("does not scroll for a request it cannot see, and takes the query id from the page's modules", async () => {
		const h = harness({
			streams: ["friends"],
			pages: {
				[ME]: meSnapshot,
				[FRIENDS_URL]: {
					landedUrl: FRIENDS_URL,
					scripts: [
						preloaded("adp_f", {
							data: friendsPage(0, { end_cursor: "c1", has_next_page: true })
								.data,
						}),
					],
				},
			},
			moduleDocIds: { [FRIENDS_OP.friendlyName]: FRIENDS_OP.docId },
			replies: [
				response(friendsPage(1000, { end_cursor: "c2", has_next_page: false })),
			],
		});
		h.services.observesRequests = false;
		await collectFacebook(h.ctx, h.services);
		assert.deepEqual(h.failures, []);
		assert.equal(h.scrolls, 0);
		assert.equal(h.records.length, 6);
		assert.equal(h.calls[0]?.docId, FRIENDS_OP.docId);
	});
});

describe("page functions", () => {
	it("stay self-contained when serialized into the page", () => {
		for (const [name, fn] of Object.entries(PAGE_FUNCTIONS)) {
			const source = fn.toString();
			assert.doesNotMatch(
				source,
				/__name|__publicField|_\$\w+\(/,
				`${name} carries a Node-only helper`,
			);
			assert.doesNotThrow(
				() => new Function(`return (${source});`),
				`${name} reparses on its own`,
			);
		}
	});

	it("blank the page's tokens before scripts leave the page", () => {
		const fake = {
			querySelectorAll: () => [
				{
					textContent:
						'{"x":["DTSGInitialData",[],{"token":"SECRET1"}],"y":"RelayPrefetchedStreamCache"}',
				},
				{ textContent: '{"unrelated":true}' },
			],
		};
		const saved = globalThis.document;
		Object.defineProperty(globalThis, "document", {
			value: fake,
			configurable: true,
		});
		try {
			const out = PAGE_FUNCTIONS.readScriptsInPage({
				markers: ["RelayPrefetchedStreamCache"],
				secretKeys: ["token"],
			});
			assert.equal(out.length, 1);
			assert.doesNotMatch(out[0] ?? "", /SECRET1/);
			assert.deepEqual(JSON.parse(out[0] ?? ""), {
				x: ["DTSGInitialData", [], { token: "" }],
				y: "RelayPrefetchedStreamCache",
			});
		} finally {
			Object.defineProperty(globalThis, "document", {
				value: saved,
				configurable: true,
			});
		}
	});
});

const never = <T>(): Promise<T> => new Promise<T>(() => undefined);
const SHORT: PageDeadlines = {
	open: 50,
	graphql: 50,
	resolveModule: 50,
	scroll: 50,
};

describe("bounded waits", () => {
	it("fails a stream whose query never answers as a page timeout and moves on to the next stream", async () => {
		const groupsUrl = "https://www.facebook.com/groups/joins/";
		const h = harness({
			streams: ["friends", "groups"],
			pages: {
				[ME]: meSnapshot,
				[FRIENDS_URL]: { landedUrl: FRIENDS_URL, scripts: [] },
				[groupsUrl]: { landedUrl: groupsUrl, scripts: [] },
			},
			captured: [FRIENDS_OP],
			replies: [],
		});
		h.services.graphql = () => never();
		await collectFacebook(h.ctx, h.services, SHORT);
		assert.equal(h.failures[0]?.stream, "friends");
		assert.match(h.failures[0]?.message ?? "", /^facebook_page_timeout/);
		assert.ok(h.opened.includes(groupsUrl), "the next stream still ran");
		assert.equal(h.failures[1]?.stream, "groups");
		assert.match(h.failures[1]?.message ?? "", /^facebook_query_outdated/);
	});

	it("fails as an outdated query when the query lookup in the page hangs", async () => {
		const h = harness({
			streams: ["friends"],
			pages: {
				[ME]: meSnapshot,
				[FRIENDS_URL]: { landedUrl: FRIENDS_URL, scripts: [] },
			},
			replies: [],
		});
		h.services.resolveModule = () => never();
		await collectFacebook(h.ctx, h.services, SHORT);
		assert.match(
			h.failures[0]?.message ?? "",
			/^facebook_query_outdated: .* could not be found in the page in time/,
		);
		assert.equal(
			h.scrolls,
			4,
			"scrolling for the page's own request is bounded",
		);
	});

	it("bounds a page that never finishes opening", async () => {
		const h = harness({
			streams: ["friends", "reactions"],
			pages: { [ME]: meSnapshot },
			replies: [],
		});
		const open = h.services.open;
		h.services.open = (url) => (url === ME ? open(url) : never());
		await collectFacebook(h.ctx, h.services, SHORT);
		assert.deepEqual(
			h.failures.map((failure) => failure.stream),
			["friends", "reactions"],
		);
		for (const failure of h.failures)
			assert.match(failure.message, /^facebook_page_timeout: opening/);
	});

	it("bounds the first page too, ending the run with an error instead of hanging", async () => {
		const h = harness({ streams: ["profile"], pages: {}, replies: [] });
		h.services.open = () => never();
		await assert.rejects(
			collectFacebook(h.ctx, h.services, SHORT),
			/^Error: facebook_page_timeout/,
		);
		assert.equal(h.tickers[0]?.stopped, true);
	});

	it("sends a heartbeat PROGRESS naming the current step, and stops it when the run ends", async () => {
		const h = harness({
			streams: ["profile"],
			pages: { [ME]: meSnapshot },
			replies: [],
		});
		await collectFacebook(h.ctx, h.services, SHORT);
		const ticker = h.tickers[0];
		assert.ok(ticker);
		assert.ok(ticker.ms <= 30_000 && ticker.ms === HEARTBEAT_MS);
		assert.equal(ticker.stopped, true);
		ticker.tick();
		await Promise.resolve();
		assert.equal(h.progress.at(-1), "Reading your Facebook profile");
	});

	it("gives up on a sign-in probe that hangs", async () => {
		const page = {
			url: () => "https://www.facebook.com/",
			evaluate: () => never(),
		};
		const context = {
			cookies: async () => [
				{ name: "c_user", value: "1" },
				{ name: "xs", value: "x" },
			],
		};
		const started = Date.now();
		const live = await probeFacebookSession({ context, page } as never, 50);
		assert.equal(live, false);
		assert.ok(Date.now() - started < 2000);
	});
});

describe("main-world evaluation", () => {
	it("asks Patchright for the main world, where Facebook's require lives", async () => {
		const seen: unknown[][] = [];
		const page = {
			evaluate: (...args: unknown[]) => {
				seen.push(args);
				return Promise.resolve("100476");
			},
		};
		const result = await evaluateInMainWorld(
			page as never,
			PAGE_FUNCTIONS.viewerIdInPage,
			undefined,
		);
		assert.equal(result, "100476");
		assert.equal(seen[0]?.[3], false);
	});

	it("reads the viewer from server-rendered data when require is not visible", () => {
		const fake = {
			querySelectorAll: () => [
				{
					textContent:
						'{"define":[["CurrentUserInitialData",[],{"USER_ID":"100476"},270]]}',
				},
			],
		};
		const saved = globalThis.document;
		Object.defineProperty(globalThis, "document", {
			value: fake,
			configurable: true,
		});
		try {
			assert.equal(PAGE_FUNCTIONS.viewerIdInPage(), "100476");
		} finally {
			Object.defineProperty(globalThis, "document", {
				value: saved,
				configurable: true,
			});
		}
	});
});

describe("review round 1", () => {
	it("fails the stream instead of nulling text Facebook sent as binary (finding 3)", async () => {
		const page = loadFixture(ACTIVITY);
		const stories = ((page.data as JsonRecord).node as JsonRecord)
			.activity_log_stories as JsonRecord;
		for (const [index, edge] of (stories.edges as JsonRecord[]).entries()) {
			(edge.node as JsonRecord).id = `S:_I1:VK:${index}`;
		}
		((stories.edges as JsonRecord[])[0]?.node as JsonRecord).message = {
			text: "bad\u0000bytes",
		};
		stories.page_info = { end_cursor: null, has_next_page: false };
		const url = activityUrl(TIMELINE_VIEWER, "comment");
		const h = harness({
			streams: ["comments"],
			pages: { [ME]: meSnapshot, [url]: { landedUrl: url, scripts: [] } },
			moduleDocIds: {
				CometActivityLogStoriesListPaginationQuery: "5555555555",
			},
			replies: [response(page)],
		});
		await collectFacebook(h.ctx, h.services);
		assert.match(h.failures[0]?.message ?? "", /^facebook_unsafe_text/);
		assert.equal(stateFor(h, "comments"), undefined);
	});

	it("fails the stream when a GraphQL error nulled a field a record is built from (finding 4)", async () => {
		const page = loadFixture(TIMELINE);
		const units = ((page.data as JsonRecord).node as JsonRecord)
			.timeline_list_feed_units as JsonRecord;
		units.page_info = { end_cursor: null, has_next_page: false };
		page.errors = [
			{
				message: "A server error field_exception occured.",
				severity: "ERROR",
				path: [
					"node",
					"timeline_list_feed_units",
					"edges",
					0,
					"node",
					"comet_sections",
					"content",
					"story",
					"message",
				],
			},
		];
		const h = harness({
			streams: ["posts"],
			pages: { [ME]: meSnapshot },
			moduleDocIds: { ProfileCometTimelineFeedRefetchQuery: "9876543210123" },
			replies: [response(page)],
		});
		await collectFacebook(h.ctx, h.services);
		assert.match(
			h.failures[0]?.message ?? "",
			/Facebook reported errors on 1 item/,
		);
		assert.equal(stateFor(h, "posts"), undefined);
	});

	it("tolerates the live activity log's errors on privacy fields the records never read (finding 4)", async () => {
		const page = loadFixture(ACTIVITY);
		const stories = ((page.data as JsonRecord).node as JsonRecord)
			.activity_log_stories as JsonRecord;
		for (const [index, edge] of (stories.edges as JsonRecord[]).entries()) {
			(edge.node as JsonRecord).id = `S:_I1:VK:${index}`;
		}
		stories.page_info = { end_cursor: null, has_next_page: false };
		page.errors = (page.errors as JsonRecord[]).map((error, index) => ({
			...error,
			path: [
				"node",
				"activity_log_stories",
				"edges",
				index,
				"node",
				"privacy_scope",
				"label",
			],
		}));
		const url = activityUrl(TIMELINE_VIEWER, "reaction");
		const h = harness({
			streams: ["reactions"],
			pages: { [ME]: meSnapshot, [url]: { landedUrl: url, scripts: [] } },
			moduleDocIds: {
				CometActivityLogStoriesListPaginationQuery: "5555555555",
			},
			replies: [response(page)],
		});
		await collectFacebook(h.ctx, h.services);
		assert.deepEqual(h.failures, []);
		assert.equal(h.records.length, 3);
	});

	it("fails the profile when the page did not include the intro card (finding 5)", async () => {
		const h = harness({
			streams: ["profile"],
			pages: { [ME]: { ...meSnapshot, scripts: [VIEWER_SCRIPT] } },
			replies: [],
		});
		await collectFacebook(h.ctx, h.services);
		assert.equal(h.records.length, 0);
		assert.match(h.failures[0]?.message ?? "", /intro card/);
	});

	it("does not emit friend suggestions next to the friends list (finding 6)", async () => {
		const friends = friendsPage(0, { end_cursor: null, has_next_page: false });
		const suggestions = friendsPage(5000, {
			end_cursor: null,
			has_next_page: false,
		});
		const items = ((suggestions.data as JsonRecord).node as JsonRecord)
			.pageItems as JsonRecord;
		const longer = [
			...(items.edges as JsonRecord[]),
			...structuredClone(items.edges as JsonRecord[]),
		];
		for (const [index, edge] of longer.entries()) {
			const node = edge.node as JsonRecord;
			(node.node as JsonRecord).id = String(900_000 + index);
			node.id = `suggestion-${index}`;
			(
				(node.actions_renderer as JsonRecord).action as JsonRecord
			).profile_owner = {
				id: String(900_000 + index),
				name: "Someone",
				friendship_status: "CAN_REQUEST",
			};
			const handler = (
				((node.actions_renderer as JsonRecord).action as JsonRecord)
					.client_handler as JsonRecord
			).profile_action as JsonRecord;
			(handler.restrictable_profile_owner as JsonRecord).friendship_status =
				"CAN_REQUEST";
		}
		items.edges = longer;
		const scripts = [
			preloaded("adp_friends", { data: friends.data }),
			preloaded("adp_suggestions", { data: { suggestions: suggestions.data } }),
		];
		const h = harness({
			streams: ["friends"],
			pages: {
				[ME]: meSnapshot,
				[FRIENDS_URL]: { landedUrl: FRIENDS_URL, scripts },
			},
			replies: [],
		});
		await collectFacebook(h.ctx, h.services);
		assert.deepEqual(h.failures, []);
		assert.equal(h.records.length, 3, "the three confirmed friends");
		for (const record of h.records)
			assert.ok(Number(record.data.id) < 900_000, "no suggestion emitted");
		assert.equal(
			h.records.length,
			new Set(h.records.map((record) => record.data.id)).size,
		);
	});

	it("refuses to guess between a joined-groups list and recommendations (finding 7)", async () => {
		const group = (id: number) => ({
			node: {
				id: String(id),
				name: `Group ${id}`,
				url: `https://www.facebook.com/groups/${id}/`,
			},
		});
		const scripts = [
			preloaded("adp_g", {
				data: {
					viewer: {
						tab_groups_list: {
							edges: [group(1), group(2)],
							page_info: { end_cursor: null, has_next_page: false },
						},
						recommended: {
							edges: [group(3), group(4), group(5)],
							page_info: { end_cursor: null, has_next_page: false },
						},
					},
				},
			}),
		];
		const url = "https://www.facebook.com/groups/joins/";
		const h = harness({
			streams: ["groups"],
			pages: { [ME]: meSnapshot, [url]: { landedUrl: url, scripts } },
			replies: [],
		});
		await collectFacebook(h.ctx, h.services);
		assert.equal(h.records.length, 0);
		assert.match(h.failures[0]?.message ?? "", /refusing to guess/);
	});

	it("takes the list whose path names a membership when one does (finding 7)", async () => {
		const group = (id: number) => ({
			node: {
				id: String(id),
				name: `Group ${id}`,
				url: `https://www.facebook.com/groups/${id}/`,
			},
		});
		const scripts = [
			preloaded("adp_g", {
				data: {
					viewer: {
						all_joined_groups: {
							edges: [group(1), group(2)],
							page_info: { end_cursor: null, has_next_page: false },
						},
						recommended: {
							edges: [group(3), group(4), group(5)],
							page_info: { end_cursor: null, has_next_page: false },
						},
					},
				},
			}),
		];
		const url = "https://www.facebook.com/groups/joins/";
		const h = harness({
			streams: ["groups"],
			pages: { [ME]: meSnapshot, [url]: { landedUrl: url, scripts } },
			replies: [],
		});
		await collectFacebook(h.ctx, h.services);
		assert.deepEqual(h.failures, []);
		assert.deepEqual(
			h.records.map((record) => record.data.id),
			["1", "2"],
		);
	});

	it("completes an empty friends list shown in the profile's FRIENDS section (finding 8)", async () => {
		const scripts = [
			preloaded("adp_f", {
				data: {
					user: {
						timeline_nav_app_sections: {
							edges: [
								{
									node: {
										section_type: "FRIENDS",
										all_collections: {
											edges: [
												{
													node: {
														style_renderer: {
															collection: {
																id: "YXBwX2NvbGxlY3Rpb246MQ==",
																pageItems: {
																	edges: [],
																	page_info: {
																		end_cursor: null,
																		has_next_page: false,
																	},
																},
															},
														},
													},
												},
											],
										},
									},
								},
							],
						},
					},
				},
			}),
		];
		const h = harness({
			streams: ["friends"],
			pages: {
				[ME]: meSnapshot,
				[FRIENDS_URL]: { landedUrl: FRIENDS_URL, scripts },
			},
			replies: [],
		});
		await collectFacebook(h.ctx, h.services);
		assert.deepEqual(h.failures, []);
		assert.equal(h.records.length, 0);
		assert.deepEqual(stateFor(h, "friends"), {
			type: "STATE",
			stream: "friends",
			cursor: {},
		});
		const coverage = h.emitted.find((entry) => entry.type === "DETAIL_COVERAGE")
			?.message as JsonRecord;
		assert.equal(coverage.considered, 0);
	});

	it("emits a post once when the timeline shows it twice under different wrappers (finding 9)", async () => {
		const page = loadFixture(TIMELINE);
		const units = ((page.data as JsonRecord).node as JsonRecord)
			.timeline_list_feed_units as JsonRecord;
		const edges = units.edges as JsonRecord[];
		const copy = structuredClone(edges[0] as JsonRecord);
		(copy.node as JsonRecord).id = "UzpfSTpinnedcopy";
		edges.push(copy);
		units.page_info = { end_cursor: null, has_next_page: false };
		const h = harness({
			streams: ["posts"],
			pages: { [ME]: meSnapshot },
			moduleDocIds: { ProfileCometTimelineFeedRefetchQuery: "9876543210123" },
			replies: [response(page)],
		});
		await collectFacebook(h.ctx, h.services);
		assert.deepEqual(h.failures, []);
		assert.equal(h.records.length, 1);
	});

	it("ends the whole run on a real 5xx instead of opening the next pages (finding 11)", async () => {
		const h = harness({
			streams: ["friends", "groups"],
			pages: {
				[ME]: meSnapshot,
				[FRIENDS_URL]: { landedUrl: FRIENDS_URL, scripts: [] },
			},
			captured: [FRIENDS_OP],
			replies: [response({ error: "internal" }, 500)],
		});
		await assert.rejects(
			collectFacebook(h.ctx, h.services),
			/^Error: facebook_http_5xx/,
		);
		assert.equal(
			h.opened.includes("https://www.facebook.com/groups/joins/"),
			false,
		);
	});

	it("on the mobile host, a multi-page joined-groups list fails visibly as an outdated query (finding 12)", async () => {
		const group = (id: number) => ({
			node: {
				id: String(id),
				name: `Group ${id}`,
				url: `https://www.facebook.com/groups/${id}/`,
			},
		});
		const scripts = [
			preloaded("adp_g", {
				data: {
					viewer: {
						all_joined_groups: {
							edges: [group(1)],
							page_info: { end_cursor: "g1", has_next_page: true },
						},
					},
				},
			}),
		];
		const url = "https://www.facebook.com/groups/joins/";
		const h = harness({
			streams: ["groups"],
			pages: { [ME]: meSnapshot, [url]: { landedUrl: url, scripts } },
			replies: [],
		});
		h.services.observesRequests = false;
		await collectFacebook(h.ctx, h.services);
		assert.match(h.failures[0]?.message ?? "", /^facebook_query_outdated/);
		assert.equal(stateFor(h, "groups"), undefined);
		assert.equal(h.scrolls, 0);
	});

	it("fails when a continuation says more follows but brings nothing (P3)", async () => {
		const h = harness({
			streams: ["friends"],
			pages: {
				[ME]: meSnapshot,
				[FRIENDS_URL]: {
					landedUrl: FRIENDS_URL,
					scripts: [
						preloaded("adp_f", {
							data: friendsPage(0, { end_cursor: "c1", has_next_page: true })
								.data,
						}),
					],
				},
			},
			captured: [FRIENDS_OP],
			replies: [
				response({
					data: {
						node: {
							id: (
								(
									friendsPage(0, { end_cursor: null, has_next_page: false })
										.data as JsonRecord
								).node as JsonRecord
							).id,
							pageItems: {
								edges: [],
								page_info: { end_cursor: "c2", has_next_page: true },
							},
						},
					},
				}),
			],
		});
		await collectFacebook(h.ctx, h.services);
		assert.match(
			h.failures[0]?.message ?? "",
			/said more follows but added nothing new/,
		);
		assert.equal(stateFor(h, "friends"), undefined);
	});
});
