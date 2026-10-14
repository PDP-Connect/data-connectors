// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Sign-in: the real handoff against the readiness probe (Layer 3.2); the identity the OCI builder
// checks; then one real headless Patchright journey, from a signed-out page through Garmin's
// sign-in host to collected records on that same page (Layer 3.3).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { chromium, type Page as RawPage } from "patchright";
import type { Page } from "playwright";
import { z } from "zod";
import { manualBrowserLogin } from "../../packages/polyfill-connectors/src/browser-handoff.ts";
import type {
	AssistanceRequest,
	EnsureSessionArgs,
	StreamScope,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { makeRecordingEmit } from "../../packages/polyfill-connectors/src/test-harness.ts";
import { garminApi } from "./fake-garmin.ts";
import {
	APP_URL,
	collectGarminBrowser,
	makeEnsureSession,
	ORIGIN,
	type PageFetch,
	PROBE_PATH,
	probeOnPage,
	probeSession,
	STREAMS,
} from "./index.ts";
import { validateRecord } from "./schemas.ts";

const NOW = new Date("2026-09-20T13:30:00.000Z");
const read = (path: string): string =>
	readFileSync(new URL(path, import.meta.url), "utf8");
const MESSAGE =
	"Sign in to Garmin Connect in the secure browser. PDPP continues on its own once you are signed in.";

// ── Layer 3.2: the real handoff against probeOnPage ────────────────────────

/** What pageFetch's callback answers on the owner's page, or how its evaluate fails. */
type Answer = PageFetch | null | Error;
const answer = (
	status: number,
	contentType: string,
	body: string,
): PageFetch => ({
	kind: "response",
	status,
	contentType,
	retryAfter: null,
	body,
});
const LIVE = answer(200, "application/json", read("./fixtures/settings.json"));
/** Garmin's answers without a session, and without the token. */
const SIGNED_OUT = answer(401, "text/plain", "");
const NO_HEADER = answer(403, "text/plain", "");
const CHALLENGE = answer(
	403,
	"text/html; charset=UTF-8",
	"<!doctype html><title>Just a moment...</title>",
);
const ON_SIGN_IN_PAGE: PageFetch = {
	kind: "wrong_origin",
	origin: "https://sso.garmin.com",
};
const NO_TOKEN: PageFetch = { kind: "no_token" };
/** A page leaving for the sign-in host during or just after load. */
const NAVIGATED_AWAY = new Error(
	"page.evaluate: Execution context was destroyed, most likely because of a navigation",
);

/**
 * The owner's page, with no `goto`: each evaluate is recorded and answered in turn, the last
 * answer repeating. Every member the handoff or the probe reaches for is recorded too.
 */
function ownerPage(answers: Answer[]): {
	page: Page;
	reads: unknown[];
	touched: Set<string>;
} {
	const reads: unknown[] = [];
	const touched = new Set<string>();
	const target = {
		evaluate: async (_fn: unknown, arg: unknown): Promise<unknown> => {
			reads.push(arg);
			const next = answers[Math.min(reads.length, answers.length) - 1];
			if (next instanceof Error) throw next;
			return next;
		},
	};
	const page = new Proxy(target, {
		get(object, property) {
			touched.add(String(property));
			return Reflect.get(object, property);
		},
	}) as unknown as Page;
	return { page, reads, touched };
}

function handoff(
	page: Page,
	completions: string[],
	window: { autoProbeWindowMs: number; now?: () => number },
): Promise<boolean> {
	return manualBrowserLogin({
		assist: async () => "garmin-browser-handoff",
		autoProbeIntervalMs: 1,
		...window,
		completeAssistance: async (_id, status) => {
			completions.push(status);
		},
		isProbeSuccessful: (ok) => ok === true,
		message: MESSAGE,
		page,
		probe: async () => {
			throw new Error("the owner-page probe is not the watcher's");
		},
		readinessProbe: probeOnPage,
		readinessProbeOnHandoffPage: true,
		sendInteraction: async () => {
			throw new Error("manual_action fallback: a streamed argument is missing");
		},
	});
}

const SETTINGS_READ = { origin: ORIGIN, path: PROBE_PATH };

test("garmin_browser: readiness on a signed-in page resolves the handoff without navigating", {
	timeout: 30_000,
}, async () => {
	const owner = ownerPage([LIVE]);
	const completions: string[] = [];
	assert.equal(
		await handoff(owner.page, completions, { autoProbeWindowMs: 50 }),
		true,
	);
	assert.deepEqual(completions, ["resolved"]);
	assert.deepEqual(owner.reads, [SETTINGS_READ]);
	assert.equal(owner.touched.has("goto"), false, "never navigates");
	assert.equal(owner.touched.has("url"), false, "never reads page.url()");
});

test("garmin_browser: readiness waits out the sign-in page, a tokenless app page and navigation races, still without navigating", {
	timeout: 30_000,
}, async () => {
	// The owner's way in: the app leaves for the sign-in host mid-probe, PageShim answers a throw
	// with null, the app comes back before its token is in the page, then signed in.
	const owner = ownerPage([
		NAVIGATED_AWAY,
		ON_SIGN_IN_PAGE,
		null,
		NO_TOKEN,
		SIGNED_OUT,
		LIVE,
	]);
	const completions: string[] = [];
	const ready = await handoff(owner.page, completions, {
		autoProbeWindowMs: 50,
		now: () => 0, // a still clock: the window cannot close under a loaded runner
	});
	assert.equal(ready, true);
	assert.deepEqual(completions, ["resolved"]);
	assert.equal(owner.reads.length, 6);
	for (const arg of owner.reads) assert.deepEqual(arg, SETTINGS_READ);
	assert.equal(owner.touched.has("goto"), false, "never navigates");
});

test("garmin_browser: readiness that never passes rejects as timed out, not as a probe failure", {
	timeout: 30_000,
}, async () => {
	const signedOut: Array<[string, Answer]> = [
		["Garmin's 401", SIGNED_OUT],
		["a 403 without the token", NO_HEADER],
		["a Cloudflare 403", CHALLENGE],
		["the sign-in page", ON_SIGN_IN_PAGE],
		["an app page without its token", NO_TOKEN],
		["PageShim's null", null],
		["a navigation race", NAVIGATED_AWAY],
	];
	for (const [label, stub] of signedOut) {
		const owner = ownerPage([stub]);
		const completions: string[] = [];
		await assert.rejects(
			handoff(owner.page, completions, { autoProbeWindowMs: 0 }),
			/browser_handoff_readiness_timed_out/u,
			label,
		);
		assert.deepEqual(completions, ["escalated"], label);
		assert.deepEqual(owner.reads, [SETTINGS_READ], label);
		assert.equal(owner.touched.has("goto"), false, `${label}: navigated`);
	}
});

test("garmin_browser: identity meets the OCI builder's key and id checks, and the profile is named by the key", () => {
	const manifest = z
		.object({
			connector_key: z.string(),
			connector_id: z.string(),
			manifest_uri: z.string(),
			source: z.object({ id: z.string() }),
		})
		.parse(JSON.parse(read("./manifest.json")));
	const key = manifest.connector_key;
	assert.equal(key, "garmin-browser");
	assert.match(key, /^[a-z0-9][a-z0-9-]*$/u);
	assert.equal(
		manifest.connector_id,
		`https://registry.pdpp.dev/connectors/${key}`,
	);
	assert.equal(manifest.manifest_uri, manifest.connector_id);
	assert.equal(
		manifest.source.id,
		"https://registry.pdpp.dev/sources/garmin_browser",
	);
	// The runtime names the host-browser variable from profileName, DataConnect from the key.
	const entry = read("./index.ts");
	assert.match(entry, /\bname: "garmin_browser",/u);
	assert.equal(/profileName: "([^"]*)"/u.exec(entry)?.[1], key);
});

