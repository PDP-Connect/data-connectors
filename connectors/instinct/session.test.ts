// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fixturesDir } from "../../packages/polyfill-connectors/src/connector-paths.ts";
import { isConnectorErrorCodeShaped } from "../../packages/polyfill-connectors/src/terminal-error.ts";
import {
	classifySession,
	type EnsureInstinctSessionArgs,
	ensureInstinctSession,
	INSTINCT_AUTH_FAILED,
	INSTINCT_INTERRUPTED,
	makeInstinctGraphql,
	SIGN_IN_URL,
} from "./index.ts";
import type { GraphqlFetchResult } from "./types.ts";

const APP_URL = "https://app.instinct.com/workspace";

async function signedIn(): Promise<GraphqlFetchResult> {
	const json = JSON.parse(
		await readFile(join(fixturesDir("instinct"), "profile.json"), "utf8"),
	) as unknown;
	return { json, status: 200 };
}

const SIGNED_OUT: GraphqlFetchResult = {
	json: { data: { authSession: null } },
	status: 200,
};

interface Harness {
	readonly args: EnsureInstinctSessionArgs;
	readonly assists: string[];
	readonly completions: string[];
	readonly delays: number[];
	readonly gotos: string[];
	readonly reads: () => number;
}

/**
 * A page that records navigation and a GraphQL caller that answers the
 * `authSession` reads in order (the last answer repeats).
 */
function harness(
	answers: readonly GraphqlFetchResult[],
	options: {
		failGoto?: (target: string) => boolean;
		interactive?: boolean;
		url?: string;
	} = {},
): Harness {
	let url = options.url ?? "https://app.instinct.com/vault";
	let reads = 0;
	const gotos: string[] = [];
	const assists: string[] = [];
	const completions: string[] = [];
	const delays: number[] = [];
	const page = {
		goto: (target: string) => {
			gotos.push(target);
			if (options.failGoto?.(target) === true) {
				return Promise.reject(new Error("net::ERR_TIMED_OUT"));
			}
			url = target;
			return Promise.resolve(null);
		},
		url: () => url,
	} as unknown as EnsureInstinctSessionArgs["page"];
	const args: EnsureInstinctSessionArgs = {
		assist: (request) => {
			assists.push(request.message ?? "");
			return Promise.resolve(`assist-${String(assists.length)}`);
		},
		capture: null,
		completeAssistance: (_id, status) => {
			completions.push(status);
			return Promise.resolve();
		},
		graphql: (query) => {
			assert.match(query, /PdppInstinctSession/);
			const answer = answers[Math.min(reads, answers.length - 1)];
			reads += 1;
			assert.ok(answer);
			return Promise.resolve(answer);
		},
		interactive: options.interactive ?? true,
		page,
		sendInteraction: () =>
			Promise.reject(new Error("the streamed handoff must not fall back")),
	};
	return { args, assists, completions, delays, gotos, reads: () => reads };
}

function timings(h: Harness): {
	delay: (ms: number) => Promise<void>;
	probeIntervalMs: number;
} {
	return {
		delay: (ms) => {
			h.delays.push(ms);
			return Promise.resolve();
		},
		probeIntervalMs: 1,
	};
}

test("a signed-in page already on the app is read where it is", async () => {
	const h = harness([await signedIn()]);
	await ensureInstinctSession(h.args, timings(h));
	assert.deepEqual(h.gotos, []);
	assert.deepEqual(h.assists, []);
	assert.equal(h.reads(), 1);
});

test("a page that is not on the app goes there once, then is read", async () => {
	const h = harness([await signedIn()], { url: "about:blank" });
	await ensureInstinctSession(h.args, timings(h));
	assert.deepEqual(h.gotos, [APP_URL]);
});

test("signed out on a manual run: the sign-in page is handed over and readiness never navigates", async () => {
	const h = harness([SIGNED_OUT, SIGNED_OUT, SIGNED_OUT, await signedIn()]);
	await ensureInstinctSession(h.args, timings(h));
	// One move to the sign-in page, then back to the workspace after the
	// person is in. The readiness reads in between move nothing.
	assert.deepEqual(h.gotos, [SIGN_IN_URL, APP_URL]);
	assert.equal(h.assists.length, 1);
	assert.match(String(h.assists[0]), /Sign in to Instinct/);
	assert.deepEqual(h.completions, ["resolved"]);
	assert.equal(new URL(SIGN_IN_URL).pathname, "/signin");
});

test("a 401 is read as signed out and handed over", async () => {
	const h = harness([{ json: null, status: 401 }, await signedIn()]);
	await ensureInstinctSession(h.args, timings(h));
	assert.deepEqual(h.gotos, [SIGN_IN_URL, APP_URL]);
});

test("signed out on a scheduled run throws the bare auth code and opens nothing", async () => {
	const h = harness([SIGNED_OUT], { interactive: false });
	await assert.rejects(ensureInstinctSession(h.args, timings(h)), (error) => {
		assert.ok(error instanceof Error);
		assert.equal(error.message, INSTINCT_AUTH_FAILED);
		return true;
	});
	assert.deepEqual(h.gotos, []);
	assert.deepEqual(h.assists, []);
});

