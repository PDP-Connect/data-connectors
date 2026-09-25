// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { Page } from "playwright";
import { z } from "zod";
import { manualBrowserLogin } from "../../packages/polyfill-connectors/src/browser-handoff.ts";
import { probeGitHubBrowserSession } from "./probe.ts";

function handoffPages(readinessPage: Page): Page {
	return {
		context: () => readinessPage.context(),
	} as Page;
}

function readinessPage(navigations: string[], loggedIn: boolean): Page {
	return {
		context: () => ({
			request: {
				get: async (url: string) => {
					navigations.push(url);
					return {
						text: async () =>
							loggedIn
								? '<meta name="user-login" content="sample-user">'
								: "<html></html>",
						dispose: async () => undefined,
					};
				},
			},
		}),
	} as Page;
}

test("GitHub readiness probe uses shared context cookies without navigating the owner page", async () => {
	const requests: string[] = [];
	const completions: string[] = [];
	const page = readinessPage(requests, true);
	const result = await manualBrowserLogin({
		assist: async () => "github_handoff",
		autoProbeIntervalMs: 1,
		autoProbeWindowMs: 50,
		completeAssistance: async (_id, status) => {
			completions.push(status);
		},
		isProbeSuccessful: (ready) => ready,
		message: "Sign in to GitHub in the secure browser.",
		page: handoffPages(page),
		probe: async () => {
			throw new Error("owner page probe is not used by watcher");
		},
		readinessProbe: probeGitHubBrowserSession,
		readinessProbeOnHandoffPage: true,
		sendInteraction: async () => {
			throw new Error("unexpected manual action fallback");
		},
	});
	assert.equal(result, true);
	assert.deepEqual(requests, ["https://github.com/"]);
	assert.deepEqual(completions, ["resolved"]);
});

test("GitHub readiness timeout rejects instead of resolving the handoff as successful", async () => {
	const requests: string[] = [];
	const page = readinessPage(requests, false);
	const login = manualBrowserLogin({
		assist: async () => "github_handoff",
		autoProbeIntervalMs: 1,
		autoProbeWindowMs: 0,
		completeAssistance: async () => {},
		isProbeSuccessful: (ready) => ready,
		message: "Sign in to GitHub in the secure browser.",
		page: handoffPages(page),
		probe: async () => {
			throw new Error("owner page probe is not used by watcher");
		},
		readinessProbe: probeGitHubBrowserSession,
		readinessProbeOnHandoffPage: true,
		sendInteraction: async () => {
			throw new Error("unexpected manual action fallback");
		},
	});
	await assert.rejects(login, /browser_handoff_readiness_timed_out/u);
	assert.deepEqual(requests, ["https://github.com/"]);
});

test("browser profile identity meets the OCI builder key and ID checks", async () => {
	const manifest = z
		.object({
			connector_key: z.string(),
			connector_id: z.string(),
		})
		.parse(
			JSON.parse(
				await readFile(new URL("./manifest.json", import.meta.url), "utf8"),
			),
		);
	assert.match(manifest.connector_key, /^[a-z0-9][a-z0-9-]*$/u);
	assert.ok(manifest.connector_id.endsWith(`/${manifest.connector_key}`));
});
