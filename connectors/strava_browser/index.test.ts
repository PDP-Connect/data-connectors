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
): Promise<T> {
	const savedFetch = globalThis.fetch;
	const savedLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
	Object.defineProperty(globalThis, "location", {
		configurable: true,
		value: { origin },
	});
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
		fetcher(new URL(String(input), origin), init)) as typeof fetch;
	try {
		return await run();
	} finally {
		globalThis.fetch = savedFetch;
		if (savedLocation) {
			Object.defineProperty(globalThis, "location", savedLocation);
		} else {
			Reflect.deleteProperty(globalThis, "location");
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

const FAST = { pageDelayMs: 0, rateLimitDelayMs: 0 };
const BOTH = ["activities", "coverage_diagnostics"];

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

test("walks every page and emits schema-valid live records", async () => {
	const log: string[] = [];
	const h = harness(BOTH);
	await withStrava(listFetcher(PAGES, log), () =>
		collectStravaBrowser(h.ctx, FAST),
	);
	assert.equal(log.length, 2);
	assert.match(log[0] ?? "", /page=1&per_page=20/);
	const activities = h.of("activities");
	assert.deepEqual(
		activities.map((a) => [a.id, a.activity_type, a.start_time]),
		[
			["90000000005", "Ride", "2026-09-20T06:30:00-07:00"],
			["90000000004", "Run", "2026-09-18T18:05:12+01:00"],
			["90000000003", "Yoga", "2026-09-16T00:45:00+01:00"],
			["90000000002", "EBikeRide", "2026-09-10T07:00:00-07:00"],
			["90000000001", "Swim", "2026-09-01T12:00:00-07:00"],
		],
	);
	assert.deepEqual(activities[0], {
		id: "90000000005",
		activity_type: "Ride",
		start_date: "2026-09-20",
		start_time: "2026-09-20T06:30:00-07:00",
		start_time_basis: "local",
		distance_m: 32150.4,
		moving_time_s: 5400,
		elapsed_time_s: 6120,
		total_elevation_gain_m: 610,
		average_heartrate: null,
		max_heartrate: null,
		calories_kcal: null,
		gear: null,
		freshness: "live",
		exported_at: null,
	});
	// 23:45 UTC is already the next day at UTC+1; start_date is the local day.
	assert.equal(activities[2]?.start_date, "2026-09-16");
	const [diagnostic] = h.of("coverage_diagnostics");
	assert.equal(diagnostic?.reason, "covered_in_full");
	assert.equal(diagnostic?.status, "complete");
	assert.equal(diagnostic?.record_count, 5);
	assert.equal(diagnostic?.window_covered_from, "2026-09-01T19:00:00Z");
	assert.equal(diagnostic?.window_covered_to, "2026-09-20T13:30:00Z");
	assert.deepEqual(diagnostic?.fields_unavailable, [
		"average_heartrate",
		"max_heartrate",
		"calories_kcal",
		"gear",
	]);
	assert.deepEqual(h.skips(), []);
	assert.deepEqual(h.cursor(), { last_start_time: "2026-09-20T13:30:00Z" });
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

test("the page bound saves where to continue, and the next run finishes the walk", async () => {
	const first = harness(BOTH);
	await withStrava(listFetcher(), () =>
		collectStravaBrowser(first.ctx, { ...FAST, maxPages: 1 }),
	);
	assert.equal(first.of("activities").length, 3);
	assert.equal(
		first.of("coverage_diagnostics")[0]?.reason,
		"source_limit_reached",
	);
	assert.equal(first.of("coverage_diagnostics")[0]?.status, "partial");
	assert.equal(first.skips()[0]?.reason, "source_limit_reached");
	assert.deepEqual(first.cursor(), {
		last_start_time: null,
		resume_page: 2,
		walk_newest_start_time: "2026-09-20T13:30:00Z",
	});

	const log: string[] = [];
	const second = harness(BOTH, {
		activities: first.cursor() as Record<string, unknown>,
	});
	await withStrava(listFetcher(PAGES, log), () =>
		collectStravaBrowser(second.ctx, { ...FAST, maxPages: 1 }),
	);
	assert.match(log[0] ?? "", /page=2/);
	assert.deepEqual(
		second.of("activities").map((a) => a.id),
		["90000000002", "90000000001"],
	);
	assert.equal(second.of("coverage_diagnostics")[0]?.reason, "covered_in_full");
	assert.deepEqual(second.cursor(), {
		last_start_time: "2026-09-20T13:30:00Z",
	});
});

test("a requested time range filters by local calendar day", async () => {
	const log: string[] = [];
	const h = harness(
		BOTH,
		{},
		{
			since: "2026-09-16T00:00:00Z",
			until: "2026-09-19T00:00:00Z",
		},
	);
	await withStrava(listFetcher(PAGES, log), () =>
		collectStravaBrowser(h.ctx, FAST),
	);
	assert.equal(log.length, 2);
	// Activity 3 started on 2026-09-15 in UTC but 2026-09-16 locally.
	assert.deepEqual(
		h.of("activities").map((a) => a.id),
		["90000000004", "90000000003"],
	);
	const [diagnostic] = h.of("coverage_diagnostics");
	assert.equal(diagnostic?.window_requested_from, "2026-09-16T00:00:00.000Z");
	assert.equal(diagnostic?.window_requested_to, "2026-09-19T00:00:00.000Z");
});

test("an unrecognised list envelope fails closed with nothing emitted", async () => {
	const h = harness(BOTH);
	await withStrava(
		() => json('{"activities":[{"id":1}]}'),
		() => collectStravaBrowser(h.ctx, FAST),
	);
	assert.deepEqual(h.of("activities"), []);
	const [diagnostic] = h.of("coverage_diagnostics");
	assert.equal(diagnostic?.reason, "source_unreadable");
	assert.equal(diagnostic?.status, "empty");
	assert.equal(h.skips()[0]?.reason, "source_unreadable");
	assert.deepEqual(h.cursor(), {}, "the cursor does not move");
});

test("an HTML answer where JSON belongs fails closed", async () => {
	const h = harness(BOTH);
	await withStrava(
		() =>
			new Response("<html></html>", {
				headers: { "content-type": "text/html" },
			}),
		() => collectStravaBrowser(h.ctx, FAST),
	);
	assert.equal(h.of("coverage_diagnostics")[0]?.reason, "source_unreadable");
});

test("a sign-in wall mid-walk keeps what was collected and resumes at that page", async () => {
	const h = harness(BOTH);
	await withStrava(
		(url) =>
			url.searchParams.get("page") === "1"
				? json(PAGES["1"] as string)
				: new Response("", { status: 401 }),
		() => collectStravaBrowser(h.ctx, FAST),
	);
	assert.equal(h.of("activities").length, 3);
	const [diagnostic] = h.of("coverage_diagnostics");
	assert.equal(diagnostic?.reason, "sign_in_required");
	assert.equal(diagnostic?.status, "partial");
	assert.equal((h.cursor() as { resume_page?: number }).resume_page, 2);
});

test("HTTP 429 is retried, then the run stops as interrupted", async () => {
	let calls = 0;
	const h = harness(BOTH);
	await withStrava(
		() => {
			calls += 1;
			return new Response("", { status: 429 });
		},
		() => collectStravaBrowser(h.ctx, FAST),
	);
	assert.equal(calls, 3);
	assert.equal(
		h.of("coverage_diagnostics")[0]?.reason,
		"collection_interrupted",
	);
});

test("a model without a zoned start time is counted, not emitted", async () => {
	const page = JSON.parse(PAGES["2"] as string);
	page.models[1].start_time = "2026-09-01 12:00:00";
	const h = harness(BOTH);
	await withStrava(
		listFetcher({ "1": PAGES["1"] as string, "2": JSON.stringify(page) }),
		() => collectStravaBrowser(h.ctx, FAST),
	);
	assert.equal(h.of("activities").length, 4);
	const [diagnostic] = h.of("coverage_diagnostics");
	assert.equal(diagnostic?.reason, "records_unreadable");
	assert.equal(diagnostic?.status, "partial");
	assert.deepEqual(h.cursor(), { last_start_time: "2026-09-20T13:30:00Z" });
});

test("a page that repeats the previous page ends the walk", async () => {
	const h = harness(BOTH);
	await withStrava(
		() => json(PAGES["1"] as string),
		() => collectStravaBrowser(h.ctx, FAST),
	);
	assert.equal(h.of("activities").length, 3);
	assert.equal(h.of("coverage_diagnostics")[0]?.reason, "source_unreadable");
});

test("an empty account is nothing_in_range, not a failure", async () => {
	const h = harness(BOTH);
	await withStrava(
		() => json('{"models":[],"page":1,"perPage":20,"total":0}'),
		() => collectStravaBrowser(h.ctx, FAST),
	);
	const [diagnostic] = h.of("coverage_diagnostics");
	assert.equal(diagnostic?.reason, "nothing_in_range");
	assert.equal(diagnostic?.status, "empty");
	assert.deepEqual(h.skips(), []);
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

test("a ranged run's cursor does not hide older history from a later unranged run", async () => {
	const first = harness(BOTH, {}, { since: "2026-09-16T00:00:00Z" });
	await withStrava(listFetcher(), () => collectStravaBrowser(first.ctx, FAST));
	assert.deepEqual(
		first.of("activities").map((a) => a.id),
		["90000000005", "90000000004", "90000000003"],
	);
	assert.deepEqual(first.cursor(), {
		last_start_time: "2026-09-20T13:30:00Z",
		requested_since: "2026-09-16",
	});

	const second = harness(BOTH, {
		activities: first.cursor() as Record<string, unknown>,
	});
	await withStrava(listFetcher(), () => collectStravaBrowser(second.ctx, FAST));
	assert.deepEqual(
		second.of("activities").map((a) => a.id).slice(-2),
		["90000000002", "90000000001"],
	);
	assert.equal(second.of("coverage_diagnostics")[0]?.reason, "covered_in_full");
	assert.deepEqual(second.cursor(), {
		last_start_time: "2026-09-20T13:30:00Z",
	});

	// A later start than the cursor's still uses the cursor.
	const third = harness(
		BOTH,
		{ activities: first.cursor() as Record<string, unknown> },
		{ since: "2026-09-18T00:00:00Z" },
	);
	await withStrava(listFetcher(), () => collectStravaBrowser(third.ctx, FAST));
	assert.deepEqual(third.of("activities"), []);
	assert.deepEqual(third.cursor(), first.cursor());
});

test("a full refresh that fails on page 1 keeps the stored cursor", async () => {
	const stored = { last_start_time: "2026-09-20T13:30:00Z" };
	const h = harness(BOTH, { activities: stored }, undefined, "full_refresh");
	await withStrava(
		() => json('{"activities":[{"id":1}]}'),
		() => collectStravaBrowser(h.ctx, FAST),
	);
	assert.equal(h.of("coverage_diagnostics")[0]?.reason, "source_unreadable");
	assert.deepEqual(h.cursor(), stored);
});
