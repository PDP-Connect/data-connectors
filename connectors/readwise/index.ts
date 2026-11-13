#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Readwise v2 official API only; never starts a Kindle import/sync.
 * Full bounded snapshots of Kindle books selected by the provider's source field.
 * GET books (20/min limit) then GET export for those ids (240/min base limit).
 * Requests are paced at 3.1s, never retried; failed pages emit no checkpoint.
 * No inferred tombstones: missing books/highlights are not evidence of deletion.
 */
import { setTimeout as delay } from "node:timers/promises";
import { isMainModule } from "@pdpp/connector-protocol";
import {
	type CollectContext,
	runConnector,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { booksPage, exportPage, kindleHighlightsRecord } from "./parsers.ts";
import { validateRecord } from "./schemas.ts";

const ORIGIN = "https://readwise.io";
const MAX_PAGES = 100;
const MAX_BOOKS = 1000;
const MAX_RECORDS = 100000;
/** Dependencies keep fixture runs offline, including pacing. */
export interface ReadwiseDeps {
	fetch: typeof fetch;
	pause: () => Promise<void>;
}
const live: ReadwiseDeps = { fetch, pause: () => delay(3100) };

/** Only known API paths may receive the credential; redirect responses are refused. */
function checkedUrl(value: string, pathname: string): URL {
	const url = new URL(value, ORIGIN);
	if (
		url.origin !== ORIGIN ||
		url.pathname !== pathname ||
		url.username ||
		url.password
	) {
		throw new Error("readwise_unsafe_pagination_url");
	}
	return url;
}

/** Collect a full Kindle-only snapshot; commit a receipt only after natural pagination end. */
export async function collectReadwise(
	ctx: CollectContext,
	deps: ReadwiseDeps = live,
): Promise<void> {
	if (!ctx.requested.has("kindle_highlights")) return;
	const token = ctx.credentials.READWISE_API_TOKEN;
	if (!token) throw new Error("readwise_auth_failed");
	let requests = 0;
	async function get(url: URL): Promise<unknown> {
		requests += 1;
		if (requests > MAX_PAGES)
			throw new Error("readwise_request_bound_exceeded");
		if (requests > 1) await deps.pause();
		const response = await deps.fetch(url, {
			headers: { Authorization: `Token ${token}`, Accept: "application/json" },
			redirect: "error",
			signal: AbortSignal.timeout(30000),
		});
		if (response.status === 401) throw new Error("readwise_auth_failed");
		if (response.status === 403)
			throw new Error("readwise_access_denied_check_subscription");
		if (response.status === 429)
			throw new Error("readwise_rate_limited_try_later");
		if (!response.ok) throw new Error(`readwise_http_${response.status}`);
		if (!response.body) throw new Error("readwise_empty_body");
		const reader = response.body.getReader();
		const chunks: Uint8Array[] = [];
		let size = 0;
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) break;
			size += chunk.value.byteLength;
			if (size > 32 * 1024 * 1024) {
				await reader.cancel();
				throw new Error("readwise_response_bound_exceeded");
			}
			chunks.push(chunk.value);
		}
		const body = Buffer.concat(chunks).toString("utf8");
		try {
			return JSON.parse(body);
		} catch {
			throw new Error("readwise_invalid_json");
		}
	}
	const ids = new Set<number>();
	const expectedHighlights = new Map<number, number>();
	const activeHighlights = new Map<number, Set<number>>();
	const seen = new Set<string>();
	let url: URL | null = new URL(
		"/api/v2/books/?category=books&source=kindle&page_size=1000",
		ORIGIN,
	);
	let expected: number | undefined;
	while (url) {
		if (seen.has(url.href)) throw new Error("readwise_pagination_cycle");
		seen.add(url.href);
		const page = booksPage.parse(await get(url));
		expected ??= page.count;
		if (page.count !== expected)
			throw new Error("readwise_books_changed_during_snapshot");
		for (const book of page.results) {
			if (book.source !== "kindle" || book.category !== "books")
				throw new Error("readwise_scope_mismatch");
			ids.add(book.id);
			expectedHighlights.set(book.id, book.num_highlights);
		}
		if (ids.size > MAX_BOOKS) throw new Error("readwise_book_bound_exceeded");
		url = page.next ? checkedUrl(page.next, "/api/v2/books/") : null;
	}
	if (ids.size !== expected)
		throw new Error("readwise_incomplete_book_listing");
	let records = 0;
	const returned = new Set<number>();
	// Batches keep request URLs short, while the ids filter avoids collecting articles/tweets.
	const allIds = [...ids];
	for (let offset = 0; offset < allIds.length; offset += 100) {
		const batch = allIds.slice(offset, offset + 100);
		const cursors = new Set<string>();
		let cursor: string | null = null;
		do {
			const endpoint = new URL("/api/v2/export/", ORIGIN);
			endpoint.searchParams.set("ids", batch.join(","));
			endpoint.searchParams.set("includeDeleted", "true");
			if (cursor) endpoint.searchParams.set("pageCursor", cursor);
			const page = exportPage.parse(await get(endpoint));
			for (const book of page.results) {
				if (
					!batch.includes(book.user_book_id) ||
					book.source !== "kindle" ||
					book.category !== "books"
				) {
					throw new Error("readwise_scope_mismatch");
				}
				returned.add(book.user_book_id);
				for (const h of book.highlights) {
					if (!book.is_deleted && !h.is_deleted) {
						let active = activeHighlights.get(book.user_book_id);
						if (!active) {
							active = new Set<number>();
							activeHighlights.set(book.user_book_id, active);
						}
						active.add(h.id);
					}
					records += 1;
					if (records > MAX_RECORDS)
						throw new Error("readwise_record_bound_exceeded");
					await ctx.emitRecord(
						"kindle_highlights",
						kindleHighlightsRecord(book, h),
					);
				}
			}
			cursor = page.nextPageCursor;
			if (cursor) {
				if (cursors.has(cursor)) throw new Error("readwise_pagination_cycle");
				cursors.add(cursor);
			}
		} while (cursor);
	}
	// An expired trial or truncated export must not be mistaken for a complete snapshot.
	for (const [id, expectedCount] of expectedHighlights) {
		if ((activeHighlights.get(id)?.size ?? 0) !== expectedCount) {
			throw new Error("readwise_incomplete_highlight_export");
		}
	}
	await ctx.progress(
		`Read ${records} Kindle highlight records from ${returned.size} books`,
		{ stream: "kindle_highlights" },
	);
	await ctx.emit({
		type: "STATE",
		stream: "kindle_highlights",
		cursor: {
			snapshot_completed_at: ctx.emittedAt,
			listed_books: ids.size,
			returned_books: returned.size,
			records_read: records,
		},
	});
}
if (isMainModule(import.meta.url)) {
	runConnector({
		name: "readwise",
		auth: { kind: "env", required: ["READWISE_API_TOKEN"] },
		validateRecord,
		isTombstone: (_stream, data) => data.deleted === true,
		collect: collectReadwise,
	});
}
