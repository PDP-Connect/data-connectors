// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import type { BrowserContext, Page } from "playwright";
import type { EnsureSessionArgs } from "../../packages/polyfill-connectors/src/session-establish.ts";
import { ensureMetaSession } from "./index.ts";

test("ensureMetaSession: read-only readiness probe stays in the sign-in tab", async () => {
	const gotoUrls: string[] = [];
	const assistanceStatuses: string[] = [];
	let liveSession = false;
	const context = Object.assign({} as BrowserContext, {
		cookies: async () =>
			liveSession ? [{ name: "sessionid", value: "token" }] : [],
		newPage: async () => {
			throw new Error("Meta readiness must stay in the sign-in tab");
		},
	});
	const page = Object.assign({} as Page, {
		context: () => context,
		goto: async (url: string) => {
			gotoUrls.push(url);
			return null;
		},
	});
	const args: EnsureSessionArgs = {
		assist: async () => {
			liveSession = true;
			return "assistance-1";
		},
		capture: null,
		checkpoint: async () => undefined,
		completeAssistance: async (_id, status) => {
			assistanceStatuses.push(status);
		},
		context,
		credentials: {},
		onCredentialSubmit: () => undefined,
		page,
		progress: async () => undefined,
		sendInteraction: async (): Promise<never> => {
			throw new Error("unexpected manual interaction");
		},
	};

	await ensureMetaSession(args);

	assert.deepEqual(assistanceStatuses, ["resolved"]);
	assert.deepEqual(gotoUrls, ["https://www.instagram.com/accounts/login/"]);
});
