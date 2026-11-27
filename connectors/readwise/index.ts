#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { isMainModule } from "@pdpp/connector-protocol";
import {
	buildDetailCoverageMessage,
	type CollectContext,
	type RecordData,
	runConnector,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { bookRecord, createExportReader, highlightRecord } from "./api.ts";
import { validateRecord } from "./schemas.ts";

const STREAMS = ["books", "highlights"] as const;
const CURSOR_SKEW_MS = 5 * 60 * 1000;
const MAX_PAGES = 1000;

type ReadPage = ReturnType<typeof createExportReader>;
type ReadwiseContext = Pick<
	CollectContext,
	| "state"
	| "requested"
	| "credentials"
	| "collectionMode"
	| "emit"
	| "emitRecord"
	| "isRecordSelected"
	| "progress"
	| "emittedAt"
>;

function checkpointTime(value: unknown): number {
	if (
		value &&
		typeof value === "object" &&
		"updated_after" in value &&
		typeof value.updated_after === "string"
	) {
		return Date.parse(value.updated_after);
	}
	return Number.NaN;
}

/** Collect the selected streams through the end of the Readwise export window. */
export async function collectReadwise(
	ctx: ReadwiseContext,
	readPage: ReadPage = createExportReader(),
): Promise<void> {
	const streams = STREAMS.filter((stream) => ctx.requested.has(stream));
	if (streams.length === 0) return;
	const token = ctx.credentials.READWISE_ACCESS_TOKEN;
	if (!token) throw new Error("readwise_auth_failed");

	const runStartedAt = Date.parse(ctx.emittedAt);
	// Each stream advances independently. A newly selected stream needs the
	// full export, and a resumed run starts at the oldest selected checkpoint.
	const earliest = Math.min(
		...streams.map((stream) => checkpointTime(ctx.state[stream])),
	);
	const updatedAfter =
		ctx.collectionMode === "full_refresh" || !Number.isFinite(earliest)
			? null
			: new Date(earliest).toISOString();
	const seen = new Set<string>();
	let cursor: string | null = null;
	let pages = 0;
	const counts = {
		books: { considered: 0, covered: 0 },
		highlights: { considered: 0, covered: 0 },
	};
	const emitSelected = async (
		stream: (typeof STREAMS)[number],
		data: RecordData,
	) => {
		if (ctx.isRecordSelected?.(stream, data) === false) return;
		const count = counts[stream];
		count.considered += 1;
		// The runtime emits tombstones directly, without calling beforeEmit.
		let accepted = data.is_deleted === true;
		await ctx.emitRecord(stream, data, {
			beforeEmit: async () => {
				accepted = true;
			},
		});
		if (accepted) count.covered += 1;
	};

	do {
		if (++pages > MAX_PAGES) throw new Error("readwise_page_bound_exceeded");
		const page = await readPage(token, cursor, updatedAfter);
		for (const book of page.results) {
			if (ctx.requested.has("books")) {
				await emitSelected("books", bookRecord(book));
			}
			if (ctx.requested.has("highlights")) {
				for (const highlight of book.highlights ?? []) {
					await emitSelected("highlights", highlightRecord(highlight, book));
				}
			}
		}
		await ctx.progress(
			`Collected ${counts.books.covered} books and ${counts.highlights.covered} highlights`,
		);
		cursor = page.nextPageCursor;
		if (cursor !== null && seen.has(cursor))
			throw new Error("readwise_pagination_cycle");
		if (cursor !== null) seen.add(cursor);
	} while (cursor !== null);

	const checkpoint = {
		updated_after: new Date(runStartedAt - CURSOR_SKEW_MS).toISOString(),
	};
	for (const stream of streams) {
		const { considered, covered } = counts[stream];
		await ctx.emit(
			buildDetailCoverageMessage({
				stream,
				stateStream: stream,
				requiredKeys: [],
				hydratedKeys: [],
				considered,
				covered,
			}),
		);
		if (covered === considered) {
			await ctx.emit({ type: "STATE", stream, cursor: checkpoint });
		}
	}
}

if (isMainModule(import.meta.url)) {
	runConnector({
		name: "readwise",
		validateRecord,
		retryablePattern:
			/ECONN|ETIMEDOUT|timeout|readwise_(?:rate_limited|export_retryable)/i,
		auth: { kind: "env", required: ["READWISE_ACCESS_TOKEN"] },
		isTombstone: (_stream, data) => data.is_deleted === true,
		collect: collectReadwise,
	});
}
