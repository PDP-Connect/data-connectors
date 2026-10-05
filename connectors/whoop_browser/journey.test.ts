// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Sign-in: the real handoff against the readiness probe, and the settle before it (Layer 3.2);
// then real headless Patchright journeys, from a signed-out page to collected records on that same
// page, and through WHOOP's silent refresh without a prompt (Layer 3.3).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
	type BrowserContext,
	chromium,
	type Page as RawPage,
} from "patchright";
import type { Page } from "playwright";
import { z } from "zod";
import { manualBrowserLogin } from "../../packages/polyfill-connectors/src/browser-handoff.ts";
import type {
	AssistanceRequest,
	EnsureSessionArgs,
	StreamScope,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { makeRecordingEmit } from "../../packages/polyfill-connectors/src/test-harness.ts";
import {
	API_BASE,
	collectWhoopBrowser,
	makeEnsureSession,
	ORIGIN,
	type PageFetch,
	PROBE_PATH,
	probeOnPage,
	probeSession,
	STREAMS,
} from "./index.ts";
import { validateRecord } from "./schemas.ts";

const NOW = new Date("2026-09-20T12:00:00.000Z");
const read = (path: string): string =>
	readFileSync(new URL(path, import.meta.url), "utf8");
const fixture = (name: string): string => read(`./fixtures/${name}`);
const BOOTSTRAP = fixture("bootstrap.json");
const CYCLES = fixture("cycles-details.json");
const MESSAGE =
	"Sign in to WHOOP in the secure browser. PDPP continues on its own once you are signed in.";

// ── Layer 3.2: the real handoff against probeOnPage ────────────────────────

/** What pageFetch's callback answers on the owner's page, or how its evaluate fails. */
type Answer = PageFetch | null | Error;
const answer = (status: number, contentType: string, body: string) =>
	({
		kind: "response",
		status,
		url: `${API_BASE}${PROBE_PATH}`,
		contentType,
		retryAfter: null,
		body,
	}) as const;
const LIVE = answer(200, "application/json", BOOTSTRAP);
/** WHOOP's signed-out answer: JSON by its header, plain text by its body. */
const SIGNED_OUT = answer(
	401,
	"application/json",
	"Authorization was not valid",
);
const CHALLENGE = answer(
	403,
	"text/html; charset=UTF-8",
	"<!doctype html><title>Just a moment...</title>",
);
const ON_SIGN_IN_PAGE: PageFetch = {
	kind: "wrong_origin",
	origin: "https://id.whoop.com",
};
/** A signed-out app page leaves for id.whoop.com during or just after load. */
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
		assist: async () => "whoop-browser-handoff",
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

const BOOTSTRAP_READ = { origin: ORIGIN, apiBase: API_BASE, path: PROBE_PATH };

test("whoop_browser: readiness on a signed-in page resolves the handoff without navigating", {
	timeout: 30_000,
}, async () => {
	const owner = ownerPage([LIVE]);
	const completions: string[] = [];
	const ready = await handoff(owner.page, completions, {
		autoProbeWindowMs: 50,
	});
	assert.equal(ready, true);
	assert.deepEqual(completions, ["resolved"]);
	assert.deepEqual(owner.reads, [BOOTSTRAP_READ]);
	assert.equal(owner.touched.has("goto"), false, "never navigates");
	assert.equal(owner.touched.has("url"), false, "never reads page.url()");
});

test("whoop_browser: readiness waits out the sign-in page and navigation races, still without navigating", {
	timeout: 30_000,
}, async () => {
	// The owner's way in: the app leaves for id.whoop.com mid-probe, PageShim answers a throw
	// with null, the app comes back before the cookie is set, then signed in.
	const owner = ownerPage([
		NAVIGATED_AWAY,
		ON_SIGN_IN_PAGE,
		null,
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
	assert.equal(owner.reads.length, 5);
	for (const arg of owner.reads) assert.deepEqual(arg, BOOTSTRAP_READ);
	assert.equal(owner.touched.has("goto"), false, "never navigates");
});

test("whoop_browser: readiness that never passes rejects as timed out, not as a probe failure", {
	timeout: 30_000,
}, async () => {
	const signedOut: Array<[string, Answer]> = [
		["WHOOP's 401", SIGNED_OUT],
		["a Cloudflare 403", CHALLENGE],
		["the sign-in page", ON_SIGN_IN_PAGE],
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
		assert.deepEqual(owner.reads, [BOOTSTRAP_READ], label);
		assert.equal(owner.touched.has("goto"), false, `${label}: navigated`);
	}
});

/**
 * ensureSession's arguments on a stub page that logs, in order, every step the connector and the
 * handoff take. Before its first goto the page is off the app; each goto loads the app afresh, so
 * its reads answer `load` from the start, and once the owner has signed in, `signedIn`.
 */
function stubSession(
	steps: string[],
	load: Answer[],
	signedIn: Answer[] = [],
): EnsureSessionArgs {
	let answers: Answer[] | null = null;
	let read = 0;
	const page = {
		goto: async () => {
			steps.push("goto");
			answers = load;
			read = 0;
			return null;
		},
		evaluate: async () => {
			steps.push("probe");
			if (answers === null) return { kind: "wrong_origin", origin: "null" };
			const next = answers[Math.min(read++, answers.length - 1)];
			if (next instanceof Error) throw next;
			return next;
		},
	} as unknown as Page;
	return {
		assist: async () => {
			steps.push("assist");
			if (signedIn.length === 0) throw new Error("the owner was prompted");
			answers = signedIn;
			read = 0;
			return "whoop-browser-handoff";
		},
		capture: null,
		checkpoint: async (label: string) => {
			steps.push(label);
		},
		completeAssistance: async (_id: string, status: string) => {
			steps.push(status);
		},
		page,
		sendInteraction: async () => {
			throw new Error("manual_action fallback");
		},
	} as unknown as EnsureSessionArgs;
}

test("whoop_browser: a session WHOOP refreshes silently is found without prompting the owner", {
	timeout: 30_000,
}, async () => {
	// Access token expired (its cookie gone), refresh cookie live: the app loads without a
	// token, leaves for id.whoop.com, and comes back signed in with no prompt (spec §1).
	const noToken: PageFetch = {
		kind: "response",
		status: 401,
		url: "",
		contentType: "",
		retryAfter: null,
		body: "",
	};
	const steps: string[] = [];
	const args = stubSession(steps, [
		noToken,
		NAVIGATED_AWAY,
		ON_SIGN_IN_PAGE,
		LIVE,
	]);
	const ensureSession = makeEnsureSession({
		attempts: 5,
		intervalMs: 0,
		sleep: async () => {
			steps.push("sleep");
		},
	});
	// The runtime's order for an authoritative probe (session-establish.ts).
	const live =
		(await probeSession(args.page)) ||
		(await ensureSession(args).then(
			() => true,
			() => false,
		));
	assert.equal(live, true);
	assert.deepEqual(steps, [
		// The runtime's probe: off the app, to it once, read before the bounce.
		...["probe", "goto", "probe"],
		...["sign-in-page", "goto", "sign-in-settle"],
		// The settle reads through the bounce, never navigating, and stops at the first live read:
		// no handoff, no assist, nothing to complete.
		...["probe", "sleep", "probe", "sleep", "probe", "sleep", "probe"],
	]);
});

test("whoop_browser: a signed-out owner is asked right after the settle's last read", {
	timeout: 30_000,
}, async () => {
	const steps: string[] = [];
	const args = stubSession(steps, [SIGNED_OUT], [LIVE]);
	await makeEnsureSession({
		attempts: 3,
		intervalMs: 1500,
		sleep: async (ms) => {
			steps.push(`sleep ${ms}`);
		},
	})(args);
	assert.deepEqual(steps, [
		...["sign-in-page", "goto", "sign-in-settle"],
		...["probe", "sleep 1500", "probe", "sleep 1500", "probe"],
		...["sign-in-handoff", "assist", "probe", "resolved"],
	]);
});

test("whoop_browser: identity meets the OCI builder's key and id checks", () => {
	const manifest = z
		.object({
			connector_key: z.string(),
			connector_id: z.string(),
			manifest_uri: z.string(),
			source: z.object({ id: z.string() }),
		})
		.parse(JSON.parse(read("./manifest.json")));
	const key = manifest.connector_key;
	assert.match(key, /^[a-z0-9][a-z0-9-]*$/u);
	assert.ok(manifest.connector_id.endsWith(`/${key}`));
	assert.equal(
		manifest.connector_id,
		`https://registry.pdpp.dev/connectors/${key}`,
	);
	assert.equal(manifest.manifest_uri, manifest.connector_id);
	assert.ok(manifest.source.id.endsWith("/sources/whoop_browser"));
	assert.match(
		manifest.source.id,
		/^https:\/\/registry\.pdpp\.dev\/sources\/[a-z0-9_]+$/u,
	);
	// The runtime names the host-browser variable from profileName, DataConnect from the key.
	const entry = read("./index.ts");
	assert.match(entry, /\bname: "whoop_browser",/u);
	assert.equal(/profileName: "([^"]*)"/u.exec(entry)?.[1], key);
});

// ── Layer 3.3: real headless Patchright journeys ───────────────────────────

const CORS = {
	"access-control-allow-credentials": "true",
	"access-control-allow-headers": "accept, authorization",
	"access-control-allow-origin": ORIGIN,
};
const APP = "<!doctype html><title>WHOOP fixture</title>";
/** Expected from cycles-details.json: one recovery scored, three sleeps with the nap, one run. */
const EXPECTED: Record<(typeof STREAMS)[number], number> = {
	cycles: 3,
	recoveries: 1,
	sleeps: 3,
	workouts: 1,
};
const BOOTSTRAP_PATH = new URL(`${API_BASE}${PROBE_PATH}`).pathname;

type ApiRead = { url: string; authorization: string | undefined };
const pathAndToken = (r: ApiRead) => [new URL(r.url).pathname, r.authorization];

/** WHOOP's API on the fixtures: the account and the cycles for the cookie's token, its plain-text 401 for any other. */
async function serveApi(
	context: BrowserContext,
	reads: ApiRead[],
): Promise<void> {
	await context.route(`${API_BASE}/**`, (route) => {
		const request = route.request();
		if (request.method() === "OPTIONS") {
			return route.fulfill({ status: 204, headers: CORS });
		}
		const { authorization } = request.headers();
		reads.push({ url: request.url(), authorization });
		if (authorization !== "bearer fixture-token") {
			return route.fulfill({
				status: 401,
				headers: CORS,
				contentType: "application/json",
				body: "Authorization was not valid",
			});
		}
		const { pathname } = new URL(request.url());
		const body = pathname.startsWith("/users-service/")
			? BOOTSTRAP
			: pathname.startsWith("/core-details-bff/")
				? CYCLES
				: null;
		return route.fulfill({
			status: body === null ? 404 : 200,
			headers: CORS,
			contentType: "application/json",
			body: body ?? "{}",
		});
	});
}

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

test("whoop_browser: sign-in and collection keep one headless Patchright page", {
	timeout: 30_000,
}, async () => {
	const browser = await chromium.launch({ headless: true });
	try {
		// An older sign-in's localStorage token, long expired: the cookie must win over it.
		const context = await browser.newContext({
			storageState: {
				cookies: [],
				origins: [
					{
						origin: ORIGIN,
						localStorage: [
							{
								name: "whoop.security.accessToken",
								value: JSON.stringify("stale-token"),
							},
						],
					},
				],
			},
		});
		try {
			await context.route(`${ORIGIN}/**`, (route) =>
				route.fulfill({ contentType: "text/html", body: APP }),
			);
			const api: ApiRead[] = [];
			await serveApi(context, api);
			const opened: unknown[] = [];
			context.on("page", (p) => {
				opened.push(p);
			});
			const raw = await context.newPage();
			const { page, touched, navigations } = watch(raw);

			// 1. From about:blank, the first probe goes to the app once and finds no session:
			// the stale token is sent, and WHOOP's plain-text 401 is not taken for a session.
			assert.equal(await probeSession(page), false);
			assert.deepEqual(navigations, [`${ORIGIN}/`]);
			assert.deepEqual(api.map(pathAndToken), [
				[BOOTSTRAP_PATH, "bearer stale-token"],
			]);

			// 2. The real ensureSession, its settle cut to two reads with no wait between them;
			// the owner signs in through the fake assist.
			const assists: AssistanceRequest[] = [];
			const checkpoints: string[] = [];
			const completions: string[] = [];
			const before = { navigations: navigations.length, reads: api.length };
			let atHandoff = before;
			const args: EnsureSessionArgs = {
				assist: async (request) => {
					assists.push(request);
					atHandoff = { navigations: navigations.length, reads: api.length };
					await raw.goto(`${ORIGIN}/`);
					await raw.evaluate(() => {
						// biome-ignore lint/suspicious/noDocumentCookie: the owner's sign-in leaves WHOOP's JS-readable token cookie, which the connector reads back with document.cookie
						document.cookie = "whoop-auth-token=fixture-token; path=/";
					});
					await raw.goto(`${ORIGIN}/`);
					return "whoop-browser-fixture-handoff";
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
			await makeEnsureSession({
				attempts: 2,
				intervalMs: 0,
				sleep: async () => {},
			})(args);
			assert.deepEqual(completions, ["resolved"]);
			assert.deepEqual(checkpoints, [
				"sign-in-page",
				"sign-in-settle",
				"sign-in-handoff",
			]);
			// One load of the app, then two settle reads on it that navigate nowhere and find
			// only the stale token, before the owner is asked.
			assert.deepEqual(
				navigations.slice(before.navigations, atHandoff.navigations),
				[`${ORIGIN}/`],
			);
			assert.deepEqual(
				api.slice(before.reads, atHandoff.reads).map(pathAndToken),
				[
					[BOOTSTRAP_PATH, "bearer stale-token"],
					[BOOTSTRAP_PATH, "bearer stale-token"],
				],
			);
			assert.equal(assists.length, 1);
			assert.equal(assists[0]?.owner_action, "operate_attachment");
			assert.equal(assists[0]?.timeout_seconds, 1800);
			assert.equal(
				api.at(-1)?.authorization,
				"bearer fixture-token",
				"the cookie's token, not the stale stored one",
			);

			// 3. Collection on the same page, which is already on the app: no navigation.
			const navigated = navigations.length;
			const readsBefore = api.length;
			const h = makeRecordingEmit(validateRecord);
			await collectWhoopBrowser(
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

			assert.deepEqual(completions, ["resolved"]);
			assert.deepEqual(h.skipped, []);
			for (const stream of STREAMS) {
				assert.equal(
					h.emitted.filter((r) => r.stream === stream).length,
					EXPECTED[stream],
					stream,
				);
			}
			assert.deepEqual(
				h.protocolMessages.filter(
					(m) => m.type === "SKIP_RESULT" || m.type === "PROGRESS",
				),
				[],
			);
			// The account began 2026-08-01T09:30Z: the walk starts a day earlier and reaches NOW.
			// The fixture's third cycle has no end yet: the next run re-reads from its start.
			const cursor = {
				floor: "2026-07-31T09:30:00.000Z",
				through: NOW.toISOString(),
				open_since: "2026-09-16T12:50:00.000Z",
			};
			assert.deepEqual(
				h.protocolMessages.filter((m) => m.type === "STATE"),
				STREAMS.map((stream) => ({ type: "STATE", stream, cursor })),
			);

			const [bootstrap, ...windows] = api
				.slice(readsBefore)
				.map((r) => new URL(r.url));
			assert.equal(`${bootstrap?.pathname}${bootstrap?.search}`, PROBE_PATH);
			assert.equal(windows.length, 2, "two thirty-day windows");
			for (const u of windows) {
				assert.equal(u.pathname, "/core-details-bff/v0/cycles/details");
				assert.equal(u.searchParams.get("id"), "41001");
				assert.equal(u.searchParams.get("apiVersion"), "7");
				for (const edge of ["startTime", "endTime"]) {
					assert.match(
						u.searchParams.get(edge) ?? "",
						/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u,
					);
				}
			}

			assert.equal(navigations.length, navigated, "collection navigated");
			assert.deepEqual(
				opened.filter((p) => p !== raw),
				[],
			);
			assert.equal(context.pages().length, 1);
			assert.equal(await raw.evaluate(() => location.origin), ORIGIN);
			assert.equal(new URL(raw.url()).origin, ORIGIN);
			assert.equal(touched.has("url"), false, "never reads page.url()");
			for (const r of api) {
				assert.doesNotMatch(r.url, /fixture-token|stale-token/u);
			}
			assert.doesNotMatch(
				JSON.stringify(h.events),
				/fixture-token|stale-token/u,
			);
		} finally {
			await context.close();
		}
	} finally {
		await browser.close();
	}
});
