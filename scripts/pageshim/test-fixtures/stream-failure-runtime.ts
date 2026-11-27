// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
// A conversations stream that fails with no records, reported either as a raw
// portable SKIP_RESULT or through ctx.reportStreamFailure, optionally next to
// a memories stream that completes.
import { runOnPageShim, type ShimPage } from "../runtime.ts";
declare const PAGESHIM_STREAM_FAILURE_MODE: "report" | "skip";
declare const PAGESHIM_STREAM_FAILURE_OPTIONS: { retryable?: boolean; recoveryHint?: { action: string; retryable?: boolean } };
const MESSAGE = "The conversations list failed to load.";
(globalThis as Record<string, unknown>).__pageshimMain = (
	page: ShimPage,
	initialState: Record<string, unknown>,
	supportsState: boolean,
) =>
	runOnPageShim(page, {
		platform: "chatgpt",
		scopes: ["chatgpt.conversations", "chatgpt.memories"],
		version: "1.0.0",
		loginUrl: "https://chatgpt.test/",
		loginMessage: "Sign in",
		validateRecord: () => ({ ok: true, data: {} }) as never,
		probe: async () => true,
		collect: async ({ emit, reportStreamFailure, requested }) => {
			if (requested.has("memories")) {
				await emit({ type: "RECORD", stream: "memories", data: { id: "m1" } });
				await emit({ type: "STATE", stream: "memories", cursor: { done: true } });
			}
			if (PAGESHIM_STREAM_FAILURE_MODE === "report") {
				await reportStreamFailure?.("conversations", MESSAGE, typeof PAGESHIM_STREAM_FAILURE_OPTIONS === "undefined" ? { retryable: true } : PAGESHIM_STREAM_FAILURE_OPTIONS);
				return;
			}
			await emit({
				type: "SKIP_RESULT",
				stream: "conversations",
				reason: "stream_collection_failed",
				message: MESSAGE,
				recovery_hint: { action: "retry_by_runtime", retryable: true },
			});
		},
		toScope: (_stream, records) => ({ records }),
		summarize: (scopes) => ({
			count: Object.values(scopes).reduce(
				(total: number, scope) =>
					total + ((scope as { records?: unknown[] }).records?.length ?? 0),
				0,
			),
			label: "items",
			details: {},
		}),
	}, initialState, supportsState);
