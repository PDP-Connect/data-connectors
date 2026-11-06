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

/**
 * One session body per `/api/auth/session` read, in order; the last one repeats.
 * `SYNTHETIC_SESSIONS` is a JSON array of bodies. `SYNTHETIC_REVOKED_TOKENS`
 * (a JSON array) makes the backend answer 401 for those tokens; any other token
 * gets one memory named after it, so a test can see which token read data.
 * With neither set, every backend call answers 404.
 */
const SESSIONS: unknown[] = process.env.SYNTHETIC_SESSIONS
	? JSON.parse(process.env.SYNTHETIC_SESSIONS)
	: [
			{
				accessToken: "synthetic-token",
				user: { id: process.env.SYNTHETIC_USER_ID ?? "user-synthetic0001" },
			},
		];
const REVOKED_TOKENS: string[] = process.env.SYNTHETIC_REVOKED_TOKENS
	? JSON.parse(process.env.SYNTHETIC_REVOKED_TOKENS)
	: [];
const SERVES_DATA = process.env.SYNTHETIC_SESSIONS !== undefined;
let sessionReads = 0;
const nextSession = (): unknown =>
	SESSIONS[Math.min(sessionReads++, SESSIONS.length - 1)];

const page: Pick<Page, "evaluate" | "goto" | "waitForFunction"> = {
	evaluate: ((fn: unknown, arg?: unknown): Promise<unknown> => {
		if (typeof fn === "function" && arg === undefined) {
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
						Promise.resolve({
							json: () => Promise.resolve(nextSession()),
							ok: true,
						}),
				}),
			);
		}
		const token = (arg as { auth?: { accessToken?: string } }).auth
			?.accessToken;
		if (token !== undefined && REVOKED_TOKENS.includes(token)) {
			return Promise.resolve({ json: null, status: 401 });
		}
		if (SERVES_DATA && token !== undefined) {
			return Promise.resolve({
				json: { memories: [{ id: `memory-read-with-${token}` }] },
				status: 200,
			});
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
