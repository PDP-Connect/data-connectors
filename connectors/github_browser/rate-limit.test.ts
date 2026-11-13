// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { githubLink } from "./api-link-fixture.ts";
import { collectGitHubBrowser } from "./collector.ts";
import {
	MAX_TOTAL_RATE_LIMIT_WAIT_MS,
	RATE_LIMIT_RESET_MARGIN_MS,
	createRateLimitPacer,
	type RateLimitObservation,
} from "./rate-limit.ts";
import type { BrowserServices } from "./types.ts";

const START_MS = Date.parse("2026-01-01T00:00:00Z");
const SEARCH_URL = "https://api.github.com/search/issues?q=a&page=1";

function fakeClock() {
	const clock = { ms: START_MS, sleeps: [] as number[] };
	return {
		clock,
		now: () => new Date(clock.ms),
		sleep: async (ms: number) => {
			clock.sleeps.push(ms);
			clock.ms += ms;
		},
	};
}

const limit = (remaining: number, resetInSeconds: number): RateLimitObservation => ({
	remaining,
	resetEpochSeconds: START_MS / 1000 + resetInSeconds,
	retryAfterSeconds: null,
});

function httpError(status: number, rateLimit?: RateLimitObservation) {
	return Object.assign(new Error(`github_browser_http_${status}`), rateLimit === undefined ? {} : { rateLimit });
}

test("a burst of ten search calls goes out without a sleep and the eleventh waits for the reset", async () => {
	const { clock, now, sleep } = fakeClock();
	const pacer = createRateLimitPacer({ now, sleep });
	let sent = 0;
	const request = async () => {
		sent += 1;
		return { status: 200, rateLimit: limit(10 - sent, 50) };
	};
	for (let i = 0; i < 10; i += 1) await pacer.send(SEARCH_URL, request);
	assert.equal(sent, 10);
	assert.deepEqual(clock.sleeps, []);
	await pacer.send(SEARCH_URL, request);
	assert.equal(sent, 11);
	assert.deepEqual(clock.sleeps, [50_000 + RATE_LIMIT_RESET_MARGIN_MS]);
});

test("search and core limits are tracked apart", async () => {
	const { clock, now, sleep } = fakeClock();
	const pacer = createRateLimitPacer({ now, sleep });
	await pacer.send(SEARCH_URL, async () => ({ status: 200, rateLimit: limit(0, 40) }));
	await pacer.send("https://api.github.com/users/sample-user/events/public", async () => ({ status: 200 }));
	assert.deepEqual(clock.sleeps, []);
});

test("a rate-limited 403 waits for the reset once, retries once, then reports the original failure", async () => {
	const { clock, now, sleep } = fakeClock();
	const pacer = createRateLimitPacer({ now, sleep });
	let sent = 0;
	await assert.rejects(
		pacer.send(SEARCH_URL, async () => {
			sent += 1;
			throw httpError(403, limit(0, 30));
		}),
		/^Error: github_browser_http_403$/u,
	);
	assert.equal(sent, 2);
	assert.deepEqual(clock.sleeps, [30_000 + RATE_LIMIT_RESET_MARGIN_MS]);
});

test("a 429 that clears after the wait returns the retried response", async () => {
	const { now, sleep } = fakeClock();
	const pacer = createRateLimitPacer({ now, sleep });
	let sent = 0;
	const result = await pacer.send(SEARCH_URL, async () => {
		sent += 1;
		if (sent === 1) return { status: 429, rateLimit: limit(0, 5) };
		return { status: 200 };
	});
	assert.equal(result.status, 200);
	assert.equal(sent, 2);
});

test("a 403 without rate-limit headers is not waited on or retried", async () => {
	const { clock, now, sleep } = fakeClock();
	const pacer = createRateLimitPacer({ now, sleep });
	let sent = 0;
	await assert.rejects(pacer.send(SEARCH_URL, async () => { sent += 1; throw httpError(403); }), /http_403/u);
	assert.equal(sent, 1);
	assert.deepEqual(clock.sleeps, []);
});

test("a 403 that still has allowance left is not a rate limit", async () => {
	const { clock, now, sleep } = fakeClock();
	const pacer = createRateLimitPacer({ now, sleep });
	let sent = 0;
	await assert.rejects(pacer.send(SEARCH_URL, async () => { sent += 1; throw httpError(403, limit(7, 30)); }), /http_403/u);
	assert.equal(sent, 1);
	assert.deepEqual(clock.sleeps, []);
});

