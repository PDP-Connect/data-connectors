// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { after, before, type TestContext, test } from "node:test";
import type { StreamScope } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import {
	collectUser,
	createGithubHttpGovernor,
	GITHUB_RETRYABLE_PATTERN,
	type StreamCtx,
} from "./index.ts";

const ORIGINAL_SET_TIMEOUT = globalThis.setTimeout;
before(() => {
	globalThis.setTimeout = new Proxy(ORIGINAL_SET_TIMEOUT, {
		apply: (_target, _thisArg, callArgs: unknown[]) => {
			const [handler, , ...args] = callArgs as [
				TimerHandler,
				number?,
				...unknown[],
			];
			if (typeof handler === "function") {
				queueMicrotask(() => (handler as (...a: unknown[]) => void)(...args));
			}
			const handle = ORIGINAL_SET_TIMEOUT(() => undefined, 0);
			clearTimeout(handle);
			return handle;
		},
	});
});

after(() => {
	globalThis.setTimeout = ORIGINAL_SET_TIMEOUT;
});

/**
 * Only counts/routes calls to the GitHub REST API host — these tests assert
 * exact call counts for the REST governor's retry sequence. `collectUser`
 * also makes one unauthenticated, ungoverned fetch to the public profile
 * page (`https://github.com/{login}`, achievements scrape); that call must
 * not perturb the REST retry-count assertions below, so it's answered with a
 * neutral empty-body 200 outside the counted `response()` callback.
 */
function mockFetch(t: TestContext, response: () => Response): void {
	t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
		const url = typeof input === "string" ? input : input.toString();
		if (!url.startsWith("https://api.github.com")) {
			return new Response("<html></html>", { status: 200 });
		}
		return response();
	});
}

function userResponse(): Response {
	return new Response(
		JSON.stringify({
			id: 42,
			login: "octocat",
			public_repos: 0,
			public_gists: 0,
			followers: 0,
			following: 0,
			created_at: "2020-01-01T00:00:00Z",
			updated_at: "2026-01-01T00:00:00Z",
		}),
		{ status: 200 },
	);
}

function makeCtx(retrySleep?: (ms: number) => void): {
	ctx: StreamCtx;
	progresses: string[];
} {
	const progresses: string[] = [];
	const requested = new Map<string, StreamScope>([["user", { name: "user" }]]);
	return {
		ctx: {
			emit: async () => undefined,
			emitRecord: async () => undefined,
			httpGovernor: createGithubHttpGovernor(
				retrySleep === undefined ? {} : { retrySleep },
			),
			progress: async (message) => {
				progresses.push(message);
			},
			requested,
			state: {},
			token: "test-token",
		},
		progresses,
	};
}

test("GitHub secondary 403 retries with Retry-After and emits retry progress", async (t) => {
	const sleeps: number[] = [];
	let calls = 0;
	mockFetch(t, () => {
		calls += 1;
		return calls === 1
			? new Response(
					JSON.stringify({
						message: "You have exceeded a secondary rate limit",
					}),
					{
						status: 403,
						headers: { "Retry-After": "2" },
					},
				)
			: userResponse();
	});
	const { ctx, progresses } = makeCtx((ms) => sleeps.push(ms));

	await collectUser(ctx);

	assert.equal(calls, 2);
	assert.deepEqual(sleeps, [2000]);
	assert.ok(progresses.includes("Rate limited by GitHub, retrying in 2s"));
});

test("GitHub 429 retries until x-ratelimit-reset when Retry-After is absent", async (t) => {
	const sleeps: number[] = [];
	let calls = 0;
	const reset = Math.ceil(Date.now() / 1000) + 2;
	mockFetch(t, () => {
		calls += 1;
		return calls === 1
			? new Response("rate limited", {
					status: 429,
					headers: { "x-ratelimit-reset": String(reset) },
				})
			: userResponse();
	});
	const { ctx } = makeCtx((ms) => sleeps.push(ms));

	await collectUser(ctx);

	assert.equal(calls, 2);
	assert.equal(sleeps.length, 1);
	assert.ok((sleeps[0] ?? 0) >= 1000 && (sleeps[0] ?? Infinity) <= 3000);
});

test("GitHub headerless secondary 403 uses jittered exponential backoff", async (t) => {
	const sleeps: number[] = [];
	let calls = 0;
	mockFetch(t, () => {
		calls += 1;
		return calls === 1
			? new Response(
					JSON.stringify({
						message: "You have exceeded a secondary rate limit",
					}),
					{ status: 403 },
				)
			: userResponse();
	});
	const { ctx } = makeCtx((ms) => sleeps.push(ms));

	await collectUser(ctx);

	assert.equal(calls, 2);
	assert.ok((sleeps[0] ?? 0) >= 30_000);
});

