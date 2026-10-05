// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
	assertUserFacingProgress,
	setConnectorDiagnosticSink,
} from "../../packages/polyfill-connectors/src/connector-diagnostic.ts";
import type {
	EmittedMessage,
	RecordData,
	StreamScope,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import type { EnsureSessionArgs } from "../../packages/polyfill-connectors/src/session-establish.ts";
import {
	collectStravaBrowser,
	ensureStravaSession,
	LOGIN_URL,
	probeStravaSession,
	type StravaCollectContext,
	TRAINING_URL,
} from "./index.ts";
import { validateRecord } from "./schemas.ts";

/** Run `fn` with diagnostics captured; returns the lines written. */
async function captureDiagnostics(fn: () => Promise<void>): Promise<string[]> {
	const lines: string[] = [];
	setConnectorDiagnosticSink((line) => lines.push(line));
	try {
		await fn();
	} finally {
		setConnectorDiagnosticSink(undefined);
	}
	return lines;
}

/** Parse the first `[strava_browser-diagnostic] coverage {...}` line. */
function coverageOf(lines: string[]): Record<string, string | number> {
	const prefix = "[strava_browser-diagnostic] coverage ";
	const line = lines.find((candidate) => candidate.startsWith(prefix));
	assert.ok(line, "a coverage diagnostic line was written");
	return JSON.parse(line.slice(prefix.length));
}

const ORIGIN = "https://www.strava.com";
const fixture = (name: string) =>
	readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const PAGES: Record<string, string> = {
	"1": fixture("training-activities-page-1.json"),
	"2": fixture("training-activities-page-2.json"),
};
const ACTIVITY_DETAIL = fixture("activity-detail-synthetic.html");
const ACTIVITY_HEARTRATE = fixture("activity-heartrate-stream-synthetic.json");
const GEAR_BIKES = fixture("gear-bikes-synthetic.json");
const manifest = (dir: string) =>
	JSON.parse(
		readFileSync(new URL(`../${dir}/manifest.json`, import.meta.url), "utf8"),
	);

type Fetcher = (url: URL, init?: RequestInit) => Response | Promise<Response>;

const json = (body: string, status = 200) =>
	new Response(body, {
		status,
		headers: { "content-type": "application/json; charset=utf-8" },
	});

/** strava.com's list, served from the fixtures by page number. */
const listFetcher =
	(pages = PAGES, log: string[] = []): Fetcher =>
	(url, init) => {
		log.push(url.search);
		const headers = new Headers(init?.headers);
		assert.equal(headers.get("X-Requested-With"), "XMLHttpRequest");
		assert.equal(init?.credentials, "include");
		assert.equal(url.pathname, "/athlete/training_activities");
		const body = pages[url.searchParams.get("page") ?? ""];
		return json(body ?? '{"models":[],"page":9,"perPage":3,"total":5}');
	};

/** Synthetic fixture account large enough to cross the existing detail budget. */
function syntheticActivityPages(count: number): Record<string, string> {
	const perPage = 20;
	const pages: Record<string, string> = {};
	const newest = Date.parse("2026-09-29T12:00:00Z");
	for (let offset = 0; offset < count; offset += perPage) {
		const models = Array.from(
			{ length: Math.min(perPage, count - offset) },
			(_, index) => {
				const position = offset + index;
				return {
					id: 91000000000 + count - position,
					sport_type: "Run",
					start_time: new Date(newest - position * 60_000).toISOString(),
					distance_raw: 5000,
					moving_time_raw: 1800,
					elapsed_time_raw: 1900,
					elevation_gain_raw: 12,
				};
			},
		);
		const page = offset / perPage + 1;
		pages[String(page)] = JSON.stringify({
			models,
			page,
			perPage,
			total: count,
		});
	}
	return pages;
}

/**
 * Runs page.evaluate callbacks in this process against a fake strava.com:
 * `location` and `fetch` are swapped in for the duration of the test.
 */
async function withStrava<T>(
	fetcher: Fetcher,
	run: () => Promise<T>,
	origin = ORIGIN,
	gearBikes = GEAR_BIKES,
	detailStatus: (activityId: string) => number = () => 200,
): Promise<T> {
	const savedFetch = globalThis.fetch;
	const savedLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
	const savedDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
	const savedPerformance = Object.getOwnPropertyDescriptor(
		globalThis,
		"performance",
	);
	Object.defineProperty(globalThis, "location", {
		configurable: true,
		value: { origin },
	});
	Object.defineProperty(globalThis, "document", {
		configurable: true,
		value: {
			querySelectorAll: () => [{ getAttribute: () => "/athletes/900001" }],
		},
	});
	Object.defineProperty(globalThis, "performance", {
		configurable: true,
		value: {
			getEntriesByType: () => [
				{ name: `${ORIGIN}/athletes/900001/gear/bikes` },
				{ name: `${ORIGIN}/athletes/900001/gear/shoes` },
			],
		},
	});
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(String(input), origin);
		if (/^\/activities\/\d+$/.test(url.pathname)) {
			const status = detailStatus(url.pathname.split("/").at(-1) ?? "");
			if (status !== 200) return new Response("", { status });
			return new Response(ACTIVITY_DETAIL, {
				headers: { "content-type": "text/html; charset=utf-8" },
			});
		}
		if (/^\/activities\/\d+\/streams$/.test(url.pathname)) {
			return json(ACTIVITY_HEARTRATE);
		}
		if (/^\/athletes\/\d+\/gear\/bikes$/.test(url.pathname)) {
			return json(gearBikes);
		}
		if (/^\/athletes\/\d+\/gear\/shoes$/.test(url.pathname)) {
			return json("[]");
		}
		return fetcher(url, init);
	}) as typeof fetch;
	try {
		return await run();
	} finally {
		globalThis.fetch = savedFetch;
		if (savedLocation) {
			Object.defineProperty(globalThis, "location", savedLocation);
		} else {
			Reflect.deleteProperty(globalThis, "location");
		}
		if (savedDocument) {
			Object.defineProperty(globalThis, "document", savedDocument);
		} else {
			Reflect.deleteProperty(globalThis, "document");
		}
		if (savedPerformance) {
			Object.defineProperty(globalThis, "performance", savedPerformance);
		} else {
			Reflect.deleteProperty(globalThis, "performance");
		}
	}
}