test("a wait beyond the total bound is skipped and the typed failure is reported", async () => {
	const { clock, now, sleep } = fakeClock();
	const pacer = createRateLimitPacer({ now, sleep });
	const hourAway = MAX_TOTAL_RATE_LIMIT_WAIT_MS / 1000 + 1;
	let sent = 0;
	await assert.rejects(pacer.send(SEARCH_URL, async () => { sent += 1; throw httpError(403, limit(0, hourAway)); }), /http_403/u);
	assert.equal(sent, 1);
	assert.deepEqual(clock.sleeps, []);
});

test("waits share one total bound", async () => {
	const { clock, now, sleep } = fakeClock();
	const pacer = createRateLimitPacer({ now, sleep, maxTotalWaitMs: 70_000 });
	const exhausted = async () => ({
		status: 200,
		rateLimit: { remaining: 0, resetEpochSeconds: clock.ms / 1000 + 40, retryAfterSeconds: null },
	});
	await pacer.send(SEARCH_URL, exhausted);
	await pacer.send(SEARCH_URL, exhausted); // waits 41 s, learns a window 40 s away again
	await pacer.send(SEARCH_URL, exhausted); // 41 s more would pass 70 s: send anyway
	assert.deepEqual(clock.sleeps, [40_000 + RATE_LIMIT_RESET_MARGIN_MS]);
});

test("a retry-after header sets the wait when the reset header is absent", async () => {
	const { clock, now, sleep } = fakeClock();
	const pacer = createRateLimitPacer({ now, sleep });
	let sent = 0;
	await pacer.send(SEARCH_URL, async () => {
		sent += 1;
		return sent === 1
			? { status: 429, rateLimit: { remaining: null, resetEpochSeconds: null, retryAfterSeconds: 12 } }
			: { status: 200 };
	});
	assert.deepEqual(clock.sleeps, [12_000]);
});

test("a secondary limit's retry-after wins over an unspent reset header", async () => {
	const { clock, now, sleep } = fakeClock();
	const pacer = createRateLimitPacer({ now, sleep });
	let sent = 0;
	await pacer.send(SEARCH_URL, async () => {
		sent += 1;
		if (sent === 1) throw httpError(403, { remaining: 7, resetEpochSeconds: START_MS / 1000 + 50, retryAfterSeconds: 9 });
		return { status: 200 };
	});
	assert.equal(sent, 2);
	assert.deepEqual(clock.sleeps, [9_000]);
});

const fixture = async (name: string) => JSON.parse(await readFile(new URL(`./__fixtures__/synthetic/${name}`, import.meta.url), "utf8"));

test("history walks its search pages on the rate-limit headers with no fixed sleep", async () => {
	const source = (await fixture("history-issue.json")).items[0];
	const { clock, now, sleep } = fakeClock();
	const requests: Array<{ at: number; page: number; type: string }> = [];
	const state: Record<string, unknown> = {};
	const records: unknown[] = [];
	const pagesOf = { issue: 5, pr: 6 };
	const services: BrowserServices = {
		openPage: async (url) => ({ requestedUrl: url, currentUrl: url, html: '<meta name="user-login" content="sample-user">' }),
		fetchPublicJson: async (url) => {
			const page = Number(new URL(url).searchParams.get("page"));
			const type = url.includes("type%3Apr") ? "pr" : "issue";
			// Ten search calls per window, which closes sixty seconds after the first.
			const windowEnd = START_MS / 1000 + 60;
			const used = requests.length + 1;
			requests.push({ at: clock.ms - START_MS, page, type });
			const last = pagesOf[type];
			return {
				requestedUrl: url, responseUrl: url, status: 200,
				link: githubLink(url, last),
				rateLimit: { remaining: Math.max(0, 10 - used), resetEpochSeconds: windowEnd, retryAfterSeconds: null },
				data: { total_count: last * 100, incomplete_results: false,
					items: Array.from({ length: 100 }, (_, i) => ({ ...source, id: (type === "pr" ? 100_000 : 0) + page * 1000 + i, number: page * 1000 + i, ...(type === "pr" ? { draft: false, pull_request: { merged_at: null } } : {}) })) },
			};
		},
		now, sleep,
	};
	await collectGitHubBrowser({
		emit: async () => {}, emitRecord: async (_s, data) => { records.push(data); },
		progress: async () => {}, requested: new Set(["history"]), state,
	}, services);
	assert.equal(requests.length, 11);
	assert.deepEqual(clock.sleeps, [60_000 + RATE_LIMIT_RESET_MARGIN_MS]);
	assert.deepEqual(requests.slice(0, 10).map((request) => request.at), Array(10).fill(0));
	assert.equal(requests[10]?.at, 60_000 + RATE_LIMIT_RESET_MARGIN_MS);
	assert.equal(records.length, 1);
});
