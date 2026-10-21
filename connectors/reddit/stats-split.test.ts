// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Acceptance tests for the Reddit content / current-stats split.
 *
 * Content streams (submitted, comments, saved, upvoted, downvoted, hidden)
 * carry what the item IS. Volatile source metrics (score, num_comments,
 * upvote_ratio, gilded) live in `<stream>_stats` streams keyed by the SAME
 * Reddit fullname. These tests drive the real `collectAllStreams` through a
 * synthetic listing server and the real runtime emit closure
 * (`makeEmitRecord`: scope selection and schema validation). Reddit emits no
 * STATE because all streams are full inventories. No browser, account, or
 * network.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { EmittedMessage } from "@pdpp/connector-protocol";
import { REDDIT_JSON_ORIGIN } from "../../packages/polyfill-connectors/src/auto-login/reddit.ts";
import {
	consentTimeFieldResolver,
	makeEmitRecord,
	withholdsBoundedProgress,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { collectAllStreams } from "./index.ts";
import { validateRecord } from "./schemas.ts";
import type { RedditChild, RedditFetchResult } from "./types.ts";

const EMITTED_AT = "2026-10-14T12:00:00.000Z";
const NO_DELAY = (): Promise<void> => Promise.resolve();
const T0 = 1_700_000_000;

type PersistedState = Record<string, unknown>;

// ─── Synthetic listings ─────────────────────────────────────────────────

function post(
	name: string,
	created: number,
	over: Partial<RedditChild["data"]> = {},
): RedditChild {
	return {
		kind: "t3",
		data: {
			name,
			subreddit: "synthetic",
			title: `Post ${name}`,
			permalink: `/r/synthetic/comments/${name.slice(3)}/post/`,
			url: "https://example.com/a",
			selftext: "",
			is_self: false,
			over_18: false,
			score: 10,
			num_comments: 5,
			upvote_ratio: 0.9,
			gilded: 0,
			created_utc: created,
			...over,
		},
	};
}

function comment(
	name: string,
	created: number,
	over: Partial<RedditChild["data"]> = {},
): RedditChild {
	return {
		kind: "t1",
		data: {
			name,
			subreddit: "synthetic",
			body: `Comment ${name}`,
			link_id: "t3_parent1",
			parent_id: "t3_parent1",
			permalink: `/r/synthetic/comments/parent1/x/${name.slice(3)}/`,
			score: 3,
			gilded: 0,
			created_utc: created,
			...over,
		},
	};
}

/** A fake Reddit: per-endpoint full listings served in `pageSize` pages. */
class FakeReddit {
	readonly lists: Record<string, RedditChild[]> = {};
	readonly calls: string[] = [];
	pageSize = 100;
	/** Make the nth (1-based) request to an endpoint answer HTTP 500. */
	failOn: { call: number; endpoint: string } | null = null;
	private readonly counts: Record<string, number> = {};

	set(endpoint: string, children: RedditChild[]): this {
		this.lists[endpoint] = children;
		return this;
	}

	fetch = (path: string): Promise<RedditFetchResult> => {
		this.calls.push(path);
		const [endpointPath = "", query = ""] = path.split("?");
		const endpoint = endpointPath
			.replace("/user/anon/", "")
			.replace(".json", "");
		this.counts[endpoint] = (this.counts[endpoint] ?? 0) + 1;
		if (
			this.failOn &&
			this.failOn.endpoint === endpoint &&
			this.failOn.call === this.counts[endpoint]
		) {
			return Promise.resolve({ status: 500, json: null });
		}
		const after = new URLSearchParams(query).get("after");
		const offset = after ? Number(after.slice(1)) : 0;
		const all = this.lists[endpoint] ?? [];
		const end = Math.min(offset + this.pageSize, all.length);
		return Promise.resolve({
			status: 200,
			json: {
				data: {
					children: all.slice(offset, end),
					after: end < all.length ? `a${end}` : null,
				},
			},
		});
	};
}

// ─── Run simulator: real collect, real emit closure, runtime state rules ──

type RequestedInput =
	| string
	| {
			name: string;
			resources?: string[];
			time_range?: { since?: string; until?: string };
	  };

interface RunOptions {
	collectionMode?: "full_refresh" | "incremental";
	requested: RequestedInput[];
	state?: PersistedState;
}

interface RunResult {
	error: Error | null;
	/** Stream failures reported through the runtime's reportStreamFailure. */
	failures: Array<{ message: string; retryable: boolean; stream: string }>;
	messages: EmittedMessage[];
	/** State the runtime would hold for the next run. */
	nextState: PersistedState;
}

async function run(fake: FakeReddit, opts: RunOptions): Promise<RunResult> {
	const messages: EmittedMessage[] = [];
	const failures: RunResult["failures"] = [];
	const rawEmit = (m: EmittedMessage): Promise<void> => {
		messages.push(m);
		return Promise.resolve();
	};
	const requested = new Map(
		opts.requested.map((r) => {
			const scope = typeof r === "string" ? { name: r } : r;
			return [scope.name, scope] as const;
		}),
	);
	const emitRecord = makeEmitRecord({
		requested,
		emit: rawEmit,
		emittedAt: EMITTED_AT,
		validateRecord,
		isTombstone: undefined,
		timeRangeFieldFor: consentTimeFieldResolver("reddit"),
	});
	const emit = (m: EmittedMessage): Promise<void> =>
		withholdsBoundedProgress(m, emitRecord.withheldAtOrAfterUntil)
			? Promise.resolve()
			: rawEmit(m);
	const prior = structuredClone(opts.state ?? {});
	const page = {
		evaluate: (_fn: unknown, args: unknown) =>
			fake.fetch((args as { path: string }).path),
		goto: (): Promise<null> => Promise.resolve(null),
		url: (): string => `${REDDIT_JSON_ORIGIN}/`,
	};
	const ctx = {
		assist: () => Promise.reject(new Error("no assist")),
		capture: null,
		collectionMode: opts.collectionMode ?? "incremental",
		completeAssistance: () => Promise.resolve(),
		// biome-ignore lint/suspicious/noExplicitAny: no browser in this harness
		context: {} as any,
		credentials: { REDDIT_USERNAME: "anon" },
		detailGaps: [],
		emit,
		emitRecord: emitRecord.emit,
		emittedAt: EMITTED_AT,
		// biome-ignore lint/suspicious/noExplicitAny: only evaluate/goto/url are read
		page: page as any,
		progress: () => Promise.resolve(),
		reportStreamFailure: (
			stream: string,
			message: string,
			options?: { retryable?: boolean },
		) => {
			failures.push({
				message,
				retryable: options?.retryable === true,
				stream,
			});
			return Promise.resolve();
		},
		requestDetailGapPage: () => Promise.resolve([]),
		requested,
		scope: { streams: [...requested.values()] },
		sendInteraction: () => Promise.reject(new Error("no interaction")),
		state: prior,
	};
	let error: Error | null = null;
	try {
		// biome-ignore lint/suspicious/noExplicitAny: ctx is a hand-built subset
		await (collectAllStreams as any)(ctx, { delay: NO_DELAY });
	} catch (e) {
		error = e as Error;
	}
	const nextState: PersistedState = structuredClone(opts.state ?? {});
	if (!error) {
		for (const m of messages) {
			if (m.type === "STATE") {
				nextState[m.stream] = m.cursor;
			}
		}
	}
	return { error, failures, messages, nextState };
}

const records = (r: RunResult, stream: string) =>
	r.messages.flatMap((m) =>
		m.type === "RECORD" && m.stream === stream ? [m.data] : [],
	);
const ids = (r: RunResult, stream: string) =>
	records(r, stream).map((d) => String(d.id));
const stateMsgs = (r: RunResult, stream: string) =>
	r.messages.filter((m) => m.type === "STATE" && m.stream === stream);
/** Records by id, for deep comparison across runs. */
const byId = (r: RunResult, stream: string) =>
	Object.fromEntries(records(r, stream).map((d) => [String(d.id), d]));
/** Every wire message that names a stream, excluding PROGRESS chatter. */
const streamsTouched = (r: RunResult): string[] =>
	[
		...new Set(
			r.messages.flatMap((m) =>
				"stream" in m && typeof m.stream === "string" && m.type !== "PROGRESS"
					? [m.stream]
					: [],
			),
		),
	].sort();

const METRIC_KEYS = ["score", "num_comments", "upvote_ratio", "gilded"];

interface Group {
	entity: string;
	make: (
		name: string,
		created: number,
		o?: Partial<RedditChild["data"]>,
	) => RedditChild;
	prefix: string;
	stats: string;
	/** Metrics the stats stream carries for this group. */
	statsKeys: string[];
}

const GROUPS: Group[] = [
	{
		entity: "submitted",
		stats: "submitted_stats",
		make: post,
		prefix: "t3_s",
		statsKeys: ["score", "num_comments", "upvote_ratio", "gilded"],
	},
	{
		entity: "comments",
		stats: "comments_stats",
		make: comment,
		prefix: "t1_c",
		statsKeys: ["score", "gilded"],
	},
	{
		entity: "upvoted",
		stats: "upvoted_stats",
		make: post,
		prefix: "t3_u",
		statsKeys: ["score", "num_comments"],
	},
	{
		entity: "downvoted",
		stats: "downvoted_stats",
		make: post,
		prefix: "t3_d",
		statsKeys: ["score", "num_comments"],
	},
	{
		entity: "hidden",
		stats: "hidden_stats",
		make: post,
		prefix: "t3_h",
		statsKeys: ["score", "num_comments"],
	},
];
const ALL_STREAMS = [...GROUPS.flatMap((g) => [g.entity, g.stats]), "saved"];

function fakeFor(g: Group, n = 3): FakeReddit {
	const f = new FakeReddit();
	f.set(
		g.entity,
		Array.from({ length: n }, (_, i) =>
			g.make(`${g.prefix}${i + 1}`, T0 + 1000 - i * 10),
		),
	);
	return f;
}

// ─── 1. Metric-only churn ───────────────────────────────────────────────

for (const g of GROUPS) {
	test(`${g.entity}: metrics-only change leaves the content record byte-identical and updates ${g.stats} with the actual values`, async () => {
		const fake = fakeFor(g);
		const both = [g.entity, g.stats];
		const r1 = await run(fake, { requested: both });
		assert.equal(ids(r1, g.entity).length, 3);
		assert.equal(ids(r1, g.stats).length, 3);
		for (const d of records(r1, g.entity)) {
			for (const k of METRIC_KEYS) {
				assert.equal(k in d, false, `${g.entity} content must not carry ${k}`);
			}
		}

		// Only source metrics move on the middle item.
		const mid = `${g.prefix}2`;
		fake.lists[g.entity] = (fake.lists[g.entity] ?? []).map((c) =>
			c.data.name === mid
				? g.make(mid, T0 + 990, { score: 777, num_comments: 31, gilded: 2 })
				: c,
		);
		const r2 = await run(fake, { requested: both, state: r1.nextState });
		// Whatever content is re-walked is byte-identical to what was stored.
		for (const [id, d] of Object.entries(byId(r2, g.entity))) {
			assert.deepEqual(d, byId(r1, g.entity)[id], `${id} content unchanged`);
		}
		const before = byId(r1, g.stats);
		const after = byId(r2, g.stats);
		for (const id of Object.keys(before)) {
			if (id !== mid) {
				assert.deepEqual(after[id], before[id], `${id} stats unchanged`);
			}
		}
		const stat = after[mid];
		assert.ok(stat);
		assert.notDeepEqual(stat, before[mid]);
		assert.equal(stat.score, 777);
		if (g.statsKeys.includes("num_comments")) {
			assert.equal(stat.num_comments, 31);
		}
		if (g.statsKeys.includes("gilded")) {
			assert.equal(stat.gilded, 2);
		}
	});
}

// ─── 2. Unchanged source ────────────────────────────────────────────────

test("unchanged source: later runs re-emit byte-identical records without checkpoint or self-coverage claims", async () => {
	const fake = new FakeReddit();
	for (const g of GROUPS) {
		fake.set(
			g.entity,
			[1, 2, 3].map((i) => g.make(`${g.prefix}${i}`, T0 + 1000 - i * 10)),
		);
	}
	fake.set("saved", [post("t3_sv1", T0 + 500), comment("t1_sv2", T0 + 400)]);
	const r1 = await run(fake, { requested: ALL_STREAMS });
	assert.equal(
		ALL_STREAMS.every((s) => records(r1, s).length > 0),
		true,
		"first run emits every requested stream",
	);
	let state = r1.nextState;
	for (const round of [2, 3]) {
		const r = await run(fake, { requested: ALL_STREAMS, state });
		assert.equal(r.error, null);
		for (const s of ALL_STREAMS) {
			assert.deepEqual(byId(r, s), byId(r1, s), `run ${round}: ${s} stable`);
			assert.equal(stateMsgs(r, s).length, 0, `run ${round}: no ${s} STATE`);
			assert.equal(
				r.messages.some((m) => m.type === "DETAIL_COVERAGE" && m.stream === s),
				false,
				`run ${round}: no undeclared self-coverage for ${s}`,
			);
		}
		assert.deepEqual(
			r.nextState,
			state,
			"old opaque runtime state is preserved",
		);
		state = r.nextState;
	}
});

// ─── 3. Genuine content change ──────────────────────────────────────────

test("upvoted: a genuine content edit changes the content record only; a new id appears in both outputs", async () => {
	const fake = new FakeReddit().set("upvoted", [
		post("t3_u1", T0 + 30),
		post("t3_u2", T0 + 20),
	]);
	const both = ["upvoted", "upvoted_stats"];
	const r1 = await run(fake, { requested: both });
	fake.lists.upvoted = [
		post("t3_u3", T0 + 5),
		post("t3_u1", T0 + 30, { title: "edited title" }),
		post("t3_u2", T0 + 20),
	];
	const r2 = await run(fake, { requested: both, state: r1.nextState });
	const c1 = byId(r1, "upvoted");
	const c2 = byId(r2, "upvoted");
	assert.equal(c2.t3_u1?.title, "edited title");
	assert.deepEqual(c2.t3_u2, c1.t3_u2);
	assert.ok(c2.t3_u3, "new id is a content record");
	const s1 = byId(r1, "upvoted_stats");
	const s2 = byId(r2, "upvoted_stats");
	assert.deepEqual(s2.t3_u1, s1.t3_u1, "an edit does not touch stats");
	assert.ok(s2.t3_u3, "new id is a stats record");
});

test("submitted: every current listing emits both outputs, including edits to older posts", async () => {
	const fake = new FakeReddit().set("submitted", [
		post("t3_s2", T0 + 200),
		post("t3_s1", T0 + 100),
	]);
	const both = ["submitted", "submitted_stats"];
	const r1 = await run(fake, { requested: both });
	fake.lists.submitted = [
		post("t3_s3", T0 + 300),
		post("t3_s2", T0 + 200),
		post("t3_s1", T0 + 100, { title: "edited later" }),
	];
	const r2 = await run(fake, { requested: both, state: r1.nextState });
	assert.deepEqual(ids(r2, "submitted").sort(), ["t3_s1", "t3_s2", "t3_s3"]);
	assert.deepEqual(
		ids(r2, "submitted_stats").sort(),
		["t3_s1", "t3_s2", "t3_s3"],
		"stats re-reads the whole listing",
	);
	const r3 = await run(fake, {
		requested: both,
		state: r2.nextState,
		collectionMode: "full_refresh",
	});
	assert.deepEqual(ids(r3, "submitted").sort(), ["t3_s1", "t3_s2", "t3_s3"]);
	assert.equal(
		records(r3, "submitted").find((d) => d.id === "t3_s1")?.title,
		"edited later",
	);
});

// ─── 4. Stats refresh below the creation cursor ─────────────────────────

test("submitted_stats: stats-only refresh reads below old cursor state and emits nothing for unrequested content", async () => {
	const fake = new FakeReddit().set("submitted", [
		post("t3_s3", T0 + 300),
		post("t3_s2", T0 + 200),
		post("t3_s1", T0 + 100),
	]);
	const r1 = await run(fake, {
		requested: ["submitted", "submitted_stats"],
		state: { submitted: { last_created_utc: T0 + 300 } },
	});
	fake.lists.submitted = [
		post("t3_s3", T0 + 300),
		post("t3_s2", T0 + 200),
		post("t3_s1", T0 + 100, { score: 4242, num_comments: 99 }),
	];
	const r2 = await run(fake, {
		requested: ["submitted_stats"],
		state: r1.nextState,
	});
	assert.equal(byId(r2, "submitted_stats").t3_s1?.score, 4242);
	assert.equal(byId(r2, "submitted_stats").t3_s1?.num_comments, 99);
	assert.deepEqual(streamsTouched(r2), ["submitted_stats"]);
	assert.deepEqual(
		r2.nextState.submitted,
		{ last_created_utc: T0 + 300 },
		"unrequested old opaque content state is preserved",
	);
});

test("stats walk past the page cap: keeps partial evidence, reports a stream failure, and writes no checkpoint or self-coverage", async () => {
	const fake = new FakeReddit();
	fake.pageSize = 1;
	fake.set(
		"submitted",
		Array.from({ length: 105 }, (_, i) => post(`t3_s${i + 1}`, T0 + 5000 - i)),
	);
	const priorState = { submitted: { last_created_utc: T0 + 4999 } };
	const r = await run(fake, {
		requested: ["submitted_stats"],
		state: priorState,
	});
	assert.equal(r.error, null);
	assert.equal(fake.calls.length, 100, "bounded by the page ceiling");
	assert.equal(ids(r, "submitted_stats").length, 100);
	assert.deepEqual(
		r.failures.map((f) => [f.stream, f.retryable]),
		[["submitted_stats", false]],
		"the capped output is reported as a stream failure, once",
	);
	assert.match(r.failures[0]?.message ?? "", /100-page limit/);
	assert.deepEqual(streamsTouched(r), ["submitted_stats"]);
	assert.deepEqual(r.nextState.submitted, priorState.submitted);
	assert.equal(stateMsgs(r, "submitted_stats").length, 0);
	assert.equal(
		r.messages.some((m) => m.type === "DETAIL_COVERAGE"),
		false,
	);
});

// ─── 5. Scope isolation and A/B/A ───────────────────────────────────────

test("scopes: content-only, stats-only and combined touch only their own streams, and combined walks the listing once", async () => {
	const g = GROUPS[0] as Group;
	const fake = fakeFor(g);
	fake.pageSize = 1;
	const content = await run(fake, { requested: ["submitted"] });
	assert.deepEqual(streamsTouched(content), ["submitted"]);
	const callsContent = fake.calls.length;

	fake.calls.length = 0;
	const stats = await run(fake, { requested: ["submitted_stats"] });
	assert.deepEqual(streamsTouched(stats), ["submitted_stats"]);
	const callsStats = fake.calls.length;

	fake.calls.length = 0;
	const both = await run(fake, {
		requested: ["submitted", "submitted_stats"],
	});
	assert.deepEqual(streamsTouched(both), ["submitted", "submitted_stats"]);
	assert.equal(
		fake.calls.length,
		Math.max(callsContent, callsStats),
		"one provider walk serves both outputs",
	);
	assert.equal(
		fake.calls.every((p) => p.includes("/submitted.json")),
		true,
	);
});

test("A/B/A scope switching and value reverts always emit the real current value", async () => {
	const fake = new FakeReddit();
	const L = (score: number) => [
		post("t3_s2", T0 + 200, { score }),
		post("t3_s1", T0 + 100),
	];
	const scoreOf = (r: RunResult) => byId(r, "submitted_stats").t3_s2?.score;
	fake.set("submitted", L(5));
	// A: content only.
	const a = await run(fake, { requested: ["submitted"] });
	assert.deepEqual(streamsTouched(a), ["submitted"]);
	// B: stats only; never collected before.
	const b = await run(fake, {
		requested: ["submitted_stats"],
		state: a.nextState,
	});
	assert.equal(scoreOf(b), 5);
	assert.deepEqual(b.nextState.submitted, a.nextState.submitted);
	// Score moves; a combined run carries the new value, content is unchanged.
	fake.set("submitted", L(6));
	const c = await run(fake, {
		requested: ["submitted", "submitted_stats"],
		state: b.nextState,
	});
	assert.deepEqual(ids(c, "submitted").sort(), ["t3_s1", "t3_s2"]);
	assert.equal(scoreOf(c), 6);
	// Revert to the exact value an EARLIER stats run saw: still emitted.
	fake.set("submitted", L(5));
	const d = await run(fake, {
		requested: ["submitted_stats"],
		state: c.nextState,
	});
	assert.equal(scoreOf(d), 5);
	// A content-only run in between does not disturb the stats stream's state.
	const e = await run(fake, { requested: ["submitted"], state: d.nextState });
	assert.deepEqual(e.nextState.submitted_stats, d.nextState.submitted_stats);
	const f = await run(fake, {
		requested: ["submitted_stats"],
		state: e.nextState,
	});
	assert.equal(scoreOf(f), 5);
});

test("upvoted content edit under a content-only run is not hidden from a later combined run", async () => {
	const fake = new FakeReddit().set("upvoted", [post("t3_u1", T0 + 30)]);
	const a = await run(fake, { requested: ["upvoted", "upvoted_stats"] });
	fake.lists.upvoted = [post("t3_u1", T0 + 30, { title: "v2", score: 50 })];
	const b = await run(fake, { requested: ["upvoted"], state: a.nextState });
	assert.equal(byId(b, "upvoted").t3_u1?.title, "v2");
	assert.deepEqual(streamsTouched(b), ["upvoted"]);
	const c = await run(fake, {
		requested: ["upvoted", "upvoted_stats"],
		state: b.nextState,
	});
	assert.deepEqual(byId(c, "upvoted"), byId(b, "upvoted"));
	assert.equal(byId(c, "upvoted_stats").t3_u1?.score, 50, "stats still owed");
});

// ─── 6. Full-inventory refresh and legacy state ────────────────────────

const LEGACY_T = T0 + 150;
function legacyListing(): FakeReddit {
	return new FakeReddit().set("submitted", [
		post("t3_s3", T0 + 300),
		post("t3_s2", T0 + 200),
		post("t3_s1", T0 + 100),
	]);
}

test("old creation state never limits a full-inventory content refresh", async () => {
	const fake = legacyListing();
	const oldState = { submitted: { last_created_utc: LEGACY_T } };
	const r1 = await run(fake, { requested: ["submitted"], state: oldState });
	assert.deepEqual(ids(r1, "submitted").sort(), ["t3_s1", "t3_s2", "t3_s3"]);
	assert.deepEqual(
		r1.nextState,
		oldState,
		"opaque old state is left untouched",
	);
	assert.equal(stateMsgs(r1, "submitted").length, 0);
	assert.equal(
		r1.messages.some((m) => m.type === "DETAIL_COVERAGE"),
		false,
	);
	fake.lists.submitted = [
		post("t3_s4", T0 + 400),
		...(fake.lists.submitted ?? []),
	];
	const r2 = await run(fake, { requested: ["submitted"], state: r1.nextState });
	assert.deepEqual(ids(r2, "submitted").sort(), [
		"t3_s1",
		"t3_s2",
		"t3_s3",
		"t3_s4",
	]);
});

test("a host-rejected legacy observation is attempted again on the next full-inventory run", async () => {
	const fake = legacyListing();
	const rejectedKey = "t3_s1";
	const stored = new Map<string, Record<string, unknown>>([
		[rejectedKey, { id: rejectedKey, score: 5, title: "legacy stored shape" }],
	]);
	const oldState = { submitted: { last_created_utc: LEGACY_T } };
	const first = await run(fake, { requested: ["submitted"], state: oldState });
	assert.equal(first.error, null);

	// Simulate the host boundary: it accepts the other RECORDs, rejects one
	// schema-valid row, and can therefore leave that old stored row unchanged.
	// This is a model of the boundary, not a database integration test.
	for (const data of records(first, "submitted")) {
		if (String(data.id) !== rejectedKey) stored.set(String(data.id), data);
	}
	assert.ok("score" in (stored.get(rejectedKey) ?? {}));
	assert.deepEqual(first.nextState, oldState);
	assert.equal(stateMsgs(first, "submitted").length, 0);

	const later = await run(fake, {
		requested: ["submitted"],
		state: first.nextState,
	});
	assert.ok(ids(later, "submitted").includes(rejectedKey));
});

test("old opaque state shapes do not block full inventory and are not rewritten", async () => {
	const shapes: unknown[] = [
		null,
		{},
		[],
		"junk",
		{ last_created_utc: "x" },
		{ fingerprints: { t3_s1: 7 } },
	];
	// Each shape runs against its own fake listing, so the runs are independent.
	await Promise.all(
		shapes.map(async (shape) => {
			const fake = legacyListing();
			const oldState = { submitted: shape, submitted_stats: shape };
			const r = await run(fake, {
				requested: ["submitted", "submitted_stats"],
				state: oldState,
			});
			assert.equal(r.error, null, JSON.stringify(shape));
			assert.deepEqual(ids(r, "submitted").sort(), ["t3_s1", "t3_s2", "t3_s3"]);
			assert.deepEqual(ids(r, "submitted_stats").sort(), [
				"t3_s1",
				"t3_s2",
				"t3_s3",
			]);
			assert.deepEqual(r.nextState, oldState);
		}),
	);
});

test("page-cap runs keep partial evidence and report a failure for each requested output, never checkpointing", async () => {
	const fake = new FakeReddit();
	fake.pageSize = 1;
	fake.set(
		"submitted",
		Array.from({ length: 105 }, (_, i) => post(`t3_s${i + 1}`, T0 + 5000 - i)),
	);
	const oldState = {
		submitted: { legacy: "opaque" },
		submitted_stats: { old: true },
	};
	const result = await run(fake, {
		requested: ["submitted", "submitted_stats"],
		state: oldState,
	});
	assert.equal(ids(result, "submitted").length, 100);
	assert.equal(ids(result, "submitted_stats").length, 100);
	assert.deepEqual(
		result.failures.map((f) => f.stream),
		["submitted", "submitted_stats"],
		"each requested capped output is reported",
	);
	assert.equal(
		result.messages.some((m) => m.type === "SKIP_RESULT"),
		false,
		"the legacy deferred-page SKIP is gone",
	);
	assert.equal(
		stateMsgs(result, "submitted").length +
			stateMsgs(result, "submitted_stats").length,
		0,
	);
	assert.equal(
		result.messages.some((m) => m.type === "DETAIL_COVERAGE"),
		false,
	);
	assert.deepEqual(result.nextState, oldState);
});

// ─── 7. Rejected / filtered records are never cached ────────────────────

test("schema-rejected records produce runtime skips without connector coverage claims", async () => {
	const fake = new FakeReddit().set("submitted", [
		post("t3_s2", T0 + 200),
		post("t3_bad_id", T0 + 100), // underscore: fails the fullname schema
	]);
	const r1 = await run(fake, {
		requested: ["submitted", "submitted_stats"],
	});
	assert.deepEqual(ids(r1, "submitted"), ["t3_s2"]);
	assert.deepEqual(ids(r1, "submitted_stats"), ["t3_s2"]);
	const skips = r1.messages.filter(
		(m) => m.type === "SKIP_RESULT" && m.reason === "shape_check_failed",
	);
	assert.equal(skips.length >= 2, true, "runtime still reports the rejection");
	assert.equal(
		r1.messages.some((m) => m.type === "DETAIL_COVERAGE"),
		false,
	);
	assert.equal(
		r1.messages.some((m) => m.type === "STATE"),
		false,
	);
});

test("no per-record cache or connector checkpoint is persisted", async () => {
	const fake = new FakeReddit();
	for (const g of GROUPS) {
		fake.set(g.entity, [g.make(`${g.prefix}1`, T0 + 10)]);
	}
	fake.set("saved", [post("t3_sv1", T0 + 20)]);
	const r = await run(fake, { requested: ALL_STREAMS });
	assert.deepEqual(r.nextState, {});
	assert.equal(
		r.messages.some((m) => m.type === "STATE"),
		false,
	);
});

test("resource-filtered runs emit only the selected record and leave nothing that hides the rest from a later unscoped run", async () => {
	const g = GROUPS[2] as Group; // upvoted
	const fake = fakeFor(g);
	const r1 = await run(fake, {
		requested: [
			{ name: "upvoted", resources: ["t3_u1"] },
			{ name: "upvoted_stats", resources: ["t3_u1"] },
		],
	});
	assert.deepEqual(ids(r1, "upvoted"), ["t3_u1"]);
	assert.deepEqual(ids(r1, "upvoted_stats"), ["t3_u1"]);
	const r2 = await run(fake, {
		requested: ["upvoted", "upvoted_stats"],
		state: r1.nextState,
	});
	assert.deepEqual(ids(r2, "upvoted").sort(), ["t3_u1", "t3_u2", "t3_u3"]);
	assert.deepEqual(ids(r2, "upvoted_stats").sort(), [
		"t3_u1",
		"t3_u2",
		"t3_u3",
	]);
});

test("time-range filtering selects output without changing opaque old state", async () => {
	const fake = legacyListing();
	const legacy = { submitted: { last_created_utc: LEGACY_T } };
	const since = new Date((T0 + 250) * 1000).toISOString();
	const r1 = await run(fake, {
		requested: [{ name: "submitted", time_range: { since } }],
		state: legacy,
	});
	assert.deepEqual(ids(r1, "submitted"), ["t3_s3"]);
	assert.deepEqual(r1.nextState, legacy);
	// An unscoped run still reads the full current inventory.
	const r2 = await run(fake, { requested: ["submitted"], state: r1.nextState });
	assert.deepEqual(ids(r2, "submitted").sort(), ["t3_s1", "t3_s2", "t3_s3"]);
});

test("a malformed listed item remains a runtime skip on later full-inventory runs", async () => {
	const fake = new FakeReddit().set("submitted", [
		post("t3_s2", T0 + 200),
		post("t3_bad_id", T0 + 100),
	]);
	const legacy = { submitted: { last_created_utc: LEGACY_T } };
	const r1 = await run(fake, { requested: ["submitted"], state: legacy });
	assert.ok(
		r1.messages.some(
			(m) => m.type === "SKIP_RESULT" && m.stream === "submitted",
		),
	);
	fake.calls.length = 0;
	const r2 = await run(fake, { requested: ["submitted"], state: r1.nextState });
	assert.deepEqual(ids(r2, "submitted"), ["t3_s2"]);
	assert.ok(
		r2.messages.some(
			(m) => m.type === "SKIP_RESULT" && m.stream === "submitted",
		),
	);
});

test("resource-scoped runs do not hide other listed rows from later runs", async () => {
	const fake = legacyListing();
	const legacy = { submitted: { last_created_utc: LEGACY_T } };
	const r1 = await run(fake, {
		requested: [{ name: "submitted", resources: ["t3_s3"] }],
		state: legacy,
	});
	assert.deepEqual(ids(r1, "submitted"), ["t3_s3"]);
	const r2 = await run(fake, { requested: ["submitted"], state: r1.nextState });
	assert.deepEqual(ids(r2, "submitted").sort(), ["t3_s1", "t3_s2", "t3_s3"]);
});

// ─── Failed run after emission (HEB-RUNTIME-EVIDENCE.md) ────────────────
//
// Hazard this guards against: a persisted "unchanged" cache is only as durable
// as committed STATE. The data-connect RS ingest contract (pinned 36380c83)
// says earlier accepted records MUST NOT be rolled back, each record is its
// own transaction, and permanent per-record rejects inside a 2xx do not block
// a successful DONE or the cache commit. So: cache A committed; a run stores B
// and then fails (no STATE commit); the source returns to A; a cache keyed on A
// would suppress it and leave B stored. (Source-read evidence, not execution.)
//
// This connector therefore keeps NO such cache. These tests pin that: the
// same scenario must re-emit A. They fail if a persisted suppression is added
// without a contract that makes it safe. A previous variant of this change
// (kept outside the repo for review) did suppress, and a test pinned the bug.

test("failed run after emission, then source reverts to the committed value: the committed value is emitted again", async () => {
	const fake = new FakeReddit()
		.set("submitted", [post("t3_s1", T0 + 100, { score: 5 })])
		.set("comments", [comment("t1_c1", T0 + 100)]);
	const both = ["submitted_stats", "comments"];
	const a = await run(fake, { requested: both });
	assert.equal(a.error, null);
	// Value moves to B. submitted_stats emits B; then the comments walk fails.
	fake.set("submitted", [post("t3_s1", T0 + 100, { score: 6 })]);
	fake.failOn = { endpoint: "comments", call: 2 };
	const failed = await run(fake, { requested: both, state: a.nextState });
	assert.ok(failed.error);
	assert.equal(
		byId(failed, "submitted_stats").t3_s1?.score,
		6,
		"B was emitted",
	);
	assert.deepEqual(failed.nextState, a.nextState, "but no STATE committed");
	// Source reverts to A.
	fake.set("submitted", [post("t3_s1", T0 + 100, { score: 5 })]);
	fake.failOn = null;
	const later = await run(fake, { requested: both, state: failed.nextState });
	assert.equal(
		byId(later, "submitted_stats").t3_s1?.score,
		5,
		"A is emitted again, overwriting stored B",
	);
});

test("content emitted before a failed later listing is re-emitted by the next run", async () => {
	const fake = legacyListing();
	fake.set("comments", [comment("t1_c1", T0 + 100)]);
	fake.failOn = { endpoint: "comments", call: 1 };
	const legacy = {
		submitted: { last_created_utc: LEGACY_T },
		comments: { last_created_utc: T0 + 50 },
	};
	const failed = await run(fake, {
		requested: ["submitted", "comments"],
		state: legacy,
	});
	assert.ok(failed.error);
	assert.equal(ids(failed, "submitted").length, 3, "repair rows were stored");
	assert.deepEqual(
		failed.nextState,
		legacy,
		"opaque old state remains untouched",
	);
	fake.failOn = null;
	const later = await run(fake, {
		requested: ["submitted", "comments"],
		state: failed.nextState,
	});
	assert.equal(
		ids(later, "submitted").length,
		3,
		"repair repeated, not skipped",
	);
	assert.equal(stateMsgs(later, "submitted").length, 0);
});

test("a fetch failure inside a listing emits nothing from that listing (walk completes before any emission)", async () => {
	const fake = new FakeReddit().set("upvoted", [
		post("t3_u1", T0 + 3),
		post("t3_u2", T0 + 2),
	]);
	fake.pageSize = 1;
	fake.failOn = { endpoint: "upvoted", call: 2 };
	const r = await run(fake, { requested: ["upvoted", "upvoted_stats"] });
	assert.ok(r.error);
	assert.equal(
		records(r, "upvoted").length + records(r, "upvoted_stats").length,
		0,
	);
});

// ─── 8. Recovery ────────────────────────────────────────────────────────

test("incremental and full_refresh both refresh every currently listed record", async () => {
	const fake = fakeFor(GROUPS[0] as Group);
	const both = ["submitted", "submitted_stats"];
	const r1 = await run(fake, { requested: both });
	const inc = await run(fake, { requested: both, state: r1.nextState });
	assert.deepEqual(ids(inc, "submitted").sort(), ids(r1, "submitted").sort());
	const r2 = await run(fake, {
		requested: both,
		state: r1.nextState,
		collectionMode: "full_refresh",
	});
	assert.deepEqual(byId(r2, "submitted"), byId(r1, "submitted"));
	assert.deepEqual(byId(r2, "submitted_stats"), byId(r1, "submitted_stats"));
});

// ─── 9. Identity, source time, schema, manifest ─────────────────────────

test("stats records share the parent's fullname key and carry only source values", async () => {
	// Each group runs against its own fake listing, so the runs are independent.
	await Promise.all(
		GROUPS.map(async (g) => {
			const fake = fakeFor(g);
			const r = await run(fake, { requested: [g.entity, g.stats] });
			assert.deepEqual(ids(r, g.stats).sort(), ids(r, g.entity).sort());
			for (const d of records(r, g.stats)) {
				assert.deepEqual(
					Object.keys(d).sort(),
					["created_utc", "id", ...g.statsKeys].sort(),
					`${g.stats} keys`,
				);
				assert.match(String(d.id), /^t[13]_[a-z0-9]+$/u);
				assert.match(String(d.created_utc), /^\d{4}-\d{2}-\d{2}T.*\.\d{3}Z$/u);
				assert.equal(
					String(d.created_utc).startsWith("2023-"),
					true,
					"created_utc is the source creation time, not the run clock",
				);
			}
		}),
	);
});

test("no record on any stream carries a collection clock", async () => {
	const fake = new FakeReddit();
	for (const g of GROUPS) {
		fake.set(g.entity, [g.make(`${g.prefix}1`, T0 + 10)]);
	}
	fake.set("saved", [post("t3_sv1", T0 + 20)]);
	const r = await run(fake, { requested: ALL_STREAMS });
	const banned = [
		"fetched_at",
		"collected_at",
		"observed_on",
		"observed_at",
		"run_at",
		"emitted_at",
	];
	for (const m of r.messages) {
		if (m.type === "RECORD") {
			for (const k of banned) {
				assert.equal(k in m.data, false, `${m.stream}.${k}`);
			}
			assert.equal(JSON.stringify(m.data).includes("2026-10-14"), false);
		}
	}
});

interface ManifestStream {
	[k: string]: unknown;
	name: string;
	schema: { properties: Record<string, { x_pdpp_role?: string }> };
	query?: { range_filters?: Record<string, unknown> };
}
const manifest = JSON.parse(
	readFileSync(new URL("./manifest.json", import.meta.url), "utf8"),
) as { streams: ManifestStream[]; version: string };
const mstream = (name: string): ManifestStream => {
	const s = manifest.streams.find((x) => x.name === name);
	assert.ok(s, `manifest stream ${name}`);
	return s;
};

test("manifest: content streams keep their names and keys; stats streams are mutable_state keyed by the same id with no clock field", () => {
	const names = manifest.streams.map((s) => s.name);
	for (const g of GROUPS) {
		assert.ok(names.includes(g.entity));
		assert.ok(names.includes(g.stats));
	}
	assert.ok(names.includes("saved"));
	assert.equal(names.includes("saved_stats"), false, "saved has no metrics");
	assert.equal(names.length, 11);
	for (const g of GROUPS) {
		const e = mstream(g.entity);
		const s = mstream(g.stats);
		assert.deepEqual(e.primary_key, ["id"]);
		assert.deepEqual(s.primary_key, ["id"]);
		assert.equal(s.semantics, "mutable_state");
		assert.equal(e.semantics, "mutable_state");
		assert.equal(s.consent_time_field, "created_utc");
		assert.equal(s.required, false);
		assert.equal(e.required, true);
		for (const k of METRIC_KEYS) {
			assert.equal(k in e.schema.properties, false, `${g.entity}.${k}`);
			assert.equal(
				k in s.schema.properties,
				g.statsKeys.includes(k),
				`${g.stats}.${k}`,
			);
		}
		for (const banned of ["observed_on", "collected_at", "fetched_at"]) {
			assert.equal(banned in s.schema.properties, false);
		}
		assert.equal(JSON.stringify(s).includes("append_only"), false);
	}
	assert.equal(mstream("saved").semantics, "mutable_state");
});

test("manifest: score / num_comments query affordances moved to the stats streams", () => {
	for (const g of GROUPS) {
		const e = mstream(g.entity).query?.range_filters ?? {};
		const s = mstream(g.stats).query?.range_filters ?? {};
		assert.equal("score" in e, false, `${g.entity} range score`);
		assert.equal("num_comments" in e, false, `${g.entity} range num_comments`);
		assert.equal("score" in s, true, `${g.stats} range score`);
		assert.equal("num_comments" in s, g.statsKeys.includes("num_comments"));
	}
});

test("manifest: breaking field removal is a 0.x minor bump from 0.3.13, not a 1.0 promotion", () => {
	const [major, minor] = manifest.version.split(".").map(Number);
	assert.equal(major, 0, "not a 1.0 promotion");
	assert.ok((minor ?? 0) >= 4, "at least the 0.4 minor bump from 0.3.13");
});

test("manifest schema properties match the zod schema keys for all eleven streams", async () => {
	const { SCHEMAS } = await import("./schemas.ts");
	for (const s of manifest.streams) {
		const zod = SCHEMAS[s.name] as unknown as {
			shape?: Record<string, unknown>;
		};
		assert.ok(zod?.shape, `zod schema for ${s.name}`);
		assert.deepEqual(
			Object.keys(s.schema.properties).sort(),
			Object.keys(zod.shape).sort(),
			`${s.name}: manifest vs zod`,
		);
	}
});
