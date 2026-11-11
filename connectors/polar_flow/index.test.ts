// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The in-page read, run from its source as the browser runs it, against a fake flow.polar.com;
 * `classify`; the request builders; the cursor plan; and the collector end to end over the
 * synthetic fixtures. Expected values are written out here, not imported from index.ts, so a wrong
 * constant there fails a test. No test waits a real pause: each passes an instant sleep.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright";
import type {
	BrowserCollectContext,
	EnsureSessionArgs,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { fixtureData, polarApi, type SiteData } from "./fake-polar.ts";
import {
	activityRequest,
	classify,
	collectPolarFlow,
	grantDays,
	localDay,
	makeEnsureSession,
	nightlyRequest,
	type PageFetch,
	type PolarCollectContext,
	pageFetch,
	planDays,
	probeSession,
	readCursor,
	sleepRequest,
	trainingHistoryRequest,
	trainingSummaryRequest,
	windows,
} from "./index.ts";

const FLOW = "https://flow.polar.com";
const NOW = new Date("2026-11-05T21:30:00.000Z"); // 23:30 at +02:00, still 5 November
const instant = async (): Promise<void> => {};

/** Runs a page.evaluate callback from its source, as the browser would. */
const inPage = (fn: unknown, arg?: unknown): Promise<unknown> =>
	Promise.resolve(
		new Function(`return (${String(fn)})`)()(
			arg === undefined ? undefined : JSON.parse(JSON.stringify(arg)),
		),
	);

interface Site {
	url: string;
	signedIn: boolean;
	data: SiteData;
	/** Overrides the fake's answer for one request; return undefined to fall through. */
	override?: (url: string, init: RequestInit) => Response | undefined;
	fetches: Array<{ url: string; init: RequestInit }>;
	gotos: string[];
}

function site(overrides: Partial<Site> = {}): Site {
	return {
		url: `${FLOW}/diary`,
		signedIn: true,
		data: fixtureData(),
		fetches: [],
		gotos: [],
		...overrides,
	};
}

const SWAPPED = ["location", "fetch"] as const;

async function inSite<T>(s: Site, run: () => Promise<T>): Promise<T> {
	const saved = SWAPPED.map(
		(name) =>
			[name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
	);
	Object.defineProperty(globalThis, "location", {
		configurable: true,
		value: { href: s.url, origin: new URL(s.url).origin },
	});
	const api = polarApi(s.data);
	Object.defineProperty(globalThis, "fetch", {
		configurable: true,
		writable: true,
		value: async (input: unknown, init: RequestInit = {}) => {
			const url = String(input);
			s.fetches.push({ url, init });
			const forced = s.override?.(url, init);
			if (forced) return forced;
			const a = api(url, init, s.signedIn);
			return new Response(a.body === "" ? null : a.body, {
				status: a.status,
				headers: a.contentType ? { "content-type": a.contentType } : {},
			});
		},
	});
	try {
		return await run();
	} finally {
		for (const [name, descriptor] of saved) {
			if (descriptor) Object.defineProperty(globalThis, name, descriptor);
			else Reflect.deleteProperty(globalThis, name);
		}
	}
}

function pageOn(s: Site): Page {
	return {
		evaluate: (fn: unknown, arg?: unknown) => inSite(s, () => inPage(fn, arg)),
		goto: async (target: string) => {
			s.gotos.push(target);
			s.url = target;
			return null;
		},
	} as unknown as Page;
}

interface Emitted {
	records: Array<{ stream: string; data: Record<string, unknown> }>;
	messages: Array<Record<string, unknown>>;
}

function context(
	s: Site,
	streams: string[],
	state: Record<string, unknown> = {},
	ranges: Record<string, { since?: string; until?: string }> = {},
	mode: "incremental" | "full_refresh" = "incremental",
): { ctx: PolarCollectContext; out: Emitted } {
	const out: Emitted = { records: [], messages: [] };
	const requested = new Map(
		streams.map((name) => [
			name,
			{ name, ...(ranges[name] ? { time_range: ranges[name] } : {}) },
		]),
	);
	const ctx = {
		collectionMode: mode,
		requested,
		state,
		page: pageOn(s),
		emit: async (msg: Record<string, unknown>) => {
			out.messages.push(msg);
		},
		emitRecord: async (stream: string, data: Record<string, unknown>) => {
			out.records.push({ stream, data });
		},
	} as unknown as PolarCollectContext;
	return { ctx, out };
}

const ALL = [
	"profile",
	"training_sessions",
	"daily_activity",
	"sleep",
	"nightly_recharge",
];
const recordsOf = (out: Emitted, stream: string) =>
	out.records.filter((r) => r.stream === stream).map((r) => r.data);
const stateOf = (out: Emitted, stream: string) =>
	out.messages.find((m) => m.type === "STATE" && m.stream === stream)?.cursor;
const skipsOf = (out: Emitted) =>
	out.messages.filter((m) => m.type === "SKIP_RESULT");

// ── In-page fetch ──────────────────────────────────────────────────────────
test("pageFetch sends the page's cookies and X-Requested-With from a flow.polar.com page", async () => {
	const s = site();
	const r = await pageFetch(pageOn(s), {
		url: "/api/account/users/current/user",
		method: "GET",
	});
	assert.equal(r.kind, "response");
	assert.ok(r.kind === "response" && r.status === 200);
	const [call] = s.fetches;
	assert.ok(call && call.url === "/api/account/users/current/user");
	assert.equal(call.init.credentials, "include");
	assert.equal(
		new Headers(call.init.headers).get("x-requested-with"),
		"XMLHttpRequest",
	);
});

test("pageFetch posts the training history as JSON", async () => {
	const s = site();
	const r = await pageFetch(
		pageOn(s),
		trainingHistoryRequest(11111111, { from: "2026-11-01", to: "2026-11-30" }),
	);
	assert.ok(r.kind === "response" && r.status === 200);
	const [call] = s.fetches;
	assert.ok(call && call.url === "/api/training/history");
	assert.equal(call.init.method, "POST");
	assert.equal(
		new Headers(call.init.headers).get("content-type"),
		"application/json",
	);
	assert.deepEqual(JSON.parse(String(call.init.body)), {
		userId: 11111111,
		fromDate: "2026-11-01",
		toDate: "2026-11-30",
	});
	assert.equal(JSON.parse(r.body).length, 2);
});

test("pageFetch refuses to read off flow.polar.com and never fetches there", async () => {
	const s = site({ url: "https://auth.polar.com/login" });
	const r = await pageFetch(pageOn(s), { url: "/api/x", method: "GET" });
	assert.deepEqual(r, {
		kind: "wrong_origin",
		origin: "https://auth.polar.com",
	});
	assert.equal(s.fetches.length, 0);
});

test("pageFetch turns a throwing evaluate into a network error", async () => {
	const page = {
		evaluate: async () => {
			throw new Error("Execution context was destroyed");
		},
	} as unknown as Page;
	assert.deepEqual(await pageFetch(page, { url: "/api/x", method: "GET" }), {
		kind: "network_error",
		message: "evaluate_failed",
	});
});

// ── Classification ─────────────────────────────────────────────────────────
const resp = (
	status: number,
	body = "",
	contentType = "application/json",
	retryAfter: string | null = null,
): PageFetch => ({ kind: "response", status, contentType, retryAfter, body });

test("classify maps Flow's answers to outcomes", () => {
	assert.equal(classify(resp(200, "[1]")).ok, true);
	const signIn = classify(resp(401, '{"error":"NotAuthenticated"}'));
	assert.ok(!signIn.ok && signIn.reason === "sign_in_required");
	const refused = classify(resp(403));
	assert.ok(!refused.ok && refused.reason === "sign_in_required");
	const limited = classify(resp(429, "", "text/plain", "7"), false, 0);
	assert.ok(
		!limited.ok &&
			limited.reason === "collection_interrupted" &&
			limited.retryAfterMs === 7000,
	);
	const down = classify(resp(503));
	assert.ok(!down.ok && down.reason === "collection_interrupted");
	const moved = classify(resp(404, "<html>", "text/html"));
	assert.ok(!moved.ok && moved.reason === "source_unreadable");
	assert.deepEqual(classify(resp(404, ""), true), {
		ok: true,
		json: null,
		status: 404,
	});
	const html = classify(resp(200, "<html>", "text/html"));
	assert.ok(!html.ok && html.reason === "source_unreadable");
	const auth = classify({
		kind: "wrong_origin",
		origin: "https://auth.polar.com",
	});
	assert.ok(!auth.ok && auth.reason === "sign_in_required");
	const elsewhere = classify({ kind: "wrong_origin", origin: "about:blank" });
	assert.ok(!elsewhere.ok && elsewhere.reason === "collection_interrupted");
});

// ── Requests ───────────────────────────────────────────────────────────────
test("loadFour is asked for the window's third day, which answers the window", () => {
	const r = activityRequest({ from: "2026-11-03", to: "2026-11-06" });
	assert.equal(
		r.url,
		"/api/activity-timeline/loadFour?day=2026-11-05&maxSampleCount=200",
	);
	assert.equal(r.method, "GET");
});

test("the sleep report is widened back to its 30-day floor, and goes to the sleep host", () => {
	assert.equal(
		sleepRequest({ from: "2026-11-01", to: "2026-11-05" }).url,
		"https://sleep-api.flow.polar.com/api/sleep/report?from=2026-10-06&to=2026-11-05",
	);
	assert.equal(
		sleepRequest({ from: "2025-11-06", to: "2026-11-05" }).url,
		"https://sleep-api.flow.polar.com/api/sleep/report?from=2025-11-06&to=2026-11-05",
	);
});

test("Nightly Recharge and session summaries use the web app's paths", () => {
	assert.equal(
		nightlyRequest({ from: "2026-10-01", to: "2026-10-28" }).url,
		"/api/nightly-recovery/2026-10-01/2026-10-28",
	);
	assert.equal(
		trainingSummaryRequest(8349588454).url,
		"/api/training/analysis/8349588454/summary",
	);
});

test("windows cut a span oldest first, the last one short", () => {
	assert.deepEqual(windows("2026-11-01", "2026-11-10", 4), [
		{ from: "2026-11-01", to: "2026-11-04" },
		{ from: "2026-11-05", to: "2026-11-08" },
		{ from: "2026-11-09", to: "2026-11-10" },
	]);
	assert.deepEqual(windows("2026-11-02", "2026-11-01", 4), []);
});

// ── Days and cursors ───────────────────────────────────────────────────────
const PLAN = {
	windowDays: 4,
	initialDays: 90,
	overlapDays: 3,
	maxWindowsPerRun: 100,
};

test("localDay reads the owner's UTC offset", () => {
	assert.equal(localDay(NOW, "+02:00"), "2026-11-05");
	assert.equal(
		localDay(new Date("2026-11-05T22:30:00Z"), "+02:00"),
		"2026-11-06",
	);
	assert.equal(
		localDay(new Date("2026-11-06T02:00:00Z"), "-05:00"),
		"2026-11-05",
	);
	assert.equal(localDay(new Date("2026-11-05T23:59:00Z"), null), "2026-11-05");
});

test("a first run reads initialDays up to today", () => {
	const p = planDays({}, "2026-11-05", {}, false, PLAN);
	assert.deepEqual(p, {
		cursor: { next_day: "2026-08-08", floor: "2026-08-08" },
		from: "2026-08-08",
		to: "2026-11-05",
	});
});

test("a later run re-reads overlapDays before next_day and reads on", () => {
	const p = planDays(
		{ next_day: "2026-11-01", floor: "2026-08-08" },
		"2026-11-05",
		{},
		false,
		PLAN,
	);
	assert.deepEqual(p, {
		cursor: { next_day: "2026-11-01", floor: "2026-08-08" },
		from: "2026-10-29",
		to: "2026-11-05",
	});
});

test("a grant starting before the floor, a full refresh, or a cursor in the future reads afresh", () => {
	const prev = { next_day: "2026-11-01", floor: "2026-08-08" };
	assert.equal(
		planDays(prev, "2026-11-05", { since: "2026-01-01" }, false, PLAN).from,
		"2026-01-01",
	);
	assert.equal(planDays(prev, "2026-11-05", {}, true, PLAN).from, "2026-08-08");
	assert.equal(
		planDays(
			{ next_day: "2027-01-01", floor: "2026-12-30" },
			"2026-11-05",
			{},
			false,
			PLAN,
		).from,
		"2026-08-08",
	);
});

test("a grant's until ends the read the day before it", () => {
	const p = planDays(
		{},
		"2026-11-05",
		grantDays({ since: "2026-10-01T00:00:00Z", until: "2026-10-15" }),
		false,
		PLAN,
	);
	assert.equal(p.from, "2026-10-01");
	assert.equal(p.to, "2026-10-14");
});

test("readCursor keeps only a cursor whose days parse and run forward", () => {
	assert.deepEqual(
		readCursor({ next_day: "2026-11-01", floor: "2026-10-01" }),
		{
			next_day: "2026-11-01",
			floor: "2026-10-01",
		},
	);
	assert.deepEqual(
		readCursor({ next_day: "2026-10-01", floor: "2026-11-01" }),
		{},
	);
	assert.deepEqual(
		readCursor({ next_day: "2026-02-30", floor: "2026-01-01" }),
		{},
	);
	assert.deepEqual(readCursor("nope"), {});
});

// ── Collect ────────────────────────────────────────────────────────────────
test("collects every stream from the fixtures, with a cursor at the owner's tomorrow", async () => {
	const s = site();
	const { ctx, out } = context(s, ALL);
	await collectPolarFlow(ctx, { sleep: instant }, NOW);
	assert.deepEqual(skipsOf(out), []);

	const [profile] = recordsOf(out, "profile");
	assert.equal(profile?.id, "11111111");
	assert.equal(profile?.birthday, "1990-04-07");
	assert.equal(profile?.utc_offset, "+02:00");
	assert.equal("email" in (profile ?? {}), false);

	const sessions = recordsOf(out, "training_sessions");
	assert.deepEqual(
		sessions.map((r) => [r.id, r.start_time_local, r.max_heart_rate_bpm]),
		[
			["8349588454", "2026-11-03T07:12:09", 176],
			["8351200017", "2026-11-05T18:30:00", null],
		],
	);
	assert.equal(sessions[0]?.duration_s, 2735);
	assert.equal(sessions[0]?.device_name, "Polar Pacer Pro");
	assert.equal(sessions[0]?.note, null);
	assert.equal(sessions[1]?.average_heart_rate_bpm, null);

	assert.deepEqual(
		recordsOf(out, "daily_activity").map((r) => [r.date, r.steps]),
		[
			["2026-11-03", 12408],
			["2026-11-04", 6611],
		],
	);
	assert.deepEqual(
		recordsOf(out, "sleep").map((r) => [r.date, r.sleep_score]),
		[
			["2026-11-03", 78.4213],
			["2026-11-04", null],
		],
	);
	assert.deepEqual(
		recordsOf(out, "nightly_recharge").map((r) => [
			r.date,
			r.nightly_recharge_status,
			r.ans_charge,
		]),
		[
			["2026-11-03", 4, 2.7],
			["2026-11-04", 2, null],
		],
	);
	for (const stream of ALL.slice(1)) {
		assert.equal(
			(stateOf(out, stream) as { next_day?: string } | undefined)?.next_day,
			"2026-11-06",
			stream,
		);
	}
	// The profile read is the only one that may navigate; on the app already, none did.
	assert.deepEqual(s.gotos, []);
	// Every sleep request goes to the sleep host with a span the report accepts.
	for (const f of s.fetches.filter((x) =>
		x.url.includes("/api/sleep/report"),
	)) {
		assert.ok(f.url.startsWith("https://sleep-api.flow.polar.com/"));
	}
});

test("a later run reads from overlap days before the saved cursor", async () => {
	const s = site();
	const { ctx } = context(s, ["daily_activity"], {
		daily_activity: { next_day: "2026-11-05", floor: "2026-08-08" },
	});
	await collectPolarFlow(ctx, { sleep: instant }, NOW);
	const days = s.fetches
		.filter((f) => f.url.startsWith("/api/activity-timeline/loadFour"))
		.map((f) => new URL(f.url, FLOW).searchParams.get("day"));
	// From 2026-11-02 (next_day - 3) to today: windows 11-02..11-05, asked for their third day.
	assert.deepEqual(days, ["2026-11-04"]);
});

test("signed out: every stream is skipped as sign_in_required, with no cursor", async () => {
	const s = site({ signedIn: false });
	const { ctx, out } = context(s, ALL);
	await collectPolarFlow(ctx, { sleep: instant }, NOW);
	assert.equal(out.records.length, 0);
	const skips = skipsOf(out);
	assert.deepEqual(
		skips.map((m) => [m.stream, m.reason]),
		ALL.map((stream) => [stream, "sign_in_required"]),
	);
	assert.equal(out.messages.filter((m) => m.type === "STATE").length, 0);
});

test("off flow.polar.com, the first read goes to the app once", async () => {
	const s = site({ url: "about:blank" });
	const { ctx, out } = context(s, ["profile"]);
	await collectPolarFlow(ctx, { sleep: instant }, NOW);
	assert.deepEqual(s.gotos, ["https://flow.polar.com/diary"]);
	assert.equal(recordsOf(out, "profile").length, 1);
});

test("an unreadable session holds the cursor at its window, and the rest still ships", async () => {
	for (const corrupt of [
		(row: Record<string, unknown>) => {
			row.startDate = "2026-11-03 7:12";
		},
		(row: Record<string, unknown>) => {
			row.duration = "45 min";
		},
	]) {
		const data = fixtureData();
		const bad = data.training[0];
		assert.ok(bad);
		corrupt(bad);
		const s = site({ data });
		const { ctx, out } = context(
			s,
			["training_sessions"],
			{},
			{
				training_sessions: { since: "2026-10-01" },
			},
		);
		await collectPolarFlow(ctx, { sleep: instant }, NOW);
		assert.equal(recordsOf(out, "training_sessions").length, 1);
		const progress = out.messages.find((m) => m.type === "PROGRESS");
		assert.equal(progress?.count, 1);
		// Windows: 10-01..10-31 (clean) then 11-01..11-05 (the bad row): the cursor stops at 11-01.
		assert.deepEqual(stateOf(out, "training_sessions"), {
			next_day: "2026-11-01",
			floor: "2026-10-01",
		});
		assert.deepEqual(skipsOf(out), []);
	}
});

test("a session whose summary 404s keeps its list fields, the summary's null", async () => {
	const data = fixtureData();
	data.summaries = {};
	const s = site({ data });
	const { ctx, out } = context(
		s,
		["training_sessions"],
		{},
		{
			training_sessions: { since: "2026-11-01" },
		},
	);
	await collectPolarFlow(ctx, { sleep: instant }, NOW);
	const [run] = recordsOf(out, "training_sessions");
	assert.equal(run?.average_heart_rate_bpm, 151);
	assert.equal(run?.max_heart_rate_bpm, null);
	assert.equal(run?.end_time_local, null);
	assert.ok(
		s.fetches.some(
			(f) => f.url === "/api/training/analysis/8349588454/summary",
		),
	);
});

test("a run that reaches its window limit says so and saves where it stopped", async () => {
	const s = site();
	const { ctx, out } = context(
		s,
		["daily_activity"],
		{},
		{
			daily_activity: { since: "2025-01-01" },
		},
	);
	await collectPolarFlow(ctx, { sleep: instant }, NOW);
	const [skip] = skipsOf(out);
	assert.equal(skip?.reason, "source_limit_reached");
	// 100 windows of 4 days from 2025-01-01.
	assert.deepEqual(stateOf(out, "daily_activity"), {
		next_day: "2026-02-05",
		floor: "2025-01-01",
	});
});

test("a 429 waits Retry-After and reads again", async () => {
	let limited = 0;
	const waits: number[] = [];
	const s = site({
		override: (url) => {
			if (url.startsWith("/api/nightly-recovery/") && limited === 0) {
				limited += 1;
				return new Response("", {
					status: 429,
					headers: { "retry-after": "2" },
				});
			}
			return undefined;
		},
	});
	const { ctx, out } = context(
		s,
		["nightly_recharge"],
		{},
		{
			nightly_recharge: { since: "2026-11-01" },
		},
	);
	await collectPolarFlow(
		ctx,
		{
			sleep: async (ms) => {
				waits.push(ms);
			},
		},
		NOW,
	);
	assert.ok(waits.includes(2000));
	assert.equal(recordsOf(out, "nightly_recharge").length, 2);
	assert.deepEqual(skipsOf(out), []);
});

test("a sleep answer that is not a list stops the stream as unreadable, without moving its cursor", async () => {
	const s = site({
		override: (url) =>
			url.includes("/api/sleep/report")
				? new Response('{"nights":[]}', {
						status: 200,
						headers: { "content-type": "application/json" },
					})
				: undefined,
	});
	const { ctx, out } = context(s, ["sleep"]);
	await collectPolarFlow(ctx, { sleep: instant }, NOW);
	const [skip] = skipsOf(out);
	assert.equal(skip?.reason, "source_unreadable");
	assert.equal(stateOf(out, "sleep"), undefined);
});

// ── Probes and sign-in ─────────────────────────────────────────────────────
test("probeSession: signed in is live, signed out is not, an outage is not a sign-out", async () => {
	assert.equal(await probeSession(pageOn(site())), true);
	assert.equal(await probeSession(pageOn(site({ signedIn: false }))), false);
	const down = site({
		override: () => new Response("", { status: 503 }),
	});
	assert.equal(await probeSession(pageOn(down)), true);
});

test("ensureSession returns without a handoff when the session is already there", async () => {
	const s = site({ url: "about:blank" });
	const checkpoints: string[] = [];
	const args = {
		page: pageOn(s),
		checkpoint: async (label: string) => {
			checkpoints.push(label);
		},
	} as unknown as EnsureSessionArgs;
	await makeEnsureSession({ attempts: 2, intervalMs: 0, sleep: instant })(args);
	assert.deepEqual(s.gotos, ["https://flow.polar.com/login"]);
	assert.deepEqual(checkpoints, ["sign-in-page", "sign-in-settle"]);
});

test("the runtime context type stays structurally compatible", () => {
	const typed: (ctx: BrowserCollectContext) => Promise<void> = (ctx) =>
		collectPolarFlow(ctx);
	assert.equal(typeof typed, "function");
});