test("no answer three times stops as a bare retryable code, with no handoff", async () => {
	const h = harness([
		{ json: null, status: 503 },
		{ json: null, status: 0 },
		{ invalidJson: true, json: null, status: 200 },
	]);
	await assert.rejects(ensureInstinctSession(h.args, timings(h)), (error) => {
		assert.ok(error instanceof Error);
		assert.equal(error.message, INSTINCT_INTERRUPTED);
		return true;
	});
	assert.equal(h.reads(), 3);
	assert.equal(h.delays.length, 2);
	assert.deepEqual(h.gotos, []);
	assert.deepEqual(h.assists, []);
});

test("a transient answer followed by a signed-in one continues without a handoff", async () => {
	const h = harness([{ json: null, status: 502 }, await signedIn()]);
	await ensureInstinctSession(h.args, timings(h));
	assert.deepEqual(h.gotos, []);
	assert.deepEqual(h.assists, []);
});

test("signed out again after the handoff fails with the bare auth code", async () => {
	// Readiness says signed in once, then the workspace answers signed out.
	const h = harness([SIGNED_OUT, await signedIn(), SIGNED_OUT]);
	await assert.rejects(ensureInstinctSession(h.args, timings(h)), (error) => {
		assert.ok(error instanceof Error);
		assert.equal(error.message, INSTINCT_AUTH_FAILED);
		return true;
	});
});

test("session codes survive the runtime: the whole message is the code", () => {
	assert.ok(isConnectorErrorCodeShaped(INSTINCT_AUTH_FAILED));
	assert.ok(isConnectorErrorCodeShaped(INSTINCT_INTERRUPTED));
});

test("classifySession: only a readable answer without a user is signed out", async () => {
	assert.equal(classifySession(await signedIn()), "signed_in");
	assert.equal(classifySession(SIGNED_OUT), "signed_out");
	assert.equal(classifySession({ json: null, status: 403 }), "signed_out");
	assert.equal(classifySession({ json: null, status: 429 }), "unknown");
	assert.equal(classifySession({ json: "<html>", status: 200 }), "unknown");
	assert.equal(
		classifySession({ invalidJson: true, json: null, status: 200 }),
		"unknown",
	);
});

test("a GraphQL error without a user says nothing about sign-in", () => {
	assert.equal(
		classifySession({
			json: { data: null, errors: [{ message: "internal server error" }] },
			status: 200,
		}),
		"unknown",
	);
	assert.equal(
		classifySession({
			json: {
				data: { authSession: null },
				errors: [{ message: "Unauthenticated", path: ["authSession"] }],
			},
			status: 200,
		}),
		"signed_out",
	);
});

test("an error that only mentions a session is not a sign-out", () => {
	assert.equal(
		classifySession({
			json: {
				data: { authSession: null },
				errors: [{ message: "session service unavailable" }],
			},
			status: 200,
		}),
		"unknown",
	);
});

// ─── Final review (P3) ─────────────────────────────────────────────────────

test("a sign-in page that does not open stops as the bare retryable code", async () => {
	const h = harness([SIGNED_OUT], {
		failGoto: (target) => target === SIGN_IN_URL,
	});
	await assert.rejects(ensureInstinctSession(h.args, timings(h)), (error) => {
		assert.ok(error instanceof Error);
		assert.equal(error.message, INSTINCT_INTERRUPTED);
		return true;
	});
	assert.deepEqual(h.assists, []);
});

test("a sign-in the person never finishes ends as instinct_auth_failed", async () => {
	const h = harness([SIGNED_OUT]);
	await assert.rejects(
		ensureInstinctSession(h.args, { ...timings(h), probeWindowMs: 5 }),
		(error) => {
			assert.ok(error instanceof Error);
			assert.equal(error.message, INSTINCT_AUTH_FAILED);
			return true;
		},
	);
	assert.equal(h.assists.length, 1);
	assert.deepEqual(h.completions, ["escalated"]);
});

test("a page that moves under a GraphQL call reads as a request that did not complete", async () => {
	const moving = makeInstinctGraphql({
		evaluate: () =>
			Promise.reject(
				new Error(
					"page.evaluate: Execution context was destroyed, most likely because of a navigation",
				),
			),
	} as unknown as Parameters<typeof makeInstinctGraphql>[0]);
	assert.deepEqual(await moving("query PdppInstinctSession { a }"), {
		json: null,
		status: 0,
	});
	assert.equal(
		classifySession(await moving("query PdppInstinctSession { a }")),
		"unknown",
	);
	const broken = makeInstinctGraphql({
		evaluate: () => Promise.reject(new TypeError("boom")),
	} as unknown as Parameters<typeof makeInstinctGraphql>[0]);
	await assert.rejects(broken("query PdppInstinctSession { a }"), TypeError);
});
