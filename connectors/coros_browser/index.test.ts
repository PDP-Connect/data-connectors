// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import type { EmittedMessage } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { type Answer, coded, corosApi, fixtureData } from "./fake-coros.ts";
import {
	activitiesPath,
	addDays,
	type CorosCollectContext,
	classify,
	collectCorosBrowser,
	type DayCursor,
	dayDetailPath,
	OVERLAP_DAYS,
	type PageFetch,
	pageFetch,
	planDays,
	probeSession,
	readCursor,
	schedulePath,
	windowsOf,
} from "./index.ts";
import type { Stream } from "./schemas.ts";

const NOW = new Date("2026-11-10T18:00:00.000Z");
const TODAY = "2026-11-10";
const FAST = { requestDelayMs: 0, refreshSettleMs: 0, sleep: async () => {} };

const response = (answer: Answer, region = 1): PageFetch => ({
	kind: "response",
	retryAfter: null,
	region,
	...answer,
});

/** A signed-in Training Hub page whose every read the fake API answers, recording the paths read. */
function fakePage(api: (path: string) => Answer) {
	const paths: string[] = [];
	const gotos: string[] = [];
	const page = {
		goto: async (url: string) => {
			gotos.push(url);
			return null;
		},
		evaluate: async (_fn: unknown, arg: { path: string }) => {
			paths.push(arg.path);
			return response(api(arg.path));
		},
	} as unknown as CorosCollectContext["page"];
	return { page, paths, gotos };
}

type Scope = { since?: string; until?: string };
function context(
	page: CorosCollectContext["page"],
	streams: Partial<Record<Stream, Scope | undefined>>,
	state: Record<string, unknown> = {},
) {
	const messages: EmittedMessage[] = [];
	const records: Array<{ stream: string; data: Record<string, unknown> }> = [];
	const ctx: CorosCollectContext = {
		page,
		state,
		collectionMode: "incremental",
		requested: new Map(
			Object.entries(streams).map(([name, time_range]) => [
				name,
				time_range ? { name, time_range } : { name },
			]),
		) as CorosCollectContext["requested"],
		emit: async (m) => {
			messages.push(m);
		},
		emitRecord: async (stream, data) => {
			records.push({ stream, data });
		},
	};
	return { ctx, messages, records };
}

const idsOf = (
	records: Array<{ stream: string; data: Record<string, unknown> }>,
	stream: Stream,
): string[] =>
	records.filter((r) => r.stream === stream).map((r) => String(r.data.id));
const statesOf = (messages: EmittedMessage[]) =>
	Object.fromEntries(
		messages.flatMap((m) =>
			m.type === "STATE" ? [[String(m.stream), m.cursor]] : [],
		),
	);
const skipsOf = (messages: EmittedMessage[]) =>
	messages.flatMap((m) =>
		m.type === "SKIP_RESULT" ? [[m.stream, m.reason, m.recovery_hint]] : [],
	);

// ── Classification ─────────────────────────────────────────────────────────
test("classify: COROS's envelope, its expired and invalid sessions, and plain HTTP failures", () => {
	const okAnswer = classify(
		response({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({ result: "0000", data: { userId: "1" } }),
		}),
	);
	assert.deepEqual(okAnswer, { ok: true, data: { userId: "1" }, region: 1 });
	const expired = classify(response(coded("1019")));
	assert.equal(expired.ok === false && expired.reason, "sign_in_required");
	assert.equal(expired.ok === false && expired.refresh, true);
	const invalid = classify(response(coded("ACCESS_TOKEN_IS_INVALID")));
	assert.equal(invalid.ok === false && invalid.reason, "sign_in_required");
	assert.equal(invalid.ok === false && invalid.refresh, undefined);
	const other = classify(response(coded("5025")));
	assert.equal(other.ok === false && other.reason, "source_unreadable");
	assert.match(other.ok === false ? other.message : "", /5025/);
	const signedOut = classify({ kind: "no_token" });
	assert.equal(signedOut.ok === false && signedOut.reason, "sign_in_required");
	const limited = classify({
		kind: "response",
		status: 429,
		contentType: "",
		body: "",
		retryAfter: "7",
		region: 1,
	});
	assert.equal(limited.ok === false && limited.retryAfterMs, 7000);
	const down = classify(
		response({ status: 502, contentType: "text/html", body: "" }),
	);
	assert.equal(down.ok === false && down.reason, "collection_interrupted");
	const html = classify(
		response({
			status: 200,
			contentType: "text/html",
			body: "<!doctype html>",
		}),
	);
	assert.equal(html.ok === false && html.reason, "source_unreadable");
	const region = classify({ kind: "no_region" });
	assert.equal(region.ok === false && region.reason, "source_unreadable");
});

