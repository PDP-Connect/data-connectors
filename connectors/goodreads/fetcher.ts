// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Same-origin page fetches for goodreads.com, from inside the owner's
 * signed-in browser page, with the three failure modes the site shows:
 *
 *   - a navigation or network failure, or HTTP 429/5xx: retried with backoff,
 *     waiting at least as long as a Retry-After header asks; a 429 that does
 *     not lift, or asks for a longer wait than a run should sleep, stops the
 *     run as rate limited;
 *   - an AWS WAF challenge (HTTP 202, an `x-amzn-waf-action` header, or an
 *     empty body): the page is loaded once at that URL so the challenge
 *     script can run, then the fetch is retried once; still challenged means
 *     the run stops with a clear reason, never an empty result;
 *   - a redirect to the sign-in page: the session is gone.
 *
 * The in-page function is self-contained (no inner named functions): the
 * PageShim host serialises it with `Function.prototype.toString`.
 */

import { parseRetryAfterMs } from "@pdpp/connector-protocol/http-retry";
import type { Page } from "playwright";
import { politeDelay } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { ORIGIN } from "./parsers.ts";

export type FetchPage = Pick<Page, "evaluate" | "goto">;

/** A light same-origin page to fetch from when the browser is somewhere else. */
export const ANCHOR_URL = `${ORIGIN}/robots.txt`;
export const NAVIGATION_TIMEOUT_MS = 45_000;
export const RETRY_BASE_DELAY_MS = 3000;
export const WAF_SETTLE_MS = 5000;
/** The longest Retry-After a run sleeps through; a longer ask stops the run. */
export const MAX_RETRY_AFTER_MS = 5 * 60_000;
const MAX_ATTEMPTS = 3;
const MAX_ORIGIN_RECOVERIES = 2;

const WAF_ACTION_RE = /challenge|captcha|block/i;
const SIGN_IN_PATH_RE = /^\/(?:user\/sign_in|ap\/signin|sign_in)/;

type RawResponse =
	| { kind: "wrong_origin" }
	| { kind: "network_error"; message: string }
	| {
			kind: "response";
			status: number;
			url: string;
			waf: string;
			retryAfter: string | null;
			body: string;
	  };

export type FetchOutcome =
	| { ok: true; body: string; url: string }
	| {
			ok: false;
			reason:
				| "bot_challenge"
				| "collection_interrupted"
				| "rate_limited"
				| "sign_in_required"
				| "source_unreadable";
			message: string;
	  };

async function rawFetch(page: FetchPage, path: string): Promise<RawResponse> {
	const result = await page.evaluate(
		async ({ origin, path }) => {
			if (location.origin !== origin) return { kind: "wrong_origin" };
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), 45_000);
			try {
				const response = await fetch(path, {
					credentials: "include",
					headers: { Accept: "text/html,application/xhtml+xml" },
					signal: controller.signal,
				});
				return {
					kind: "response",
					status: response.status,
					url: response.url,
					waf: response.headers.get("x-amzn-waf-action") ?? "",
					retryAfter: response.headers.get("retry-after"),
					body: await response.text(),
				};
			} catch (error) {
				return {
					kind: "network_error",
					message: error instanceof Error ? error.message : String(error),
				};
			} finally {
				clearTimeout(timer);
			}
		},
		{ origin: ORIGIN, path },
	);
	// PageShim reports an evaluate that failed in the page as null.
	return (
		(result as RawResponse | null) ?? {
			kind: "network_error",
			message: "the page did not return a result",
		}
	);
}

/** Load a URL in the page, retrying a slow or failed navigation. */
export async function navigate(page: FetchPage, url: string): Promise<boolean> {
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
		try {
			await page.goto(url, {
				timeout: NAVIGATION_TIMEOUT_MS,
				waitUntil: "domcontentloaded",
			});
			return true;
		} catch {
			if (attempt < MAX_ATTEMPTS) {
				await politeDelay(RETRY_BASE_DELAY_MS * attempt);
			}
		}
	}
	return false;
}