function fakePage(opts: { signedIn?: () => boolean; visits?: string[] } = {}) {
	const visits = opts.visits ?? [];
	return {
		goto: async (url: string) => {
			visits.push(url);
			return null;
		},
		evaluate: async (fn: (arg: unknown) => unknown, arg: unknown) => fn(arg),
		context: () => ({
			request: {
				get: async (
					url: string,
					init?: { headers?: Record<string, string> },
				) => {
					// strava.com answers the list URL with HTML unless asked as XHR.
					assert.equal(init?.headers?.["X-Requested-With"], "XMLHttpRequest");
					const u = new URL(url);
					assert.equal(
						u.origin + u.pathname,
						`${ORIGIN}/athlete/training_activities`,
					);
					const signedIn = opts.signedIn?.() === true;
					return {
						status: () => (signedIn ? 200 : 401),
						text: async () =>
							signedIn ? (PAGES["1"] as string) : '{"message":"Unauthorized"}',
						dispose: async () => {},
					};
				},
			},
		}),
	} as unknown as StravaCollectContext["page"];
}

function harness(
	names: string[],
	state: Record<string, unknown> = {},
	timeRange?: { since?: string; until?: string },
	collectionMode?: "full_refresh" | "incremental",
) {
	const messages: EmittedMessage[] = [];
	const records: Array<{ stream: string; data: RecordData }> = [];
	const ctx: StravaCollectContext = {
		collectionMode,
		page: fakePage(),
		state,
		requested: new Map(
			names.map((name) => [
				name,
				{
					name,
					...(timeRange ? { time_range: timeRange } : {}),
				} as StreamScope,
			]),
		),
		emit: async (message: EmittedMessage) => {
			messages.push(message);
		},
		emitRecord: async (stream: string, data: RecordData) => {
			const parsed = validateRecord(stream, data);
			assert.equal(parsed.ok, true, JSON.stringify(parsed));
			records.push({ stream, data });
		},
	};
	const of = (stream: string) =>
		records.filter((r) => r.stream === stream).map((r) => r.data);
	const cursor = () =>
		(messages.find((m) => m.type === "STATE") as { cursor: unknown }).cursor;
	const skips = () => messages.filter((m) => m.type === "SKIP_RESULT");
	return { ctx, messages, of, cursor, skips };
}

