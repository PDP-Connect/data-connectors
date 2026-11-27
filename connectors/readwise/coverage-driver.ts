// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { makeRecordingEmit } from "../../packages/polyfill-connectors/src/test-harness.ts";
import type { DriverResult } from "../_conformance/coverage-conformance-drivers.ts";
import { createExportReader } from "./api.ts";
import { collectReadwise } from "./index.ts";
import { validateRecord } from "./schemas.ts";

export async function runCoverageDriver(): Promise<DriverResult> {
	const recording = makeRecordingEmit(validateRecord);
	const read = createExportReader(async () =>
		Response.json({
			nextPageCursor: null,
			results: [
				{
					user_book_id: 11,
					source: "reader",
					category: "articles",
					title: "Synthetic article",
					highlights: [{ id: 101, text: "A synthetic highlight." }],
				},
			],
		}),
	);
	await collectReadwise(
		{
			...recording,
			credentials: { READWISE_ACCESS_TOKEN: "fixture-token" },
			collectionMode: "incremental",
			emittedAt: "2026-11-06T00:00:00.000Z",
			requested: new Map([
				["books", { name: "books" }],
				["highlights", { name: "highlights" }],
			]),
			state: {},
			progress: async () => {},
		},
		read,
	);
	return {
		exercised: true,
		messages: recording.protocolMessages,
		skippedRecords: recording.skipped,
		emittedCounts: {
			books: recording.emitted.filter(({ stream }) => stream === "books")
				.length,
			highlights: recording.emitted.filter(
				({ stream }) => stream === "highlights",
			).length,
		},
	};
}