// ── Layer 3.3: a real headless Patchright journey ──────────────────────────

const SSO =
	"https://sso.garmin.com/portal/sso/en-US/sign-in?clientId=GarminConnect&service=https%3A%2F%2Fconnect.garmin.com%2Fapp";
const SESSION_COOKIE = "GARMIN-FIXTURE-SESSION";
const TOKEN = "fixture-csrf-0123456789abcdef";
const APP_PAGE = `<!doctype html><html><head><meta name="csrf-token" content="${TOKEN}"><title>Garmin Connect fixture</title></head><body></body></html>`;
/**
 * Signed out, the app sends the page on to sign-in. From the page, not with a 3xx: Patchright lets
 * a navigation fulfilled with a redirect status go on to the network.
 */
const SIGNED_OUT_APP_PAGE = `<!doctype html><html><head><script>location.replace(${JSON.stringify(SSO)})</script></head><body></body></html>`;
const SIGN_IN_PAGE =
	"<!doctype html><html><head><title>Sign in fixture</title></head><body><form></form></body></html>";
/** Document loads the journey may make: two signed-out loads of the app, each sent to sign-in, and one signed in. */
const NAVIGATION_BUDGET = 8;
/**
 * Nothing leaves the machine: every request goes to a proxy that is not there, and no host name
 * resolves. A request the routes do not answer fails here instead of reaching a real site.
 */