const FAST = { pageDelayMs: 0, activityDelayMs: 0, rateLimitDelayMs: 0 };
const BOTH = ["activities"];

test("shares the strava source and its stream names", () => {
	// The contract identity is asserted against the published declaration in
	// packages/connector-installer-core/source-declaration.test.mjs.
	const file = manifest("strava");
	const browser = manifest("strava_browser");
	assert.equal(browser.source.id, file.source.id);
	assert.equal(browser.connector_key, "strava-browser");
	assert.ok(browser.connector_id.endsWith(`/${browser.connector_key}`));
	assert.equal(browser.setup, undefined);
	assert.deepEqual(
		browser.streams.map((s: { name: string }) => s.name),
		file.streams.map((s: { name: string }) => s.name),
	);
});

test("incremental discovery emits new summaries and stops at a known boundary", async () => {
	const log: string[] = [];
	const h = harness(BOTH, {
		activities: {
			known_ids: ["90000000003", "90000000002", "90000000001"],
			pending_detail_ids: [],
			list_complete: true,
			requested_since: null,
		},
	});
	await withStrava(listFetcher(PAGES, log), () =>
		collectStravaBrowser(h.ctx, FAST),
	);
	assert.equal(log.length, 1);
	assert.deepEqual(
		[...new Set(h.of("activities").map((a) => a.id))],
		["90000000005", "90000000004"],
	);
	assert.deepEqual(h.cursor(), {
		known_ids: [
			"90000000003",
			"90000000002",
			"90000000001",
			"90000000005",
			"90000000004",
		],
		pending_detail_ids: [],
		list_complete: true,
		requested_since: null,
	});
});

test("a full refresh ignores the cursor", async () => {
	const h = harness(
		["activities"],
		{
			activities: {
				known_ids: ["90000000001"],
				pending_detail_ids: [],
				list_complete: false,
			},
		},
		undefined,
		"full_refresh",
	);
	await withStrava(listFetcher(), () => collectStravaBrowser(h.ctx, FAST));
	assert.equal(h.of("activities").length, 5);
});

test("activity records include heart-rate summary and calories from detail resources", async () => {
	const initial = harness(BOTH);
	await withStrava(listFetcher(), () =>
		collectStravaBrowser(initial.ctx, FAST),
	);
	const h = harness(BOTH, { activities: initial.cursor() });
	await withStrava(listFetcher(), () => collectStravaBrowser(h.ctx, FAST));
	const newest = h
		.of("activities")
		.find((record) => record.id === "90000000005");
	assert.deepEqual(
		{
			average_heartrate: newest?.average_heartrate,
			max_heartrate: newest?.max_heartrate,
			calories_kcal: newest?.calories_kcal,
			gear: newest?.gear,
		},
		{
			average_heartrate: 81.2,
			max_heartrate: 90,
			calories_kcal: 42,
			gear: "Synthetic Test Bike",
		},
	);
});

test("unmatched gear ids keep activities and report reason and count through diagnostics", async () => {
	const initial = harness(BOTH);
	await withStrava(listFetcher(), () =>
		collectStravaBrowser(initial.ctx, FAST),
	);
	const h = harness(BOTH, { activities: initial.cursor() });
	const lines = await captureDiagnostics(() =>
		withStrava(
			listFetcher(),
			() => collectStravaBrowser(h.ctx, FAST),
			ORIGIN,
			"[]",
		),
	);
	assert.equal(h.of("activities").length, 5);
	assert.equal(
		h.of("activities").every((record) => record.gear === null),
		true,
	);
	assert.equal(h.skips().length, 0);
	const coverage = coverageOf(lines);
	assert.equal(coverage.gear_name_unresolved, 1);
	assert.equal(coverage.gear_name_reasons, "gear_id_unmatched:1");
	assertUserFacingProgress(h.messages);
});

