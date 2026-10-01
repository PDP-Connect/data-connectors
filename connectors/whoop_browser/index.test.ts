// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Layer 1: the in-page read, run from its source as the browser runs it, against a fake
 * app.whoop.com, and `classify`. Layer 3.1: the probes and `ensureSession`, its settle included,
 * with fakes and the real `manualBrowserLogin`. Expected values come from the WHOOP discovery
 * spec, written out here, not imported from index.ts, so a wrong constant there fails a test.
 * No test waits a real settle interval: each passes its own instant sleep or mocks the clock.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { Page } from "playwright";
import {
	type EnsureSessionArgs,
	politeDelay,
	resolveSessionEstablishWatchdogMs,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import {
	API_BASE,
	classify,
	ensureSession,
	LOGIN_URL,
	makeEnsureSession,
	ORIGIN,
	type PageFetch,
	PROBE_PATH,
	pageFetch,
	probeOnPage,
	probeSession,
	type Settle,
	SIGN_IN_SETTLE,
} from "./index.ts";

const NOW = new Date("2026-09-20T12:00:00.000Z");
const APP = "https://app.whoop.com/";
const API = "https://api.prod.whoop.com";
/** The account summary as the web app requests it. */
const BOOTSTRAP_URL = `${API}/users-service/v2/bootstrap/?accountType=users&apiVersion=7`;
/** Where signed-out app.whoop.com sends the page. */
const SIGN_IN = `https://id.whoop.com/sign-in?for=${encodeURIComponent(APP)}`;
const BOOTSTRAP = readFileSync(
	new URL("./fixtures/bootstrap.json", import.meta.url),
	"utf8",
);
const COOKIE_TOKEN = "fixture.cookie-token+/=";
const STORED_TOKEN = "fixture.stored-token";
const TOKEN_COOKIE = `whoop-auth-token=${encodeURIComponent(COOKIE_TOKEN)}`;
const REFRESH_COOKIE = "whoop-auth-refresh-token=fixture-refresh";
const STORAGE_KEY = "whoop.security.accessToken";
/** WHOOP's signed-out answer: typed as JSON, but plain text. */
const NOT_VALID = "Authorization was not valid";
const SIGNED_OUT: PageFetch = {
	kind: "response",
	status: 401,
	url: "",
	contentType: "",
	retryAfter: null,
	body: "",
};

/** Runs a page.evaluate callback from its source, as the browser would. */
const inPage = (fn: unknown, arg?: unknown): Promise<unknown> =>
	Promise.resolve(
		new Function(`return (${String(fn)})`)()(
			arg === undefined ? undefined : JSON.parse(JSON.stringify(arg)),
		),
	);

const answer = (
	status: number,
	body: string,
	headers: Record<string, string> = { "content-type": "application/json" },
) => new Response(body, { status, headers });

// ── A fake browser tab ─────────────────────────────────────────────────────
interface Site {
	/** The tab's current URL; its origin is what the callback sees. */
	url: string;
	cookie: string;
	/** localStorage, or what reading it throws. */
	storage: Record<string, string> | Error;
	/** api.prod.whoop.com's answer to the page's fetch. */
	api: (url: string, init: RequestInit) => Promise<Response>;
	/** Where a goto ends up; by default its target. */
	land?: (target: string) => string;
	/** Runs after each evaluate: the page moving on by itself. */
	afterRead?: () => void;
	gotoFails?: boolean;
	closed: boolean;
	onClose: Set<() => void>;
	cookieReads: number;
	fetches: Array<{ url: string; init: RequestInit }>;
	fns: unknown[];
	gotos: string[];
	/** Every page-visible step, in order. */
	trail: string[];
}

/** By default: on the app, signed in, the API answering the account summary and nothing else. */
function site(overrides: Partial<Site> = {}): Site {
	return {
		url: APP,
		cookie: `whoop-auth-user=fixture; ${TOKEN_COOKIE}; ${REFRESH_COOKIE}`,
		storage: {},
		api: async (url) =>
			url === BOOTSTRAP_URL ? answer(200, BOOTSTRAP) : answer(404, ""),
		closed: false,
		onClose: new Set(),
		cookieReads: 0,
		fetches: [],
		fns: [],
		gotos: [],
		trail: [],
		...overrides,
	};
}

const SWAPPED = ["location", "document", "localStorage", "fetch"] as const;

/** Runs `run` with the page's globals in place, restoring Node's afterwards. */
async function inSite<T>(s: Site, run: () => Promise<T>): Promise<T> {
	const saved = SWAPPED.map(
		(name) =>
			[name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
	);
	const { storage } = s;
	Object.defineProperty(globalThis, "location", {
		configurable: true,
		value: { href: s.url, origin: new URL(s.url).origin },
	});
	Object.defineProperty(globalThis, "document", {
		configurable: true,
		value: {
			get cookie() {
				s.cookieReads += 1;
				return s.cookie;
			},
		},
	});
	Object.defineProperty(
		globalThis,
		"localStorage",
		storage instanceof Error
			? {
					configurable: true,
					get: () => {
						throw storage;
					},
				}
			: {
					configurable: true,
					value: {
						getItem: (key: string) =>
							Object.hasOwn(storage, key) ? (storage[key] ?? null) : null,
					},
				},
	);
	Object.defineProperty(globalThis, "fetch", {
		configurable: true,
		writable: true,
		value: async (input: unknown, init: RequestInit = {}) => {
			const url = String(input);
			s.fetches.push({ url, init });
			s.trail.push(`fetch ${url}`);
			const res = await s.api(url, init);
			Object.defineProperty(res, "url", { value: url });
			return res;
		},
	});
	try {
		return await run();
	} finally {
		for (const [name, descriptor] of saved) {
			if (descriptor) {
				Object.defineProperty(globalThis, name, descriptor);
			} else {
				Reflect.deleteProperty(globalThis, name);
			}
		}
	}
}

/** The owner closes the window: the handoff's close listeners fire. */
function shut(s: Site): void {
	s.closed = true;
	s.trail.push("closed");
	for (const listener of s.onClose) {
		listener();
	}
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
				if (s.trail.includes("assist") && !answered200(result)) {
					shut(s);
				}
			}
		},
		on: (event: string, listener: () => void) => {
			if (event === "close") {
				s.onClose.add(listener);
			}
		},
		off: (_event: string, listener: () => void) => {
			s.onClose.delete(listener);
		},
		goto: async (target: string) => {
			s.gotos.push(target);
			s.trail.push(`goto ${target}`);
			if (s.gotoFails) {
				throw new Error("page.goto: Timeout 30000ms exceeded.");
			}
			s.url = s.land ? s.land(target) : target;
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

const authorization = (s: Site, index = 0): string | null =>
	new Headers(s.fetches[index]?.init.headers).get("authorization");

// ── Layer 1: constants ─────────────────────────────────────────────────────
test("the origin, API host, sign-in URL and probe are the ones the web app uses", () => {
	assert.equal(ORIGIN, "https://app.whoop.com");
	assert.equal(API_BASE, API);
	assert.equal(LOGIN_URL, APP);
	assert.equal(`${API_BASE}${PROBE_PATH}`, BOOTSTRAP_URL);
});

// ── Layer 1: the in-page read ──────────────────────────────────────────────
test("the in-page read is self-contained: no tsx __name helper, and it runs from its own source", async () => {
	const s = site();
	const result = await pageFetch(pageOn(s), PROBE_PATH);
	assert.equal(s.fns.length, 1);
	assert.doesNotMatch(String(s.fns[0]), /__name/);
	assert.equal(result.kind, "response");
});

test("off the app the read answers wrong_origin and never touches the token", async () => {
	for (const [url, origin] of [
		["about:blank", "null"],
		[SIGN_IN, "https://id.whoop.com"],
		["https://www.whoop.com/", "https://www.whoop.com"],
	] as const) {
		const s = site({ url });
		assert.deepEqual(
			await pageFetch(pageOn(s), PROBE_PATH),
			{ kind: "wrong_origin", origin },
			url,
		);
		assert.equal(s.cookieReads, 0, url);
		assert.deepEqual(s.fetches, [], url);
	}
});

test("the token is the whoop-auth-token cookie, URL-decoded, sent as a lowercase bearer, and never returned", async () => {
	const s = site();
	const result = await pageFetch(pageOn(s), PROBE_PATH);
	assert.equal(authorization(s), `bearer ${COOKIE_TOKEN}`);
	assert.deepEqual(result, {
		kind: "response",
		status: 200,
		url: BOOTSTRAP_URL,
		contentType: "application/json",
		retryAfter: null,
		body: BOOTSTRAP,
	});
	const returned = JSON.stringify(result);
	for (const secret of [
		COOKIE_TOKEN,
		encodeURIComponent(COOKIE_TOKEN),
		"fixture-refresh",
	]) {
		assert.ok(!returned.includes(secret), `${secret} left the page`);
	}
});

test("the cookie wins over a different, possibly stale, localStorage token", async () => {
	const s = site({ storage: { [STORAGE_KEY]: JSON.stringify(STORED_TOKEN) } });
	await pageFetch(pageOn(s), PROBE_PATH);
	assert.equal(authorization(s), `bearer ${COOKIE_TOKEN}`);
});

test("without the cookie, the localStorage token is used, JSON-quoted or bare, and never the refresh cookie", async () => {
	for (const stored of [JSON.stringify(STORED_TOKEN), STORED_TOKEN]) {
		const s = site({
			cookie: `whoop-auth-user=fixture; ${REFRESH_COOKIE}`,
			storage: { [STORAGE_KEY]: stored },
		});
		const result = await pageFetch(pageOn(s), PROBE_PATH);
		assert.equal(authorization(s), `bearer ${STORED_TOKEN}`, stored);
		assert.ok(
			!JSON.stringify(result).includes(STORED_TOKEN),
			`${stored} left the page`,
		);
	}
});

test("a cookie whose name only resembles whoop-auth-token is not the token", async () => {
	const s = site({
		cookie: ["xwhoop-auth-token", "whoop-auth-token-v2"]
			.map((name) => `${name}=fixture`)
			.join("; "),
	});
	assert.deepEqual(await pageFetch(pageOn(s), PROBE_PATH), SIGNED_OUT);
	assert.deepEqual(s.fetches, []);
});

test("with no token at all the read answers a 401 without a request", async () => {
	const s = site({ cookie: `whoop-auth-user=fixture; ${REFRESH_COOKIE}` });
	assert.deepEqual(await pageFetch(pageOn(s), PROBE_PATH), SIGNED_OUT);
	assert.deepEqual(s.fetches, []);
});

test("unreadable localStorage answers a 401 without a request", async () => {
	const s = site({
		cookie: "",
		storage: new DOMException("The operation is insecure.", "SecurityError"),
	});
	assert.deepEqual(await pageFetch(pageOn(s), PROBE_PATH), SIGNED_OUT);
	assert.deepEqual(s.fetches, []);
});

test("the request goes to the API host plus the path, with the page's credentials, asking for JSON", async () => {
	const path =
		"/core-details-bff/v0/cycles/details?apiVersion=7&id=41001&limit=64";
	const s = site({ api: async () => answer(200, '{"records":[]}') });
	await pageFetch(pageOn(s), path);
	assert.equal(s.fetches.length, 1);
	const [call] = s.fetches;
	assert.equal(call?.url, `${API}${path}`);
	assert.equal(call?.init.credentials, "include");
	assert.equal(call?.init.method ?? "GET", "GET");
	assert.equal(
		new Headers(call?.init.headers).get("accept"),
		"application/json",
	);
	assert.ok(
		call?.init.signal instanceof AbortSignal,
		"the read is bounded by a signal",
	);
});

test("status, content type, Retry-After and body come back as the page read them", async () => {
	const limited = site({
		api: async () =>
			answer(429, "{}", {
				"content-type": "application/json; charset=utf-8",
				"retry-after": "7",
			}),
	});
	assert.deepEqual(await pageFetch(pageOn(limited), PROBE_PATH), {
		kind: "response",
		status: 429,
		url: BOOTSTRAP_URL,
		contentType: "application/json; charset=utf-8",
		retryAfter: "7",
		body: "{}",
	});
	// WHOOP's signed-out answer, with a token the API no longer accepts.
	const expired = site({ api: async () => answer(401, NOT_VALID) });
	const result = await pageFetch(pageOn(expired), PROBE_PATH);
	assert.deepEqual(result, {
		kind: "response",
		status: 401,
		url: BOOTSTRAP_URL,
		contentType: "application/json",
		retryAfter: null,
		body: NOT_VALID,
	});
	const untyped = site({
		api: async () => new Response(new Uint8Array([123, 125]), { status: 200 }),
	});
	const bare = await pageFetch(pageOn(untyped), PROBE_PATH);
	assert.equal(bare.kind === "response" && bare.contentType, "");
});

test("a fetch that rejects is a network_error naming only the error's type", async () => {
	const s = site({
		api: async () => {
			throw new TypeError(`Failed to fetch with ${COOKIE_TOKEN}`);
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
const read = (
	status: number,
	contentType = "application/json",
	body = "{}",
	retryAfter: string | null = null,
) =>
	({
		kind: "response",
		status,
		url: BOOTSTRAP_URL,
		contentType,
		retryAfter,
		body,
	}) as const;

test("401 and 403 ask for sign-in, WHOOP's plain-text 401 and the page's own 401 included", () => {
	for (const r of [
		read(401, "application/json", NOT_VALID),
		SIGNED_OUT,
		read(403, "text/html", "<html></html>"),
	]) {
		const outcome = classify(r, NOW.getTime());
		assert.equal(outcome.ok, false);
		assert.equal(
			!outcome.ok && outcome.reason,
			"sign_in_required",
			JSON.stringify(r),
		);
		assert.equal(!outcome.ok && outcome.retryAfterMs, undefined);
	}
});

test("429 waits Retry-After as seconds or an HTTP date, and 60 seconds without a readable one", () => {
	const cases: Array<[string | null, number]> = [
		["5", 5000],
		[" 12 ", 12_000],
		["0", 0],
		// IMF-fixdate, 30 s after and before NOW.
		["Sun, 20 Sep 2026 12:00:30 GMT", 30_000],
		["Sun, 20 Sep 2026 11:59:30 GMT", 0],
		[null, 60_000],
		["", 60_000],
		["soon", 60_000],
	];
	for (const [header, ms] of cases) {
		const outcome = classify(
			read(429, "application/json", "{}", header),
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

test("a malformed Retry-After falls back to 60 seconds", () => {
	// RFC 9110: delay-seconds is digits only. V8's legacy parser reads 1.5, -5 and +5 as dates in
	// 2001, and Number reads 1e3 and 0x10; an ISO instant is a date, but not an HTTP-date.
	for (const header of [
		"1.5",
		"-5",
		"+5",
		"5s",
		"1e3",
		"0x10",
		"2026-09-20T12:00:30Z",
	]) {
		const outcome = classify(
			read(429, "application/json", "{}", header),
			NOW.getTime(),
		);
		assert.equal(!outcome.ok && outcome.retryAfterMs, 60_000, header);
	}
});

test("5xx interrupts collection without a retry wait", () => {
	for (const status of [500, 502, 503, 504]) {
		const outcome = classify(
			read(status, "text/html", "<html></html>"),
			NOW.getTime(),
		);
		assert.equal(
			!outcome.ok && outcome.reason,
			"collection_interrupted",
			String(status),
		);
		assert.equal(
			!outcome.ok && outcome.retryAfterMs,
			undefined,
			String(status),
		);
	}
});

test("a page that read nothing interrupts collection, naming only what happened", () => {
	const cases: Array<[PageFetch, string]> = [
		// about:blank, a run's first page.
		[{ kind: "wrong_origin", origin: "null" }, "Not read (wrong_origin)."],
		[
			{ kind: "wrong_origin", origin: "https://www.whoop.com" },
			"Not read (wrong_origin).",
		],
		[
			{ kind: "network_error", message: "TypeError" },
			"Not read (network_error).",
		],
	];
	for (const [r, message] of cases) {
		assert.deepEqual(classify(r, NOW.getTime()), {
			ok: false,
			reason: "collection_interrupted",
			message,
		});
	}
});

test("a page gone to WHOOP's sign-in host asks for sign-in, as a 401 does", async () => {
	const signedOutOutcome = classify(SIGNED_OUT, NOW.getTime());
	assert.equal(
		!signedOutOutcome.ok && signedOutOutcome.reason,
		"sign_in_required",
	);
	assert.deepEqual(
		classify(
			{ kind: "wrong_origin", origin: "https://id.whoop.com" },
			NOW.getTime(),
		),
		signedOutOutcome,
	);
	// The in-page read on the sign-in page itself, as a run that the app sent there makes it.
	assert.deepEqual(
		classify(await pageFetch(pageOn(site({ url: SIGN_IN })), PROBE_PATH)),
		signedOutOutcome,
	);
});

test("only id.whoop.com itself is the sign-in host: a lookalike origin interrupts collection", () => {
	for (const origin of [
		"http://id.whoop.com",
		"https://id.whoop.com:8443",
		"https://xid.whoop.com",
		"https://id.whoop.com.example.invalid",
	]) {
		assert.deepEqual(
			classify({ kind: "wrong_origin", origin }, NOW.getTime()),
			{
				ok: false,
				reason: "collection_interrupted",
				message: "Not read (wrong_origin).",
			},
			origin,
		);
	}
});

test("a 200 that is not JSON, or JSON-typed but unparseable, is unreadable, and its body stays out of the message", () => {
	const leaky = "<html>fixture@example.invalid</html>";
	for (const r of [
		read(200, "text/html; charset=utf-8", leaky),
		read(200, "application/json", NOT_VALID),
		read(200, "", '{"user":{"id":41001}}'),
		read(404, "application/json", '{"user":{"id":41001}}'),
		read(204, "", ""),
	]) {
		const outcome = classify(r, NOW.getTime());
		assert.equal(
			!outcome.ok && outcome.reason,
			"source_unreadable",
			JSON.stringify(r),
		);
		const message = outcome.ok ? "" : outcome.message;
		for (const value of ["fixture@example.invalid", "41001", NOT_VALID]) {
			assert.ok(!message.includes(value), `${value} in "${message}"`);
		}
	}
});

test("a JSON 200 parses, whatever its charset", () => {
	for (const contentType of [
		"application/json",
		"application/json; charset=utf-8",
	]) {
		assert.deepEqual(
			classify(read(200, contentType, BOOTSTRAP), NOW.getTime()),
			{
				ok: true,
				json: JSON.parse(BOOTSTRAP),
			},
		);
	}
});

// ── Layer 3.1: probes ──────────────────────────────────────────────────────
test("probeSession from about:blank goes to the app once, then finds the session", async () => {
	const s = site({ url: "about:blank" });
	assert.equal(await probeSession(pageOn(s)), true);
	assert.deepEqual(s.gotos, [APP]);
	assert.equal(authorization(s), `bearer ${COOKIE_TOKEN}`);
});

test("probeSession lets an unavailable API through to collection, which reports it to retry; a 401 is still signed out", async () => {
	// Asking the owner to sign in because WHOOP's API is down would end in a 30-minute wait that
	// is not retried; collection classifies 429 and 5xx as an interruption to retry instead.
	for (const status of [429, 500, 503]) {
		const s = site({ api: async () => answer(status, "") });
		assert.equal(await probeSession(pageOn(s)), true, String(status));
	}
	const s = site({ api: async () => answer(401, NOT_VALID) });
	assert.equal(await probeSession(pageOn(s)), false);
});

test("probeSession already on the app does not navigate", async () => {
	const s = site();
	assert.equal(await probeSession(pageOn(s)), true);
	assert.deepEqual(s.gotos, []);
});

test("probeSession signed out answers false after one goto, wherever the app sends the page", async () => {
	// The app stays put without a token; or sends the page to id.whoop.com; or holds a token WHOOP refuses.
	const variants: Array<[string, Partial<Site>, number]> = [
		["no token", { cookie: "whoop-auth-user=fixture" }, 0],
		[
			"sent to sign-in",
			{ cookie: "whoop-auth-user=fixture", land: () => SIGN_IN },
			0,
		],
		[
			"stale stored token",
			{
				cookie: "whoop-auth-user=fixture",
				storage: { [STORAGE_KEY]: JSON.stringify(STORED_TOKEN) },
				api: async () => answer(401, NOT_VALID),
			},
			1,
		],
	];
	for (const [label, overrides, requests] of variants) {
		const s = site({ url: "about:blank", ...overrides });
		assert.equal(await probeSession(pageOn(s)), false, label);
		assert.deepEqual(s.gotos, [APP], label);
		assert.equal(s.fetches.length, requests, label);
	}
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
	assert.deepEqual(gotos, [], "only an off-origin answer navigates");
});

test("probeOnPage never navigates: false on id.whoop.com even once the cookie is set, true back on the app", async () => {
	const s = site({ url: SIGN_IN });
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

test("the default settle waits at most fifteen seconds, well inside the establish watchdog", () => {
	const settle: Settle = SIGN_IN_SETTLE;
	assert.equal(settle.sleep, politeDelay);
	const longest = (settle.attempts - 1) * settle.intervalMs;
	assert.ok(longest <= 15_000);
	assert.ok(longest < resolveSessionEstablishWatchdogMs({}) / 2);
	assert.equal(typeof ensureSession, "function");
});

test("the settle starts no read after sixty seconds, so stalled reads cannot hold it past the establish watchdog", {
	timeout: 30_000,
}, async () => {
	// Each settle read stalls for thirty seconds; without the time budget all ten would run.
	const s = signedOut();
	let clock = 0;
	s.afterRead = () => {
		clock += 30_000;
	};
	const sleeps: number[] = [];
	await makeEnsureSession({
		attempts: 10,
		intervalMs: 1500,
		sleep: async (ms) => {
			sleeps.push(ms);
		},
		now: () => clock,
	})(
		sessionArgs(s, pageOn(s), [], () => {
			s.cookie = `${s.cookie}; ${TOKEN_COOKIE}`;
			s.url = APP;
		}),
	);
	assert.deepEqual(sleeps, [1500], "two reads, one pause, then the handoff");
	assert.ok(s.trail.includes("checkpoint sign-in-handoff"));
});

/** The real ensureSession with its settle cut to two reads and no wait, so a signed-out case hands off at once. */
const ensureSessionNow = makeEnsureSession({
	attempts: 2,
	intervalMs: 0,
	sleep: async () => {},
});

/** Signed out: the app sends the page to id.whoop.com until the cookie is set. */
function signedOut(): Site {
	const s = site({ url: "about:blank", cookie: "whoop-auth-user=fixture" });
	s.land = (target) => (s.cookie.includes(TOKEN_COOKIE) ? target : SIGN_IN);
	return s;
}

test("ensureSession opens the sign-in page once and hands it over; the readiness probe resolves it", {
	timeout: 30_000,
}, async () => {
	const s = signedOut();
	const requests: Array<Record<string, unknown>> = [];
	await ensureSessionNow(
		sessionArgs(s, pageOn(s), requests, () => {
			// The owner signs in; id.whoop.com sets the cookie and sends the page back to the app.
			s.cookie = `${s.cookie}; ${TOKEN_COOKIE}`;
			s.url = APP;
		}),
	);
	assert.deepEqual(s.gotos, [LOGIN_URL]);
	assert.deepEqual(s.trail, [
		"checkpoint sign-in-page",
		`goto ${APP}`,
		"checkpoint sign-in-settle",
		"checkpoint sign-in-handoff",
		"assist",
		`fetch ${BOOTSTRAP_URL}`,
		"complete resolved",
	]);
	assert.equal(requests.length, 1);
	assert.equal(requests[0]?.owner_action, "operate_attachment");
	assert.equal(requests[0]?.timeout_seconds, 1800);
	assert.equal(requests[0]?.response_contract, "none");
	assert.deepEqual(requests[0]?.attachments, [
		{ kind: "browser_surface", role: "streaming_companion" },
	]);
	assert.equal(authorization(s), `bearer ${COOKIE_TOKEN}`);
	assert.ok(!JSON.stringify(requests).includes(COOKIE_TOKEN));
});

test("while the owner is still on id.whoop.com, the readiness probe neither reads nor navigates", {
	timeout: 30_000,
}, async () => {
	const s = signedOut();
	// The owner is still typing; the fake then closes the window, which ends the handoff here.
	await assert.rejects(
		ensureSessionNow(sessionArgs(s, pageOn(s), [], () => {})),
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
		ensureSessionNow(
			sessionArgs(s, pageOn(s), [], () => {
				s.closed = true;
			}),
		),
		/browser_sign_in_cancelled/,
	);
	assert.deepEqual(s.trail.slice(-2), ["assist", "complete escalated"]);
	assert.deepEqual(s.fetches, []);
});

test("an expired token with a live refresh cookie is renewed without asking the owner", {
	timeout: 30_000,
}, async () => {
	// The access-token cookie is deleted when the token expires (about a day); the 30-day refresh
	// cookie is not. Loading the app bounces through id.whoop.com and back, which sets a new cookie,
	// but the page reaches domcontentloaded first: the first read after the goto finds no token.
	const s = site({
		url: "about:blank",
		cookie: `whoop-auth-user=fixture; ${REFRESH_COOKIE}`,
	});
	let bouncing = false;
	s.land = (target) => {
		bouncing = !s.cookie.includes(TOKEN_COOKIE);
		return target;
	};
	s.afterRead = () => {
		if (bouncing && s.url === APP) {
			s.cookie = `${s.cookie}; ${TOKEN_COOKIE}`;
			bouncing = false;
		}
	};
	const page = pageOn(s);
	const requests: Array<Record<string, unknown>> = [];
	// What the runtime does with probeSessionIsAuthoritative: probe, and only if dead, ensureSession.
	if (!(await probeSession(page))) {
		await ensureSessionNow(sessionArgs(s, page, requests, () => {}));
	}
	assert.deepEqual(
		requests,
		[],
		"the owner was asked to sign in although WHOOP renews the session itself",
	);
});
