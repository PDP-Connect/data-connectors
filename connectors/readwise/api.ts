// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Readwise Highlight EXPORT API: types, record builders and the page fetch.
 * Kept free of runConnector so tests can import it.
 * Docs: https://readwise.io/api_deets
 */

import { RetryExhaustedError } from "@pdpp/connector-protocol/http-retry";
import { z } from "zod";
import {
	ConnectorRateLimitedError,
	createConnectorHttpGovernor,
} from "../../packages/polyfill-connectors/src/connector-http-governor.ts";
import type { RecordData } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { encodeText, TEXT_ENCODING } from "./text.ts";

export const EXPORT_URL = "https://readwise.io/api/v2/export/";
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const id = z.number().int().positive().safe();
const maybeText = z.string().nullish();
const tag = z.object({ id: id.optional(), name: z.string().optional() });
const highlight = z.object({
	id,
	book_id: id.optional(),
	color: maybeText,
	created_at: maybeText,
	end_location: z.number().nullish(),
	highlighted_at: maybeText,
	is_deleted: z.boolean().optional(),
	is_discard: z.boolean().optional(),
	is_favorite: z.boolean().optional(),
	location: z.number().nullish(),
	location_type: maybeText,
	note: maybeText,
	readwise_url: maybeText,
	tags: z.array(tag).optional(),
	text: maybeText,
	updated_at: maybeText,
	url: maybeText,
});
const book = z.object({
	user_book_id: id,
	asin: maybeText,
	author: maybeText,
	book_tags: z.array(tag).optional(),
	category: maybeText,
	cover_image_url: maybeText,
	document_note: maybeText,
	highlights: z.array(highlight),
	is_deleted: z.boolean().optional(),
	readable_title: maybeText,
	readwise_url: maybeText,
	source: maybeText,
	source_url: maybeText,
	summary: maybeText,
	title: maybeText,
	unique_url: maybeText,
});
const exportPage = z.object({
	nextPageCursor: z
		.union([z.string().min(1), z.number().int().nonnegative().safe()])
		.nullable()
		.transform((value) => (value === null ? null : String(value))),
	results: z.array(book),
});

type ReadwiseHighlight = z.infer<typeof highlight>;
export type ReadwiseBook = z.infer<typeof book>;
type ReadwiseTag = z.infer<typeof tag>;

const emptyToNull = (value: string | null | undefined): string | null =>
	value === undefined || value === null || value === "" ? null : value;

const encodedOrNull = (value: string | null | undefined): string | null => {
	const text = emptyToNull(value);
	return text === null ? null : encodeText(text);
};

const tagNames = (tags: ReadwiseTag[] | undefined): string[] =>
	(tags ?? [])
		.map((tag) => tag.name)
		.filter((name): name is string => typeof name === "string" && name !== "")
		.map(encodeText);

export function bookRecord(book: ReadwiseBook): RecordData {
	return {
		text_encoding: TEXT_ENCODING,
		id: String(book.user_book_id),
		title:
			encodedOrNull(book.readable_title) ?? encodedOrNull(book.title) ?? "",
		author: encodedOrNull(book.author),
		category: encodedOrNull(book.category),
		source: encodedOrNull(book.source),
		cover_image_url: emptyToNull(book.cover_image_url),
		source_url: emptyToNull(book.source_url) ?? emptyToNull(book.unique_url),
		readwise_url: emptyToNull(book.readwise_url),
		document_note: encodedOrNull(book.document_note),
		summary: encodedOrNull(book.summary),
		asin: encodedOrNull(book.asin),
		tags: tagNames(book.book_tags),
		is_deleted: book.is_deleted === true,
	};
}

export function highlightRecord(
	highlight: ReadwiseHighlight,
	book: ReadwiseBook,
): RecordData {
	return {
		text_encoding: TEXT_ENCODING,
		id: String(highlight.id),
		book_id: String(highlight.book_id ?? book.user_book_id),
		// Denormalized so one scope is enough to search and display a highlight.
		book_title:
			encodedOrNull(book.readable_title) ?? encodedOrNull(book.title) ?? "",
		book_author: encodedOrNull(book.author),
		book_category: encodedOrNull(book.category),
		text: encodeText(highlight.text ?? ""),
		note: encodedOrNull(highlight.note),
		color: encodedOrNull(highlight.color),
		location:
			typeof highlight.location === "number" ? highlight.location : null,
		location_type: encodedOrNull(highlight.location_type),
		url: emptyToNull(highlight.url),
		readwise_url: emptyToNull(highlight.readwise_url),
		tags: tagNames(highlight.tags),
		is_favorite: highlight.is_favorite === true,
		is_discard: highlight.is_discard === true,
		is_deleted: book.is_deleted === true || highlight.is_deleted === true,
		highlighted_at: emptyToNull(highlight.highlighted_at),
		created_at: emptyToNull(highlight.created_at),
		updated_at: emptyToNull(highlight.updated_at),
	};
}

function exportPageUrl(
	cursor: string | null,
	updatedAfter: string | null,
): string {
	const url = new URL(EXPORT_URL);
	if (cursor) {
		url.searchParams.set("pageCursor", cursor);
	}
	if (updatedAfter) {
		url.searchParams.set("updatedAfter", updatedAfter);
	}
	url.searchParams.set("includeDeleted", "true");
	return url.toString();
}

async function readPage(response: Response) {
	if (!response.body) throw new Error("readwise_invalid_export");
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	while (true) {
		const chunk = await reader.read();
		if (chunk.done) break;
		size += chunk.value.byteLength;
		if (size > MAX_RESPONSE_BYTES) {
			await reader.cancel();
			throw new Error("readwise_response_bound_exceeded");
		}
		chunks.push(chunk.value);
	}
	try {
		return exportPage.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
	} catch {
		throw new Error("readwise_invalid_export");
	}
}

export function createExportReader(
	fetchImpl: typeof fetch = fetch,
	retrySleep?: (ms: number) => Promise<void>,
) {
	const governor = createConnectorHttpGovernor({
		name: "readwise",
		// Highlight EXPORT uses the base quota of 240 requests/minute per token.
		profile: { pacingMinIntervalMs: 250 },
		...(retrySleep ? { retrySleep, pacingInitialIntervalMs: 0 } : {}),
	});

	return async (
		token: string,
		cursor: string | null,
		updatedAfter: string | null,
	) => {
		try {
			const { value } = await governor.request(
				async () => {
					const response = await fetchImpl(
						exportPageUrl(cursor, updatedAfter),
						{
							headers: {
								Authorization: `Token ${token}`,
								Accept: "application/json",
							},
							redirect: "error",
							signal: AbortSignal.timeout(30_000),
						},
					);
					if (!response.ok) await response.body?.cancel();
					return response;
				},
				(response) => ({
					status: response.status,
					headers: {
						"retry-after": response.headers.get("Retry-After") ?? undefined,
					},
					value: response,
				}),
			);
			if (value.status === 401 || value.status === 403) {
				throw new Error("readwise_auth_failed");
			}
			if (!value.ok) throw new Error(`readwise_http_${value.status}`);
			return await readPage(value);
		} catch (error) {
			if (error instanceof ConnectorRateLimitedError) throw error;
			if (error instanceof RetryExhaustedError) {
				throw new Error("readwise_export_retryable");
			}
			throw error;
		}
	};
}
