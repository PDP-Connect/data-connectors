// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { runConnector } from "../../../packages/polyfill-connectors/src/connector-runtime.ts";
import { ProviderBudgetController } from "../../../packages/polyfill-connectors/src/provider-budget.ts";
import {
	ChatGptPlannedProviderBudgetDeferredError,
	ChatGptRunBudget,
	runAccountPlanStream,
	runConversationsAndMessagesStreams,
	runCustomInstructionsStream,
	runMemoriesStream,
	runSharedConversationsStream,
	type StreamDeps,
} from "../index.ts";
import { validateRecord } from "../schemas.ts";
import type { ChatGptApi } from "../types.ts";

// Real protocol runtime, synthetic upstream. No browser or network is opened.
runConnector({
	name: "chatgpt",
	validateRecord,
	async collect(ctx) {
		let now = 0;
		const providerBudget = new ProviderBudgetController({
			pacing: { initialIntervalMs: 1234 },
			circuitBreaker: {
				minimumThroughput: 1,
				windowSize: 1,
				resetTimeoutMs: 1000,
				now: () => now,
			},
		});
		const api: ChatGptApi = {
			auth: () => Promise.reject(new Error("unused")),
			async fetch(path) {
				if (path.startsWith("/conversations/search")) {
					const failure = process.env.LISTING_FIXTURE_FAILURE;
					if (failure) {
						throw new Error(
							failure === "auth"
								? "apiFetch got 401 (auth - not retryable)"
								: "fixture programmer error",
						);
					}
					providerBudget.circuitBreaker?.beforeRequest();
					providerBudget.recordFailure();
					const gate = await providerBudget.beforeRequest();
					if (!gate.ok) {
						throw new ChatGptPlannedProviderBudgetDeferredError(
							"fixture circuit_open",
							"circuit_open",
							gate,
						);
					}
					throw new Error("persistent circuit unexpectedly admitted");
				}
				if (path.startsWith("/memories")) {
					return {
						status: 200,
						json: {
							memories: Array.from({ length: 24 }, (_, i) => ({
								id: `memory-${i}`,
								content: "Fixture memory",
							})),
						},
					};
				}
				if (path === "/user_system_messages") {
					return { status: 200, json: { about_user: "Fixture instructions" } };
				}
				if (path.startsWith("/shared_conversations")) {
					return {
						status: 200,
						json: {
							items: Array.from({ length: 33 }, (_, i) => ({
								share_id: `share-${i}`,
								conversation_id: `conversation-${i}`,
								title: "Fixture share",
								create_time: 1_700_000_000,
							})),
						},
					};
				}
				return {
					status: 200,
					json: {
						accounts: {
							default: {
								account: { account_id: "fixture", plan_type: "plus" },
							},
						},
					},
				};
			},
		};
		const deps: StreamDeps = {
			...ctx,
			api,
			providerBudget,
			runBudget: new ChatGptRunBudget({ maxWallClockMs: 60_000, now: () => now }),
			sleep: (ms) => {
				now += ms;
				return Promise.resolve();
			},
			conversationSearchPrefetchPages: 6,
		};
		await runMemoriesStream(deps);
		await runCustomInstructionsStream(deps, ctx.state);
		await runSharedConversationsStream(deps, ctx.state);
		await runAccountPlanStream(deps, ctx.state);
		await runConversationsAndMessagesStreams(deps, ctx.state);
	},
});