/** Whether a response is a WAF challenge rather than the page that was asked for. */
export function isWafChallenge(response: {
	body: string;
	status: number;
	waf: string;
}): boolean {
	return (
		WAF_ACTION_RE.test(response.waf) ||
		response.status === 202 ||
		(response.status === 200 && response.body.trim() === "")
	);
}

function isSignInUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		return (
			SIGN_IN_PATH_RE.test(parsed.pathname) ||
			!parsed.hostname.endsWith("goodreads.com")
		);
	} catch {
		return false;
	}
}

/**
 * What to do after the `failures`-th retryable answer: wait this many ms, give
 * up as interrupted, or give up as rate limited. A Retry-After header sets the
 * least wait; one longer than MAX_RETRY_AFTER_MS ends the run at once rather
 * than sleeping through it. Shared with the book API's retry loop.
 */
export function retryWait(
	failures: number,
	raw:
		| { kind: "network_error" }
		| { kind: "response"; status: number; retryAfter: string | null },
): number | "give_up" | "rate_limited" {
	const limited = raw.kind === "response" && raw.status === 429;
	const asked =
		raw.kind === "response" ? parseRetryAfterMs(raw.retryAfter) : null;
	if (failures >= MAX_ATTEMPTS || (asked ?? 0) > MAX_RETRY_AFTER_MS) {
		return limited ? "rate_limited" : "give_up";
	}
	return Math.max(asked ?? 0, RETRY_BASE_DELAY_MS * 2 ** (failures - 1));
}

/** GET a goodreads.com path from the owner's page and classify the answer. */
export async function fetchHtml(
	page: FetchPage,
	path: string,
	label: string,
): Promise<FetchOutcome> {
	let failures = 0;
	let wafAttempts = 0;
	let originRecoveries = 0;
	for (;;) {
		const raw = await rawFetch(page, path);
		if (raw.kind === "wrong_origin") {
			originRecoveries += 1;
			if (
				originRecoveries > MAX_ORIGIN_RECOVERIES ||
				!(await navigate(page, ANCHOR_URL))
			) {
				return {
					ok: false,
					reason: "collection_interrupted",
					message: `The browser could not get back to Goodreads to read ${label}.`,
				};
			}
			continue;
		}
		if (
			raw.kind === "network_error" ||
			raw.status === 429 ||
			raw.status >= 500
		) {
			failures += 1;
			const wait = retryWait(failures, raw);
			if (wait === "rate_limited") {
				return {
					ok: false,
					reason: "rate_limited",
					message: `Goodreads asked this run to slow down (HTTP 429) while reading ${label}, and did not lift the limit in time.`,
				};
			}
			if (wait === "give_up") {
				return {
					ok: false,
					reason: "collection_interrupted",
					message:
						raw.kind === "network_error"
							? `Goodreads could not be reached while reading ${label}.`
							: `Goodreads kept answering with an error (${raw.status}) while reading ${label}.`,
				};
			}
			await politeDelay(wait);
			continue;
		}
		if (isWafChallenge(raw)) {
			wafAttempts += 1;
			if (wafAttempts > 1) {
				return {
					ok: false,
					reason: "bot_challenge",
					message: `Goodreads asked the browser to pass a verification check before ${label} could be read, and it did not clear. Open Goodreads in the connector's browser, pass the check, then run collection again.`,
				};
			}
			// Let the challenge script run in a real page load, then try again.
			await navigate(page, new URL(path, ORIGIN).toString());
			await politeDelay(WAF_SETTLE_MS);
			continue;
		}
		if (raw.status === 401 || isSignInUrl(raw.url)) {
			return {
				ok: false,
				reason: "sign_in_required",
				message: `Goodreads asked for sign-in while reading ${label}.`,
			};
		}
		if (raw.status !== 200) {
			return {
				ok: false,
				reason: "source_unreadable",
				message: `Goodreads answered ${label} with HTTP ${raw.status}, not a page this connector can read.`,
			};
		}
		return { ok: true, body: raw.body, url: raw.url };
	}
}
