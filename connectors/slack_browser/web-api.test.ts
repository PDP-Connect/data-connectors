// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import {
	type Fetcher,
	fakeApiPage,
	jsonResponse,
	withSlackGlobals,
} from "./test-support.ts";
import {
	callSlackInPage,
	createSlackApiClient,
	readSignedInTeams,
	SlackApiError,
	SlackSessionLostError,
} from "./web-api.ts";

const TEAMS = {
	T0123456789: {
		name: "Acme",
		domain: "acme",
		url: "https://acme.slack.com",
		token: "xoxc-test-token",
	},
	T0999999999: {
		name: "Other",
		domain: "other",
		url: "https://other.slack.com",
	},
};

function client(
	fetcher: Fetcher,
	options: {
		maxAttempts?: number;
		sleeps?: number[];
		teams?: typeof TEAMS | Record<string, never>;
		origin?: string;
	} = {},
) {
	const sleeps = options.sleeps ?? [];
	const page = fakeApiPage({
		fetch: fetcher,
		teams: options.teams ?? TEAMS,
		...(options.origin ? { origin: options.origin } : {}),
	});
	return createSlackApiClient(page, {
		maxAttempts: options.maxAttempts ?? 3,
		pauseMs: 350,
		retryBaseMs: 10,
		sleep: async (ms) => {
			sleeps.push(ms);
		},
	});
}

test("a call posts the method's form to /api on app.slack.com with the team's token", async () => {
	const seen: Array<{ body: string; init: RequestInit; url: URL }> = [];
	const api = client(async (url, init) => {
		seen.push({ body: String(init.body), init, url });
		return jsonResponse({ ok: true, user_id: "U0123456789" });
	});
	const answer = await api.call("T0123456789", "auth.test", { foo: "bar" });
	assert.deepEqual(answer, { ok: true, user_id: "U0123456789" });
	const [request] = seen;
	assert.ok(request);
	assert.ok(request.url.pathname === "/api/auth.test");
	assert.equal(request.url.origin, "https://app.slack.com");
	assert.equal(request.init.method, "POST");
	assert.equal(request.init.credentials, "include");
	const form = new URLSearchParams(request.body);
	assert.equal(form.get("token"), "xoxc-test-token");
	assert.equal(form.get("foo"), "bar");
});

test("a team the client has no token for is a lost session, not a network fault", async () => {
	const api = client(async () => jsonResponse({ ok: true }));
	await assert.rejects(
		api.call("T0999999999", "auth.test", {}),
		SlackSessionLostError,
	);
});

test("off app.slack.com nothing is sent and the error is not retried", async () => {
	let calls = 0;
	const sleeps: number[] = [];
	const api = client(
		async () => {
			calls += 1;
			return jsonResponse({ ok: true });
		},
		{ origin: "https://acme.slack.com", sleeps },
	);
	await assert.rejects(
		api.call("T0123456789", "auth.test", {}),
		(error: unknown) =>
			error instanceof SlackApiError &&
			error.reason === "wrong_origin:https://acme.slack.com" &&
			error.retryable === false,
	);
	assert.equal(calls, 0);
	assert.deepEqual(sleeps, []);
});

test("HTTP 429 waits for Retry-After and tries again", async () => {
	let calls = 0;
	const sleeps: number[] = [];
	const api = client(
		async () => {
			calls += 1;
			return calls === 1
				? new Response("", { status: 429, headers: { "retry-after": "7" } })
				: jsonResponse({ ok: true, ok_after: calls });
		},
		{ sleeps },
	);
	assert.deepEqual(await api.call("T0123456789", "users.list", {}), {
		ok: true,
		ok_after: 2,
	});
	assert.deepEqual(sleeps, [8000]);
});

test("a 5xx and a malformed body are retried, then reported as retryable", async () => {
	let calls = 0;
	const sleeps: number[] = [];
	const api = client(
		async () => {
			calls += 1;
			return calls === 1
				? new Response("upstream", { status: 503 })
				: new Response("garbage {", { status: 200 });
		},
		{ maxAttempts: 3, sleeps },
	);
	await assert.rejects(
		api.call("T0123456789", "users.list", {}),
		(error: unknown) =>
			error instanceof SlackApiError &&
			error.retryable === true &&
			error.reason === "bad_json",
	);
	assert.equal(calls, 3);
	assert.deepEqual(sleeps, [10, 20]);
});

test("Slack's own auth errors end the session; a method error is final; ratelimited is retried", async () => {
	const authApi = client(async () =>
		jsonResponse({ ok: false, error: "invalid_auth" }),
	);
	await assert.rejects(
		authApi.call("T0123456789", "auth.test", {}),
		(error: unknown) =>
			error instanceof SlackSessionLostError &&
			error.slackError === "invalid_auth",
	);

	const methodApi = client(async () =>
		jsonResponse({ ok: false, error: "channel_not_found" }),
	);
	await assert.rejects(
		methodApi.call("T0123456789", "conversations.history", { channel: "C1" }),
		(error: unknown) =>
			error instanceof SlackApiError &&
			error.reason === "channel_not_found" &&
			error.retryable === false &&
			error.httpStatus === 200,
	);

	let calls = 0;
	const sleeps: number[] = [];
	const limitedApi = client(
		async () => {
			calls += 1;
			return jsonResponse(
				calls === 1 ? { ok: false, error: "ratelimited" } : { ok: true },
			);
		},
		{ sleeps },
	);
	assert.deepEqual(await limitedApi.call("T0123456789", "users.list", {}), {
		ok: true,
	});
	assert.deepEqual(sleeps, [5000]);
});