test("detail work resumes from the pending queue without repeating summaries", async () => {
	const initial = harness(BOTH);
	await withStrava(listFetcher(), () =>
		collectStravaBrowser(initial.ctx, FAST),
	);
	const first = harness(BOTH, { activities: initial.cursor() });
	await withStrava(listFetcher(), () =>
		collectStravaBrowser(first.ctx, { ...FAST, maxDetails: 2 }),
	);
	assert.deepEqual(
		first.of("activities").map((record) => record.id),
		["90000000005", "90000000004"],
	);
	assert.equal(first.skips().length, 0);
	assert.deepEqual(
		(first.cursor() as { pending_detail_ids: string[] }).pending_detail_ids,
		["90000000003", "90000000002", "90000000001"],
	);

	const second = harness(BOTH, {
		activities: first.cursor() as Record<string, unknown>,
	});
	await withStrava(listFetcher(), () =>
		collectStravaBrowser(second.ctx, { ...FAST, maxDetails: 10 }),
	);
	assert.deepEqual(
		second.of("activities").map((record) => record.id),
		["90000000003", "90000000002", "90000000001"],
	);
});

test("a failed activity detail stays queued while later details continue", async () => {
	const initial = harness(BOTH);
	await withStrava(listFetcher(), () =>
		collectStravaBrowser(initial.ctx, FAST),
	);
	const firstPending = (initial.cursor() as { pending_detail_ids: string[] })
		.pending_detail_ids[0];
	const h = harness(BOTH, { activities: initial.cursor() });
	await withStrava(
		listFetcher(),
		() => collectStravaBrowser(h.ctx, FAST),
		ORIGIN,
		GEAR_BIKES,
		(id) => (id === firstPending ? 404 : 200),
	);
	assert.equal(h.of("activities").length, 4);
	assert.deepEqual(
		(h.cursor() as { pending_detail_ids: string[] }).pending_detail_ids,
		[firstPending],
	);
});

test("an interrupted detail run checkpoints pending work for the next run", async () => {
	const initial = harness(BOTH);
	await withStrava(listFetcher(), () =>
		collectStravaBrowser(initial.ctx, FAST),
	);
	const queued = (initial.cursor() as { pending_detail_ids: string[] })
		.pending_detail_ids;
	const interrupted = harness(BOTH, { activities: initial.cursor() });
	await withStrava(
		listFetcher(),
		() => collectStravaBrowser(interrupted.ctx, FAST),
		ORIGIN,
		GEAR_BIKES,
		() => 500,
	);
	assert.equal(interrupted.of("activities").length, 0);
	assert.deepEqual(interrupted.skips()[0]?.reason, "collection_interrupted");
	assert.deepEqual(
		(interrupted.cursor() as { pending_detail_ids: string[] })
			.pending_detail_ids,
		queued,
	);

	const resumed = harness(BOTH, { activities: interrupted.cursor() });
	await withStrava(listFetcher(), () =>
		collectStravaBrowser(resumed.ctx, FAST),
	);
	assert.equal(resumed.of("activities").length, 5);
	assert.deepEqual(
		(resumed.cursor() as { pending_detail_ids: string[] }).pending_detail_ids,
		[],
	);
});

test("details completed before an interruption are stored while the remainder resumes", async () => {
	const initial = harness(BOTH);
	await withStrava(listFetcher(), () =>
		collectStravaBrowser(initial.ctx, FAST),
	);
	const interrupted = harness(BOTH, { activities: initial.cursor() });
	let requests = 0;
	await withStrava(
		listFetcher(),
		() => collectStravaBrowser(interrupted.ctx, FAST),
		ORIGIN,
		GEAR_BIKES,
		() => (++requests === 3 ? 500 : 200),
	);
	assert.equal(interrupted.of("activities").length, 2);
	const remaining = (interrupted.cursor() as { pending_detail_ids: string[] })
		.pending_detail_ids;
	assert.equal(remaining.length, 3);

	const resumed = harness(BOTH, { activities: interrupted.cursor() });
	await withStrava(listFetcher(), () =>
		collectStravaBrowser(resumed.ctx, FAST),
	);
	assert.equal(resumed.of("activities").length, 3);
	assert.deepEqual(
		(resumed.cursor() as { pending_detail_ids: string[] }).pending_detail_ids,
		[],
	);
});

