// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import {
	enumerationEnded,
	type ListEnd,
	readListEnd,
} from "./page-evidence.ts";

const NO_EVIDENCE: ListEnd = {
	dataReadable: false,
	dataItemCount: 0,
	dataHasContinuation: false,
	domHasContinuation: false,
	declaredTotal: null,
	domItemCount: null,
	domHasEndMarker: false,
	verifiedEmpty: false,
};

test("enumeration ends only on positive page terminal evidence", () => {
	const ended = (
		end: Partial<ListEnd> | null,
		rendered: number,
		continuationFollowed = false,
	) =>
		enumerationEnded(
			end ? { ...NO_EVIDENCE, ...end } : null,
			rendered,
			continuationFollowed,
		);
	assert.equal(ended(null, 3), false, "no evidence read");
	assert.equal(ended({}, 3), false, "unreadable page data is not evidence");
	assert.equal(ended({ declaredTotal: 3 }, 3), false, "a total is not an end marker");
	assert.equal(ended({ declaredTotal: 9 }, 3), false, "total not reached");
	assert.equal(
		ended({ dataReadable: true, dataItemCount: 3 }, 3),
		false,
		"absence of a next page at load is not a terminal response",
	);
	assert.equal(
		ended({ dataReadable: true, domHasContinuation: true }, 3),
		false,
		"next page still shown",
	);
	assert.equal(
		ended(
			{ dataReadable: true, dataItemCount: 3, dataHasContinuation: true },
			3,
		),
		false,
		"next page existed and was never followed",
	);
	assert.equal(
		ended(
			{ dataReadable: true, dataItemCount: 3, dataHasContinuation: true },
			7,
		),
		false,
		"row growth with no next-page control is not the final source response",
	);
	assert.equal(
		ended(
			{
				dataReadable: true,
				dataItemCount: 3,
				dataHasContinuation: false,
				domHasContinuation: false,
			},
			7,
			true,
		),
		true,
		"a followed continuation with no remaining token reached the end",
	);
	assert.equal(
		ended({ domHasEndMarker: true }, 3),
		true,
		"an explicit rendered end marker proves exhaustion",
	);
	assert.equal(
		ended(
			{ dataReadable: true, dataItemCount: 3, dataHasContinuation: true },
			7,
			false,
		),
		false,
		"row growth while a continuation remains is not end evidence",
	);
	assert.equal(
		ended({ dataReadable: true, dataItemCount: 3 }, 1),
		false,
		"source entries were left unread",
	);
	assert.equal(
		ended({ declaredTotal: 3, dataReadable: true, dataItemCount: 1 }, 1),
		false,
		"a header total that differs from the rows read is not an end, even with no next page",
	);
	assert.equal(
		ended({ dataReadable: true, domItemCount: 25 }, 20),
		false,
		"rows hidden by the connector's own limit",
	);
});

test("a page-data region with no recognized entry is not readable evidence", () => {
	const globals = globalThis as Record<string, unknown>;
	const { document, window } = parseHTML(
		`<script>var ytInitialData = {"contents":{}};</script>`,
	);
	globals.document = document;
	globals.window = window;
	try {
		assert.equal(readListEnd("playlist").dataReadable, false);
	} finally {
		globals.document = undefined;
		globals.window = undefined;
	}
});

test("an unrelated empty message without a list renderer cannot prove an empty playlist", () => {
	const globals = globalThis as Record<string, unknown>;
	const data = {
		contents: {
			messageRenderer: { text: { simpleText: "Nothing to show" } },
		},
	};
	const { document, window } = parseHTML(
		`<script>var ytInitialData = ${JSON.stringify(data)};</script>`,
	);
	globals.document = document;
	globals.window = window;
	try {
		assert.equal(readListEnd("playlist").verifiedEmpty, false);
	} finally {
		globals.document = undefined;
		globals.window = undefined;
	}
});

test("readListEnd reads the header total, continuation and row count from the page", () => {
	const data = {
		contents: {
			twoColumnBrowseResultsRenderer: {
				tabs: [
					{
						tabRenderer: {
							selected: true,
							content: {
								playlistVideoListRenderer: {
									contents: [
										{ playlistVideoRenderer: {} },
										{ continuationItemRenderer: {} },
									],
								},
							},
						},
					},
				],
			},
		},
	};
	const { document, window } = parseHTML(
		`<div class="yt-content-metadata-view-model__metadata-text">1,204 videos</div><script>var ytInitialData = ${JSON.stringify(data)};</script><ytd-channel-renderer></ytd-channel-renderer>`,
	);
	const globals = globalThis as Record<string, unknown>;
	globals.document = document;
	globals.window = window;
	try {
		assert.deepEqual(readListEnd("playlist"), {
			dataReadable: true,
			dataItemCount: 1,
			dataHasContinuation: true,
			domHasContinuation: false,
			declaredTotal: 1204,
			domItemCount: null,
			domHasEndMarker: false,
			verifiedEmpty: false,
		});
		assert.equal(readListEnd("history").declaredTotal, null);
		assert.equal(readListEnd("subscriptions").domItemCount, 1);
	} finally {
		globals.document = undefined;
		globals.window = undefined;
	}
});
