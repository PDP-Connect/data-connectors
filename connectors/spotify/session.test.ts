// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import type { BrowserContext, Page } from "playwright";
import { assertUserFacingProgress } from "../../packages/polyfill-connectors/src/connector-diagnostic.ts";
import type { EnsureSessionArgs } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import {
	ensureSpotifySession,
	hasSpotifySession,
	probeSpotifySession,
	spotifyAllowsInteractiveSignIn,
	spotifyRetryablePattern,
} from "./index.ts";

/** What one token request gets back: a body, an HTTP status, or a failure. */
type TokenAnswer =
	| "signed_in"
	| "anonymous"
	| "empty_body"
	| "invalid_json"
	| "timeout"
	| number;

interface Calls {
	assist: unknown[];
	completed: [string, string][];
	/** How many completions had been reported when each token request arrived. */
	completedAtTokenRequest: number[];
	navigations: string[];
	progress: string[];
	tokenRequests: number;
}

type TestArgs = EnsureSessionArgs & {
	autoProbeIntervalMs?: number;
	autoProbeWindowMs?: number;
	now?: () => number;
};

function tokenResponse(answer: TokenAnswer): {
	dispose: () => Promise<undefined>;
	json: () => Promise<unknown>;
	ok: () => boolean;
} {
	const status = typeof answer === "number" ? answer : 200;
	const body = (): unknown => {
		switch (answer) {
			case "signed_in":
				return { accessToken: "fixture-token", isAnonymous: false };
			case "anonymous":
				return { accessToken: "anonymous-token", isAnonymous: true };
			case "invalid_json":
				throw new SyntaxError("Unexpected token < in JSON at position 0");
			default:
				return {};
		}
	};
	return {
		dispose: async () => undefined,
		json: async () => body(),
		ok: () => status < 400,
	};
}

/**
 * A Spotify page whose token endpoint answers from `answers`, one entry per
 * token request, the last entry repeating. Navigating only records the visit:
 * the owner "signs in" when the answers change, so a test decides how many
 * checks happen before that.
 */
function makeSession(...answers: TokenAnswer[]): {
	args: TestArgs;
	calls: Calls;
} {
	const calls: Calls = {
		assist: [],
		completed: [],
		completedAtTokenRequest: [],
		navigations: [],
		progress: [],
		tokenRequests: 0,
	};
	const page = {
		context: () => ({
			request: {
				get: async (url: string) => {
					if (url.endsWith("/api/server-time")) {
						return {
							dispose: async () => undefined,
							json: async () => ({ serverTime: 1_700_000_000 }),
							ok: () => true,
						};
					}
					const answer =
						answers[Math.min(calls.tokenRequests, answers.length - 1)];
					calls.tokenRequests += 1;
					calls.completedAtTokenRequest.push(calls.completed.length);
					if (answer === "timeout") {
						throw new Error("Timeout 10000ms exceeded.");
					}
					return tokenResponse(answer ?? "anonymous");
				},
			},
		}),
		goto: async (url: string) => {
			calls.navigations.push(url);
		},
	} as unknown as Page;
	const args = {
		assist: async (request: unknown) => {
			calls.assist.push(request);
			return "assist-1";
		},
		capture: null,
		checkpoint: async () => undefined,
		completeAssistance: async (id: string, status: string) => {
			calls.completed.push([id, status]);
		},
		context: {} as BrowserContext,
		credentials: {},
		onCredentialSubmit: () => undefined,
		page,
		progress: async (message: string) => {
			calls.progress.push(message);
		},
		sendInteraction: async () => {
			throw new Error("the sign-in handoff must not use an interaction");
		},
	} as unknown as TestArgs;
	return { args, calls };
}

/** Poll without waiting and without a window that could expire. */
const patientOwner = {
	autoProbeIntervalMs: 0,
	autoProbeWindowMs: 10_000,
	now: () => 0,
};

test("only a manual run, or one with no trigger metadata, may open the sign-in handoff", () => {
	assert.equal(spotifyAllowsInteractiveSignIn({}), true);
	assert.equal(
		spotifyAllowsInteractiveSignIn({ PDPP_RUN_TRIGGER_KIND: "" }),
		true,
	);
	assert.equal(
		spotifyAllowsInteractiveSignIn({ PDPP_RUN_TRIGGER_KIND: "  " }),
		true,
	);
	assert.equal(
		spotifyAllowsInteractiveSignIn({ PDPP_RUN_TRIGGER_KIND: " manual " }),
		true,
	);
	for (const trigger of ["scheduled", "retry", "webhook", "unknown"]) {
		assert.equal(
			spotifyAllowsInteractiveSignIn({ PDPP_RUN_TRIGGER_KIND: trigger }),
			false,
			trigger,
		);
	}
});

for (const [label, answers, expected] of [
	["a token for a signed-in account", ["signed_in"], "signed_in"],
	["an anonymous token", ["anonymous"], "anonymous"],
	["HTTP 429", [429], "inconclusive"],
	["HTTP 503", [503], "inconclusive"],
	["a request timeout", ["timeout"], "inconclusive"],
	["a body that is not JSON", ["invalid_json"], "inconclusive"],
	[
		"a body with neither a token nor an anonymous flag",
		["empty_body"],
		"inconclusive",
	],
] as const) {
	test(`the session probe reads ${label} as ${expected}`, async () => {
		const { args } = makeSession(...answers);
		assert.equal(await probeSpotifySession(args.page), expected);
		assert.equal(await hasSpotifySession(args.page), expected === "signed_in");
	});
}

