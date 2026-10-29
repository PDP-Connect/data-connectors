// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type {
	ChatGptApi,
	ChatGptFetchResult,
	ConversationListItem,
} from "../types.ts";

/** Rows per `/conversations/search` page; the connector's grid. */
export const FAKE_PAGE_SIZE = 30;

export interface PagingApiOptions {
	/** The upstream list, newest first, read afresh on every page request. */
	list: () => readonly ConversationListItem[];
	/** The answer for `/conversation/<id>`; may throw to fail the request. */
	detail: (id: string) => ChatGptFetchResult;
	/**
	 * Called before a list page is served, with the page's cursor. May change the
	 * upstream list (an arrival or an update after earlier pages were read),
	 * throw, or return a response to serve in place of the page.
	 */
	onListPage?: (cursor: number) => ChatGptFetchResult | undefined;
}

/**
 * A fake ChatGPT API whose list pages through `list()` the way the real search
 * does: no snapshot, so a change between two page requests shows in the second.
 */
export function makePagingApi({
	list,
	detail,
	onListPage,
}: PagingApiOptions): ChatGptApi {
	return {
		auth: (): Promise<never> =>
			Promise.reject(new Error("auth not used in fake")),
		fetch: (path: string): Promise<ChatGptFetchResult> => {
			if (path.startsWith("/conversations/search?")) {
				const cursor = Number(
					new URLSearchParams(path.split("?")[1]).get("cursor"),
				);
				let override: ChatGptFetchResult | undefined;
				try {
					override = onListPage?.(cursor);
				} catch (error) {
					return Promise.reject(error);
				}
				if (override) return Promise.resolve(override);
				const rows = list();
				const more = cursor + FAKE_PAGE_SIZE < rows.length;
				return Promise.resolve({
					status: 200,
					json: {
						items: rows.slice(cursor, cursor + FAKE_PAGE_SIZE),
						total: rows.length,
						has_more: more,
						next_cursor: more ? cursor + FAKE_PAGE_SIZE : null,
					},
				});
			}
			try {
				return Promise.resolve(
					detail(decodeURIComponent(path.replace(/^\/conversation\//, ""))),
				);
			} catch (error) {
				return Promise.reject(error);
			}
		},
	};
}
