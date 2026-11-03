#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PDPP Goodreads browser connector (v0.1.0).
 *
 * Collection runs in the owner's own signed-in goodreads.com session. The
 * owner signs in in the browser (any method Goodreads offers). An owner whose
 * account uses an email and password may also save them for this connection;
 * the connector then signs in once by itself when the session is missing, and
 * falls back to the browser handoff when Goodreads asks for more (see
 * sign-in.ts). Collection reads what the owner can already see: the library list (print view, 100 a page), the
 * profile and the account settings pages, and the shelves and book details
 * that Goodreads' own book pages read from its GraphQL API, with the
 * short-lived token those pages carry. Goodreads offers no public API, key
 * or feed for any of this.
 *
 * Streams: books, shelves, account_profile, usage_summary. The summary is
 * computed from the full library listing even when `books` is not asked for,
 * and is withheld unless that listing is proven complete. Books and shelves
 * are incremental on the desktop runtime: unchanged records are not emitted
 * again, and a book or shelf gone from Goodreads is emitted as a deletion.
 * Identity text (name, username, email, gender, location, about-me,
 * friends) is never read into a record. See collector.ts for the request
 * order and the completeness rules, graphql.ts for the API, and fetcher.ts
 * for retries and AWS WAF handling.
 *
 * Robots: goodreads.com disallows /review/list for crawlers. This reads the
 * owner's own list in the owner's own session, one request at a time with a
 * pause of about two seconds.
 *
 * Reachability probe: permanently exempt. Every page needs the owner's
 * session (the browser-automation-behind-a-login-wall case in
 * CONNECTOR-CHECKLIST.md).
 */

