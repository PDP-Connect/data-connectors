// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { createConnectorFailure } from "../../../packages/polyfill-connectors/src/connector-runtime.ts";
import { runOnPageShim, type ShimPage } from "../runtime.ts";

declare const PAGESHIM_COVERAGE_MESSAGES: {
	type: string;
	[key: string]: unknown;
}[];
declare const PAGESHIM_COVERAGE_THROW: boolean;
declare const PAGESHIM_TERMINAL_CODE: string;
declare const PAGESHIM_COVERAGE_RECORD: boolean;
declare const PAGESHIM_COVERAGE_STREAM: boolean;
declare const PAGESHIM_COVERAGE_RANGE_MODE: string;
const rangeMode =
	typeof PAGESHIM_COVERAGE_RANGE_MODE === "string"
		? PAGESHIM_COVERAGE_RANGE_MODE
		: null;
(globalThis as Record<string, unknown>).__pageshimMain = (
	page: ShimPage,
	initialState: Record<string, unknown>,
	supportsState: boolean,
) =>
	runOnPageShim(
		page,
		{
			platform: "chatgpt",
			scopes: ["chatgpt.conversations", "chatgpt.memories"],
			version: "1.0.0",
			loginUrl: "https://chatgpt.test/",
			loginMessage: "Sign in",
			validateRecord: (_stream, data) =>
				({ ok: true, data: rangeMode ? data : {} }) as never,
			prepareRequested: (requested) => {
				if (rangeMode === "bounded") {
					const conversation = requested.get("conversations");
					if (!conversation)
						throw new Error("Missing requested conversation stream");
					Object.assign(conversation, {
						time_range: { until: "2026-10-22T00:00:00.000Z" },
					});
				}
			},
			probe: async () => true,
			collect: async ({ emit, emitRecord }) => {
				if (rangeMode) {
					await emitRecord("conversations", {
						id: "retained",
						update_time: "2026-10-21T00:00:00.000Z",
					});
					await emit({
						type: "STATE",
						stream: "conversations",
						cursor: { checkpoint: "candidate" },
					});
					await emitRecord("conversations", {
						id: "filtered",
						update_time: "2026-10-22T00:00:00.000Z",
					});
					return;
				}
				if (PAGESHIM_COVERAGE_RECORD)
					await emit({
						type: "RECORD",
						stream: "conversations",
						data: { id: "one" },
					});
				for (const message of PAGESHIM_COVERAGE_MESSAGES) await emit(message);
				if (typeof PAGESHIM_TERMINAL_CODE === "string")
					throw createConnectorFailure(
						PAGESHIM_TERMINAL_CODE,
						"Authentication rejected.",
						{
							retryable: false,
							recoveryHint: {
								action: "manual_action_required",
								retryable: false,
							},
						},
					);
				if (PAGESHIM_COVERAGE_THROW)
					throw new Error("synthetic network failure");
			},
			toScope: (_stream, records) => ({ records }),
			...(PAGESHIM_COVERAGE_STREAM
				? {
						streamScopeRecords: {
							order: ["conversations"],
							summarizeCounts: (counts: Record<string, number>) => ({
								count: counts.conversations ?? 0,
								label: "conversations",
								details: {},
							}),
						},
					}
				: {}),
			summarize: (scopes) => ({
				count:
					(scopes["chatgpt.conversations"] as { records?: unknown[] })?.records
						?.length ?? 0,
				label: "conversations",
				details: {},
			}),
		},
		initialState,
		supportsState,
	);
