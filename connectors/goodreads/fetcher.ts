// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Same-origin page fetches for goodreads.com, from inside the owner's
 * signed-in browser page, with the three failure modes the site shows:
 *
 *   - a navigation or network failure, or HTTP 429/5xx: retried by the
 *     shared HTTP governor, which also paces every request (see
 *     `GoodreadsHttp`); a 429 that does not lift, or asks for a longer wait
 *     than a run should sleep, stops the run as rate limited;
 *   - an AWS WAF challenge (HTTP 202, an `x-amzn-waf-action` header, or an
 *     empty body): the page is loaded once at that URL so the challenge
 *     script can run, then the fetch is retried once; still challenged means
 *     the run stops with a clear reason, never an empty result;
 *   - a redirect to the sign-in page: the session is gone.
 *
 * The in-page function is self-contained (no inner named functions): the
 * PageShim host serialises it with `Function.prototype.toString`.
 */

import {
	type HttpRetryBudget,
	parseRetryAfterMs,
	RetryExhaustedError,
} from "@pdpp/connector-protocol/http-retry";
import type { Page } from "playwright";
import {
	type ConnectorHttpGovernor,
	ConnectorRateLimitedError,
} from "../../packages/polyfill-connectors/src/connector-http-governor.ts";
import { politeDelay } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { RetryBudget } from "../../packages/polyfill-connectors/src/provider-budget.ts";
import { ORIGIN } from "./parsers.ts";

export type FetchPage = Pick<Page, "evaluate" | "goto">;

/** A light same-origin page to fetch from when the browser is somewhere else. */
export const ANCHOR_URL = `${ORIGIN}/robots.txt`;
export const NAVIGATION_TIMEOUT_MS = 45_000;
/** The governor's backoff base for a retried request, before jitter. */
export const RETRY_BASE_DELAY_MS = 3000;
export const WAF_SETTLE_MS = 5000;
/** The longest Retry-After a run sleeps through; a longer ask stops the run. */
export const MAX_RETRY_AFTER_MS = 5 * 60_000;
/** Attempts per request, the first included. */
export const MAX_ATTEMPTS = 3;
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
 * The run's retry allowance. It is the governor's retry budget, so retries
 * across the whole run are bounded, not only per request. It also refuses
 * the retry after an answer whose Retry-After asks for longer than
 * MAX_RETRY_AFTER_MS: the run stops at once rather than asking again before
 * the time Goodreads named.
 */
export class GoodreadsRetryBudget implements HttpRetryBudget {
	private readonly budget = new RetryBudget({
		capacity: 6,
		initialTokens: 6,
		refillPerSuccess: 0.5,
	});
	private refuseNext = false;

	/** Called for each answer, before the governor decides on a retry. */
	noteAnswer(retryAfter: string | null): void {
		this.refuseNext = (parseRetryAfterMs(retryAfter) ?? 0) > MAX_RETRY_AFTER_MS;
	}

	/** Called before each attempt, so a refusal never outlives its answer. */
	noteAttempt(): void {
		this.refuseNext = false;
	}

	consume(): boolean {
		return !this.refuseNext && this.budget.consume();
	}

	recordSuccess(): void {
		this.budget.recordSuccess();
	}
}

/**
 * The run's one HTTP governor (built in index.ts from the provider profile)
 * and its retry budget. Every request to
 * Goodreads goes through it: page fetches, page loads and the book API. It
 * waits before each request, starts slow, speeds up while Goodreads answers,
 * backs off on 429 and 5xx, and honours Retry-After.
 */
export interface GoodreadsHttp {
	governor: Pick<ConnectorHttpGovernor, "request" | "snapshot">;
	retryBudget: GoodreadsRetryBudget;
}

/** An answer the governor can classify. */
interface Answer {
	retryAfter: string | null;
	status: number;
}

export type Governed<T> =
	| { ok: true; value: T }
	| { ok: false; rateLimited: true }
	| { ok: false; rateLimited: false; status: number | null };

/**
 * Send one request through the governor. `send` throws on a network
 * failure. Fails as rate limited when 429s did not lift, otherwise with the
 * last status (null after network failures).
 */
export async function governed<T extends Answer>(
	http: GoodreadsHttp,
	send: () => Promise<T>,
): Promise<Governed<T>> {
	try {
		const result = await http.governor.request(
			() => {
				http.retryBudget.noteAttempt();
				return send();
			},
			(answer: T) => {
				http.retryBudget.noteAnswer(answer.retryAfter);
				return {
					headers:
						answer.retryAfter === null
							? {}
							: { "retry-after": answer.retryAfter },
					status: answer.status,
					value: answer,
				};
			},
		);
		return { ok: true, value: result.value };
	} catch (error) {
		if (error instanceof ConnectorRateLimitedError) {
			return { ok: false, rateLimited: true };
		}
		if (error instanceof RetryExhaustedError) {
			const cause = error.originalCause as { status?: unknown } | undefined;
			return {
				ok: false,
				rateLimited: false,
				status: typeof cause?.status === "number" ? cause.status : null,
			};
		}
		throw error;
	}
}

/** Load a URL in the page through the governor, retrying a failed load. */
export async function navigate(
	page: FetchPage,
	http: GoodreadsHttp,
	url: string,
): Promise<boolean> {
	const loaded = await governed(http, async () => {
		const response = await page.goto(url, {
			timeout: NAVIGATION_TIMEOUT_MS,
			waitUntil: "domcontentloaded",
		});
		// PageShim and some redirects give no response; the load still worked.
		if (typeof response?.status !== "function") {
			return { retryAfter: null, status: 200 };
		}
		return {
			retryAfter: response.headers()["retry-after"] ?? null,
			status: response.status(),
		};
	});
	return loaded.ok;
}

/** GET a goodreads.com path from the owner's page and classify the answer. */
export async function fetchHtml(
	page: FetchPage,
	http: GoodreadsHttp,
	path: string,
	label: string,
): Promise<FetchOutcome> {
	let wafAttempts = 0;
	let originRecoveries = 0;
	for (;;) {
		const answer = await governed(http, async () => {
			const raw = await rawFetch(page, path);
			if (raw.kind === "network_error") throw new Error(raw.message);
			// No request left the page; status 0 is not retried.
			return raw.kind === "wrong_origin"
				? { kind: raw.kind, retryAfter: null, status: 0 }
				: raw;
		});
		if (!answer.ok) {
			if (answer.rateLimited) {
				return {
					ok: false,
					reason: "rate_limited",
					message: `Goodreads asked this run to slow down (HTTP 429) while reading ${label}, and did not lift the limit in time.`,
				};
			}
			return {
				ok: false,
				reason: "collection_interrupted",
				message:
					answer.status === null
						? `Goodreads could not be reached while reading ${label}.`
						: `Goodreads kept answering with an error (${answer.status}) while reading ${label}.`,
			};
		}
		const raw = answer.value;
		if (raw.kind === "wrong_origin") {
			originRecoveries += 1;
			if (
				originRecoveries > MAX_ORIGIN_RECOVERIES ||
				!(await navigate(page, http, ANCHOR_URL))
			) {
				return {
					ok: false,
					reason: "collection_interrupted",
					message: `The browser could not get back to Goodreads to read ${label}.`,
				};
			}
			continue;
		}
		// A challenge is AWS WAF asking for a token, not for a slower pace: its
		// Challenge action lets through any request with a valid token whatever
		// the rate. So it is not a throttle signal to the governor; the page load
		// that runs the challenge script is what clears it.
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
			await navigate(page, http, new URL(path, ORIGIN).toString());
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
