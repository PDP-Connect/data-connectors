// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Test-harness-only adapter for exercising the existing ChatGPT collection
// path under PageShim. This is not part of the connector runtime.
import {
	ChatGptRunBudget,
	createChatGptApi,
	resolveChatGptDetailLaneTuning,
	runConversationsAndMessagesStreams,
} from "../../../connectors/chatgpt/index.ts";
import { validateRecord } from "../../../connectors/chatgpt/schemas.ts";
import { runOnPageShim, type ShimPage } from "../runtime.ts";

declare const PAGESHIM_CONNECTOR_VERSION: string;

const STREAMS = ["conversations", "messages"];
const count = (scope: unknown): number => {
	const records = (scope as { records?: unknown[] } | undefined)?.records;
	return Array.isArray(records) ? records.length : 0;
};

(globalThis as Record<string, unknown>).__pageshimMain = (page: ShimPage) =>
	runOnPageShim(page, {
		platform: "chatgpt",
		scopes: STREAMS.map((stream) => `chatgpt.${stream}`),
		version: PAGESHIM_CONNECTOR_VERSION,
		loginUrl: "https://chatgpt.com/",
		loginMessage: "Sign in to ChatGPT, then return here.",
		validateRecord,
		probe: async (facade) =>
			(await facade.evaluate(
				'fetch("/api/auth/session", { credentials: "include" }).then((r) => r.ok).catch(() => false)',
			)) === true,
		collect: async (ctx) => {
			const api = createChatGptApi({
				page: ctx.page as never,
				capture: null,
				emit: ctx.emit as never,
			});
			await runConversationsAndMessagesStreams(
				{
					api,
					detailGaps: [],
					emit: ctx.emit as never,
					emitRecord: ctx.emitRecord as never,
					isRecordSelected: ctx.isRecordSelected as never,
					preDetailPressure: { rateLimited: 0 },
					progress: ctx.progress as never,
					recoveryOnly: false,
					requested: ctx.requested as never,
					requestDetailGapPage: async () => [],
					runBudget: new ChatGptRunBudget({
						maxFetches: Number.POSITIVE_INFINITY,
						maxWallClockMs: Number.POSITIVE_INFINITY,
					}),
				},
				ctx.state as never,
				{
					detailPacing: {
						tuning: {
							...resolveChatGptDetailLaneTuning(),
							pauseMinMs: 0,
							pauseMaxMs: 0,
						},
						sleep: async () => {},
					},
				},
			);
		},
		toScope: (_stream, records) => ({ records }),
		summarize: (scopes) => {
			const details = Object.fromEntries(
				STREAMS.map((stream) => [stream, count(scopes[`chatgpt.${stream}`])]),
			);
			return {
				count: details.conversations,
				label: details.conversations === 1 ? "conversation" : "conversations",
				details,
			};
		},
	});
