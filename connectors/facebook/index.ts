#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PDPP Facebook browser connector (v0.1.0).
 *
 * Reads the signed-in person's own Facebook profile, posts, friends, joined
 * groups, and the likes/reactions and comments in their activity log, from
 * the facebook.com web app in the person's own signed-in tab. Messenger is
 * not read: it is end-to-end encrypted on the web and needs the person's PIN.
 *
 * How it collects. Facebook's web app is Relay over GraphQL. The connector
 * opens the page the web app shows each list on, takes the first page of the
 * list from the page's server-rendered payloads, and pages the rest with the
 * list's own persisted query, sent from the page with `fetch` (same origin,
 * the page's cookies). It never hard-codes a query id (`doc_id`): Facebook
 * versions them. It reads the id from the page's own request for that list
 * (watching the page's requests, scrolling as a person would if the page has
 * not asked yet) or from the page's loaded query modules. When neither shows
 * the query, the stream fails as `facebook_query_outdated` rather than
 * returning an empty list.
 *
 * Secrets. The CSRF token (`fb_dtsg`), `lsd` and the viewer id are read inside
 * the page for each query and never leave it; captured requests keep only the
 * query id and variables; server-rendered scripts have their tokens blanked
 * before they are read. None of it is logged or written to STATE.
 *
 * Read-only. Every query passes `assertReadOnlyOperation`, which refuses any
 * operation that is not a plain `...Query` or that names a mutation.
 *
 * Pacing. One query at a time, a 2-4.5 s random pause before each, 3-6 s
 * before each page opened; a rate-limit answer ends the run at once.
 *
 * Bounded. Every page action has a deadline (30 s to open a page or answer a
 * query, 10 s to look up a query or scroll); past it the action fails as
 * `facebook_page_timeout` and only that stream fails. A query id the page does
 * not reveal in time fails the stream as `facebook_query_outdated`. A PROGRESS
 * goes out at least every 20 s while collecting, and the sign-in hand-off
 * gives up after 5 minutes, so every run ends with DONE.
 *
 * Main world. Page functions that need Facebook's module `require` run in the
 * page's main world (`evaluateInMainWorld`): Patchright evaluates in an
 * isolated world by default, where `require` does not exist.
 *
 * Terms of service and legal basis. Meta's terms restrict automated access.
 * This connector reads only the account owner's own data, in the owner's own
 * session, at the owner's request, under their rights of access and
 * portability (GDPR Articles 15 and 20, CCPA/CPRA 1798.100 and 1798.130).
 * Facebook's own "Download your information" export serves the same right.
 *
 * Streams: profile, posts, friends, groups, reactions, comments.
 *
 * Tested surfaces (as of 2026-10-22): response shapes from one English-language
 * account (synthetic fixtures with real structure). Not yet run end to end.
 * Known unverified: the joined-groups pagination query name, the comments
 * activity-log category key (COMMENTSCLUSTER), the intro-card shape, and the
 * fallback variable defaults used when the page's own request is not seen.
 *
 * CHANGES
 *   v0.1.0 (2026-10-22): first version.
 *   v0.1.1 (2026-10-22): posts gain title, shared_text and attachment_title.
 *   v0.1.4 (2026-10-26): a bounded grant narrows the walk at the source (the
 *     walk stops past `since`, the timeline's own date variables carry
 *     `until`, a walk for chosen ids stops once all were read); posts,
 *     reactions and comments are declared non-incremental, reactions and
 *     comments mutable; failures that need a newer connector say so; a record
 *     the schema rejects fails its stream; the session probe reads the page
 *     only, not the cookie jar, which the manifest never declared.
 */

