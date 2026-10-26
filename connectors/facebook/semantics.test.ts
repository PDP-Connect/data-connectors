// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PDPP grant semantics: `time_range` and `resources` narrow the walk at the
 * source, the runtime's own record gate still decides what is delivered, and
 * the manifest says what the code does. Records pass through the runtime's
 * real `makeEmitRecord`, so window and resource filtering here is the
 * runtime's, not a test double's.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
	consentTimeFieldResolver,
	makeEmitRecord,
	withholdsBoundedProgress,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import {
	activityUrl,
	type CollectorContext,
	collectFacebook,
	type FacebookServices,
	type GraphqlCall,
	OLDER_ITEMS_TO_STOP,
	type PageGraphqlResult,
	type PageSnapshot,
	PUSHED_BOUND_SLACK_SECONDS,
	streamFailureHint,
} from "./collect.ts";
import { probeFacebookSession } from "./index.ts";
import {
	asRecord,
	type CapturedOperation,
	ERROR_CLASSES,
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

// ─── Page and source doubles ────────────────────────────────────────────

const ME = "https://www.facebook.com/me";
const FRIENDS_URL = "https://www.facebook.com/me/friends_all";
const TIMELINE_QUERY = "ProfileCometTimelineFeedRefetchQuery";
const ACTIVITY_QUERY = "CometActivityLogStoriesListPaginationQuery";
const FRIENDS_QUERY =
	"ProfileCometAppCollectionSelfFriendsListRendererPaginationQuery";

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

/** Noon UTC on a day of January 2024, in epoch seconds. */
const day = (n: number): number => Date.UTC(2024, 0, n, 12) / 1000;
/** Midnight UTC starting a day of January 2024, as RFC 3339. */
const dayStart = (n: number): string =>
	new Date(Date.UTC(2024, 0, n)).toISOString();

interface Item {
	id: string;
	time: number;
}

/** Ids and times for `count` items, one a day, newest first. */
function daily(count: number, id: (n: number) => string): Item[] {
	return Array.from({ length: count }, (_, index) => {
		const n = count - index;
		return { id: id(n), time: day(n) };
	});
}

const postId = (n: number): string => String(200_000 + n);
const activityId = (n: number): string => `S:_I1:VK:${n}`;

function timelinePage(
	items: readonly Item[],
	pageInfo: JsonRecord,
): JsonRecord {
	const page = loadFixture(TIMELINE);
	const units = asRecord(
		asRecord(asRecord(page.data)?.node)?.timeline_list_feed_units,
	);
	assert.ok(units && Array.isArray(units.edges));
	const template = JSON.stringify(units.edges[0]);
	units.edges = items.map((item) => {
		const edge = JSON.parse(template) as JsonRecord;
		const node = asRecord(edge.node);
		assert.ok(node);
		node.post_id = item.id;
		node.id = `unit-${item.id}`;
		node.creation_time = item.time;
		const story = asRecord(
			asRecord(asRecord(node.comet_sections)?.content)?.story,
		);
		if (story) story.post_id = item.id;
		const stamp = asRecord(
			asRecord(asRecord(node.comet_sections)?.timestamp)?.story,
		);
		if (stamp) stamp.creation_time = item.time;
		return edge;
	});
	units.page_info = pageInfo;
	return page;
}

function activityPage(
	items: readonly Item[],
	pageInfo: JsonRecord,
): JsonRecord {
	const page = loadFixture(ACTIVITY);
	delete page.errors;
	const stories = asRecord(
		asRecord(asRecord(page.data)?.node)?.activity_log_stories,
	);
	assert.ok(stories && Array.isArray(stories.edges));
	const template = JSON.stringify(stories.edges[0]);
	stories.edges = items.map((item) => {
		const edge = JSON.parse(template) as JsonRecord;
		const node = asRecord(edge.node);
		assert.ok(node);
		node.id = item.id;
		node.creation_time = item.time;
		return edge;
	});
	stories.page_info = pageInfo;
	return page;
}

type DateHandling = "honors" | "ignores" | "empties" | "rejects";

/**
 * A newest-first list served `size` items a page with numeric cursors, as
 * the source pages it. `dates` says what the source does with `afterTime`
 * and `beforeTime`: applies them, ignores them, answers nothing for them, or
 * fails the query.
 */
function listSource(
	items: readonly Item[],
	size: number,
	build: (items: readonly Item[], pageInfo: JsonRecord) => JsonRecord,
	dates: DateHandling = "honors",
) {
	return (variables: JsonRecord): JsonRecord => {
		const after = variables.afterTime;
		const before = variables.beforeTime;
		const dated = typeof after === "number" || typeof before === "number";
		if (dated && dates === "rejects")
			return {
				errors: [{ message: "Variable beforeTime got an invalid value" }],
			};
		let list = [...items];
		if (dated && dates === "empties") list = [];
		if (dated && dates === "honors")
			list = list.filter(
				(item) =>
					(typeof after !== "number" || item.time >= after) &&
					(typeof before !== "number" || item.time < before),
			);
		const start = variables.cursor === null ? 0 : Number(variables.cursor);
		const end = start + size;
		return build(list.slice(start, end), {
			end_cursor: String(end),
			has_next_page: end < list.length,
		});
	};
}

function response(body: unknown): PageGraphqlResult {
	return {
		kind: "response",
		status: 200,
		url: `https://www.facebook.com${GRAPHQL_PATH}`,
		contentType: "text/html; charset=utf-8",
		mitigated: null,
		text: `for (;;);${JSON.stringify(body)}`,
	};
}

interface Scope {
	resources?: string[];
	time_range?: { since?: string; until?: string };
}

interface Run {
	calls: GraphqlCall[];
	ctx: CollectorContext;
	emitted: JsonRecord[];
	failures: { message: string; options: unknown; stream: string }[];
	services: FacebookServices;
}

/** Records the runtime delivered for a stream, by id. */
function delivered(run: Run, stream: string): string[] {
	return run.emitted
		.filter((m) => m.type === "RECORD" && m.stream === stream)
		.map((m) => String(m.key));
}

function stateOf(run: Run, stream: string): JsonRecord | undefined {
	return run.emitted.find((m) => m.type === "STATE" && m.stream === stream);
}

function variablesOf(call: GraphqlCall | undefined): JsonRecord {
	return JSON.parse(call?.variables ?? "{}") as JsonRecord;
}

function runOf(args: {
	captured?: CapturedOperation[];
	pages: Record<string, PageSnapshot>;
	scopes: Record<string, Scope>;
	sources: Record<string, (variables: JsonRecord) => JsonRecord>;
	state?: Record<string, unknown> | undefined;
}): Run {
	const requested = new Map(
		Object.entries(args.scopes).map(([name, scope]) => [
			name,
			{ name, ...scope },
		]),
	);
	const run: Run = {
		calls: [],
		emitted: [],
		failures: [],
		ctx: undefined as never,
		services: {
			open: async (url) => {
				const page = args.pages[url];
				if (!page) throw new Error(`unexpected navigation to ${url}`);
				return page;
			},
			scroll: async () => undefined,
			takeCaptured: (spec) =>
				args.captured?.find((op) => operationMatches(spec, op.friendlyName)) ??
				null,
			resolveModule: async (name) => ({
				docId: name in args.sources ? "9876543210123" : null,
				provided: {},
			}),
			graphql: async (call) => {
				run.calls.push(call);
				const source = args.sources[call.friendlyName];
				if (!source) throw new Error(`no source for ${call.friendlyName}`);
				return response(source(JSON.parse(call.variables) as JsonRecord));
			},
			sleep: async () => undefined,
			random: () => 0.5,
			observesRequests: true,
			every: () => () => undefined,
		},
	};
	const gate = makeEmitRecord({
		requested,
		emit: async (message) => {
			run.emitted.push(message as unknown as JsonRecord);
		},
		emittedAt: "2026-10-26T00:00:00.000Z",
		validateRecord,
		isTombstone: undefined,
		timeRangeFieldFor: consentTimeFieldResolver("facebook"),
	});
	run.ctx = {
		emit: async (message) => {
			// As the runtime does: no checkpoint after a record at or after `until` was withheld.
			if (withholdsBoundedProgress(message, gate.withheldAtOrAfterUntil))
				return;
			run.emitted.push(message as unknown as JsonRecord);
		},
		emitRecord: gate.emit,
		isRecordSelected: gate.isSelected,
		progress: async () => undefined,
		reportStreamFailure: async (stream, message, options) => {
			run.failures.push({ stream, message, options });
		},
		requested,
		state: args.state ?? {},
	};
	return run;
}

const meSnapshot = (timeline: JsonRecord | null): PageSnapshot => ({
	landedUrl: "https://www.facebook.com/ada.example",
	scripts: [
		VIEWER_SCRIPT,
		...(timeline ? [preloaded("adp_tl", { data: timeline.data })] : []),
	],
});

const POSTS = daily(30, postId);
const POST_PAGE = 3;

/** The posts stream over a 30-post timeline, three posts a page, first page server-rendered. */
function postsRun(
	scope: Scope,
	dates: DateHandling = "honors",
	state?: Record<string, unknown>,
): Run {
	const source = listSource(POSTS, POST_PAGE, timelinePage, dates);
	return runOf({
		scopes: { posts: scope },
		pages: { [ME]: meSnapshot(source({ cursor: null })) },
		sources: { [TIMELINE_QUERY]: source },
		state,
	});
}

const ids = (from: number, to: number): string[] =>
	Array.from({ length: to - from + 1 }, (_, index) => postId(to - index));

/** Pages the plain walk of all 30 posts asks for after the server-rendered first one. */
const FULL_POST_CALLS = POSTS.length / POST_PAGE - 1;

// ─── time_range on posts ────────────────────────────────────────────────

describe("posts under time_range", () => {
	it("stops paging past since, once a run of older posts closes a page", async () => {
		const run = postsRun({ time_range: { since: dayStart(25) } });
		await collectFacebook(run.ctx, run.services);
		assert.deepEqual(run.failures, []);
		assert.deepEqual(delivered(run, "posts"), ids(25, 30));
		// Pages: 30-28 (rendered), 27-25, then 24-22, 21-19, 18-16 make nine older posts.
		assert.equal(run.calls.length, 4);
		assert.ok(run.calls.length < FULL_POST_CALLS);
		assert.equal(OLDER_ITEMS_TO_STOP.posts, 9);
		assert.deepEqual(stateOf(run, "posts")?.cursor, {});
	});

	it("does not stop on one old post out of order", async () => {
		const items = [...POSTS];
		// A back-dated post high on the timeline, then newer posts again.
		items.splice(2, 0, { id: postId(99), time: day(1) - 86_400 * 400 });
		const source = listSource(items, POST_PAGE, timelinePage);
		const run = runOf({
			scopes: { posts: { time_range: { since: dayStart(25) } } },
			pages: { [ME]: meSnapshot(source({ cursor: null })) },
			sources: { [TIMELINE_QUERY]: source },
		});
		await collectFacebook(run.ctx, run.services);
		assert.deepEqual(run.failures, []);
		assert.deepEqual(delivered(run, "posts"), ids(25, 30));
	});

	it("sends until in the timeline's own beforeTime, a day wide, and starts at the query's first page", async () => {
		const until = dayStart(6);
		const run = postsRun({ time_range: { until } });
		await collectFacebook(run.ctx, run.services);
		assert.deepEqual(run.failures, []);
		assert.deepEqual(delivered(run, "posts"), ids(1, 5));
		const first = variablesOf(run.calls[0]);
		assert.equal(first.cursor, null);
		assert.equal(
			first.beforeTime,
			Date.parse(until) / 1000 + PUSHED_BOUND_SLACK_SECONDS,
		);
		assert.equal(first.afterTime, null);
		// Six posts before the widened bound: two pages, not the whole timeline.
		assert.equal(run.calls.length, 2);
		// The post on the bound's day was withheld at until, so no checkpoint is saved.
		assert.equal(stateOf(run, "posts"), undefined);
	});

	it("sends since and until together and reads only the window", async () => {
		const since = dayStart(10);
		const until = dayStart(16);
		const run = postsRun({ time_range: { since, until } });
		await collectFacebook(run.ctx, run.services);
		assert.deepEqual(run.failures, []);
		assert.deepEqual(delivered(run, "posts"), ids(10, 15));
		const first = variablesOf(run.calls[0]);
		assert.equal(
			first.afterTime,
			Date.parse(since) / 1000 - PUSHED_BOUND_SLACK_SECONDS,
		);
		assert.equal(
			first.beforeTime,
			Date.parse(until) / 1000 + PUSHED_BOUND_SLACK_SECONDS,
		);
		assert.equal(run.calls.length, 3);
	});

	it("is still right when the source ignores the date variables", async () => {
		const run = postsRun(
			{ time_range: { since: dayStart(10), until: dayStart(16) } },
			"ignores",
		);
		await collectFacebook(run.ctx, run.services);
		assert.deepEqual(run.failures, []);
		assert.deepEqual(delivered(run, "posts"), ids(10, 15));
	});

	it("walks without the date variables when the dated walk brings nothing", async () => {
		const run = postsRun({ time_range: { until: dayStart(6) } }, "empties");
		await collectFacebook(run.ctx, run.services);
		assert.deepEqual(run.failures, []);
		assert.deepEqual(delivered(run, "posts"), ids(1, 5));
		assert.equal(
			run.calls.some((call) => variablesOf(call).beforeTime === null),
			true,
		);
	});

	it("walks without the date variables when the dated query fails", async () => {
		const run = postsRun(
			{ time_range: { since: dayStart(10), until: dayStart(16) } },
			"rejects",
		);
		await collectFacebook(run.ctx, run.services);
		assert.deepEqual(run.failures, []);
		assert.deepEqual(delivered(run, "posts"), ids(10, 15));
	});

	it("never sends a date variable the query does not declare", async () => {
		const source = listSource(POSTS, POST_PAGE, timelinePage);
		const run = runOf({
			scopes: { posts: { time_range: { until: dayStart(6) } } },
			pages: { [ME]: meSnapshot(source({ cursor: null })) },
			sources: { [TIMELINE_QUERY]: source },
			captured: [
				{
					friendlyName: TIMELINE_QUERY,
					docId: "1234567890123",
					variables: { count: 3, cursor: "x", id: TIMELINE_VIEWER },
					asbdId: null,
				},
			],
		});
		await collectFacebook(run.ctx, run.services);
		assert.deepEqual(run.failures, []);
		assert.deepEqual(delivered(run, "posts"), ids(1, 5));
		for (const call of run.calls) {
			assert.equal("beforeTime" in variablesOf(call), false);
			assert.equal("afterTime" in variablesOf(call), false);
		}
	});
});

// ─── narrow, then wide ──────────────────────────────────────────────────

describe("a narrow run never shortens a later wide one", () => {
	for (const narrow of [
		{ since: dayStart(25) },
		{ until: dayStart(6) },
		{ since: dayStart(10), until: dayStart(16) },
	]) {
		it(`posts: ${JSON.stringify(narrow)} then no time range`, async () => {
			const first = postsRun({ time_range: narrow });
			await collectFacebook(first.ctx, first.services);
			assert.deepEqual(first.failures, []);
			const saved = stateOf(first, "posts");
			const wide = postsRun({}, "honors", saved ? { posts: saved.cursor } : {});
			await collectFacebook(wide.ctx, wide.services);
			assert.deepEqual(wide.failures, []);
			assert.deepEqual(delivered(wide, "posts"), ids(1, 30));
		});
	}

	it("reactions: since then no time range", async () => {
		const narrow = activityRun({ time_range: { since: dayStart(50) } });
		await collectFacebook(narrow.ctx, narrow.services);
		const saved = stateOf(narrow, "reactions");
		const wide = activityRun({}, saved ? { reactions: saved.cursor } : {});
		await collectFacebook(wide.ctx, wide.services);
		assert.deepEqual(wide.failures, []);
		assert.equal(delivered(wide, "reactions").length, ACTIVITY_ITEMS.length);
	});
});

// ─── time_range on the activity log ─────────────────────────────────────

const ACTIVITY_ITEMS = daily(90, activityId);
const ACTIVITY_PAGE = 10;

function activityRun(
	scope: Scope,
	state?: Record<string, unknown> | undefined,
): Run {
	const source = listSource(ACTIVITY_ITEMS, ACTIVITY_PAGE, activityPage);
	const url = activityUrl(TIMELINE_VIEWER, "reaction");
	return runOf({
		scopes: { reactions: scope },
		pages: {
			[ME]: meSnapshot(null),
			[url]: {
				landedUrl: url,
				scripts: [preloaded("adp_al", { data: source({ cursor: null }).data })],
			},
		},
		sources: { [ACTIVITY_QUERY]: source },
		state,
	});
}

const activityIds = (from: number, to: number): string[] =>
	Array.from({ length: to - from + 1 }, (_, index) => activityId(to - index));

/** Pages of all 90 entries after the server-rendered one. */
const FULL_ACTIVITY_CALLS = ACTIVITY_ITEMS.length / ACTIVITY_PAGE - 1;

describe("reactions under time_range", () => {
	it("stops paging past since", async () => {
		const run = activityRun({ time_range: { since: dayStart(81) } });
		await collectFacebook(run.ctx, run.services);
		assert.deepEqual(run.failures, []);
		assert.deepEqual(delivered(run, "reactions"), activityIds(81, 90));
		// 90-81 rendered, then three pages of older entries make thirty.
		assert.equal(run.calls.length, 3);
		assert.ok(run.calls.length < FULL_ACTIVITY_CALLS);
		assert.deepEqual(stateOf(run, "reactions")?.cursor, {});
	});

	it("delivers only before until, and saves no checkpoint after withholding a newer entry", async () => {
		const run = activityRun({ time_range: { until: dayStart(11) } });
		await collectFacebook(run.ctx, run.services);
		assert.deepEqual(run.failures, []);
		assert.deepEqual(delivered(run, "reactions"), activityIds(1, 10));
		assert.equal(stateOf(run, "reactions"), undefined);
	});

	it("reads only the window with since and until, stopping past since", async () => {
		const run = activityRun({
			time_range: { since: dayStart(61), until: dayStart(71) },
		});
		await collectFacebook(run.ctx, run.services);
		assert.deepEqual(run.failures, []);
		assert.deepEqual(delivered(run, "reactions"), activityIds(61, 70));
		assert.ok(run.calls.length < FULL_ACTIVITY_CALLS);
	});
});

// ─── resources ──────────────────────────────────────────────────────────

describe("resources", () => {
	it("posts: stops once every requested post was read", async () => {
		const run = postsRun({ resources: [postId(28)] });
		await collectFacebook(run.ctx, run.services);
		assert.deepEqual(run.failures, []);
		assert.deepEqual(delivered(run, "posts"), [postId(28)]);
		assert.equal(run.calls.length, 0, "the rendered first page held it");
		assert.ok(stateOf(run, "posts"));
	});

	it("posts: walks to the end to prove a requested post is not there", async () => {
		const run = postsRun({ resources: [postId(28), "999999"] });
		await collectFacebook(run.ctx, run.services);
		assert.deepEqual(run.failures, []);
		assert.deepEqual(delivered(run, "posts"), [postId(28)]);
		assert.equal(run.calls.length, FULL_POST_CALLS);
	});

	it("reactions: stops once every requested entry was read", async () => {
		const run = activityRun({ resources: [activityId(75)] });
		await collectFacebook(run.ctx, run.services);
		assert.deepEqual(run.failures, []);
		assert.deepEqual(delivered(run, "reactions"), [activityId(75)]);
		assert.equal(run.calls.length, 1);
	});

	it("friends: stops once every requested friend was read, and claims no full inventory", async () => {
		const first = loadFixture(FRIENDS);
		const items = asRecord(asRecord(asRecord(first.data)?.node)?.pageItems);
		assert.ok(items && Array.isArray(items.edges));
		items.page_info = { end_cursor: "c1", has_next_page: true };
		const wanted = String(
			asRecord(asRecord(asRecord(items.edges[0])?.node)?.node)?.id,
		);
		const run = runOf({
			scopes: { friends: { resources: [wanted] } },
			pages: {
				[ME]: meSnapshot(null),
				[FRIENDS_URL]: {
					landedUrl: FRIENDS_URL,
					scripts: [VIEWER_SCRIPT, preloaded("adp_f", { data: first.data })],
				},
			},
			sources: {},
			captured: [
				{
					friendlyName: FRIENDS_QUERY,
					docId: "24123456789012345",
					variables: { count: 8, cursor: "c", scale: 2, search: null, id: "x" },
					asbdId: null,
				},
			],
		});
		await collectFacebook(run.ctx, run.services);
		assert.deepEqual(run.failures, []);
		assert.deepEqual(delivered(run, "friends"), [wanted]);
		assert.equal(run.calls.length, 0);
		assert.equal(
			run.emitted.some((m) => m.type === "DETAIL_COVERAGE"),
			false,
		);
		assert.ok(stateOf(run, "friends"));
	});
});

// ─── failures ───────────────────────────────────────────────────────────

describe("stream failures", () => {
	it("say a newer connector is needed for an outdated or refused query", () => {
		for (const cls of [ERROR_CLASSES.outdated, ERROR_CLASSES.mutation])
			assert.deepEqual(streamFailureHint(`${cls}: x`), {
				action: "retry_on_connector_upgrade",
				retryable: false,
			});
		for (const cls of [
			ERROR_CLASSES.incomplete,
			ERROR_CLASSES.timeout,
			ERROR_CLASSES.shape,
		])
			assert.deepEqual(streamFailureHint(`${cls}: x`), {
				action: "retry_by_runtime",
				retryable: true,
			});
	});

	it("reports an outdated query with the upgrade hint", async () => {
		const run = runOf({
			scopes: { reactions: {} },
			pages: {
				[ME]: meSnapshot(null),
				[activityUrl(TIMELINE_VIEWER, "reaction")]: {
					landedUrl: activityUrl(TIMELINE_VIEWER, "reaction"),
					scripts: [],
				},
			},
			sources: {},
		});
		await collectFacebook(run.ctx, run.services);
		assert.equal(run.failures.length, 1);
		assert.match(run.failures[0]?.message ?? "", /^facebook_query_outdated/);
		assert.deepEqual(run.failures[0]?.options, {
			recoveryHint: { action: "retry_on_connector_upgrade", retryable: false },
		});
	});

	it("fails the stream when the runtime drops a record for its shape", async () => {
		const items = daily(3, activityId);
		const page = activityPage(items, {
			end_cursor: null,
			has_next_page: false,
		});
		const stories = asRecord(
			asRecord(asRecord(page.data)?.node)?.activity_log_stories,
		);
		assert.ok(stories && Array.isArray(stories.edges));
		const node = asRecord(asRecord(stories.edges[0])?.node);
		assert.ok(node);
		// Passes the parser's https check, fails the schema's URL check.
		node.url = "https://[not-a-host";
		const url = activityUrl(TIMELINE_VIEWER, "reaction");
		const run = runOf({
			scopes: { reactions: {} },
			pages: {
				[ME]: meSnapshot(null),
				[url]: {
					landedUrl: url,
					scripts: [preloaded("adp_al", { data: page.data })],
				},
			},
			sources: {},
		});
		await collectFacebook(run.ctx, run.services);
		assert.equal(
			run.emitted.some((m) => m.type === "SKIP_RESULT"),
			true,
		);
		assert.equal(run.failures.length, 1);
		assert.match(
			run.failures[0]?.message ?? "",
			/did not match the stream's schema/,
		);
		assert.equal(stateOf(run, "reactions"), undefined);
	});
});

// ─── manifest ───────────────────────────────────────────────────────────

interface ManifestStream {
	consent_time_field?: string;
	cursor_field?: string;
	incremental?: boolean;
	name: string;
	schema: { properties: Record<string, { type: unknown }>; required: string[] };
	semantics?: string;
}

const manifest = JSON.parse(
	readFileSync(new URL("./manifest.json", import.meta.url), "utf8"),
) as {
	reason_display_messages: Record<string, string>;
	runtime_requirements: { bindings: { browser: { features: string[] } } };
	streams: ManifestStream[];
};
const streamNamed = (name: string): ManifestStream => {
	const stream = manifest.streams.find((s) => s.name === name);
	assert.ok(stream, name);
	return stream;
};

describe("manifest says what the code does", () => {
	it("claims no incremental read: STATE is never read back", () => {
		const source = readFileSync(
			new URL("./collect.ts", import.meta.url),
			"utf8",
		);
		assert.equal(/ctx\.state\b/.test(source), false);
		for (const stream of manifest.streams) {
			assert.equal(stream.incremental, false, stream.name);
			assert.equal(stream.cursor_field, undefined, stream.name);
		}
	});

	it("declares reactions and comments mutable: they can be undone or edited", () => {
		assert.equal(streamNamed("reactions").semantics, "mutable_state");
		assert.equal(streamNamed("comments").semantics, "mutable_state");
	});

	it("dates each bounded stream by a source time every record carries", () => {
		for (const [name, field] of [
			["posts", "create_time"],
			["reactions", "time"],
			["comments", "time"],
		] as const) {
			const stream = streamNamed(name);
			assert.equal(stream.consent_time_field, field);
			assert.ok(stream.schema.required.includes(field), name);
			assert.equal(stream.schema.properties[field]?.type, "string", name);
		}
		const record = {
			id: "S:_I1:VK:1",
			kind: "reaction",
			time: null,
			title: null,
			target_url: null,
			target_text: null,
			post_id: null,
			comment_text: null,
		};
		assert.equal(validateRecord("reactions", record).ok, false);
	});

	it("reads no cookie jar: cookie_read is not declared, and the mobile host does not provide it", () => {
		const index = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
		assert.equal(/\.cookies\(/.test(index), false);
		assert.equal(
			manifest.runtime_requirements.bindings.browser.features.includes(
				"cookie_read",
			),
			false,
		);
	});

	it("proves the session from the page alone, without a cookie jar", async () => {
		const probe = (viewerId: string | null) =>
			probeFacebookSession(
				{
					context: {},
					page: {
						url: () => "https://www.facebook.com/",
						evaluate: async () => viewerId,
					},
				} as never,
				1000,
			);
		assert.equal(await probe(TIMELINE_VIEWER), true);
		assert.equal(await probe("0"), false);
		assert.equal(await probe(null), false);
	});

	it("has copy for every reason this connector's streams can be skipped with", () => {
		for (const reason of [
			"stream_collection_failed",
			"shape_check_failed",
			"scope_not_supported",
		])
			assert.ok(manifest.reason_display_messages[reason], reason);
	});
});
