// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fixturesDir } from "../../packages/polyfill-connectors/src/connector-paths.ts";
import { isConnectorErrorCodeShaped } from "../../packages/polyfill-connectors/src/terminal-error.ts";
import { makeRecordingEmit } from "../../packages/polyfill-connectors/src/test-harness.ts";
import {
	classifySession,
	collectInstinctOnPage,
	type EnsureInstinctSessionArgs,
	ensureInstinctSession,
	type GraphqlEvaluateArgs,
	INSTINCT_AUTH_FAILED,
	INSTINCT_INTERRUPTED,
	type InstinctPageCollectContext,
	makeInstinctGraphql,
	probeInstinctSession,
	SIGN_IN_URL,
} from "./index.ts";
import { validateRecord } from "./schemas.ts";
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

test("on PageShim, an evaluation that answered nothing reads as a request that did not complete", async () => {
	const moving = makeInstinctGraphql({
		evaluate: () =>
			Promise.reject(
				new Error("PageShim evaluation returned an invalid transfer marker"),
			),
	} as unknown as Parameters<typeof makeInstinctGraphql>[0]);
	assert.deepEqual(await moving("query PdppInstinctSession { a }"), {
		json: null,
		status: 0,
	});
	const movedMidTransfer = makeInstinctGraphql({
		evaluate: () =>
			Promise.reject(
				new Error(
					"PageShim evaluation transfer failed: PageShim evaluation chunk exceeded its transfer bound",
				),
			),
	} as unknown as Parameters<typeof makeInstinctGraphql>[0]);
	assert.deepEqual(
		await movedMidTransfer("query PdppInstinctChatHistory { a }"),
		{ json: null, status: 0 },
	);
});

/** A page whose only member is evaluate, answering each GraphQL call. */
function evaluatingPage(
	answer: (args: GraphqlEvaluateArgs) => GraphqlFetchResult | Error,
): {
	readonly page: Pick<Parameters<typeof probeInstinctSession>[0], "evaluate">;
	readonly sent: GraphqlEvaluateArgs[];
} {
	const sent: GraphqlEvaluateArgs[] = [];
	const page = {
		evaluate: (_fn: unknown, args: GraphqlEvaluateArgs) => {
			sent.push(args);
			const result = answer(args);
			return result instanceof Error
				? Promise.reject(result)
				: Promise.resolve(result);
		},
	} as unknown as Parameters<typeof probeInstinctSession>[0];
	return { page, sent };
}

test("probeInstinctSession reads authSession once from the page as it is", async () => {
	const profile = await signedIn();
	const yes = evaluatingPage(() => profile);
	assert.equal(await probeInstinctSession(yes.page), true);
	assert.equal(yes.sent.length, 1);
	assert.equal(yes.sent[0]?.apiUrl, "https://api.instinct.com/-/api/graphql");
	assert.match(yes.sent[0]?.document ?? "", /query PdppInstinctSession/);

	assert.equal(
		await probeInstinctSession(evaluatingPage(() => SIGNED_OUT).page),
		false,
	);
	assert.equal(
		await probeInstinctSession(
			evaluatingPage(() => ({ json: null, status: 403 })).page,
		),
		false,
	);
	// No answer either way is not signed in: the host keeps polling.
	assert.equal(
		await probeInstinctSession(
			evaluatingPage(() => ({ json: null, status: 0 })).page,
		),
		false,
	);
	assert.equal(
		await probeInstinctSession(
			evaluatingPage(
				() =>
					new Error("PageShim evaluation returned an invalid transfer marker"),
			).page,
		),
		false,
	);
	assert.equal(
		await probeInstinctSession(
			evaluatingPage(() => new TypeError("boom")).page,
		),
		false,
	);
});

async function fixtureJson(name: string): Promise<unknown> {
	return JSON.parse(
		await readFile(join(fixturesDir("instinct"), `${name}.json`), "utf8"),
	) as unknown;
}

async function accountPage(): Promise<ReturnType<typeof evaluatingPage>> {
	const answers: Record<string, unknown> = {
		InstinctDevices: await fixtureJson("devices"),
		InstinctProfile: await fixtureJson("profile"),
		InstinctVault: await fixtureJson("vault"),
	};
	return evaluatingPage((args) => {
		const operation = /query Pdpp(\w+)/.exec(args.document)?.[1] ?? "";
		const json = answers[operation];
		return json === undefined
			? new Error(`unexpected operation ${operation}`)
			: { json, status: 200 };
	});
}

const ACCOUNT_STREAMS = ["profile", "devices", "vault_entries"];

function pageContext(
	page: InstinctPageCollectContext["page"],
	harness: ReturnType<typeof makeRecordingEmit>,
	extra: Partial<InstinctPageCollectContext> = {},
): InstinctPageCollectContext {
	return {
		emit: harness.emit,
		emitRecord: harness.emitRecord,
		page,
		progress: () => Promise.resolve(),
		requested: new Map(
			ACCOUNT_STREAMS.map((name) => [name, { name }] as const),
		) as InstinctPageCollectContext["requested"],
		state: {},
		...extra,
	};
}

test("collectInstinctOnPage runs with the PageShim context: no run clock, mode or gap pages", async () => {
	const { page, sent } = await accountPage();
	const harness = makeRecordingEmit(validateRecord);
	const failures: string[] = [];
	const before = Date.now();
	await collectInstinctOnPage(
		pageContext(page, harness, {
			reportStreamFailure: (stream) => {
				failures.push(stream);
				return Promise.resolve();
			},
		}),
	);
	assert.deepEqual(failures, []);
	assert.deepEqual(harness.skipped, []);
	assert.deepEqual(
		[...new Set(harness.emitted.map((record) => record.stream))].sort(),
		[...ACCOUNT_STREAMS].sort(),
	);
	// Without a run clock, only STATE carries the collection time; no record
	// does (Collection Profile 5.2).
	for (const record of harness.emitted) {
		assert.equal("observed_at" in record.data, false, record.stream);
	}
	const state = harness.protocolMessages.find(
		(message) => message.type === "STATE",
	) as { cursor?: { observed_at?: unknown } } | undefined;
	const observed = Date.parse(String(state?.cursor?.observed_at));
	assert.ok(observed >= before - 1000 && observed <= Date.now() + 1000);
	assert.ok(
		sent.every(
			(args) => args.apiUrl === "https://api.instinct.com/-/api/graphql",
		),
	);
});

test("collectInstinctOnPage keeps the desktop run clock in STATE, never in records", async () => {
	const { page } = await accountPage();
	const harness = makeRecordingEmit(validateRecord);
	await collectInstinctOnPage(
		pageContext(page, harness, { emittedAt: "2026-09-22T19:30:00.000Z" }),
	);
	assert.ok(harness.emitted.length > 0);
	for (const record of harness.emitted) {
		assert.equal("observed_at" in record.data, false, record.stream);
	}
	const states = harness.protocolMessages.filter(
		(message) => message.type === "STATE",
	) as Array<{ cursor?: { observed_at?: unknown } }>;
	assert.ok(states.length > 0);
	for (const state of states) {
		assert.equal(state.cursor?.observed_at, "2026-09-22T19:30:00.000Z");
	}
});
