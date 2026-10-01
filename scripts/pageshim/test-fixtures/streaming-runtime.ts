// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { runOnPageShim, type ShimPage } from "../runtime.ts";

declare const PAGESHIM_CONNECTOR_VERSION: string;
declare const PAGESHIM_SYNTHETIC_RECORD_COUNT: number;
declare const PAGESHIM_SWALLOW_EMIT_ERRORS: boolean;
declare const PAGESHIM_SURROGATE_EDGE: boolean;
declare const PAGESHIM_SERIALIZE_ERROR: boolean;
declare const PAGESHIM_PARTIAL_RESULT: boolean;
declare const PAGESHIM_NEGATIVE_HEAP_CONTROL: boolean;
declare const PAGESHIM_EVALUATE_RESULT_MIB: number;
declare const PAGESHIM_SYNTHETIC_RECORD_TEXT_UNITS: number;
declare const PAGESHIM_EMIT_STATE: boolean;

(globalThis as Record<string, unknown>).__pageshimMain = (
	page: ShimPage,
	initialState: Record<string, unknown>,
	supportsState: boolean,
) =>
	runOnPageShim(page, {
		platform: "chatgpt",
		scopes: ["chatgpt.conversations", "chatgpt.messages"],
		version: PAGESHIM_CONNECTOR_VERSION,
		loginUrl: "https://chatgpt.test/login",
		loginMessage: "Sign in, then return here.",
		validateRecord: () => ({ ok: true, data: {} }) as never,
		probe: async () => true,
		collect: async ({ emit, page }) => {
			if (PAGESHIM_NEGATIVE_HEAP_CONTROL) {
				(globalThis as Record<string, unknown>).__pageshimHeapControl =
					Array.from({ length: 5_000_000 }, (_, index) => ({ index }));
			}
			if (PAGESHIM_EVALUATE_RESULT_MIB > 0) {
				const detail = (await (
					page as { evaluate: (fn: () => unknown) => Promise<unknown> }
				).evaluate(() => ({
					conversation: {
						id: "synthetic-60mb-conversation",
						messages: [
							{
								text: "x".repeat(PAGESHIM_EVALUATE_RESULT_MIB * 1024 * 1024),
							},
						],
					},
				}))) as {
					conversation?: { id?: string; messages?: { text?: string }[] };
				};
				await (emit as (value: unknown) => Promise<void>)({
					type: "RECORD",
					stream: "conversations",
					data: {
						id: detail.conversation?.id,
						messageCharacters: detail.conversation?.messages?.[0]?.text?.length,
					},
				});
			}
			const send = async (message: unknown) => {
				if (!PAGESHIM_SWALLOW_EMIT_ERRORS) {
					await (emit as (value: unknown) => Promise<void>)(message);
					return;
				}
				try {
					await (emit as (value: unknown) => Promise<void>)(message);
				} catch {
					// Some connectors isolate record failures and keep collecting.
				}
			};
			for (let i = 0; i < PAGESHIM_SYNTHETIC_RECORD_COUNT; i++) {
				await send({
					type: "RECORD",
					stream: "conversations",
					data: { id: i },
				});
				const messageRecord: Record<string, unknown> = {
					text:
						PAGESHIM_SURROGATE_EDGE && i === 0
							? `${"x".repeat(262_134)}😀z`
							: "x".repeat(PAGESHIM_SYNTHETIC_RECORD_TEXT_UNITS),
				};
				if (PAGESHIM_SERIALIZE_ERROR && i === 1)
					messageRecord.invalid = BigInt(1);
				await send({
					type: "RECORD",
					stream: "messages",
					data: messageRecord,
				});
			}
			if (PAGESHIM_EMIT_STATE)
				void (emit as (value: unknown) => Promise<void>)({
					type: "STATE",
					stream: "conversations",
					cursor: { checkpoint: "synthetic" },
				});
			if (PAGESHIM_PARTIAL_RESULT)
				await send({
					type: "SKIP_RESULT",
					stream: "messages",
					message: "one synthetic record was unavailable",
				});
		},
		toScope: (_stream, records) => ({ records }),
		streamScopeRecords: {
			order: ["messages", "conversations"],
			summarizeCounts: (counts) => {
				const conversations = counts.conversations ?? 0;
				return {
					count: conversations,
					label: conversations === 1 ? "conversation" : "conversations",
					details: { conversations },
				};
			},
		},
		summarize: (scopes) => ({
			count:
				(scopes["chatgpt.conversations"] as { records?: unknown[] })?.records
					?.length ?? 0,
			label: "conversations",
			details: {},
		}),
	}, initialState, supportsState);
