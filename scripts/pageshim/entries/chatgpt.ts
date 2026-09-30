// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { collectChatGpt } from "../../../connectors/chatgpt/index.ts";
import { validateRecord } from "../../../connectors/chatgpt/schemas.ts";
import { runOnPageShim, type ShimPage } from "../runtime.ts";

declare const PAGESHIM_CONNECTOR_VERSION: string;
declare const PAGESHIM_SINCE_DAYS: number;

const CHATGPT_ORIGIN = "https://chatgpt.com";
const STREAMS = ["conversations", "messages"];
const env = (globalThis as { __pageshimEnv?: Record<string, string> })
	.__pageshimEnv ?? {};

if (env.PDPP_CHATGPT_MAX_DETAIL_FETCHES_PER_RUN !== undefined) {
	process.env.PDPP_CHATGPT_MAX_DETAIL_FETCHES_PER_RUN =
		env.PDPP_CHATGPT_MAX_DETAIL_FETCHES_PER_RUN;
}
if (env.PDPP_CHATGPT_MAX_TAIL_DEFERRAL_GAPS_PER_RUN !== undefined) {
	process.env.PDPP_CHATGPT_MAX_TAIL_DEFERRAL_GAPS_PER_RUN =
		env.PDPP_CHATGPT_MAX_TAIL_DEFERRAL_GAPS_PER_RUN;
}
for (const name of [
	"PDPP_CHATGPT_PACING_INITIAL_INTERVAL_MS",
	"PDPP_CHATGPT_PACING_MIN_INTERVAL_MS",
]) {
	if (env[name] !== undefined) process.env[name] = env[name];
}
process.env.PDPP_CHATGPT_DETAIL_INITIAL_CONCURRENCY = "1";
process.env.PDPP_CHATGPT_DETAIL_MAX_CONCURRENCY = "1";

type Facade = {
	goto: (url: string) => Promise<unknown>;
	evaluate: (code: string) => Promise<unknown>;
};

async function probe(page: Facade): Promise<boolean> {
	const authenticated = await page.evaluate(
		`fetch("${CHATGPT_ORIGIN}/api/auth/session", { credentials: "include" })
			.then((r) => r.ok ? r.json() : null)
			.then((session) => Boolean(session?.accessToken))
			.catch(() => false)`,
	);
	return authenticated === true;
}

const count = (scope: unknown): number => {
	const records = (scope as { records?: unknown[] } | undefined)?.records;
	return Array.isArray(records) ? records.length : 0;
};

(globalThis as Record<string, unknown>).__pageshimMain = (page: ShimPage) =>
	runOnPageShim(page, {
		platform: "chatgpt",
		scopes: STREAMS.map((s) => `chatgpt.${s}`),
		version: PAGESHIM_CONNECTOR_VERSION,
		sinceDays: PAGESHIM_SINCE_DAYS || undefined,
		loginUrl: `${CHATGPT_ORIGIN}/auth/login`,
		loginMessage: "Sign in to ChatGPT, then return here.",
		prepareProbe: async (facade) => {
			await (facade as Facade).goto(`${CHATGPT_ORIGIN}/`);
		},
		validateRecord,
		probe: (facade) => probe(facade as never),
		collect: (ctx) => collectChatGpt(ctx as never),
		toScope: (_stream, records) => ({ records }),
		streamScopeRecords: {
			order: ["messages", "conversations"],
			summarizeCounts: (counts) => {
				const details = Object.fromEntries(
					STREAMS.map((stream) => [stream, counts[stream] ?? 0]),
				);
				const conversations = details.conversations;
				return {
					count: conversations,
					label: conversations === 1 ? "conversation" : "conversations",
					details,
				};
			},
		},
		partialStreamsFromDetailGaps: (streams) =>
			streams.filter((s) => STREAMS.includes(s)),
		summarize: (scopes) => {
			const details = Object.fromEntries(
				STREAMS.map((s) => [s, count(scopes[`chatgpt.${s}`])]),
			);
			const conversations = details.conversations;
			return {
				count: conversations,
				label: conversations === 1 ? "conversation" : "conversations",
				details,
			};
		},
	});