test("a new activity arriving during backfill emits its summary and joins the queue", async () => {
	const initial = harness(BOTH);
	await withStrava(listFetcher(), () =>
		collectStravaBrowser(initial.ctx, FAST),
	);
	const pageOne = JSON.parse(PAGES["1"] as string) as {
		models: Array<Record<string, unknown>>;
		perPage: number;
		total: number;
	};
	pageOne.models.unshift({
		...pageOne.models[0],
		id: 90000000006,
		id_str: "90000000006",
		start_time: "2026-09-21T13:30:00+0000",
	});
	pageOne.total = 6;
	const pageTwo = JSON.parse(PAGES["2"] as string) as { total: number };
	pageTwo.total = 6;
	const h = harness(BOTH, { activities: initial.cursor() });
	await withStrava(
		listFetcher({ "1": JSON.stringify(pageOne), "2": JSON.stringify(pageTwo) }),
		() => collectStravaBrowser(h.ctx, FAST),
	);
	const newActivity = h
		.of("activities")
		.filter((record) => record.id === "90000000006");
	assert.equal(newActivity.length, 2);
	assert.equal(newActivity[0]?.average_heartrate, null);
	assert.equal(newActivity[1]?.average_heartrate, 81.2);
	assert.ok(
		!(
			h.cursor() as { pending_detail_ids: string[] }
		).pending_detail_ids.includes("90000000006"),
	);
});

test("a complete run reports redacted coverage and requested time bounds", async () => {
	const h = harness(
		["activities"],
		{},
		{
			since: "2026-09-01T00:00:00Z",
			until: "2026-10-01T00:00:00Z",
		},
	);
	const lines = await captureDiagnostics(() =>
		withStrava(listFetcher(), () => collectStravaBrowser(h.ctx, FAST)),
	);
	const coverage = coverageOf(lines);
	assert.equal(coverage.status, "complete");
	assert.equal(coverage.pages_read, 2);
	assert.equal(coverage.unreadable, 0);
	assert.equal(coverage.window_requested_from, "2026-09-01T00:00:00Z");
	assert.equal(coverage.window_requested_to, "2026-10-01T00:00:00Z");
	assert.match(String(coverage.window_covered_from), /^2026-09-01T19:00:00Z/);
	assert.equal(coverage.window_covered_to, "2026-09-20T13:30:00Z");
	assert.doesNotMatch(lines.join("\n"), /9000000000/);

	const summary = h.messages.find(
		(message): message is Extract<EmittedMessage, { type: "PROGRESS" }> =>
			message.type === "PROGRESS" &&
			message.message.startsWith("Finished reading Strava activities"),
	);
	assert.ok(summary, "a closing plain-English summary is shown to the owner");
	assert.match(
		summary.message,
		/^Finished reading Strava activities: \d+ saved/,
	);
	assertUserFacingProgress(h.messages);
});

test("time bounds compare start instants, not calendar days", async () => {
	const startOf = (record: RecordData) =>
		new Date(record.start_time as string).toISOString();
	const until = harness(["activities"], {}, { until: "2026-09-20T14:00:00Z" });
	await withStrava(listFetcher(), () => collectStravaBrowser(until.ctx, FAST));
	assert.ok(
		until.of("activities").map(startOf).includes("2026-09-20T13:30:00.000Z"),
		"an activity before the until instant on the same day is kept",
	);
	const since = harness(["activities"], {}, { since: "2026-09-20T14:00:00Z" });
	await withStrava(listFetcher(), () => collectStravaBrowser(since.ctx, FAST));
	assert.ok(
		!since.of("activities").map(startOf).includes("2026-09-20T13:30:00.000Z"),
		"an activity before the since instant on the same day is dropped",
	);
});

test("a since moved earlier by under a millisecond re-walks the full list", async () => {
	const log: string[] = [];
	const h = harness(
		BOTH,
		{
			activities: {
				known_ids: ["90000000005", "90000000004"],
				pending_detail_ids: [],
				list_complete: true,
				requested_since: "2026-09-01T00:00:00.0005Z",
			},
		},
		{ since: "2026-09-01T00:00:00Z" },
	);
	await withStrava(listFetcher(PAGES, log), () =>
		collectStravaBrowser(h.ctx, FAST),
	);
	assert.equal(log.length, 2, "both list pages are read again");
});

