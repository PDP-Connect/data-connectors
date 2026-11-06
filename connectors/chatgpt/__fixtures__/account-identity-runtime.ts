// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Real protocol runtime and the real `collectChatGpt`, with a synthetic page.
 * No browser or network is opened. The page runs the connector's real auth
 * extraction expression against a synthetic `/api/auth/session` body, so the
 * account id the test sees is the one the extraction code picks. Every backend
 * call answers 404, so the run ends after the account id was reported.
 */

import { runInNewContext } from "node:vm";
import type { Page } from "playwright";
import { runConnector } from "../../../packages/polyfill-connectors/src/connector-runtime.ts";
import {
	CHATGPT_AUTH_EXTRACTION_EXPRESSION,
	collectChatGpt,
} from "../index.ts";
import { validateRecord } from "../schemas.ts";

const SESSION = {
	accessToken: "synthetic-token",
	user: { id: process.env.SYNTHETIC_USER_ID ?? "user-synthetic0001" },
};

const page: Pick<Page, "evaluate" | "goto" | "waitForFunction"> = {
	evaluate: ((fn: unknown, arg?: unknown): Promise<unknown> => {
		if (typeof fn === "function") {
			return Promise.resolve("https://chatgpt.com/");
		}
		if (arg === undefined) {
			return Promise.resolve(
				runInNewContext(CHATGPT_AUTH_EXTRACTION_EXPRESSION, {
					decodeURIComponent,
					document: {
						cookie: "oai-did=synthetic-device",
						getElementById: () => null,
					},
					fetch: () =>
						Promise.resolve({ json: () => Promise.resolve(SESSION), ok: true }),
				}),
			);
		}
		return Promise.resolve({ json: null, status: 404 });
	}) as Page["evaluate"],
	goto: () => Promise.resolve(null),
	waitForFunction: () => Promise.reject(new Error("synthetic page")),
};

runConnector({
	name: "chatgpt",
	validateRecord,
	async collect(ctx) {
		await collectChatGpt({ ...ctx, page: page as Page });
	},
});