import { isMainModule } from "@pdpp/connector-protocol";
import type { Page } from "playwright";
import { resolveLoginCredentials } from "../../packages/polyfill-connectors/src/auto-login/login-credentials.ts";
import {
	type ManualActionReason,
	manualBrowserLogin,
} from "../../packages/polyfill-connectors/src/browser-handoff.ts";
import type {
	BrowserCollectContext,
	EnsureSessionArgs,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { runConnector } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { collectGoodreads, type GoodreadsCollectContext } from "./collector.ts";
import { ORIGIN } from "./parsers.ts";
import { validateRecord } from "./schemas.ts";
import {
	attemptAutomaticSignIn,
	fallbackExplanation,
	fallbackHandoffReason,
	GOODREADS_LOGIN_FIELDS,
} from "./sign-in.ts";

export const LOGIN_URL = `${ORIGIN}/user/sign_in`;
const LIST_URL = `${ORIGIN}/review/list`;
export const SIGN_IN_MESSAGE =
	"Sign in to Goodreads (any method), tick Keep me signed in, then return here.";

const OWN_LIST_PATH_RE = /^\/review\/list\/\d+/;
const SIGN_IN_PATH_RE = /^\/(?:user\/sign_in|ap\/signin|sign_in)/;

/** What the in-page probe fetch returns. It never throws: PageShim turns a throw into null. */
type PageProbe =
	| { kind: "wrong_origin" | "network_error" }
	| {
			kind: "response";
			blank: boolean;
			hasSignOut: boolean;
			status: number;
			url: string;
			waf: string;
	  };

function pathnameOf(url: string): string | null {
	try {
		return new URL(url).pathname;
	} catch {
		return null;
	}
}

/**
 * Whether the page's own goodreads.com session is signed in, asked from
 * inside the page, without navigating (so it is safe on the PageShim host and
 * while the owner is part way through signing in). Signed in, `/review/list`
 * redirects to `/review/list/<id>-<name>` and the page carries a sign-out
 * link; signed out it redirects to the sign-in page. A page on another
 * origin, a network failure, an empty body or a WAF challenge answers false.
 */
export async function probeGoodreadsPage(
	page: Pick<Page, "evaluate">,
): Promise<boolean> {
	try {
		const result = (await page.evaluate(async (origin) => {
			if (location.origin !== origin) return { kind: "wrong_origin" };
			try {
				const response = await fetch("/review/list", {
					credentials: "include",
					headers: { Accept: "text/html,application/xhtml+xml" },
				});
				const body = await response.text();
				return {
					kind: "response",
					blank: body.trim() === "",
					hasSignOut: body.includes("/user/sign_out"),
					status: response.status,
					url: response.url,
					waf: response.headers.get("x-amzn-waf-action") ?? "",
				};
			} catch {
				return { kind: "network_error" };
			}
		}, ORIGIN)) as PageProbe | null;
		// A WAF challenge can answer 200 at the asked-for URL with an empty
		// body, so the URL alone does not prove the page was served.
		if (
			result?.kind !== "response" ||
			result.status !== 200 ||
			result.blank ||
			result.waf !== ""
		) {
			return false;
		}
		const path = pathnameOf(result.url);
		if (path === null || SIGN_IN_PATH_RE.test(path)) return false;
		return OWN_LIST_PATH_RE.test(path) || result.hasSignOut;
	} catch {
		return false;
	}
}

/**
 * Whether the browser profile holds a signed-in Goodreads session. Asks over
 * the browser context's cookie jar first: it works from any origin and never
 * navigates, so it is safe mid sign-in on another site (Amazon, Google). When
 * Goodreads answers that request with something other than a clear yes or
 * no (a WAF challenge needs a real page load), the page's own fetch decides.
 */
export async function probeGoodreadsSession(
	page: Pick<Page, "context" | "evaluate">,
): Promise<boolean> {
	try {
		// The redirect itself answers the question: signed in, /review/list
		// redirects to /review/list/<id>-<name>; signed out, to the sign-in
		// page. Reading it without following keeps the probe to one request,
		// the same request the collector's user-id lookup makes, so a recorded
		// scenario can answer it.
		const response = await page.context().request.get(LIST_URL, {
			maxRedirects: 0,
			timeout: 15_000,
		});
		try {
			const status = response.status();
			const location = response.headers().location;
			const path =
				status >= 300 && status < 400 && location
					? pathnameOf(new URL(location, ORIGIN).toString())
					: status === 200
						? pathnameOf(response.url())
						: null;
			if (path !== null) {
				if (OWN_LIST_PATH_RE.test(path)) return true;
				if (SIGN_IN_PATH_RE.test(path)) return false;
			}
		} finally {
			await response.dispose();
		}
	} catch {
		// Fall through to the page's own answer.
	}
	return probeGoodreadsPage(page);
}

/**
 * Session order: a live saved session first; then, only when the owner saved
 * an email and password, one automatic sign-in; then the owner's browser
 * handoff. A fallback from the automatic step carries its reason into the
 * handoff message, and the handoff reason ("captcha", "2fa") when it has one.
 */
export async function ensureGoodreadsSession(
	args: EnsureSessionArgs,
): Promise<void> {
	const {
		assist,
		capture,
		checkpoint,
		completeAssistance,
		credentials,
		onCredentialSubmit,
		page,
		sendInteraction,
	} = args;
	if (await probeGoodreadsSession(page)) return;

	let message = SIGN_IN_MESSAGE;
	let reason: ManualActionReason = "login";
	let onSignInPage = false;
	const saved = resolveLoginCredentials(
		credentials,
		GOODREADS_LOGIN_FIELDS,
		"goodreads",
	);
	if (saved.kind === "resolved") {
		const outcome = await attemptAutomaticSignIn({
			checkpoint,
			loginUrl: LOGIN_URL,
			onCredentialSubmit,
			page,
			password: saved.password,
			probe: () => probeGoodreadsSession(page),
			username: saved.username,
		});
		if (outcome.kind === "signed_in") return;
		message = `${fallbackExplanation(outcome.reason)} ${SIGN_IN_MESSAGE}`;
		reason = fallbackHandoffReason(outcome.reason);
		// A CAPTCHA, code or rejected-password page is where the owner finishes;
		// leave it in place. Any other fallback restarts from the sign-in page.
		onSignInPage =
			outcome.reason === "captcha" ||
			outcome.reason === "verification" ||
			outcome.reason === "rejected_credentials";
	}
	if (!onSignInPage) {
		await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
	}
	const ready = await manualBrowserLogin({
		assist,
		capture,
		completeAssistance,
		isProbeSuccessful: (ok) => ok === true,
		message,
		page,
		probe: () => probeGoodreadsSession(page),
		readinessProbe: probeGoodreadsSession,
		readinessProbeOnHandoffPage: true,
		reason,
		sendInteraction,
		timeoutSeconds: 30 * 60,
	});
	if (!ready) {
		throw new Error("goodreads_session_missing");
	}
}

/** The PageShim and desktop entry: `ctx` needs only what GoodreadsCollectContext names. */
export function collect(ctx: GoodreadsCollectContext): Promise<void> {
	return collectGoodreads(ctx);
}

/**
 * The `runConnector` options. Exported so the startup contract is testable.
 * The manifest's `consent_time_field` is the only time-range authority; the
 * config carries no override of it.
 */
export const CONNECTOR_CONFIG = {
	name: "goodreads",
	validateRecord,
	// The saved sign-in is optional: with none, the owner signs in through the
	// browser handoff and the run never asks for a credential.
	auth: {
		kind: "env" as const,
		required: ["GOODREADS_USERNAME", "GOODREADS_PASSWORD"],
	},
	authOptional: true,
	browser: { profileName: "goodreads" },
	ensureSession: ensureGoodreadsSession,
	probeSession: ({ page }: { page: Pick<Page, "context" | "evaluate"> }) =>
		probeGoodreadsSession(page),
	probeSessionIsAuthoritative: true,
	// The collector marks a book or shelf that Goodreads no longer lists.
	isTombstone: (_stream: string, data: Record<string, unknown>) =>
		data.deleted === true,
	collect: (ctx: BrowserCollectContext) => collect(ctx),
};

if (isMainModule(import.meta.url)) {
	runConnector(CONNECTOR_CONFIG);
}