import { isMainModule } from "@pdpp/connector-protocol";
import type { Page, Request } from "playwright";
import { manualBrowserLogin } from "../../packages/polyfill-connectors/src/browser-handoff.ts";
import { connectorDiagnostic } from "../../packages/polyfill-connectors/src/connector-diagnostic.ts";
import {
	type BrowserCollectContext,
	type EnsureSessionArgs,
	type ProbeSessionArgs,
	runConnector,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { isConnectorErrorCodeShaped } from "../../packages/polyfill-connectors/src/terminal-error.ts";
import {
	type CollectorContext,
	collectFacebook,
	type FacebookServices,
	type GraphqlCall,
	type ModuleOperation,
	type PageGraphqlResult,
	type PageSnapshot,
	withDeadline,
} from "./collect.ts";
import {
	asRecord,
	assertLandedOnContent,
	type CapturedOperation,
	FB_ORIGIN,
	GRAPHQL_PATH,
	isNumericId,
	operationMatches,
	parseCapturedGraphqlRequest,
	RETRYABLE_PATTERN,
} from "./parsers.ts";
import { validateRecord } from "./schemas.ts";

const LOGIN_URL = `${FB_ORIGIN}/login/`;
const NAVIGATION_ATTEMPTS = 2;
const NAVIGATION_TIMEOUT_MS = 20_000;
const READY_TIMEOUT_MS = 8000;
/** The page's own fetch is aborted after this long; the Node-side deadline is a little longer. */
const PAGE_FETCH_TIMEOUT_MS = 25_000;
const PROBE_DEADLINE_MS = 30_000;
/**
 * How long the sign-in hand-off waits. Bounded so a run whose session cannot be
 * proven ends with a clear auth failure instead of sitting silent.
 */
const SIGN_IN_TIMEOUT_SECONDS = 300;

/** JSON keys whose string values are blanked out of server-rendered scripts before they leave the page. */
const SECRET_KEYS = ["token", "async_get_token"];
/** Markers of the scripts worth reading: Relay payloads and the signed-in person. */
const SCRIPT_MARKERS = ["RelayPrefetchedStreamCache", "CurrentUserInitialData"];

// ─── Page-side functions (serialized into the page; self-contained) ──────

function readScriptsInPage(args: {
	markers: string[];
	secretKeys: string[];
}): string[] {
	const out: string[] = [];
	for (const node of Array.from(
		document.querySelectorAll('script[type="application/json"]'),
	)) {
		let text = node.textContent ?? "";
		if (!args.markers.some((marker) => text.includes(marker))) continue;
		for (const key of args.secretKeys)
			text = text.replace(new RegExp(`"${key}":"[^"]*"`, "g"), `"${key}":""`);
		out.push(text);
	}
	return out;
}

function viewerIdInPage(): string | null {
	const req = Reflect.get(globalThis, "require") as
		| ((name: string) => unknown)
		| undefined;
	try {
		const data =
			typeof req === "function"
				? (req("CurrentUserInitialData") as { USER_ID?: unknown })
				: null;
		if (typeof data?.USER_ID === "string") return data.USER_ID;
	} catch {
		// Fall through to the server-rendered data, which every world can read.
	}
	const marker = '"USER_ID":"';
	for (const node of Array.from(
		document.querySelectorAll('script[type="application/json"]'),
	)) {
		const text = node.textContent ?? "";
		const at = text.indexOf(marker);
		if (at < 0) continue;
		const end = text.indexOf('"', at + marker.length);
		if (end > at + marker.length) return text.slice(at + marker.length, end);
	}
	return null;
}

function resolveModuleInPage(name: string): {
	docId: string | null;
	provided: Record<string, unknown>;
} {
	const req = Reflect.get(globalThis, "require") as
		| ((module: string) => unknown)
		| undefined;
	const out: { docId: string | null; provided: Record<string, unknown> } = {
		docId: null,
		provided: {},
	};
	if (typeof req !== "function") return out;
	try {
		const request = req(`${name}.graphql`) as {
			params?: {
				id?: unknown;
				providedVariables?: Record<string, { get?: () => unknown }>;
			};
		} | null;
		if (typeof request?.params?.id === "string") out.docId = request.params.id;
		for (const [key, provider] of Object.entries(
			request?.params?.providedVariables ?? {},
		)) {
			try {
				if (typeof provider.get === "function")
					out.provided[key] = provider.get();
			} catch {
				// A provider that throws is left out; the query may still accept the rest.
			}
		}
	} catch {
		// The query module is not loaded on this page.
	}
	if (out.docId === null) {
		try {
			const id = req(`${name}_facebookRelayOperation`);
			if (typeof id === "string") out.docId = id;
		} catch {
			// Not loaded either: the caller fails the stream as an outdated query.
		}
	}
	return out;
}

async function graphqlInPage(call: {
	asbdId: string | null;
	timeoutMs: number;
	docId: string;
	friendlyName: string;
	path: string;
	variables: string;
}): Promise<
	| { kind: "signed_out" }
	| {
			contentType: string | null;
			kind: "response";
			mitigated: string | null;
			status: number;
			text: string;
			url: string;
	  }
> {
	// No named helper functions in here: this body is serialized into the page,
	// and a named inner function would carry a Node-only `__name` wrapper.
	const req = Reflect.get(globalThis, "require") as
		| ((name: string) => unknown)
		| undefined;
	const lookups: [string, string, string][] = [
		["DTSGInitialData", "token", '"DTSGInitialData",[],{"token":"'],
		["LSD", "token", '"LSD",[],{"token":"'],
		["CurrentUserInitialData", "USER_ID", '"USER_ID":"'],
	];
	const found: (string | null)[] = [];
	let html: string | null = null;
	for (const [moduleName, key, marker] of lookups) {
		let value: string | null = null;
		try {
			const module =
				typeof req === "function"
					? (req(moduleName) as Record<string, unknown> | null)
					: null;
			const raw = module?.[key];
			value = typeof raw === "string" && raw.length > 0 ? raw : null;
		} catch {
			value = null;
		}
		if (value === null && moduleName === "DTSGInitialData") {
			value =
				(
					document.querySelector(
						'input[name="fb_dtsg"]',
					) as HTMLInputElement | null
				)?.value || null;
		}
		if (value === null) {
			html ??= document.documentElement.innerHTML;
			const at = html.indexOf(marker);
			const end = at < 0 ? -1 : html.indexOf('"', at + marker.length);
			value =
				end > at + marker.length ? html.slice(at + marker.length, end) : null;
		}
		found.push(value);
	}
	const [dtsg, lsd, user] = found;
	if (!dtsg || !user || user === "0") return { kind: "signed_out" };
	let sum = 0;
	for (const char of dtsg) sum += char.charCodeAt(0);
	const body = new URLSearchParams({
		av: user,
		__user: user,
		__a: "1",
		__comet_req: "15",
		fb_dtsg: dtsg,
		jazoest: `2${sum}`,
		lsd: lsd ?? "",
		fb_api_caller_class: "RelayModern",
		fb_api_req_friendly_name: call.friendlyName,
		variables: call.variables,
		server_timestamps: "true",
		doc_id: call.docId,
	});
	const headers: Record<string, string> = {
		"content-type": "application/x-www-form-urlencoded",
		"x-fb-friendly-name": call.friendlyName,
	};
	if (lsd) headers["x-fb-lsd"] = lsd;
	if (call.asbdId) headers["x-asbd-id"] = call.asbdId;
	const response = await fetch(call.path, {
		method: "POST",
		credentials: "include",
		headers,
		body,
		signal: AbortSignal.timeout(call.timeoutMs),
	});
	return {
		kind: "response",
		status: response.status,
		url: response.url,
		contentType: response.headers.get("content-type"),
		mitigated: response.headers.get("cf-mitigated"),
		text: await response.text(),
	};
}

function scrollInPage(): void {
	window.scrollBy(0, Math.round(window.innerHeight * 2.5));
}

/** The functions Playwright serializes into the page; exported so a test can check they stay self-contained. */
export const PAGE_FUNCTIONS = {
	graphqlInPage,
	locationHrefInPage,
	readScriptsInPage,
	resolveModuleInPage,
	scrollInPage,
	viewerIdInPage,
};

// ─── Page services ──────────────────────────────────────────────────────

async function gotoWithRetry(page: Page, url: string): Promise<void> {
	let lastError: unknown;
	for (let attempt = 0; attempt < NAVIGATION_ATTEMPTS; attempt += 1) {
		try {
			await page.goto(url, {
				waitUntil: "domcontentloaded",
				timeout: NAVIGATION_TIMEOUT_MS,
			});
			await page
				.waitForFunction(() => document.readyState === "complete", undefined, {
					timeout: READY_TIMEOUT_MS,
				})
				.catch(() => undefined);
			return;
		} catch (error) {
			lastError = error;
		}
	}
	throw lastError instanceof Error
		? lastError
		: new Error("facebook_navigation_failed");
}

/** The request body passed to the page. Only the query id and variables; the page adds its own tokens. */
export function graphqlPageCall(
	call: GraphqlCall,
): GraphqlCall & { path: string; timeoutMs: number } {
	return { ...call, path: GRAPHQL_PATH, timeoutMs: PAGE_FETCH_TIMEOUT_MS };
}

/**
 * Run a page function in the page's main world. Patchright runs `evaluate` in
 * an isolated world by default, where Facebook's module `require` (the query
 * modules, `DTSGInitialData`, `CurrentUserInitialData`) does not exist; the
 * first live run's sign-in probe failed for exactly that reason. Plain
 * Playwright ignores the extra arguments.
 */
export function evaluateInMainWorld<R, A>(
	page: Pick<Page, "evaluate">,
	fn: (arg: A) => R | Promise<R>,
	arg: A,
): Promise<R> {
	// Patchright's fourth `evaluate` argument is `isolatedContext`.
	const result: Promise<R> = Reflect.apply(page.evaluate, page, [
		fn,
		arg,
		undefined,
		false,
	]);
	return result;
}

function asProvided(value: unknown): Record<string, unknown> {
	return asRecord(value) ?? {};
}

function locationHrefInPage(): string {
	return location.href;
}

/**
 * Page-backed services. `observeRequests` watches the page's own GraphQL
 * requests (desktop Playwright). The mobile PageShim host has no request
 * events, so there the query id comes only from the page's loaded modules.
 */
export function createPageServices(
	page: Page,
	options: { observeRequests: boolean } = { observeRequests: true },
): FacebookServices & { dispose: () => void } {
	let captured: CapturedOperation[] = [];
	const onRequest = (request: Request): void => {
		try {
			const operation = parseCapturedGraphqlRequest({
				url: request.url(),
				method: request.method(),
				postData: request.postData(),
				headers: request.headers(),
			});
			if (operation) captured.push(operation);
		} catch {
			// A request that cannot be read is simply not a template.
		}
	};
	if (options.observeRequests) page.on("request", onRequest);
	return {
		observesRequests: options.observeRequests,
		dispose: () => {
			if (options.observeRequests) page.off("request", onRequest);
			captured = [];
		},
		open: async (url: string): Promise<PageSnapshot> => {
			captured = [];
			await gotoWithRetry(page, url);
			const landedUrl = options.observeRequests
				? page.url()
				: await page.evaluate(locationHrefInPage);
			assertLandedOnContent(landedUrl);
			const scripts = await page.evaluate(readScriptsInPage, {
				markers: SCRIPT_MARKERS,
				secretKeys: SECRET_KEYS,
			});
			return { landedUrl, scripts };
		},
		scroll: async () => {
			await page.evaluate(scrollInPage);
		},
		takeCaptured: (spec) =>
			captured.findLast((operation) =>
				operationMatches(spec, operation.friendlyName),
			) ?? null,
		resolveModule: async (friendlyName: string): Promise<ModuleOperation> => {
			const result = await evaluateInMainWorld(
				page,
				resolveModuleInPage,
				friendlyName,
			);
			return { docId: result.docId, provided: asProvided(result.provided) };
		},
		graphql: async (call: GraphqlCall): Promise<PageGraphqlResult> =>
			evaluateInMainWorld(page, graphqlInPage, graphqlPageCall(call)),
		sleep: (ms: number) =>
			new Promise<void>((resolve) => setTimeout(resolve, ms)),
		random: () => Math.random(),
		every: (ms: number, tick: () => void) => {
			const timer = setInterval(tick, ms);
			return () => clearInterval(timer);
		},
	};
}

// ─── Session ────────────────────────────────────────────────────────────

/**
 * The page itself proves the session: a signed-in page names the person, a
 * signed-out one names user "0" or lands on the sign-in form. The cookie jar
 * is not read; the manifest does not declare `cookie_read`, which the mobile
 * host does not provide, and the mobile probe already relies on the page alone.
 */
async function probeOnce({ page }: ProbeSessionArgs): Promise<boolean> {
	if (!page.url().startsWith(FB_ORIGIN))
		await gotoWithRetry(page, `${FB_ORIGIN}/`);
	assertLandedOnContent(page.url());
	const viewerId = await evaluateInMainWorld(page, viewerIdInPage, undefined);
	return isNumericId(viewerId) && viewerId !== "0";
}

/** Signed in when the page names a person. Bounded; never hangs. */
export async function probeFacebookSession(
	args: ProbeSessionArgs,
	deadlineMs = PROBE_DEADLINE_MS,
): Promise<boolean> {
	try {
		return await withDeadline(
			probeOnce(args),
			deadlineMs,
			"checking the sign-in",
		);
	} catch {
		return false;
	}
}

/**
 * A sign-in failure leaves as a bare code, the only shape the runtime keeps
 * as the run's error code (`session-establish.ts` drops a code inside a
 * sentence): `facebook_auth_failed` when the person did not finish signing
 * in, `facebook_interrupted` (retryable) when the page broke on the way.
 * What went wrong goes to a diagnostic, never into the code.
 */
export type FacebookSignIn = (
	args: Parameters<typeof manualBrowserLogin<boolean>>[0],
) => Promise<boolean>;

export function makeEnsureFacebookSession(
	login: FacebookSignIn = manualBrowserLogin,
): (args: EnsureSessionArgs) => Promise<void> {
	return async (args) => {
		let live: boolean;
		try {
			live = await signIn(args, login);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (isConnectorErrorCodeShaped(message)) throw error;
			connectorDiagnostic("facebook", "sign_in_interrupted", {
				error: error instanceof Error ? error.name : typeof error,
			});
			throw new Error(SESSION_CODES.interrupted, { cause: error });
		}
		if (!live) {
			connectorDiagnostic("facebook", "sign_in_not_completed", {});
			throw new Error(SESSION_CODES.authFailed);
		}
	};
}

const SESSION_CODES = {
	authFailed: "facebook_auth_failed",
	interrupted: "facebook_interrupted",
} as const;

async function signIn(
	args: EnsureSessionArgs,
	login: FacebookSignIn,
): Promise<boolean> {
	const {
		assist,
		capture,
		completeAssistance,
		context,
		page,
		sendInteraction,
	} = args;
	if (await probeFacebookSession({ context, page })) return true;
	await gotoWithRetry(page, LOGIN_URL);
	return login({
		assist,
		capture,
		completeAssistance,
		isProbeSuccessful: (result) => result === true,
		message:
			"Sign in to Facebook in the secure browser, then continue. Collection starts once you are signed in.",
		page,
		probe: () => probeFacebookSession({ context, page }),
		readinessProbe: () => probeFacebookSession({ context, page }),
		readinessProbeOnHandoffPage: true,
		reason: "login",
		sendInteraction,
		timeoutSeconds: SIGN_IN_TIMEOUT_SECONDS,
	});
}

export const ensureFacebookSession = makeEnsureFacebookSession();

// ─── Collect ────────────────────────────────────────────────────────────

/** The PageShim session probe: reads the current page only, never navigates. */
export async function probeFacebookSessionOnPage(page: Page): Promise<boolean> {
	try {
		const viewerId = await withDeadline(
			evaluateInMainWorld(page, viewerIdInPage, undefined),
			PROBE_DEADLINE_MS,
			"checking the sign-in",
		);
		return isNumericId(viewerId) && viewerId !== "0";
	} catch {
		return false;
	}
}

/** The PageShim (mobile) entry: the same walk, without request observation. */
export async function collectFacebookOnPage(
	ctx: CollectorContext & { page: Page },
): Promise<void> {
	const services = createPageServices(ctx.page, { observeRequests: false });
	try {
		await collectFacebook(ctx, services);
	} finally {
		services.dispose();
	}
}

export async function collect(ctx: BrowserCollectContext): Promise<void> {
	const services = createPageServices(ctx.page);
	const collector: CollectorContext = ctx;
	try {
		await collectFacebook(collector, services);
	} finally {
		services.dispose();
	}
}

if (isMainModule(import.meta.url)) {
	runConnector({
		name: "facebook",
		validateRecord,
		retryablePattern: RETRYABLE_PATTERN,
		browser: { profileName: "facebook" },
		ensureSession: ensureFacebookSession,
		probeSession: probeFacebookSession,
		probeSessionIsAuthoritative: true,
		collect,
	});
}
