// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { runOnPageShim, type ShimPage } from "../runtime.ts";

(globalThis as Record<string, unknown>).__pageshimMain = (page: ShimPage) =>
	runOnPageShim(page, {
		platform: "chatgpt",
		scopes: ["chatgpt.messages"],
		version: "test",
		loginUrl: "https://chatgpt.test/login",
		loginMessage: "login",
		validateRecord: () => ({ ok: true, data: {} }) as never,
		probe: async () => true,
		collect: async ({ emit }) => {
			const globals = globalThis as any;
			for (let i = 0; i < 80; i++) {
				const id = `c-${i}`;
				globals.__pdppPageshimSetTimingConversation([id]);
				globals.__pdppPageshimDetailFetched(id, 1, 1);
				globals.__pdppPageshimDetailProcessed(id, 1);
				await emit({
					type: "RECORD",
					stream: "messages",
					data: { conversation_id: id, text: "x".repeat(10001) },
				});
				globals.__pdppPageshimSetTimingConversation(null);
			}
			const id = "large";
			globals.__pdppPageshimSetTimingConversation([id]);
			globals.__pdppPageshimDetailFetched(id, 1, 1);
			globals.__pdppPageshimDetailProcessed(id, 1);
			for (let i = 0; i < 40; i++)
				await emit({
					type: "RECORD",
					stream: "messages",
					data: { conversation_id: id, text: "y".repeat(127990) },
				});
			globals.__pdppPageshimSetTimingConversation(null);
		},
		toScope: (_stream, records) => ({ records }),
		streamScopeRecords: {
			order: ["messages"],
			summarizeCounts: (counts) => ({
				count: counts.messages ?? 0,
				label: "messages",
				details: {},
			}),
		},
		summarize: () => ({ count: 0, label: "messages", details: {} }),
	});
