// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { runOnPageShim, type ShimPage } from "../runtime.ts";
declare const PAGESHIM_COVERAGE_MESSAGES: { type: string; [key: string]: unknown }[];
declare const PAGESHIM_COVERAGE_THROW: boolean;
declare const PAGESHIM_COVERAGE_RECORD: boolean;
declare const PAGESHIM_COVERAGE_STREAM: boolean;
(globalThis as Record<string, unknown>).__pageshimMain = (page: ShimPage) =>
	runOnPageShim(page, {
		platform: "chatgpt",
		scopes: ["chatgpt.conversations"],
		version: "1.0.0",
		loginUrl: "https://chatgpt.test/",
		loginMessage: "Sign in",
		validateRecord: () => ({ ok: true, data: {} }) as never,
		probe: async () => true,
		collect: async ({ emit }) => {
			if (PAGESHIM_COVERAGE_RECORD)
				await emit({ type: "RECORD", stream: "conversations", data: { id: "one" } });
			for (const message of PAGESHIM_COVERAGE_MESSAGES) await emit(message);
			if (PAGESHIM_COVERAGE_THROW) throw new Error("synthetic network failure");
		},
		toScope: (_stream, records) => ({ records }),
		...(PAGESHIM_COVERAGE_STREAM ? { streamScopeRecords: {
			order: ["conversations"],
			summarizeCounts: (counts: Record<string, number>) => ({
				count: counts.conversations ?? 0, label: "conversations", details: {},
			}),
		} } : {}),
		summarize: (scopes) => ({
			count: (scopes["chatgpt.conversations"] as { records?: unknown[] })?.records?.length ?? 0,
			label: "conversations", details: {},
		}),
	});
