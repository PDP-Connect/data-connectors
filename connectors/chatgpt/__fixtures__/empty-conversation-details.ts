// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { ChatGptApi, ChatGptFetchResult } from "../types.ts";

const DETAIL_PATH = "/conversation/";

/** The detail of a conversation with no messages, for a `/conversation/<id>` path. */
export function emptyConversationDetail(path: string): ChatGptFetchResult {
	const id = decodeURIComponent(path.slice(DETAIL_PATH.length));
	return { status: 200, json: { id, mapping: {}, current_node: null } };
}

/**
 * The detail of a conversation with one user message: a read that settles the
 * conversation, for a listing test that follows a cursor across runs and so
 * must not have every row held back as unread.
 */
export function readConversationDetail(path: string): ChatGptFetchResult {
	const id = decodeURIComponent(path.slice(DETAIL_PATH.length));
	return {
		status: 200,
		json: {
			id,
			conversation_id: id,
			current_node: `${id}-m0`,
			mapping: {
				[`${id}-root`]: {
					id: `${id}-root`,
					parent: null,
					children: [`${id}-m0`],
				},
				[`${id}-m0`]: {
					id: `${id}-m0`,
					parent: `${id}-root`,
					children: [],
					message: {
						id: `${id}-m0`,
						author: { role: "user" },
						content: { content_type: "text", parts: ["hello"] },
						create_time: 1_700_000_000,
						metadata: {},
					},
				},
			},
		},
	};
}

/**
 * A listing test asks for `conversations` and serves only list pages. The
 * connector also reads each conversation's detail for that stream, so a detail
 * path the test does not serve (a 404, or a fake that throws on a path it does
 * not know) would fail the run. This answers such a detail path with an empty
 * detail (no messages). Every other path, and a detail the test serves itself,
 * stays as the test wrote it.
 */
export function withEmptyConversationDetails(api: ChatGptApi): ChatGptApi {
	return {
		...api,
		fetch: async (path, options): Promise<ChatGptFetchResult> => {
			if (!path.startsWith(DETAIL_PATH)) return api.fetch(path, options);
			const empty = emptyConversationDetail(path);
			try {
				const result = await api.fetch(path, options);
				return result.status === 404 ? empty : result;
			} catch {
				return empty;
			}
		},
	};
}

/**
 * Detail pacing with no waits, for a listing test over many conversations. The
 * detail lane's launch pause is real time, and these tests list thousands.
 */
export const NO_DETAIL_WAITS = {
	tuning: {
		initialConcurrency: 1,
		maxConcurrency: 1,
		pauseMaxMs: 0,
		pauseMinMs: 0,
	},
	sleep: (): Promise<void> => Promise.resolve(),
} as const;