test("GitHub 403 Retry-After is sufficient rate-limit evidence", async (t) => {
	const sleeps: number[] = [];
	let calls = 0;
	mockFetch(t, () => {
		calls += 1;
		return calls === 1
			? new Response("request burst", {
					status: 403,
					headers: { "Retry-After": "3" },
				})
			: userResponse();
	});
	const { ctx } = makeCtx((ms) => sleeps.push(ms));

	await collectUser(ctx);

	assert.equal(calls, 2);
	assert.deepEqual(sleeps, [3000]);
});

test("GitHub prefers Retry-After over x-ratelimit-reset", async (t) => {
	const sleeps: number[] = [];
	let calls = 0;
	mockFetch(t, () => {
		calls += 1;
		return calls === 1
			? new Response("rate limited", {
					status: 429,
					headers: {
						"Retry-After": "2",
						"x-ratelimit-reset": String(Math.ceil(Date.now() / 1000) + 100),
					},
				})
			: userResponse();
	});
	const { ctx } = makeCtx((ms) => sleeps.push(ms));

	await collectUser(ctx);

	assert.deepEqual(sleeps, [2000]);
});

test("GitHub honors Retry-After values above the exponential cap", async (t) => {
	const sleeps: number[] = [];
	let calls = 0;
	mockFetch(t, () => {
		calls += 1;
		return calls === 1
			? new Response("rate limited", {
					status: 429,
					headers: { "Retry-After": "3600" },
				})
			: userResponse();
	});
	const { ctx } = makeCtx((ms) => sleeps.push(ms));

	await collectUser(ctx);

	assert.deepEqual(sleeps, [3_600_000]);
});

test("GitHub secondary 403 uses exponential fallback when reset is not for an empty bucket", async (t) => {
	const sleeps: number[] = [];
	let calls = 0;
	mockFetch(t, () => {
		calls += 1;
		return calls === 1
			? new Response(
					JSON.stringify({
						message: "You have exceeded a secondary rate limit",
					}),
					{
						status: 403,
						headers: {
							"x-ratelimit-remaining": "1",
							"x-ratelimit-reset": String(Math.ceil(Date.now() / 1000) + 1),
						},
					},
				)
			: userResponse();
	});
	const { ctx } = makeCtx((ms) => sleeps.push(ms));

	await collectUser(ctx);

	assert.equal(calls, 2);
	assert.ok((sleeps[0] ?? 0) >= 30_000);
});

test("GitHub 401 fails as auth without retrying", async (t) => {
	let calls = 0;
	mockFetch(t, () => {
		calls += 1;
		return new Response(JSON.stringify({ message: "Bad credentials" }), {
			status: 401,
		});
	});
	const { ctx, progresses } = makeCtx();

	await assert.rejects(() => collectUser(ctx), /github_auth_failed/);
	assert.equal(calls, 1);
	assert.equal(
		progresses.some((message) => message.startsWith("Rate limited by GitHub")),
		false,
	);
});

test("GitHub 403 Bad credentials fails fast as auth", async (t) => {
	let calls = 0;
	mockFetch(t, () => {
		calls += 1;
		return new Response(JSON.stringify({ message: "Bad credentials" }), {
			status: 403,
			headers: { "Retry-After": "2" },
		});
	});
	const { ctx } = makeCtx();

	await assert.rejects(() => collectUser(ctx), /github_auth_failed/);
	assert.equal(calls, 1);
});

test("GitHub pacing enforces a one-second floor across a burst", async (t) => {
	const pacingSleeps: number[] = [];
	let nowMs = 0;
	let calls = 0;
	mockFetch(t, () => {
		calls += 1;
		return userResponse();
	});
	const requested = new Map<string, StreamScope>([["user", { name: "user" }]]);
	const ctx: StreamCtx = {
		emit: async () => undefined,
		emitRecord: async () => undefined,
		httpGovernor: createGithubHttpGovernor({
			now: () => nowMs,
			retrySleep: () => undefined,
			sleep: (ms) => {
				pacingSleeps.push(ms);
				nowMs += ms;
			},
		}),
		progress: async () => undefined,
		requested,
		state: {},
		token: "test-token",
	};

	await Promise.all([collectUser(ctx), collectUser(ctx), collectUser(ctx)]);

	assert.equal(calls, 3);
	assert.ok(
		pacingSleeps.some((ms) => ms >= 1000),
		`expected a pacing wait of at least 1000ms, got ${JSON.stringify(pacingSleeps)}`,
	);
});

test("GitHub secondary-limit exhaustion keeps the observed 403 and stays retryable", async (t) => {
	let calls = 0;
	mockFetch(t, () => {
		calls += 1;
		return new Response(
			JSON.stringify({ message: "You have exceeded a secondary rate limit" }),
			{ status: 403, headers: { "Retry-After": "0" } },
		);
	});
	const { ctx } = makeCtx(() => undefined);

	await assert.rejects(
		() => collectUser(ctx),
		(error: unknown) => {
			assert.ok(error instanceof Error);
			assert.match(
				error.message,
				/^github_http_403: GitHub rate limit exhausted/,
			);
			assert.match(error.message, GITHUB_RETRYABLE_PATTERN);
			return true;
		},
	);
	assert.equal(calls, 4, "the bounded retry policy permits three retries");
});