test("an unreadable row marks the run summary partial", async () => {
	const page = JSON.parse(PAGES["1"] as string) as { models: unknown[] };
	page.models.push({});
	const h = harness(["activities"]);
	const lines = await captureDiagnostics(() =>
		withStrava(listFetcher({ ...PAGES, "1": JSON.stringify(page) }), () =>
			collectStravaBrowser(h.ctx, FAST),
		),
	);
	const coverage = coverageOf(lines);
	assert.equal(coverage.status, "partial");
	assert.equal(coverage.unreadable, 1);
});

test("off strava.com, collection navigates to the training page first", async () => {
	const visits: string[] = [];
	const h = harness(["activities"]);
	h.ctx.page = fakePage({ visits });
	// location stays on another origin, so the fetch refuses to run there.
	await withStrava(
		() => json(PAGES["1"] as string),
		() => collectStravaBrowser(h.ctx, FAST),
		"https://example.com",
	);
	assert.deepEqual(visits, [TRAINING_URL]);
	assert.equal(h.of("activities").length, 0);
	assert.equal(h.skips()[0]?.reason, "collection_interrupted");
});

test("the session probe reads the signed-in athlete meta tag", async () => {
	assert.equal(
		await probeStravaSession(fakePage({ signedIn: () => true })),
		true,
	);
	assert.equal(
		await probeStravaSession(fakePage({ signedIn: () => false })),
		false,
	);
});

test("a live session needs no sign-in", async () => {
	const visits: string[] = [];
	await ensureStravaSession(
		Object.assign(Object.create(null) as EnsureSessionArgs, {
			page: fakePage({ signedIn: () => true, visits }),
			assist: async () => {
				throw new Error("unexpected assistance");
			},
		}),
	);
	assert.deepEqual(visits, []);
});

test("without a session, the owner signs in on the login page", async () => {
	let signedIn = false;
	const visits: string[] = [];
	const statuses: string[] = [];
	await ensureStravaSession(
		Object.assign(Object.create(null) as EnsureSessionArgs, {
			page: fakePage({ signedIn: () => signedIn, visits }),
			assist: async () => {
				signedIn = true;
				return "assist-1";
			},
			completeAssistance: async (_id: string, status: string) => {
				statuses.push(status);
			},
		}),
	);
	assert.deepEqual(visits, [LOGIN_URL]);
	assert.deepEqual(statuses, ["resolved"]);
});

test("the probe accepts any signed-in JSON, so a changed list fails in collection, not at sign-in", async () => {
	const page = {
		context: () => ({
			request: {
				get: async () => ({
					status: () => 200,
					text: async () => '{"activities":[]}',
					dispose: async () => {},
				}),
			},
		}),
	} as unknown as StravaCollectContext["page"];
	assert.equal(await probeStravaSession(page), true);
});

test("a first run emits the full 2,150-activity summary inventory", async () => {
	const pages = syntheticActivityPages(2150);
	const h = harness(BOTH);
	await withStrava(listFetcher(pages), () => collectStravaBrowser(h.ctx, FAST));
	assert.equal(h.of("activities").length, 2150);
	assert.equal(
		new Set(h.of("activities").map((record) => record.id)).size,
		2150,
	);
	assert.ok(
		h.of("activities").every((record) => record.average_heartrate === null),
	);
});

test("detail backfill updates the keyed inventory in batches of 100", async () => {
	let state: unknown = {};
	const stored = new Map<string, RecordData>();
	let firstCount = 0;
	for (let run = 0; run < 23; run += 1) {
		const h = harness(BOTH, { activities: state });
		await withStrava(listFetcher(syntheticActivityPages(2150)), () =>
			collectStravaBrowser(h.ctx, FAST),
		);
		const records = h.of("activities");
		if (run === 0) {
			firstCount = records.length;
			assert.equal(firstCount, 2150);
		} else {
			assert.equal(records.length, run < 22 ? 100 : 50);
		}
		for (const record of records) stored.set(String(record.id), record);
		state = h.cursor();
	}
	assert.equal(stored.size, 2150);
	assert.equal(firstCount, 2150);
	assert.ok(
		[...stored.values()].every((record) => record.average_heartrate === 81.2),
	);
});
