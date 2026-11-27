// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Paces GitHub API calls from the rate-limit headers GitHub returns, instead
 * of a fixed delay between calls.
 *
 * GitHub's search allowance is a burst (10 requests per window), not an even
 * spacing. While `x-ratelimit-remaining` is above zero a request goes out at
 * once. When it reaches zero the next request waits until `x-ratelimit-reset`.
 */

/** What one response said about the allowance. Every field may be absent. */
export interface RateLimitObservation {
	readonly remaining: number | null;
	/** `x-ratelimit-reset`: UTC epoch seconds when the window renews. */
	readonly resetEpochSeconds: number | null;
	/** `retry-after`: seconds, sent with secondary limits instead of a reset. */
	readonly retryAfterSeconds: number | null;
}

/** `x-ratelimit-reset` has whole-second resolution; wait one second past it. */
export const RATE_LIMIT_RESET_MARGIN_MS = 1_000;

/**
 * Bound on the time one run spends waiting on rate limits. The search window
 * renews every 60 seconds, so this covers three renewals, enough for about 30
 * search calls (the connector makes at most 20). The unauthenticated core limit
 * renews hourly: a wait that long is not worth holding a run for, so it is
 * skipped and the request reports GitHub's own failure.
 */
export const MAX_TOTAL_RATE_LIMIT_WAIT_MS = 180_000;

interface PacerOptions {
	now(): Date;
	sleep(ms: number): Promise<void>;
	maxTotalWaitMs?: number;
}

interface Window {
	remaining: number;
	resetAtMs: number;
}

type Paced = { readonly status?: number; readonly rateLimit?: RateLimitObservation | undefined };

const LIMIT_STATUSES = new Set([403, 429]);

/** Search has its own allowance; every other API path draws on the core one. */
function resourceOf(url: string): "search" | "core" {
	try {
		return new URL(url).pathname.startsWith("/search/") ? "search" : "core";
	} catch {
		return "core";
	}
}

function failureStatus(error: unknown): number | undefined {
	const match = error instanceof Error ? /^github_browser_http_(\d{3})$/u.exec(error.message) : null;
	return match === null ? undefined : Number(match[1]);
}

function rateLimitOf(value: unknown): RateLimitObservation | undefined {
	return typeof value === "object" && value !== null
		? (value as { rateLimit?: RateLimitObservation }).rateLimit
		: undefined;
}

export function createRateLimitPacer({ now, sleep, maxTotalWaitMs = MAX_TOTAL_RATE_LIMIT_WAIT_MS }: PacerOptions) {
	const windows = new Map<string, Window>();
	let waitedMs = 0;

	const nowMs = (): number => now().getTime();
	// A wait that would pass the run's bound is not taken.
	const spend = async (ms: number): Promise<boolean> => {
		if (waitedMs + ms > maxTotalWaitMs) return false;
		waitedMs += ms;
		if (ms > 0) await sleep(ms);
		return true;
	};
	// Returns the window stored from this observation, or undefined when none was.
	const observe = (resource: string, rateLimit: RateLimitObservation | undefined): Window | undefined => {
		if (rateLimit === undefined || rateLimit.remaining === null || rateLimit.resetEpochSeconds === null) return undefined;
		const next = { remaining: rateLimit.remaining, resetAtMs: rateLimit.resetEpochSeconds * 1000 };
		// Concurrent lanes share a window and their responses can land out of
		// order. A response from an older window never replaces a newer one, and
		// within one window the lowest count wins: the allowance only falls.
		const prior = windows.get(resource);
		if (prior !== undefined && (next.resetAtMs < prior.resetAtMs || (next.resetAtMs === prior.resetAtMs && next.remaining > prior.remaining))) return undefined;
		windows.set(resource, next);
		return next;
	};
	// Wait, in ms, that the headers of a refusal call for; null when they call for none.
	const refusalWaitMs = (rateLimit: RateLimitObservation | undefined): number | null => {
		if (rateLimit === undefined) return null;
		// GitHub's guidance: retry-after, when sent, wins over the reset header.
		// Secondary limits send it beside an x-ratelimit-reset that is not spent.
		if (rateLimit.retryAfterSeconds !== null) return rateLimit.retryAfterSeconds * 1000;
		if (rateLimit.remaining === 0 && rateLimit.resetEpochSeconds !== null)
			return Math.max(0, rateLimit.resetEpochSeconds * 1000 - nowMs()) + RATE_LIMIT_RESET_MARGIN_MS;
		return null;
	};

	/** Send `request`, first waiting out a spent window, and handle one refusal. */
	async function send<T extends Paced>(url: string, request: () => Promise<T>): Promise<T> {
		const resource = resourceOf(url);
		for (let attempt = 0; ; attempt += 1) {
			// Another lane can observe a newer spent window while this one sleeps:
			// clear only the window waited for, then check again.
			for (let spent = windows.get(resource); spent !== undefined && spent.remaining === 0; spent = windows.get(resource)) {
				const waitMs = spent.resetAtMs - nowMs() + RATE_LIMIT_RESET_MARGIN_MS;
				if (waitMs > 0 && !(await spend(waitMs))) break;
				if (windows.get(resource) === spent) windows.delete(resource);
			}
			let result: T | undefined;
			let failure: unknown;
			try {
				result = await request();
			} catch (error) {
				failure = error;
			}
			const rateLimit = result === undefined ? rateLimitOf(failure) : result.rateLimit;
			const refused = observe(resource, rateLimit);
			const status = result === undefined ? failureStatus(failure) : result.status;
			const waitMs = status !== undefined && LIMIT_STATUSES.has(status) ? refusalWaitMs(rateLimit) : null;
			if (attempt === 0 && waitMs !== null && (await spend(waitMs))) {
				// Clear the refusal's own window; a newer spent one, if stored,
				// is waited out before the retry.
				if (refused !== undefined && windows.get(resource) === refused) windows.delete(resource);
				continue;
			}
			if (result === undefined) throw failure;
			return result;
		}
	}

	return { send };
}
