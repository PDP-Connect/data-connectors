// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Layer 1: the in-page read, run from its source as the browser runs it, against a fake
 * connect.garmin.com, `classify`, and the pure arithmetic of the cursor's retry list (the collector
 * using it is collect.test.ts's). Layer 3.1: the probes and `ensureSession`, its settle
 * included, with fakes and the real `manualBrowserLogin`. Expected values come from the discovery
 * spec, written out here, not imported from index.ts, so a wrong constant there fails a test. No
 * test waits a real settle interval: each passes its own instant sleep.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright";
import {
	type EnsureSessionArgs,
	politeDelay,
	resolveSessionEstablishWatchdogMs,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { garminApi } from "./fake-garmin.ts";
import {
	APP_URL,
	classify,
	type DayCursor,
	ensureSession,
	LOGIN_URL,
	MAX_RETRY_DAYS,
	makeEnsureSession,
	normaliseRetry,
	ORIGIN,
	OVERLAP,
	PACING,
	type PageFetch,
	PROBE_PATH,
	pageFetch,
	planDays,
	probeOnPage,
	probeSession,
	readCursor,
	SIGN_IN_ORIGIN,
	SIGN_IN_SETTLE,
} from "./index.ts";

const NOW = new Date("2026-09-20T13:30:00.000Z");
const APP = "https://connect.garmin.com/app/";
const SETTINGS = "/gc-api/userprofile-service/userprofile/settings";
/** Where signed-out connect.garmin.com/app/ sends the page. */
const SSO =
	"https://sso.garmin.com/portal/sso/en-US/sign-in?clientId=GarminConnect&service=https%3A%2F%2Fconnect.garmin.com%2Fapp";
const TOKEN = "fixture-csrf-0123456789abcdef";
const api = garminApi();

/** Runs a page.evaluate callback from its source, as the browser would. */
const inPage = (fn: unknown, arg?: unknown): Promise<unknown> =>
	Promise.resolve(
		new Function(`return (${String(fn)})`)()(
			arg === undefined ? undefined : JSON.parse(JSON.stringify(arg)),
		),
	);

const answer = (
	status: number,
	body = "",
	headers: Record<string, string> = { "content-type": "text/plain" },
) => new Response(status === 204 ? null : body, { status, headers });

// ── A fake browser tab ─────────────────────────────────────────────────────
interface Site {
	/** The tab's current URL; its origin is what the callback sees. */
	url: string;
	/** The session cookie: without it Garmin answers 401, and /app/ sends the page to sign-in. */
	signedIn: boolean;
	/** The csrf-token meta's content on an /app/ page; null for a page without it. */
	meta: string | null;
	/** Garmin's answer to the page's fetch. */
	api: (path: string, init: RequestInit) => Promise<Response>;
	/** Where a goto ends up; by default /app/ signed out lands on sign-in. */
	land?: (target: string) => string;
	/** Runs after each evaluate: the page moving on by itself. */
	afterRead?: () => void;
	gotoFails?: boolean;
	closed: boolean;
	onClose: Set<() => void>;
	metaReads: number;
	fetches: Array<{ url: string; init: RequestInit }>;
	fns: unknown[];
	gotos: string[];
	/** Every page-visible step, in order. */
	trail: string[];
}

/** Garmin as the spec found it: 401 without the session, 403 without the token, else the account. */
async function liveApi(
	s: Site,
	path: string,
	init: RequestInit,
): Promise<Response> {
	if (!s.signedIn) return answer(401);
	if (new Headers(init.headers).get("connect-csrf-token") !== TOKEN)
		return answer(403);
	const { status, contentType, body } = api(path);
	return answer(
		status,
		body,
		contentType ? { "content-type": contentType } : {},
	);
}

/** By default: on the app, signed in, the token in the page. */
function site(overrides: Partial<Site> = {}): Site {
	const s: Site = {
		url: APP,
		signedIn: true,
		meta: TOKEN,
		api: (path, init) => liveApi(s, path, init),
		closed: false,
		onClose: new Set(),
		metaReads: 0,
		fetches: [],
		fns: [],
		gotos: [],
		trail: [],
		...overrides,
	};
	return s;
}

const SWAPPED = ["location", "document", "fetch"] as const;

/** Runs `run` with the page's globals in place, restoring Node's afterwards. */
async function inSite<T>(s: Site, run: () => Promise<T>): Promise<T> {
	const saved = SWAPPED.map(
		(name) =>
			[name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
	);
	const here = new URL(s.url);
	Object.defineProperty(globalThis, "location", {
		configurable: true,
		value: { href: s.url, origin: here.origin },
	});
	Object.defineProperty(globalThis, "document", {
		configurable: true,
		value: {
			querySelector: (selector: string) => {
				s.metaReads += 1;
				const onApp =
					here.origin === ORIGIN && here.pathname.startsWith("/app/");
				return selector === 'meta[name="csrf-token"]' &&
					onApp &&
					s.meta !== null
					? {
							getAttribute: (name: string) =>
								name === "content" ? s.meta : null,
						}
					: null;
			},
		},
	});
	Object.defineProperty(globalThis, "fetch", {
		configurable: true,
		writable: true,
		value: async (input: unknown, init: RequestInit = {}) => {
			const url = String(input);
			s.fetches.push({ url, init });
			s.trail.push(`fetch ${url}`);
			return s.api(url, init);
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

/** The owner closes the window: the handoff's close listeners fire. */
function shut(s: Site): void {
	s.closed = true;
	s.trail.push("closed");
	for (const listener of s.onClose) listener();
}

const answered200 = (result: unknown): boolean =>
	typeof result === "object" &&
	result !== null &&
	"status" in result &&
	result.status === 200;

/** The runtime's one owned page: no second page, and every evaluate runs the callback's source. */
function pageOn(s: Site): Page {
	return {
		evaluate: async (fn: unknown, arg?: unknown) => {
			s.fns.push(fn);
			let result: unknown;
			try {
				result = await inSite(s, () => inPage(fn, arg));
				return result;
			} finally {
				s.afterRead?.();
				// Once the handoff is open, a readiness read that finds no session closes the window: a
				// broken probe then fails its test at once instead of polling for the handoff's 30 minutes.
				if (s.trail.includes("assist") && !answered200(result)) shut(s);
			}
		},
		on: (event: string, listener: () => void) => {
			if (event === "close") s.onClose.add(listener);
		},
		off: (_event: string, listener: () => void) => {
			s.onClose.delete(listener);
		},
		goto: async (target: string) => {
			s.gotos.push(target);
			s.trail.push(`goto ${target}`);
			if (s.gotoFails) throw new Error("page.goto: Timeout 30000ms exceeded.");
			s.url = s.land
				? s.land(target)
				: target === APP && !s.signedIn
					? SSO
					: target;
			return null;
		},
		isClosed: () => s.closed,
		context: () => ({
			newPage: async () => {
				throw new Error(
					"additional_browser_page_forbidden: use the owned run page",
				);
			},
		}),
	} as unknown as Page;
}

const tokenSent = (s: Site, index = 0): string | null =>
	new Headers(s.fetches[index]?.init.headers).get("connect-csrf-token");

// ── Layer 1: constants ─────────────────────────────────────────────────────
test("the origin, app, sign-in host and probe are the ones the web app uses", () => {
	assert.equal(ORIGIN, "https://connect.garmin.com");
	assert.equal(APP_URL, APP);
	assert.equal(
		LOGIN_URL,
		APP,
		"signed out, the app itself sends the page to sign-in",
	);
	assert.equal(SIGN_IN_ORIGIN, "https://sso.garmin.com");
	assert.equal(PROBE_PATH, SETTINGS);
});

test("production pacing: a second before each read through the runtime's polite delay, 90 days or 40 windows a run, kept ones read again until a week of days or one window still does not read, 64 requests a window, Retry-After up to a minute", () => {
	const { sleep, ...limits } = PACING;
	assert.equal(sleep, politeDelay);
	assert.deepEqual(limits, {
		maxDaysPerRun: 90,
		maxRequestsPerWindow: 64,
		maxRetryAfterMs: 60_000,
		maxRetryDaysPerRun: 7,
		maxRetryWindowsPerRun: 1,
		maxWindowsPerRun: 40,
		requestDelayMs: 1000,
	});
});

// ── Layer 1: the in-page read ──────────────────────────────────────────────
test("the in-page read is self-contained: no tsx __name helper, and it runs from its own source", async () => {
	const s = site();
	const result = await pageFetch(pageOn(s), PROBE_PATH);
	assert.equal(s.fns.length, 1);
	assert.doesNotMatch(String(s.fns[0]), /__name/);
	assert.equal(result.kind, "response");
});

test("off the app's origin, lookalikes included, the read answers wrong_origin and touches neither the token nor the network", async () => {
	for (const [url, origin] of [
		["about:blank", "null"],
		[SSO, "https://sso.garmin.com"],
		["https://www.garmin.com/en-US/", "https://www.garmin.com"],
		// URLs that begin with the origin's text but are not the origin.
		[
			"https://connect.garmin.com.example.invalid/app/",
			"https://connect.garmin.com.example.invalid",
		],
		["https://connect.garmin.com:8443/app/", "https://connect.garmin.com:8443"],
	] as const) {
		const s = site({ url });
		assert.deepEqual(
			await pageFetch(pageOn(s), PROBE_PATH),
			{ kind: "wrong_origin", origin },
			url,
		);
		assert.equal(s.metaReads, 0, url);
		assert.deepEqual(s.fetches, [], url);
	}
});

test("on the origin without the token meta, or with an empty one, the read answers no_token without a request", async () => {
	for (const overrides of [
		{ meta: null },
		{ meta: "" },
		{ url: `${ORIGIN}/robots.txt` },
	] as Array<Partial<Site>>) {
		const s = site(overrides);
		assert.deepEqual(
			await pageFetch(pageOn(s), PROBE_PATH),
			{ kind: "no_token" },
			JSON.stringify(overrides),
		);
		assert.deepEqual(s.fetches, []);
	}
});

test("the token is the csrf-token meta, sent as connect-csrf-token, and never returned", async () => {
	const s = site();
	const result = await pageFetch(pageOn(s), PROBE_PATH);
	assert.equal(tokenSent(s), TOKEN);
	assert.equal(s.metaReads, 1);
	assert.deepEqual(result, {
		kind: "response",
		status: 200,
		contentType: "application/json;charset=UTF-8",
		retryAfter: null,
		body: api(SETTINGS).body,
	});
	assert.ok(!JSON.stringify(result).includes(TOKEN), "the token left the page");
});

test("the request is a same-origin GET of the path, with the page's credentials, asking for JSON, bounded by a signal", async () => {
	const path = "/gc-api/hrv-service/hrv/daily/2026-09-14/2026-09-16";
	const s = site();
	await pageFetch(pageOn(s), path);
	assert.equal(s.fetches.length, 1);
	const [call] = s.fetches;
	assert.equal(call?.url, path);
	assert.equal(call?.init.method ?? "GET", "GET");
	assert.equal(call?.init.body, undefined);
	assert.equal(call?.init.credentials, "include");
	assert.equal(
		new Headers(call?.init.headers).get("accept"),
		"application/json",
	);
	assert.deepEqual(
		[...new Headers(call?.init.headers).keys()].toSorted(),
		["accept", "connect-csrf-token"],
		"no bearer, no other header",
	);
	assert.ok(call?.init.signal instanceof AbortSignal);
});

test("status, content type, Retry-After and body come back as the page read them, and no URL", async () => {
	const limited = site({
		api: async () =>
			answer(429, "", { "content-type": "text/plain", "retry-after": "7" }),
	});
	assert.deepEqual(await pageFetch(pageOn(limited), PROBE_PATH), {
		kind: "response",
		status: 429,
		contentType: "text/plain",
		retryAfter: "7",
		body: "",
	});
	// Garmin's signed-out and missing-token answers: plain text, empty.
	for (const [overrides, status] of [
		[{ signedIn: false }, 401],
		[{ meta: "stale-token" }, 403],
	] as const) {
		const s = site(overrides);
		assert.deepEqual(await pageFetch(pageOn(s), PROBE_PATH), {
			kind: "response",
			status,
			contentType: "text/plain",
			retryAfter: null,
			body: "",
		});
	}
	// HRV with no nights: 204, no body, no type.
	const none = site();
	const hrv = await pageFetch(
		pageOn(none),
		"/gc-api/hrv-service/hrv/daily/2026-01-01/2026-01-28",
	);
	assert.deepEqual(hrv, {
		kind: "response",
		status: 204,
		contentType: "",
		retryAfter: null,
		body: "",
	});
});

test("a fetch that rejects is a network_error naming only the error's type", async () => {
	const s = site({
		api: async () => {
			throw new TypeError(`Failed to fetch with ${TOKEN}`);
		},
	});
	assert.deepEqual(await pageFetch(pageOn(s), PROBE_PATH), {
		kind: "network_error",
		message: "TypeError",
	});
});

test("a read that never answers is aborted at 30 seconds", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const s = site({
		api: (_url, init) =>
			new Promise<Response>((_resolve, reject) => {
				init.signal?.addEventListener("abort", () =>
					reject(init.signal?.reason),
				);
			}),
	});
	const pending = pageFetch(pageOn(s), PROBE_PATH);
	await new Promise(setImmediate);
	const signal = s.fetches[0]?.init.signal;
	assert.ok(signal, "the request started at once");
	t.mock.timers.tick(29_999);
	assert.equal(signal.aborted, false);
	t.mock.timers.tick(1);
	assert.equal(signal.aborted, true);
	assert.deepEqual(await pending, {
		kind: "network_error",
		message: "AbortError",
	});
});

test("an evaluate that a navigation destroys is a network_error, not a throw", async () => {
	const page = {
		evaluate: async () => {
			throw new Error(
				"page.evaluate: Execution context was destroyed, most likely because of a navigation",
			);
		},
	} as unknown as Page;
	assert.deepEqual(await pageFetch(page, PROBE_PATH), {
		kind: "network_error",
		message: "evaluate_failed",
	});
	assert.equal(await probeOnPage(page), false);
});

test("an evaluate answering null, PageShim's answer to a throw, is a network_error", async () => {
	const page = { evaluate: async () => null } as unknown as Page;
	assert.deepEqual(await pageFetch(page, PROBE_PATH), {
		kind: "network_error",
		message: "no_result",
	});
	assert.equal(await probeOnPage(page), false);
});

// ── Layer 1: classify ──────────────────────────────────────────────────────
const response = (
	status: number,
	contentType = "application/json",
	body = "{}",
	retryAfter: string | null = null,
): PageFetch => ({ kind: "response", status, contentType, retryAfter, body });

test("401, a missing token and the sign-in host ask for sign-in", () => {
	for (const r of [
		response(401, "text/plain", ""),
		{ kind: "no_token" },
		{ kind: "wrong_origin", origin: "https://sso.garmin.com" },
	] as PageFetch[]) {
		const outcome = classify(r, NOW.getTime());
		assert.equal(
			!outcome.ok && outcome.reason,
			"sign_in_required",
			JSON.stringify(r),
		);
		assert.equal(!outcome.ok && outcome.refresh, undefined, JSON.stringify(r));
		assert.equal(
			!outcome.ok && outcome.retryAfterMs,
			undefined,
			JSON.stringify(r),
		);
	}
});

test("403 asks for sign-in and marks the read as one a reload of the app may cure", () => {
	const outcome = classify(response(403, "text/plain", ""), NOW.getTime());
	assert.deepEqual(outcome, {
		ok: false,
		reason: "sign_in_required",
		message: "Garmin refused the session (HTTP 403).",
		refresh: true,
	});
});

test("429 waits Retry-After as seconds or an HTTP date, and 30 seconds without a readable one", () => {
	const cases: Array<[string | null, number]> = [
		["5", 5000],
		[" 12 ", 12_000],
		["0", 0],
		["Sun, 20 Sep 2026 13:30:30 GMT", 30_000],
		["Sun, 20 Sep 2026 13:29:30 GMT", 0],
		[null, 30_000],
		["", 30_000],
		["soon", 30_000],
		["1.5", 30_000],
		["-5", 30_000],
		["1e3", 30_000],
		["2026-09-20T13:30:30Z", 30_000],
	];
	for (const [header, ms] of cases) {
		const outcome = classify(
			response(429, "text/plain", "", header),
			NOW.getTime(),
		);
		assert.equal(
			!outcome.ok && outcome.reason,
			"collection_interrupted",
			String(header),
		);
		assert.equal(!outcome.ok && outcome.retryAfterMs, ms, String(header));
	}
});

test("5xx, a network error and any other origin interrupt collection, naming only what happened", () => {
	for (const status of [500, 502, 503]) {
		assert.deepEqual(classify(response(status, "text/html", "<html></html>")), {
			ok: false,
			reason: "collection_interrupted",
			message: `HTTP ${status}.`,
		});
	}
	const cases: Array<[PageFetch, string]> = [
		[{ kind: "wrong_origin", origin: "null" }, "Not read (wrong_origin)."],
		[
			{ kind: "wrong_origin", origin: "https://www.garmin.com" },
			"Not read (wrong_origin).",
		],
		[
			{ kind: "network_error", message: "TypeError" },
			"Not read (network_error).",
		],
	];
	for (const [r, message] of cases) {
		assert.deepEqual(classify(r), {
			ok: false,
			reason: "collection_interrupted",
			message,
		});
	}
});

test("only sso.garmin.com itself is the sign-in host: a lookalike origin interrupts collection", () => {
	for (const origin of [
		"http://sso.garmin.com",
		"https://sso.garmin.com:8443",
		"https://xsso.garmin.com",
		"https://sso.garmin.com.example.invalid",
	]) {
		const outcome = classify({ kind: "wrong_origin", origin });
		assert.equal(
			!outcome.ok && outcome.reason,
			"collection_interrupted",
			origin,
		);
	}
});

test("204 is data with nothing in it; a JSON 200 parses, whatever its charset", () => {
	assert.deepEqual(classify(response(204, "", "")), { ok: true, json: null });
	for (const contentType of [
		"application/json",
		"application/json;charset=UTF-8",
	]) {
		assert.deepEqual(
			classify(response(200, contentType, '{"timeZone":"UTC"}')),
			{
				ok: true,
				json: { timeZone: "UTC" },
			},
		);
	}
});

test("a 400, a 404 page, a 200 that is not JSON, or JSON that does not parse is unreadable, its body kept out of the message", () => {
	const leaky = "fixture-owner";
	for (const r of [
		response(
			400,
			"application/json",
			`{"message":"${leaky}","error":"BadRequest"}`,
		),
		response(404, "text/html", `<html>${leaky}</html>`),
		response(200, "text/html; charset=utf-8", `<html>${leaky}</html>`),
		response(200, "text/plain", `{"displayName":"${leaky}"}`),
		response(200, "application/json", `{"displayName":"${leaky}"`),
		response(302, "", ""),
	]) {
		const outcome = classify(r);
		assert.equal(
			!outcome.ok && outcome.reason,
			"source_unreadable",
			JSON.stringify(r),
		);
		assert.ok(!(!outcome.ok && outcome.message.includes(leaky)));
	}
});

// ── Layer 1: the retry list ────────────────────────────────────────────────
/** A retry span; one day when `to` is left out. */
const span = (from: string, to = from) => ({ from, to });
/** A first run's cursor at NOW, in the fixture account's Pacific/Auckland. */
const CURSOR = { next_day: "2026-09-22", floor: "2026-06-24" };

test("the retry list holds at most a year and a day", () => {
	assert.equal(MAX_RETRY_DAYS, 366);
});

test("normaliseRetry sorts, merges spans that overlap, touch or nest, keeps apart those a day apart, and leaves its input alone", () => {
	const input = [
		span("2026-07-10", "2026-07-12"),
		span("2026-07-01", "2026-07-03"),
		span("2026-07-04", "2026-07-05"),
		span("2026-07-02"),
		span("2026-07-07", "2026-07-08"),
		span("2026-07-08", "2026-07-11"),
	];
	const copy = structuredClone(input);
	assert.deepEqual(normaliseRetry(input), {
		retry: [span("2026-07-01", "2026-07-05"), span("2026-07-07", "2026-07-12")],
		dropped: 0,
	});
	assert.deepEqual(input, copy);
	assert.deepEqual(normaliseRetry([]), { retry: [], dropped: 0 });
});

test("normaliseRetry keeps a year and a day whole, and past it lets the oldest days go first, counting them", () => {
	const year = span("2025-06-01", "2026-06-01");
	assert.deepEqual(normaliseRetry([year]), { retry: [year], dropped: 0 });
	assert.deepEqual(normaliseRetry([span("2026-09-16"), year]), {
		retry: [span("2025-06-02", "2026-06-01"), span("2026-09-16")],
		dropped: 1,
	});
	// 1 + 6 + 365 days: the first span goes whole, the second loses five days of six.
	assert.deepEqual(
		normaliseRetry([
			span("2025-03-01", "2026-02-28"),
			span("2025-01-05", "2025-01-10"),
			span("2025-01-01"),
		]),
		{
			retry: [span("2025-01-10"), span("2025-03-01", "2026-02-28")],
			dropped: 6,
		},
	);
	// The days over the cap exactly fill the oldest span: it goes whole, never left running backwards.
	assert.deepEqual(
		normaliseRetry([span("2025-01-01"), span("2025-03-01", "2026-03-01")]),
		{ retry: [span("2025-03-01", "2026-03-01")], dropped: 1 },
	);
});

test("readCursor keeps each retry span whose days parse and run forward, drops the rest alone, and normalises what it keeps", () => {
	assert.deepEqual(
		readCursor({
			...CURSOR,
			retry: [
				span("2026-08-10", "2026-08-01"),
				span("2026-02-30", "2026-03-01"),
				// A day that sorts after its start yet is no day.
				span("2026-07-01", "2026-07-32"),
				span("2026-07-01", "2026-13-01"),
				{ from: "2026-07-01" },
				"2026-07-01",
				null,
				7,
				["2026-07-01", "2026-07-02"],
				{ ...span("2026-07-05", "2026-07-06"), note: "kept without it" },
				span("2026-07-01", "2026-07-04"),
			],
		}),
		{ ...CURSOR, retry: [span("2026-07-01", "2026-07-06")] },
	);
	// Over the cap, a saved list is cut to the latest year and a day.
	assert.deepEqual(
		readCursor({ ...CURSOR, retry: [span("2025-01-01", "2026-06-01")] }),
		{ ...CURSOR, retry: [span("2025-06-01", "2026-06-01")] },
	);
});

test("readCursor leaves the retry key out when the saved list is not a list, is empty, or holds nothing that reads; a cursor that does not read loses it too", () => {
	for (const retry of ["2026-07-01", {}, [], [{ from: "x", to: "y" }], null]) {
		const cursor = readCursor({ ...CURSOR, retry });
		assert.deepEqual(cursor, CURSOR, JSON.stringify(retry));
		assert.equal(Object.hasOwn(cursor, "retry"), false, JSON.stringify(retry));
	}
	assert.deepEqual(
		readCursor({
			next_day: "soon",
			floor: "2026-06-24",
			retry: [span("2026-07-01")],
		}),
		{},
	);
});

test("readCursor keeps the retry list beside a history cursor, and where reading kept days again stopped only beside a list it keeps", () => {
	const backfill = { since: "2026-05-01", next_day: "2026-05-14" };
	const retry = [span("2026-07-01", "2026-07-10")];
	assert.deepEqual(
		readCursor({ ...CURSOR, backfill, retry, retry_next: "2026-07-04" }),
		{ ...CURSOR, backfill, retry, retry_next: "2026-07-04" },
	);
	for (const saved of [
		{ ...CURSOR, retry, retry_next: "2026-07-32" },
		{ ...CURSOR, retry, retry_next: 20260704 },
		{ ...CURSOR, retry_next: "2026-07-04" },
		{ ...CURSOR, retry: [], retry_next: "2026-07-04" },
	]) {
		const cursor = readCursor(saved);
		assert.equal(
			Object.hasOwn(cursor, "retry_next"),
			false,
			JSON.stringify(saved),
		);
	}
});

test("planDays reads kept days last, only inside the grant, and never a day the forward or history segment reads", () => {
	const prev = {
		...CURSOR,
		retry: [
			// Starts before the grant and ends in the history segment: nothing left to read again.
			span("2026-06-01", "2026-06-21"),
			span("2026-07-01", "2026-07-02"),
			// Ends inside the overlap week.
			span("2026-09-10", "2026-09-16"),
			// After the owner's today.
			span("2026-09-25", "2026-09-30"),
		],
	};
	const saved = structuredClone(prev);
	const plan = planDays(prev, "2026-09-21", { since: "2026-06-20" }, false, 7);
	assert.deepEqual(plan.segments, [
		{
			kind: "forward",
			from: "2026-09-15",
			to: "2026-09-21",
			since: "2026-06-24",
		},
		{
			kind: "backfill",
			from: "2026-06-20",
			to: "2026-06-23",
			since: "2026-06-20",
		},
		{ kind: "retry", from: "2026-07-01", to: "2026-07-02" },
		{ kind: "retry", from: "2026-09-10", to: "2026-09-14" },
	]);
	// Every span is still kept until a read lets it go; prev is left alone.
	assert.deepEqual(plan.cursor, saved);
	assert.notEqual(plan.cursor.retry, prev.retry);
	assert.deepEqual(prev, saved);
});

test("planDays reads kept days again from where the last run stopped, then round from the oldest", () => {
	const retry = [
		span("2026-07-01", "2026-07-05"),
		span("2026-07-10", "2026-07-12"),
		span("2026-08-01"),
	];
	const again = (retry_next?: string) =>
		planDays(
			{ ...CURSOR, retry, ...(retry_next ? { retry_next } : {}) },
			"2026-09-21",
			{},
			false,
			7,
		)
			.segments.filter(({ kind }) => kind === "retry")
			.map(({ from, to }) => [from, to]);
	assert.deepEqual(again(), [
		["2026-07-01", "2026-07-05"],
		["2026-07-10", "2026-07-12"],
		["2026-08-01", "2026-08-01"],
	]);
	// Inside a span: it is read from that day, and its start last.
	assert.deepEqual(again("2026-07-11"), [
		["2026-07-11", "2026-07-12"],
		["2026-08-01", "2026-08-01"],
		["2026-07-01", "2026-07-05"],
		["2026-07-10", "2026-07-10"],
	]);
	// Between spans, or on a span's first day: whole spans, the next one first.
	for (const day of ["2026-07-20", "2026-08-01"]) {
		assert.deepEqual(again(day), [
			["2026-08-01", "2026-08-01"],
			["2026-07-01", "2026-07-05"],
			["2026-07-10", "2026-07-12"],
		]);
	}
	// Past every span: from the oldest.
	assert.deepEqual(again("2026-08-02"), again());
});

test("planDays keeps the retry list, and where reading it again stopped, through full_refresh and through a grant that restarts the cursor; a first run has none", () => {
	const retry = [span("2026-01-10")];
	const refresh = planDays(
		{ ...CURSOR, retry, retry_next: "2026-01-10" },
		"2026-09-21",
		{},
		true,
		7,
	);
	assert.deepEqual(refresh.cursor, {
		next_day: "2026-06-24",
		floor: "2026-06-24",
		retry,
		retry_next: "2026-01-10",
	});
	assert.deepEqual(refresh.segments.at(-1), {
		kind: "retry",
		from: "2026-01-10",
		to: "2026-01-10",
	});
	const restart = planDays(
		{
			next_day: "2026-08-01",
			floor: "2026-06-01",
			retry: [span("2026-07-10")],
			retry_next: "2026-07-10",
		},
		"2026-09-21",
		{ since: "2026-09-01" },
		false,
		7,
	);
	assert.deepEqual(restart.cursor, {
		next_day: "2026-09-01",
		floor: "2026-09-01",
		retry: [span("2026-07-10")],
		retry_next: "2026-07-10",
	});
	assert.deepEqual(
		restart.segments.map(({ kind }) => kind),
		["forward"],
		"the kept day lies before the grant",
	);
	const first = planDays({}, "2026-09-21", {}, false, 7);
	assert.deepEqual(first.cursor, {
		next_day: "2026-06-24",
		floor: "2026-06-24",
	});
	assert.equal(Object.hasOwn(first.cursor, "retry"), false);
	assert.deepEqual(
		first.segments.map(({ kind }) => kind),
		["forward"],
	);
});

test("planDays re-reads the overlap it is given before the cursor, never before the floor: a week for daily streams, for range streams from four weeks before the last run's day", () => {
	assert.deepEqual(OVERLAP, {
		daily_summaries: 7,
		sleep: 29,
		hrv: 29,
		training_status: 7,
		activities: 29,
	});
	const forward = (overlap: number, prev: DayCursor = CURSOR) =>
		planDays(prev, "2026-09-23", {}, false, overlap).segments;
	assert.deepEqual(forward(OVERLAP.daily_summaries), [
		{
			kind: "forward",
			from: "2026-09-15",
			to: "2026-09-23",
			since: "2026-06-24",
		},
	]);
	// The last run's day was 21 September: four weeks before it.
	assert.deepEqual(forward(OVERLAP.activities), [
		{
			kind: "forward",
			from: "2026-08-24",
			to: "2026-09-23",
			since: "2026-06-24",
		},
	]);
	assert.deepEqual(
		forward(OVERLAP.sleep, { next_day: "2026-09-22", floor: "2026-09-09" }),
		[
			{
				kind: "forward",
				from: "2026-09-09",
				to: "2026-09-23",
				since: "2026-09-09",
			},
		],
		"a floor inside the overlap holds it",
	);
});

test("planDays never reads before the grant's start, though the overlap reaches back past it", () => {
	for (const [since, overlap] of [
		["2026-09-17", OVERLAP.daily_summaries],
		["2026-09-10", OVERLAP.hrv],
	] as const) {
		const plan = planDays(CURSOR, "2026-09-21", { since }, false, overlap);
		assert.deepEqual(
			plan.segments,
			[{ kind: "forward", from: since, to: "2026-09-21", since: "2026-06-24" }],
			`overlap ${overlap}`,
		);
		assert.deepEqual(
			plan.cursor,
			CURSOR,
			"a grant starting before the cursor restarts nothing",
		);
	}
});

// ── Layer 3.1: probes ──────────────────────────────────────────────────────
test("probeSession from about:blank goes to the app once, then finds the session", async () => {
	const s = site({ url: "about:blank" });
	assert.equal(await probeSession(pageOn(s)), true);
	assert.deepEqual(s.gotos, [APP]);
	assert.equal(tokenSent(s), TOKEN);
});

test("probeSession already on the app does not navigate", async () => {
	const s = site();
	assert.equal(await probeSession(pageOn(s)), true);
	assert.deepEqual(s.gotos, []);
});

test("probeSession on an app page without the token loads the app once and reads again", async () => {
	const s = site({ url: `${ORIGIN}/robots.txt` });
	assert.equal(await probeSession(pageOn(s)), true);
	assert.deepEqual(s.gotos, [APP]);
});

test("probeSession signed out answers false after one goto, which lands on sign-in", async () => {
	const s = site({ url: "about:blank", signedIn: false });
	assert.equal(await probeSession(pageOn(s)), false);
	assert.deepEqual(s.gotos, [APP]);
	assert.deepEqual(s.fetches, [], "the sign-in page is not read");
});

test("probeSession: a 401 or 403 is no session; an unavailable API (429, 5xx) lets the run through to collection", async () => {
	for (const status of [401, 403]) {
		assert.equal(
			await probeSession(pageOn(site({ api: async () => answer(status) }))),
			false,
			String(status),
		);
	}
	for (const status of [429, 500, 503]) {
		assert.equal(
			await probeSession(pageOn(site({ api: async () => answer(status) }))),
			true,
			String(status),
		);
	}
	// A 200 that is not JSON is no session.
	const html = site({
		api: async () =>
			answer(200, "<html></html>", { "content-type": "text/html" }),
	});
	assert.equal(await probeSession(pageOn(html)), false);
});

test("probeSession answers false, without throwing, when the goto fails or a navigation races the read", async () => {
	const stuck = site({ url: "about:blank", gotoFails: true });
	assert.equal(await probeSession(pageOn(stuck)), false);
	assert.deepEqual(stuck.gotos, [APP]);

	const gotos: string[] = [];
	const racing = {
		evaluate: async () => {
			throw new Error(
				"page.evaluate: Execution context was destroyed, most likely because of a navigation",
			);
		},
		goto: async (target: string) => {
			gotos.push(target);
			return null;
		},
	} as unknown as Page;
	assert.equal(await probeSession(racing), false);
	assert.deepEqual(
		gotos,
		[],
		"only an off-origin or tokenless answer navigates",
	);
});

test("probeOnPage never navigates: false on the sign-in page even once signed in, true back on the app", async () => {
	const s = site({ url: SSO });
	const page = { evaluate: pageOn(s).evaluate } as unknown as Page;
	assert.equal(await probeOnPage(page), false);
	assert.deepEqual(s.fetches, []);
	s.url = APP;
	assert.equal(await probeOnPage(page), true);
	assert.deepEqual(s.gotos, []);
});

// ── Layer 3.1: ensureSession with the real manualBrowserLogin ──────────────
function sessionArgs(
	s: Site,
	page: Page,
	requests: Array<Record<string, unknown>>,
	onAssist: () => void,
): EnsureSessionArgs {
	return Object.assign(Object.create(null) as EnsureSessionArgs, {
		page,
		capture: null,
		checkpoint: async (label: string) => {
			s.trail.push(`checkpoint ${label}`);
		},
		assist: async (request: object) => {
			requests.push({ ...request });
			s.trail.push("assist");
			onAssist();
			return "assist-1";
		},
		completeAssistance: async (_id: string, status: string) => {
			s.trail.push(`complete ${status}`);
		},
		sendInteraction: async () => {
			throw new Error("manual_action fallback: a streamed argument is missing");
		},
	});
}

test("the default settle is three reads 1.5 s apart, which with 30 s reads stays inside the establish watchdog", () => {
	assert.deepEqual(
		{
			attempts: SIGN_IN_SETTLE.attempts,
			intervalMs: SIGN_IN_SETTLE.intervalMs,
		},
		{ attempts: 3, intervalMs: 1500 },
	);
	assert.equal(SIGN_IN_SETTLE.sleep, politeDelay);
	const longest =
		SIGN_IN_SETTLE.attempts * 30_000 +
		(SIGN_IN_SETTLE.attempts - 1) * SIGN_IN_SETTLE.intervalMs;
	assert.ok(longest < resolveSessionEstablishWatchdogMs({}), `${longest} ms`);
	assert.equal(typeof ensureSession, "function");
});

/** The real ensureSession with its settle's pauses recorded and not waited. */
const ensureSessionNow = (s: Site) =>
	makeEnsureSession({
		attempts: 3,
		intervalMs: 1500,
		sleep: async (ms) => {
			s.trail.push(`sleep ${ms}`);
		},
	});

/** Signed out, on about:blank, where the run starts. */
const signedOut = (): Site => site({ url: "about:blank", signedIn: false });

/** The owner signs in on Garmin's page; it sets the session and sends the page back to the app. */
const signsIn = (s: Site) => () => {
	s.signedIn = true;
	s.url = APP;
};

test("ensureSession opens the app once, settles without navigating, and hands the sign-in page over; readiness resolves it", {
	timeout: 30_000,
}, async () => {
	const s = signedOut();
	const requests: Array<Record<string, unknown>> = [];
	await ensureSessionNow(s)(sessionArgs(s, pageOn(s), requests, signsIn(s)));
	assert.deepEqual(s.gotos, [LOGIN_URL]);
	assert.deepEqual(s.trail, [
		"checkpoint sign-in-page",
		`goto ${APP}`,
		"checkpoint sign-in-settle",
		// The settle's reads land on the sign-in page: no request leaves it.
		"sleep 1500",
		"sleep 1500",
		"checkpoint sign-in-handoff",
		"assist",
		`fetch ${SETTINGS}`,
		"complete resolved",
	]);
	assert.equal(requests.length, 1);
	assert.equal(requests[0]?.owner_action, "operate_attachment");
	assert.equal(requests[0]?.timeout_seconds, 1800);
	assert.equal(requests[0]?.response_contract, "none");
	assert.deepEqual(requests[0]?.attachments, [
		{ kind: "browser_surface", role: "streaming_companion" },
	]);
	assert.match(String(requests[0]?.message), /Garmin Connect/);
	assert.equal(tokenSent(s), TOKEN);
	assert.ok(!JSON.stringify(requests).includes(TOKEN));
});

test("a session the app renews on load is found by the settle, without asking the owner", {
	timeout: 30_000,
}, async () => {
	// The app's own load renews a lapsed session: the probe's read after its goto and the settle's
	// first read still find no token; the settle's second finds the session.
	const s = site({ url: "about:blank", signedIn: false, meta: null });
	s.land = () => APP;
	let reads = 0;
	s.afterRead = () => {
		reads += 1;
		if (reads === 3) {
			s.signedIn = true;
			s.meta = TOKEN;
		}
	};
	const page = pageOn(s);
	const requests: Array<Record<string, unknown>> = [];
	// The runtime's order with probeSessionIsAuthoritative: probe, and only if dead, ensureSession.
	if (!(await probeSession(page))) {
		await ensureSessionNow(s)(sessionArgs(s, page, requests, () => {}));
	}
	assert.deepEqual(
		requests,
		[],
		"the owner was asked although the session came back",
	);
	assert.deepEqual(s.gotos, [APP, APP]);
	assert.ok(!s.trail.includes("checkpoint sign-in-handoff"));
	assert.deepEqual(s.trail.slice(-3), [
		"checkpoint sign-in-settle",
		"sleep 1500",
		`fetch ${SETTINGS}`,
	]);
});

test("while the owner is still on the sign-in page, the readiness probe neither reads nor navigates", {
	timeout: 30_000,
}, async () => {
	const s = signedOut();
	// The owner is still typing; the fake then closes the window, which ends the handoff here.
	await assert.rejects(
		ensureSessionNow(s)(sessionArgs(s, pageOn(s), [], () => {})),
		/browser_sign_in_cancelled/,
	);
	await new Promise(setImmediate);
	assert.deepEqual(s.gotos, [LOGIN_URL]);
	assert.deepEqual(s.fetches, []);
	assert.deepEqual(s.trail.slice(-3), [
		"assist",
		"closed",
		"complete escalated",
	]);
});

test("ensureSession ends as escalated, not a 30-minute wait, when the owner closes the window", {
	timeout: 30_000,
}, async () => {
	const s = signedOut();
	await assert.rejects(
		ensureSessionNow(s)(
			sessionArgs(s, pageOn(s), [], () => {
				s.closed = true;
			}),
		),
		/browser_sign_in_cancelled/,
	);
	assert.deepEqual(s.trail.slice(-2), ["assist", "complete escalated"]);
	assert.deepEqual(s.fetches, []);
});

test("a goto to the app that times out fails ensureSession before the owner is asked", async () => {
	const s = site({ url: "about:blank", signedIn: false, gotoFails: true });
	const requests: Array<Record<string, unknown>> = [];
	await assert.rejects(
		ensureSessionNow(s)(sessionArgs(s, pageOn(s), requests, () => {})),
		/Timeout/,
	);
	assert.deepEqual(requests, []);
});