test("an answer that is not a Slack envelope fails closed", async () => {
	const api = client(async () => jsonResponse([1, 2, 3]));
	await assert.rejects(
		api.call("T0123456789", "users.list", {}),
		(error: unknown) =>
			error instanceof SlackApiError && error.reason === "unrecognised_answer",
	);
});

test('a JSON answer whose text carries "<html>" is read, not called a challenge', async () => {
	// Someone pasted HTML into a channel: the raw JSON body now contains the
	// substring "<html>". An edge's interstitial is a body that BEGINS with an
	// HTML document; a JSON answer with HTML in its text is parsed normally,
	// because calling it a challenge would abort every stream and send the
	// owner to pass a browser check that does not exist.
	const pasted = {
		ok: true,
		messages: [
			{
				type: "message",
				ts: "1790460000.001100",
				text: '<!doctype html>\n<html lang="en"><body>hi</body></html>',
			},
		],
		has_more: false,
		response_metadata: { next_cursor: "" },
	};
	const api = client(async () => jsonResponse(pasted));
	assert.deepEqual(await api.call("T0123456789", "conversations.history", {}), {
		...pasted,
	});

	// And the interstitial itself — the document in place of the answer — is
	// still the fatal challenge it was.
	const challenged = client(
		async () =>
			new Response("<!doctype html><html><body>cf</body></html>", {
				status: 200,
			}),
	);
	await assert.rejects(
		challenged.call("T0123456789", "conversations.history", {}),
		(error: unknown) =>
			error instanceof SlackApiError &&
			error.reason === "source_auth_or_challenge" &&
			error.retryable === false,
	);
});

test("HTTP 401 is a lost session", async () => {
	const api = client(async () => new Response("", { status: 401 }));
	await assert.rejects(
		api.call("T0123456789", "users.list", {}),
		SlackSessionLostError,
	);
});

test("every call after the first pauses", async () => {
	const sleeps: number[] = [];
	const api = client(async () => jsonResponse({ ok: true }), { sleeps });
	await api.call("T0123456789", "auth.test", {});
	assert.deepEqual(sleeps, []);
	await api.call("T0123456789", "auth.test", {});
	assert.deepEqual(sleeps, [350]);
});

test("call starts are paced across lanes: concurrent calls queue on one pause, not one each", async () => {
	let evaluated = 0;
	const page = {
		evaluate: async () => {
			evaluated += 1;
			return {
				kind: "http",
				status: 200,
				retryAfterSeconds: null,
				body: JSON.stringify({ ok: true }),
			};
		},
	} as unknown as Parameters<typeof createSlackApiClient>[0];
	const sleeps: number[] = [];
	const wakes: Array<() => void> = [];
	const api = createSlackApiClient(page, {
		pauseMs: 1000,
		sleep: (ms) =>
			new Promise<void>((resolve) => {
				sleeps.push(ms);
				wakes.push(resolve);
			}),
	});
	const flush = () => new Promise((resolve) => setImmediate(resolve));
	const calls = [1, 2, 3].map(() => api.call("T0123456789", "auth.test", {}));
	await flush();
	// Three lanes asked at once: the first starts, the second waits one
	// pause, and the third waits behind the second instead of pausing beside it.
	assert.equal(evaluated, 1);
	assert.deepEqual(sleeps, [1000]);
	wakes.shift()?.();
	await flush();
	assert.equal(evaluated, 2);
	assert.deepEqual(sleeps, [1000, 1000]);
	wakes.shift()?.();
	await Promise.all(calls);
	assert.equal(evaluated, 3);
});

test("the in-page call reports an evaluate failure as a network error", async () => {
	const page = {
		evaluate: async () => {
			throw new Error("Execution context was destroyed");
		},
	} as unknown as Parameters<typeof callSlackInPage>[0];
	const outcome = await callSlackInPage(page, "T0123456789", "auth.test", {});
	assert.equal(outcome.kind, "network_error");
});

test("readSignedInTeams lists only teams the client holds a token for, and never the token", async () => {
	const page = fakeApiPage({
		fetch: async () => jsonResponse({}),
		teams: TEAMS,
	});
	assert.deepEqual(await readSignedInTeams(page), [
		{
			id: "T0123456789",
			name: "Acme",
			domain: "acme",
			url: "https://acme.slack.com/",
		},
	]);
	const elsewhere = fakeApiPage({
		fetch: async () => jsonResponse({}),
		origin: "https://acme.slack.com",
		teams: TEAMS,
	});
	assert.deepEqual(await readSignedInTeams(elsewhere), []);
});

test("withSlackGlobals restores the process globals", async () => {
	const before = globalThis.fetch;
	await withSlackGlobals({ fetch: async () => jsonResponse({}) }, async () => {
		assert.notEqual(globalThis.fetch, before);
	});
	assert.equal(globalThis.fetch, before);
});
