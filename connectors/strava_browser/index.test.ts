// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
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

/**
 * Runs page.evaluate callbacks in this process against a fake strava.com:
 * `location` and `fetch` are swapped in for the duration of the test.
 */
async function withStrava<T>(
	fetcher: Fetcher,
	run: () => Promise<T>,
	origin = ORIGIN,
	gearBikes = GEAR_BIKES,
): Promise<T> {
	const savedFetch = globalThis.fetch;
	const savedLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
	const savedDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
	const savedPerformance = Object.getOwnPropertyDescriptor(globalThis, "performance");
	Object.defineProperty(globalThis, "location", {
		configurable: true,
		value: { origin },
	});
	Object.defineProperty(globalThis, "document", {
		configurable: true,
		value: {
			querySelectorAll: () => [
				{ getAttribute: () => "/athletes/900001" },
			],
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


test("an incremental run stops after the first page wholly older than the cursor", async () => {
	const log: string[] = [];
	const h = harness(BOTH, {
		activities: { last_start_time: "2026-09-15T23:45:00Z" },
	});
	await withStrava(listFetcher(PAGES, log), () =>
		collectStravaBrowser(h.ctx, FAST),
	);
	// Page 1 still holds newer activities; page 2 holds none, so the walk ends
	// there without reading further.
	assert.equal(log.length, 2);
	assert.deepEqual(
		h.of("activities").map((a) => a.id),
		["90000000005", "90000000004"],
	);
	assert.deepEqual(h.cursor(), { last_start_time: "2026-09-20T13:30:00Z" });
});

test("a full refresh ignores the cursor", async () => {
	const h = harness(
		["activities"],
		{ activities: { last_start_time: "2026-09-30T00:00:00Z" } },
		undefined,
		"full_refresh",
	);
	await withStrava(listFetcher(), () => collectStravaBrowser(h.ctx, FAST));
	assert.equal(h.of("activities").length, 5);
});

test("activity records include heart-rate summary and calories from detail resources", async () => {
	const h = harness(BOTH);
	await withStrava(listFetcher(), () => collectStravaBrowser(h.ctx, FAST));
	assert.deepEqual(
		{
			average_heartrate: h.of("activities")[0]?.average_heartrate,
			max_heartrate: h.of("activities")[0]?.max_heartrate,
			calories_kcal: h.of("activities")[0]?.calories_kcal,
			gear: h.of("activities")[0]?.gear,
		},
		{
			average_heartrate: 81.2,
			max_heartrate: 90,
			calories_kcal: 42,
			gear: "Synthetic Test Bike",
		},
	);
});

test("unmatched gear ids emit null with a reason in skip diagnostics", async () => {
	const h = harness(BOTH);
	await withStrava(
		listFetcher(),
		() => collectStravaBrowser(h.ctx, FAST),
		ORIGIN,
		"[]",
	);
	assert.equal(h.of("activities")[0]?.gear, null);
	assert.equal(
		JSON.stringify(h.messages).includes('"gear_id_unmatched":1'),
		true,
	);
	assert.equal(h.of("activities")[0]?.gear, null);
});

test("a detail bound saves the last completed activity and resumes after it", async () => {
	const first = harness(BOTH, {}, undefined, "full_refresh");
	await withStrava(listFetcher(), () =>
		collectStravaBrowser(first.ctx, { ...FAST, maxDetails: 2 }),
	);
	assert.deepEqual(
		first.of("activities").map((record) => record.id),
		["90000000005", "90000000004"],
	);
	assert.deepEqual(first.cursor(), {
		last_start_time: null,
		resume_after_id: "90000000004",
		resume_page: 1,
		walk_newest_start_time: "2026-09-20T13:30:00Z",
	});
	assert.deepEqual(first.skips()[0]?.recovery_hint, {
		action: "retry_by_runtime",
		retryable: true,
	});

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

test("a complete run reports redacted coverage and requested time bounds", async () => {
	const h = harness(["activities"], {}, {
		since: "2026-09-01T00:00:00Z",
		until: "2026-10-01T00:00:00Z",
	});
	await withStrava(listFetcher(), () => collectStravaBrowser(h.ctx, FAST));
	const summary = h.messages.find(
		(message): message is Extract<EmittedMessage, { type: "PROGRESS" }> =>
			message.type === "PROGRESS" &&
			message.message.includes("phase=coverage"),
	);
	assert.ok(summary, "successful runs expose coverage after removing its stream");
	assert.match(summary.message, /status=complete pages_read=2 unreadable=0/);
	assert.match(
		summary.message,
		/window_requested_from=2026-09-01T00:00:00Z window_requested_to=2026-10-01T00:00:00Z/,
	);
	assert.match(summary.message, /window_covered_from=2026-09-01T19:00:00Z/);
	assert.match(summary.message, /window_covered_to=2026-09-20T13:30:00Z/);
	assert.doesNotMatch(summary.message, /9000000000/);
});

test("an unreadable row marks the run summary partial", async () => {
	const page = JSON.parse(PAGES["1"] as string) as { models: unknown[] };
	page.models.push({});
	const h = harness(["activities"]);
	await withStrava(
		listFetcher({ ...PAGES, "1": JSON.stringify(page) }),
		() => collectStravaBrowser(h.ctx, FAST),
	);
	const summary = h.messages.find(
		(message): message is Extract<EmittedMessage, { type: "PROGRESS" }> =>
			message.type === "PROGRESS" &&
			message.message.includes("phase=coverage"),
	);
	assert.ok(summary);
	assert.match(summary.message, /status=partial/);
	assert.match(summary.message, /unreadable=1/);
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