// ── The in-page fetch, run against a stubbed page ──────────────────────────
type Globals = Record<"location" | "document" | "window" | "fetch", unknown>;
async function inPage<T>(globals: Globals, run: () => Promise<T>): Promise<T> {
	const saved = new Map<string, PropertyDescriptor | undefined>();
	for (const [key, value] of Object.entries(globals)) {
		saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, {
			value,
			configurable: true,
			writable: true,
		});
	}
	try {
		return await run();
	} finally {
		for (const [key, descriptor] of saved) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
	}
}
/** A page whose evaluate runs the connector's own in-page function, here, against the stubbed globals. */
const evaluatingPage = {
	evaluate: async (fn: (arg: unknown) => unknown, arg: unknown) => fn(arg),
} as unknown as CorosCollectContext["page"];

test("pageFetch: reads the token and region cookies, calls the region's host with the app's headers, returns no token", async () => {
	const calls: Array<{ url: string; init: RequestInit }> = [];
	const result = await inPage(
		{
			location: { origin: "https://t.coros.com" },
			document: {
				cookie: "_ga=1; CPL-coros-token=tok%3Den; CPL-coros-region=3",
			},
			window: { __INITIAL_STATE__: '{"regionId":1}' },
			fetch: async (url: string, init: RequestInit) => {
				calls.push({ url, init });
				return new Response(JSON.stringify({ result: "0000", data: {} }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			},
		},
		() => pageFetch(evaluatingPage, "/account/query"),
	);
	assert.equal(calls.length, 1);
	assert.ok(calls[0]?.url.startsWith("https://teameuapi.coros.com/"));
	assert.ok(calls[0]?.url.endsWith("/account/query"));
	const headers = calls[0]?.init.headers as Record<string, string>;
	assert.equal(headers.accessToken, "tok=en");
	assert.equal(calls[0]?.init.credentials, "include");
	assert.equal(result.kind, "response");
	assert.equal(result.kind === "response" && result.region, 3);
	assert.equal(
		JSON.stringify(result).includes("tok"),
		false,
		"the token never leaves the page",
	);
});

test("pageFetch: without a region cookie the app's initial state picks the host; signed out it reads nothing", async () => {
	const urls: string[] = [];
	const fetch = async (url: string) => {
		urls.push(url);
		return new Response("{}", { status: 200 });
	};
	await inPage(
		{
			location: { origin: "https://t.coros.com" },
			document: { cookie: "CPL-coros-token=abc" },
			window: { __INITIAL_STATE__: { regionId: 4 } },
			fetch,
		},
		() => pageFetch(evaluatingPage, "/dashboard/query"),
	);
	assert.ok(urls[0]?.startsWith("https://teamsgapi.coros.com/"));
	const signedOut = await inPage(
		{
			location: { origin: "https://t.coros.com" },
			document: { cookie: "CPL-coros-region=1" },
			window: {},
			fetch,
		},
		() => pageFetch(evaluatingPage, "/account/query"),
	);
	assert.deepEqual(signedOut, { kind: "no_token" });
	const elsewhere = await inPage(
		{
			location: { origin: "https://www.coros.com" },
			document: { cookie: "" },
			window: {},
			fetch,
		},
		() => pageFetch(evaluatingPage, "/account/query"),
	);
	assert.deepEqual(elsewhere, {
		kind: "wrong_origin",
		origin: "https://www.coros.com",
	});
	assert.equal(urls.length, 1);
});

test("probeSession: off the app it opens Training Hub once and reads again", async () => {
	let calls = 0;
	const gotos: string[] = [];
	const page = {
		goto: async (url: string) => {
			gotos.push(url);
			return null;
		},
		evaluate: async () => {
			calls += 1;
			return calls === 1
				? { kind: "wrong_origin", origin: "about:blank" }
				: response(corosApi()("/account/query"));
		},
	} as unknown as CorosCollectContext["page"];
	assert.equal(await probeSession(page), true);
	assert.deepEqual(gotos, ["https://t.coros.com/"]);
});

// ── Days and cursors ───────────────────────────────────────────────────────
test("planDays: first runs, resumed runs with overlap, grants that move", () => {
	assert.deepEqual(planDays("activities", null, undefined, false, TODAY), {
		from: "2016-01-01",
		to: "2026-11-11",
		floor: "2016-01-01",
	});
	assert.deepEqual(planDays("daily_metrics", null, undefined, false, TODAY), {
		from: "2026-05-14",
		to: "2026-11-11",
		floor: "2026-05-14",
	});
	assert.deepEqual(
		planDays("planned_workouts", null, undefined, false, TODAY),
		{
			from: "2026-10-13",
			to: "2026-12-08",
			floor: "2026-10-13",
		},
	);
	const cursor: DayCursor = {
		v: 1,
		floor: "2016-01-01",
		next_day: "2026-11-01",
	};
	assert.deepEqual(planDays("activities", cursor, undefined, false, TODAY), {
		from: addDays("2026-11-01", -OVERLAP_DAYS.activities),
		to: "2026-11-11",
		floor: "2016-01-01",
		kept: "2026-11-01",
	});
	// full_refresh reads from the start again.
	assert.equal(
		planDays("activities", cursor, undefined, true, TODAY).from,
		"2016-01-01",
	);
	// A grant start a day early for the time zone, and an end a day late.
	assert.deepEqual(
		planDays(
			"daily_metrics",
			null,
			{ since: "2026-10-01T00:00:00Z", until: "2026-10-15" },
			false,
			TODAY,
		),
		{ from: "2026-09-30", to: "2026-10-16", floor: "2026-09-30" },
	);
	// A grant reaching back past the cursor's floor reads afresh from it.
	const late: DayCursor = { v: 1, floor: "2026-10-01", next_day: "2026-11-01" };
	assert.equal(
		planDays("daily_metrics", late, { since: "2026-09-01" }, false, TODAY).from,
		"2026-08-31",
	);
});

test("readCursor keeps only a cursor of its own shape", () => {
	assert.deepEqual(
		readCursor({ v: 1, floor: "2026-01-01", next_day: "2026-02-01" }),
		{
			v: 1,
			floor: "2026-01-01",
			next_day: "2026-02-01",
		},
	);
	assert.equal(
		readCursor({ v: 2, floor: "2026-01-01", next_day: "2026-02-01" }),
		null,
	);
	assert.equal(
		readCursor({ v: 1, floor: "2026-03-01", next_day: "2026-02-01" }),
		null,
	);
	assert.equal(
		readCursor({ v: 1, floor: "2026-02-30", next_day: "2026-03-01" }),
		null,
	);
	assert.equal(readCursor("x"), null);
});

test("windowsOf covers the days once, oldest first", () => {
	assert.deepEqual(windowsOf("2026-01-01", "2026-01-10", 4), [
		{ from: "2026-01-01", to: "2026-01-04" },
		{ from: "2026-01-05", to: "2026-01-08" },
		{ from: "2026-01-09", to: "2026-01-10" },
	]);
	assert.deepEqual(windowsOf("2026-01-02", "2026-01-01", 4), []);
});

test("paths name COROS's own query parameters", () => {
	const window = { from: "2026-11-01", to: "2026-11-28" };
	assert.equal(
		activitiesPath(window, 2),
		"/activity/query?size=50&pageNumber=2&startDay=20261101&endDay=20261128",
	);
	assert.equal(
		dayDetailPath(window),
		"/analyse/dayDetail/query?startDay=20261101&endDay=20261128",
	);
	assert.equal(
		schedulePath(window),
		"/training/schedule/query?startDate=20261101&endDate=20261128&supportRestExercise=1",
	);
});

// ── Collect ────────────────────────────────────────────────────────────────
const EVERY = {
	profile: undefined,
	activities: undefined,
	daily_metrics: undefined,
	planned_workouts: undefined,
};

test("collect: a first run delivers every stream and a cursor for each day stream", async () => {
	const { page, paths } = fakePage(corosApi());
	const { ctx, messages, records } = context(page, EVERY);
	await collectCorosBrowser(ctx, FAST, NOW);
	assert.deepEqual(idsOf(records, "profile"), ["472000000000000101"]);
	assert.deepEqual(idsOf(records, "activities"), [
		"476000000000000201",
		"476000000000000203",
		"476000000000000202",
	]);
	assert.deepEqual(idsOf(records, "daily_metrics"), [
		"2026-11-07",
		"2026-11-08",
		"2026-11-09",
	]);
	assert.deepEqual(idsOf(records, "planned_workouts"), [
		"2026-11-08::3",
		"2026-11-12::4",
	]);
	assert.deepEqual(skipsOf(messages), []);
	assert.deepEqual(statesOf(messages), {
		activities: { v: 1, floor: "2016-01-01", next_day: "2026-11-12" },
		daily_metrics: { v: 1, floor: "2026-05-14", next_day: "2026-11-12" },
		planned_workouts: { v: 1, floor: "2026-10-13", next_day: "2026-12-09" },
	});
	assert.equal(paths[0], "/account/query");
	// Only the five read endpoints, never a write.
	assert.ok(
		paths.every(
			(p) =>
				p === "/account/query" ||
				p === "/dashboard/query" ||
				p.startsWith("/activity/query?") ||
				p.startsWith("/analyse/dayDetail/query?") ||
				p.startsWith("/training/schedule/query?"),
		),
	);
	assert.ok(paths.some((p) => p.startsWith("/activity/query")));
	assert.ok(paths.some((p) => p.startsWith("/analyse/dayDetail/query")));
	assert.ok(paths.some((p) => p.startsWith("/training/schedule/query")));
});

test("collect: a resumed run reads from the overlap before its cursor only", async () => {
	const { page, paths } = fakePage(corosApi());
	const state = {
		activities: { v: 1, floor: "2016-01-01", next_day: "2026-11-09" },
	};
	const { ctx, records } = context(page, { activities: undefined }, state);
	await collectCorosBrowser(ctx, FAST, NOW);
	assert.deepEqual(
		paths.filter((p) => p.startsWith("/activity/query")),
		["/activity/query?size=50&pageNumber=1&startDay=20261026&endDay=20261111"],
	);
	// The strength session on 20 October is before the overlap.
	assert.deepEqual(idsOf(records, "activities"), [
		"476000000000000203",
		"476000000000000202",
	]);
});

test("collect: a full page of activities reads the next page of the window", async () => {
	const data = fixtureData();
	const base = data.activities[1] as Record<string, unknown>;
	data.activities = Array.from({ length: 51 }, (_, i) => ({
		...base,
		labelId: `47600000000000${String(1000 + i)}`,
		startTime: 1794151800 - i * 60,
	}));
	const { page, paths } = fakePage(corosApi(data));
	const state = {
		activities: { v: 1, floor: "2016-01-01", next_day: "2026-11-09" },
	};
	const { ctx, records } = context(page, { activities: undefined }, state);
	await collectCorosBrowser(ctx, FAST, NOW);
	assert.equal(idsOf(records, "activities").length, 51);
	assert.ok(paths.some((p) => p.includes("pageNumber=2")));
});

test("collect: an expired session reloads the app once and goes on", async () => {
	let expired = 1;
	const { page, gotos } = fakePage(
		corosApi(fixtureData(), (_data, path) => {
			if (path.startsWith("/dashboard/query") && expired > 0) {
				expired -= 1;
				return coded("1019");
			}
			return undefined;
		}),
	);
	const { ctx, messages, records } = context(page, { profile: undefined });
	await collectCorosBrowser(ctx, FAST, NOW);
	assert.deepEqual(gotos, ["https://t.coros.com/"]);
	assert.deepEqual(idsOf(records, "profile"), ["472000000000000101"]);
	assert.deepEqual(skipsOf(messages), []);
});

test("collect: a lost session stops every stream with sign_in_required and keeps cursors", async () => {
	const { page } = fakePage(() => coded("ACCESS_TOKEN_IS_INVALID"));
	const state = {
		daily_metrics: { v: 1, floor: "2026-05-14", next_day: "2026-11-01" },
	};
	const { ctx, messages, records } = context(page, EVERY, state);
	await collectCorosBrowser(ctx, FAST, NOW);
	assert.equal(records.length, 0);
	const skips = skipsOf(messages);
	assert.equal(skips.length, 4);
	for (const [, reason, hint] of skips) {
		assert.equal(reason, "sign_in_required");
		assert.deepEqual(hint, { action: "refresh_credentials", retryable: false });
	}
	assert.deepEqual(statesOf(messages), {});
});

test("collect: an outage partway keeps what was read and moves the cursor only over it", async () => {
	const { page } = fakePage(
		corosApi(fixtureData(), (_data, path) =>
			path.includes("startDay=20261108")
				? { status: 503, contentType: "text/html", body: "" }
				: undefined,
		),
	);
	const { ctx, messages, records } = context(page, {
		daily_metrics: { since: "2026-10-12" },
	});
	await collectCorosBrowser(ctx, FAST, NOW);
	// Windows of 28 days from 11 October: the first ends 7 November, the second fails.
	assert.deepEqual(idsOf(records, "daily_metrics"), ["2026-11-07"]);
	assert.deepEqual(skipsOf(messages), [
		[
			"daily_metrics",
			"collection_interrupted",
			{ action: "retry_by_runtime", retryable: true },
		],
	]);
	assert.deepEqual(statesOf(messages), {
		daily_metrics: { v: 1, floor: "2026-10-11", next_day: "2026-11-08" },
	});
});

test("collect: rows none of which parse mean COROS changed shape: source_unreadable, nothing emitted", async () => {
	const data = fixtureData();
	data.days = [{ happenDay: "20261108.5" }, { happenDay: "20261109.5" }];
	const { page } = fakePage(corosApi(data));
	const { ctx, messages, records } = context(page, {
		daily_metrics: undefined,
	});
	await collectCorosBrowser(ctx, FAST, NOW);
	assert.equal(records.length, 0);
	assert.deepEqual(skipsOf(messages)[0]?.slice(0, 2), [
		"daily_metrics",
		"source_unreadable",
	]);
});

test("collect: one unreadable row among good ones is counted, not emitted", async () => {
	const data = fixtureData();
	const base = data.activities[1] as Record<string, unknown>;
	data.activities.push({ ...base, labelId: "476000000000000299", avgHr: 900 });
	const { page } = fakePage(corosApi(data));
	const { ctx, messages, records } = context(page, { activities: undefined });
	await collectCorosBrowser(ctx, FAST, NOW);
	assert.equal(idsOf(records, "activities").length, 3);
	const progress = messages.find((m) => m.type === "PROGRESS");
	assert.equal(progress?.type === "PROGRESS" && progress.count, 1);
	assert.deepEqual(skipsOf(messages), []);
});

test("collect: the request budget stops the run with source_limit_reached", async () => {
	const { page } = fakePage(corosApi());
	const { ctx, messages } = context(page, EVERY);
	await collectCorosBrowser(ctx, { ...FAST, maxRequestsPerRun: 5 }, NOW);
	const skips = skipsOf(messages);
	assert.ok(skips.some(([, reason]) => reason === "source_limit_reached"));
	assert.deepEqual(skips.at(-1)?.slice(0, 2), [
		"planned_workouts",
		"source_limit_reached",
	]);
});
