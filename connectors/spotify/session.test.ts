// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import type { BrowserContext, Page } from "playwright";
import { assertUserFacingProgress } from "../../packages/polyfill-connectors/src/connector-diagnostic.ts";
import type { EnsureSessionArgs } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import {
	ensureSpotifySession,
	spotifyAllowsInteractiveSignIn,
	spotifyRetryablePattern,
} from "./index.ts";

interface Calls {
	assist: unknown[];
	completed: [string, string][];
	navigations: string[];
	progress: string[];
}

/** A Spotify page whose token endpoint answers "signed in" once `live` is set.
 *  The login page flips it, which stands in for the owner finishing sign-in. */
function makeSession(live: boolean): {
	args: EnsureSessionArgs;
	calls: Calls;
} {
	const state = { live };
	const calls: Calls = {
		assist: [],
		completed: [],
		navigations: [],
		progress: [],
	};
	const page = {
		context: () => ({
			request: {
				get: async (url: string) => ({
					json: async () =>
						url.endsWith("/api/server-time")
							? { serverTime: 1_700_000_000 }
							: state.live
								? { accessToken: "fixture-token", isAnonymous: false }
								: { isAnonymous: true },
					ok: () => true,
					dispose: async () => undefined,
				}),
			},
		}),
		goto: async (url: string) => {
			calls.navigations.push(url);
			state.live = true;
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
	} as unknown as EnsureSessionArgs;
	return { args, calls };
}

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

test("a live session needs no sign-in, whatever started the run", async () => {
	const { args, calls } = makeSession(true);
	await ensureSpotifySession(args, { PDPP_RUN_TRIGGER_KIND: "scheduled" });
	assert.deepEqual(calls, {
		assist: [],
		completed: [],
		navigations: [],
		progress: [],
	});
});

for (const trigger of ["scheduled", "retry", "webhook"]) {
	test(`a dead session in a ${trigger} run fails at once instead of waiting for an owner`, async () => {
		const { args, calls } = makeSession(false);
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

test("the unattended failure is terminal, so the scheduler does not loop on it", () => {
	assert.equal(
		spotifyRetryablePattern.test(
			"spotify_session_failed: spotify_session_required",
		),
		false,
	);
});

for (const [label, env] of [
	["manual", { PDPP_RUN_TRIGGER_KIND: "manual" }],
	["locally started", {}],
] as const) {
	test(`a dead session in a ${label} run hands the browser to the owner and continues once signed in`, async () => {
		const { args, calls } = makeSession(false);
		await ensureSpotifySession(args, env);
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
		assert.deepEqual(calls.completed, [["assist-1", "resolved"]]);
	});
}