const OFFLINE = {
	headless: true,
	proxy: { server: "http://127.0.0.1:9" },
	args: ["--host-resolver-rules=MAP * ~NOTFOUND"],
};
const COUNTS: Record<(typeof STREAMS)[number], number> = {
	daily_summaries: 1,
	sleep: 2,
	hrv: 3,
	training_status: 1,
	activities: 2,
};

type ApiRead = {
	path: string;
	method: string;
	session: boolean;
	token: string | undefined;
};

/**
 * The page as the connector and the runtime see it, every member they reach for recorded, and its
 * main frame's navigations; the fake owner and the assertions use the raw page.
 */
function watch(raw: RawPage): {
	page: Page;
	touched: Set<string>;
	navigations: string[];
} {
	const navigations: string[] = [];
	raw.on("framenavigated", (frame) => {
		if (frame === raw.mainFrame()) navigations.push(frame.url());
	});
	const touched = new Set<string>();
	const page = new Proxy(raw, {
		get(target, property) {
			touched.add(String(property));
			const value: unknown = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	}) as unknown as Page;
	return { page, touched, navigations };
}

test("garmin_browser: sign-in and collection keep one headless Patchright page", {
	timeout: 30_000,
}, async () => {
	const browser = await chromium.launch(OFFLINE);
	try {
		const context = await browser.newContext();
		try {
			const api: ApiRead[] = [];
			const unrouted: string[] = [];
			const fake = garminApi();
			let documents = 0;
			/** A broken cookie or a redirect loop fails fast instead of navigating on. */
			const document = (): boolean => {
				documents += 1;
				return documents <= NAVIGATION_BUDGET;
			};
			// Registered first, so it answers only what no route below does: refused, and recorded.
			await context.route("**/*", (route) => {
				unrouted.push(route.request().url());
				return route.abort("blockedbyclient");
			});
			// connect.garmin.com: /app/ sends a signed-out page to sign-in, once, and serves the token
			// meta only to a signed-in one; the API answers 401 without the session and 403 without
			// the token, and the fixtures with both.
			await context.route(`${ORIGIN}/**`, (route) => {
				const request = route.request();
				const url = new URL(request.url());
				const session = (request.headers().cookie ?? "").includes(
					`${SESSION_COOKIE}=1`,
				);
				if (request.isNavigationRequest()) {
					if (!document()) return route.abort("failed");
					if (url.pathname !== "/app/")
						return route.fulfill({
							status: 404,
							contentType: "text/html",
							body: "",
						});
					return route.fulfill({
						contentType: "text/html",
						body: session ? APP_PAGE : SIGNED_OUT_APP_PAGE,
					});
				}
				if (!url.pathname.startsWith("/gc-api/"))
					return route.fulfill({ status: 404, body: "" });
				const token = request.headers()["connect-csrf-token"];
				api.push({
					path: `${url.pathname}${url.search}`,
					method: request.method(),
					session,
					token,
				});
				if (!session)
					return route.fulfill({
						status: 401,
						contentType: "text/plain",
						body: "",
					});
				if (token !== TOKEN)
					return route.fulfill({
						status: 403,
						contentType: "text/plain",
						body: "",
					});
				const { status, contentType, body } = fake(
					`${url.pathname}${url.search}`,
				);
				return route.fulfill({
					status,
					body,
					...(contentType ? { contentType } : {}),
				});
			});
			// Garmin's sign-in host: a page that never sends the owner back by itself.
			await context.route("https://sso.garmin.com/**", (route) =>
				route.request().isNavigationRequest() && !document()
					? route.abort("failed")
					: route.fulfill({ contentType: "text/html", body: SIGN_IN_PAGE }),
			);
			const opened: unknown[] = [];
			context.on("page", (p) => {
				opened.push(p);
			});
			const raw = await context.newPage();
			const { page, touched, navigations } = watch(raw);

			// 1. From about:blank, the first probe goes to the app once, lands on sign-in, and reads
			// nothing there.
			assert.equal(await probeSession(page), false);
			assert.deepEqual(navigations, [APP_URL, SSO]);
			assert.equal(api.length, 0, "the sign-in page is not read");

			// 2. The real ensureSession, its settle cut to two reads with no wait; the owner signs in
			// through the fake assist, which sets the session cookie and returns the page to the app.
			const assists: AssistanceRequest[] = [];
			const checkpoints: string[] = [];
			const completions: string[] = [];
			let navigationsAtHandoff = -1;
			// Fail fast, not after the handoff's 30 minutes, if readiness never passes.
			const guard = setTimeout(() => {
				void raw.close();
			}, 15_000);
			const args: EnsureSessionArgs = {
				assist: async (request) => {
					assists.push(request);
					navigationsAtHandoff = navigations.length;
					await context.addCookies([
						{
							name: SESSION_COOKIE,
							value: "1",
							domain: "connect.garmin.com",
							path: "/",
							secure: true,
							httpOnly: true,
							sameSite: "Lax",
						},
					]);
					await raw.goto(APP_URL);
					return "garmin-browser-fixture-handoff";
				},
				capture: null,
				checkpoint: async (label) => {
					checkpoints.push(label);
				},
				completeAssistance: async (_id, status) => {
					completions.push(status);
				},
				context: context as unknown as EnsureSessionArgs["context"],
				credentials: {},
				onCredentialSubmit: () => {},
				page,
				progress: async () => {},
				sendInteraction: async () => {
					throw new Error(
						"manual_action fallback: a streamed argument is missing",
					);
				},
			};
			try {
				await makeEnsureSession({
					attempts: 2,
					intervalMs: 0,
					sleep: async () => {},
				})(args);
			} finally {
				clearTimeout(guard);
			}
			assert.deepEqual(completions, ["resolved"]);
			assert.deepEqual(checkpoints, [
				"sign-in-page",
				"sign-in-settle",
				"sign-in-handoff",
			]);
			assert.equal(assists.length, 1);
			assert.equal(assists[0]?.owner_action, "operate_attachment");
			assert.equal(assists[0]?.timeout_seconds, 1800);
			// One load of the app, sent to sign-in; the settle and readiness reads navigate nowhere.
			assert.deepEqual(navigations.slice(2, navigationsAtHandoff), [
				APP_URL,
				SSO,
			]);
			assert.deepEqual(navigations.slice(navigationsAtHandoff), [APP_URL]);
			assert.deepEqual(
				api.map(({ path, session, token }) => [path, session, token]),
				[[PROBE_PATH, true, TOKEN]],
				"readiness read the settings once, with the session and the page's token",
			);

			// The fixture is strict: the same read without the token is refused.
			assert.equal(
				await raw.evaluate(
					async (path) =>
						(await fetch(path, { credentials: "include" })).status,
					PROBE_PATH,
				),
				403,
			);
			api.pop();

			// 3. Collection on the same page, which is already on the app: no navigation.
			const navigated = navigations.length;
			const readsBefore = api.length;
			const h = makeRecordingEmit(validateRecord);
			await collectGarminBrowser(
				{
					collectionMode: "incremental",
					emit: h.emit,
					emitRecord: h.emitRecord,
					page,
					requested: new Map(
						STREAMS.map((name) => [name, { name } as StreamScope]),
					),
					state: {},
				},
				{ requestDelayMs: 0, sleep: async () => {} },
				NOW,
			);

			assert.deepEqual(h.skipped, []);
			for (const stream of STREAMS) {
				assert.equal(
					h.emitted.filter((r) => r.stream === stream).length,
					COUNTS[stream],
					stream,
				);
			}
			assert.deepEqual(
				h.protocolMessages.filter(
					(m) => m.type === "SKIP_RESULT" || m.type === "PROGRESS",
				),
				[],
			);
			const cursor = { next_day: "2026-09-22", floor: "2026-06-24" };
			assert.deepEqual(
				h.protocolMessages.filter((m) => m.type === "STATE"),
				STREAMS.map((stream) => ({ type: "STATE", stream, cursor })),
			);
			const reads = api.slice(readsBefore);
			assert.equal(reads[0]?.path, PROBE_PATH);
			assert.equal(reads.length, 1 + 90 + 4 + 4 + 90 + 4);
			for (const r of reads) {
				assert.equal(r.method, "GET", r.path);
				assert.equal(r.session, true, r.path);
				assert.equal(r.token, TOKEN, r.path);
			}

			assert.equal(navigations.length, navigated, "collection navigated");
			assert.ok(documents <= NAVIGATION_BUDGET);
			assert.deepEqual(unrouted, [], "every request was answered by a route");
			assert.deepEqual(
				opened.filter((p) => p !== raw),
				[],
			);
			assert.equal(context.pages().length, 1);
			assert.equal(await raw.evaluate(() => location.origin), ORIGIN);
			assert.equal(touched.has("url"), false, "never reads page.url()");
			assert.doesNotMatch(JSON.stringify(h.events), new RegExp(TOKEN, "u"));
		} finally {
			await context.close();
		}
	} finally {
		await browser.close();
	}
});