test("a live session needs no sign-in, whatever started the run", async () => {
	const { args, calls } = makeSession("signed_in");
	await ensureSpotifySession(args, { PDPP_RUN_TRIGGER_KIND: "scheduled" });
	assert.deepEqual(calls, {
		assist: [],
		completed: [],
		completedAtTokenRequest: [0],
		navigations: [],
		progress: [],
		tokenRequests: 1,
	});
});

for (const trigger of ["scheduled", "retry", "webhook"]) {
	test(`a dead session in a ${trigger} run fails at once instead of waiting for an owner`, async () => {
		const { args, calls } = makeSession("anonymous");
		await assert.rejects(
			ensureSpotifySession(args, { PDPP_RUN_TRIGGER_KIND: trigger }),
			{ message: "spotify_session_required" },
		);
		assert.deepEqual(calls.navigations, []);
		assert.deepEqual(calls.assist, []);
		assert.deepEqual(calls.completed, []);
		assert.equal(calls.progress.length, 1);
		assert.match(calls.progress[0] ?? "", /sign in/u);
		assertUserFacingProgress([
			{ type: "PROGRESS", message: calls.progress[0] },
		]);
	});
}

for (const [label, answer] of [
	["a request timeout", "timeout"],
	["HTTP 429", 429],
	["HTTP 503", 503],
	["a body that is not JSON", "invalid_json"],
] as const) {
	test(`${label} while checking an unattended run's session is a retry, not a request to sign in`, async () => {
		const { args, calls } = makeSession(answer);
		await assert.rejects(
			ensureSpotifySession(args, { PDPP_RUN_TRIGGER_KIND: "scheduled" }),
			{ message: "spotify_session_check_inconclusive" },
		);
		assert.deepEqual(calls.navigations, []);
		assert.deepEqual(calls.assist, []);
		assert.deepEqual(calls.completed, []);
		assert.equal(calls.progress.length, 1);
		assert.doesNotMatch(calls.progress[0] ?? "", /sign in/iu);
		assertUserFacingProgress([
			{ type: "PROGRESS", message: calls.progress[0] },
		]);
	});
}

test("only a confirmed dead session is terminal for the scheduler", () => {
	assert.equal(
		spotifyRetryablePattern.test(
			"spotify_session_failed: spotify_session_required",
		),
		false,
	);
	assert.equal(
		spotifyRetryablePattern.test(
			"spotify_session_failed: spotify_session_check_inconclusive",
		),
		true,
	);
});

for (const [label, env] of [
	["manual", { PDPP_RUN_TRIGGER_KIND: "manual" }],
	["locally started", {}],
] as const) {
	test(`a dead session in a ${label} run asks the owner to sign in and waits until the session is live`, async () => {
		// The first check and the next three polls of the handoff page still see
		// an anonymous session; the owner finishes on the fifth.
		const { args, calls } = makeSession(
			"anonymous",
			"anonymous",
			"anonymous",
			"anonymous",
			"signed_in",
		);
		await ensureSpotifySession({ ...args, ...patientOwner }, env);
		assert.equal(calls.navigations.length, 1);
		assert.match(
			calls.navigations[0] ?? "",
			/^https:\/\/accounts\.spotify\.com\//u,
		);
		assert.deepEqual(calls.progress, ["Waiting for you to sign in to Spotify"]);
		assertUserFacingProgress(
			calls.progress.map((message) => ({ type: "PROGRESS", message })),
		);
		assert.equal(calls.assist.length, 1);
		assert.deepEqual(calls.assist[0], {
			attachments: [{ kind: "browser_surface", role: "streaming_companion" }],
			message:
				"Sign in to Spotify in the secure browser, then continue. PDPP will verify the session before collecting.",
			owner_action: "operate_attachment",
			progress_posture: "blocked",
			response_contract: "none",
			timeout_seconds: 1800,
		});
		assert.equal(calls.tokenRequests, 5, "it kept checking until sign-in");
		assert.deepEqual(
			calls.completedAtTokenRequest,
			[0, 0, 0, 0, 0],
			"nothing was reported done while the session was still anonymous",
		);
		assert.deepEqual(calls.completed, [["assist-1", "resolved"]]);
	});
}

test("a manual run whose first check is inconclusive still hands the browser to the owner", async () => {
	const { args, calls } = makeSession(503, "signed_in");
	await ensureSpotifySession(
		{ ...args, ...patientOwner },
		{ PDPP_RUN_TRIGGER_KIND: "manual" },
	);
	assert.equal(calls.navigations.length, 1);
	assert.equal(calls.assist.length, 1);
	assert.deepEqual(calls.completed, [["assist-1", "resolved"]]);
});

test("an owner who never signs in ends the handoff without a success", async () => {
	const { args, calls } = makeSession("anonymous");
	let tick = 0;
	await assert.rejects(
		ensureSpotifySession(
			{
				...args,
				autoProbeIntervalMs: 0,
				autoProbeWindowMs: 3,
				now: () => tick++,
			},
			{ PDPP_RUN_TRIGGER_KIND: "manual" },
		),
		{ code: "browser_handoff_readiness_timed_out" },
	);
	assert.equal(calls.assist.length, 1);
	assert.ok(calls.tokenRequests > 2, "the handoff page was checked repeatedly");
	assert.deepEqual(calls.completed, [["assist-1", "escalated"]]);
});
