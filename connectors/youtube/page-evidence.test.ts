// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import {
	enumerationEnded,
	type ListEnd,
	readListEnd,
	readPageReadiness,
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

function setPageLocation(window: object, url: string) {
	Object.defineProperty(window, "location", {
		configurable: true,
		value: new URL(url),
	});
}

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
	assert.equal(
		ended({ declaredTotal: 3 }, 3),
		false,
		"a total is not an end marker",
	);
	assert.equal(ended({ declaredTotal: 9 }, 3), false, "total not reached");
	assert.equal(
		ended({ dataReadable: true, dataItemCount: 3 }, 3),
		true,
		"a complete readable source list with no continuation is terminal",
	);
	assert.equal(
		ended(
			{
				dataReadable: true,
				dataItemCount: 3,
				domHasContinuation: true,
			},
			3,
		),
		false,
		"a rendered continuation still means another page may exist",
	);
	assert.equal(
		ended({ dataItemCount: 3 }, 3),
		false,
		"unreadable source data cannot prove the end",
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
		ended({ verifiedEmpty: true }, 0),
		true,
		"verified empty source data is terminal when no rows were read",
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
	assert.equal(
		ended({ dataReadable: true, dataItemCount: 60, domHasEndMarker: true }, 50),
		false,
		"source rows beyond the emitted count veto even an end marker",
	);
	assert.equal(
		ended({ dataHasContinuation: true, domHasEndMarker: true }, 3, true),
		false,
		"a continuation vetoes every positive signal",
	);
	assert.equal(
		ended({ verifiedEmpty: true, domItemCount: 1 }, 0),
		false,
		"empty data is vetoed by current DOM rows",
	);
	assert.equal(
		ended({ declaredTotal: 5, domHasEndMarker: true }, 4),
		false,
		"an unmatched declared total stays a veto even with an end marker",
	);
});

test("a page-data region with no recognized entry is not readable evidence", () => {
	const globals = globalThis as Record<string, unknown>;
	const { document, window } = parseHTML(
		`<script>var ytInitialData = {"contents":{}};</script>`,
	);
	globals.document = document;
	globals.window = window;
	setPageLocation(
		window,
		"https://www.youtube.com/playlist?list=PL_SYNTHETIC_TARGET_001",
	);
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
	setPageLocation(window, "https://www.youtube.com/playlist?list=LL");
	try {
		assert.equal(readListEnd("playlist").verifiedEmpty, false);
	} finally {
		globals.document = undefined;
		globals.window = undefined;
	}
});

test("the selected liked-videos tab's recognized empty message proves an empty list", () => {
	const data = {
		contents: {
			twoColumnBrowseResultsRenderer: {
				tabs: [
					{
						tabRenderer: {
							selected: true,
							content: {
								sectionListRenderer: {
									contents: [
										{
											itemSectionRenderer: {
												contents: [
													{
														messageRenderer: {
															text: {
																runs: [{ text: "No videos in this playlist" }],
															},
														},
													},
												],
											},
										},
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
		`<script>var ytInitialData = ${JSON.stringify(data)};</script>`,
	);
	const globals = globalThis as Record<string, unknown>;
	globals.document = document;
	globals.window = window;
	setPageLocation(window, "https://www.youtube.com/playlist?list=LL");
	try {
		assert.equal(readListEnd("playlist").verifiedEmpty, true);
	} finally {
		globals.document = undefined;
		globals.window = undefined;
	}
});

test("the selected playlist index is empty of owner playlists when only built-in lockups remain", () => {
	const lockup = (id: string) => ({
		content: {
			lockupViewModel: {
				contentId: id,
				contentType: "LOCKUP_CONTENT_TYPE_PLAYLIST",
				itemPlayback: {
					inlinePlayerData: {
						onSelect: {
							innertubeCommand: { watchEndpoint: { playlistId: id } },
						},
					},
				},
			},
		},
	});
	const data = {
		contents: {
			twoColumnBrowseResultsRenderer: {
				tabs: [
					{
						tabRenderer: {
							selected: true,
							content: {
								richGridRenderer: {
									contents: [
										{ richItemRenderer: lockup("WL") },
										{ richItemRenderer: lockup("LL") },
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
		`<yt-lockup-view-model><a href="/playlist?list=WL"></a><yt-collection-thumbnail-view-model></yt-collection-thumbnail-view-model></yt-lockup-view-model><yt-lockup-view-model><a href="/playlist?list=LL"></a><yt-collection-thumbnail-view-model></yt-collection-thumbnail-view-model></yt-lockup-view-model><script>var ytInitialData = ${JSON.stringify(data)};</script>`,
	);
	const globals = globalThis as Record<string, unknown>;
	globals.document = document;
	globals.window = window;
	setPageLocation(window, "https://www.youtube.com/feed/playlists");
	try {
		assert.equal(readListEnd("playlist-index").verifiedEmpty, true);
	} finally {
		globals.document = undefined;
		globals.window = undefined;
	}
});

test("empty playlist index grid does not prove the owner has no playlists", () => {
	assertFixtureUnproven("playlist-index-empty-grid.html", "playlist-index");
});

test("loading playlist index grid does not prove the owner has no playlists", () => {
	assertFixtureUnproven("playlist-index-loading-grid.html", "playlist-index");
});

test("a sole unselected playlist tab does not prove the owner has no playlists", () => {
	assertFixtureUnproven("playlist-index-unselected-tab.html", "playlist-index");
});

test("an unrelated empty LL section cannot prove a loading target section empty", () => {
	assertFixtureUnproven(
		"liked-videos-unrelated-empty-loading-target.html",
		"playlist",
	);
});

test("an auth or consent wall vetoes empty LL evidence", () => {
	assertFixtureUnproven("liked-videos-consent-wall.html", "playlist");
});

test("a lost session vetoes empty LL evidence on the target page", () => {
	const page = parseHTML(
		readFileSync(
			new URL(
				"./__fixtures__/real-shape/liked-videos-empty-tab.html",
				import.meta.url,
			),
			"utf8",
		),
	);
	const globals = globalThis as Record<string, unknown>;
	globals.document = page.document;
	globals.window = page.window;
	setPageLocation(page.window, "https://www.youtube.com/playlist?list=LL");
	try {
		assert.equal(
			readListEnd({ kind: "playlist", sessionPresent: false }).verifiedEmpty,
			false,
		);
	} finally {
		globals.document = undefined;
		globals.window = undefined;
	}
});

function assertFixtureUnproven(
	file: string,
	kind: "playlist-index" | "playlist",
) {
	const page = parseHTML(
		readFileSync(
			new URL(`./__fixtures__/real-shape/${file}`, import.meta.url),
			"utf8",
		),
	);
	const globals = globalThis as Record<string, unknown>;
	globals.document = page.document;
	globals.window = page.window;
	setPageLocation(
		page.window,
		kind === "playlist-index"
			? "https://www.youtube.com/feed/playlists"
			: "https://www.youtube.com/playlist?list=LL",
	);
	try {
		assert.equal(readListEnd(kind).verifiedEmpty, false);
	} finally {
		globals.document = undefined;
		globals.window = undefined;
	}
}

test("a rejected message inside a playlist index vetoes built-in-only empty evidence", () => {
	const data = {
		contents: {
			twoColumnBrowseResultsRenderer: {
				tabs: [
					{
						tabRenderer: {
							selected: true,
							content: {
								richGridRenderer: {
									contents: [
										{
											messageRenderer: {
												text: {
													runs: [
														{ text: "Sign in to confirm you're not a bot" },
													],
												},
											},
										},
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
		`<yt-lockup-view-model><a href="/playlist?list=WL"></a></yt-lockup-view-model><script>var ytInitialData = ${JSON.stringify(data)};</script>`,
	);
	const globals = globalThis as Record<string, unknown>;
	globals.document = document;
	globals.window = window;
	setPageLocation(window, "https://www.youtube.com/feed/playlists");
	try {
		assert.equal(
			readPageReadiness({
				content: "yt-lockup-view-model",
				empty: "ytd-message-renderer",
				playlistIndex: true,
			}),
			"content",
		);
		assert.equal(readListEnd("playlist-index").verifiedEmpty, false);
	} finally {
		globals.document = undefined;
		globals.window = undefined;
	}
});

test("current empty-liked and four-subscription source shapes prove their captured outcomes", () => {
	const globals = globalThis as Record<string, unknown>;
	for (const [file, kind, expectedCount] of [
		["playlist-index-view-model.html", "playlist-index", 1],
		["watch-later-playlist-items.html", "playlist", 2],
	] as const) {
		const page = parseHTML(
			readFileSync(
				new URL(`./__fixtures__/real-shape/${file}`, import.meta.url),
				"utf8",
			),
		);
		globals.document = page.document;
		globals.window = page.window;
		try {
			const end = readListEnd(kind);
			assert.equal(end.dataReadable, true);
			assert.equal(end.dataItemCount, expectedCount);
			assert.equal(end.domItemCount, expectedCount);
			assert.equal(enumerationEnded(end, expectedCount), true);
		} finally {
			globals.document = undefined;
			globals.window = undefined;
		}
	}

	const liked = parseHTML(
		readFileSync(
			new URL(
				"./__fixtures__/real-shape/liked-videos-empty-tab.html",
				import.meta.url,
			),
			"utf8",
		),
	);
	globals.document = liked.document;
	globals.window = liked.window;
	setPageLocation(liked.window, "https://www.youtube.com/playlist?list=LL");
	try {
		const end = readListEnd("playlist");
		assert.equal(end.verifiedEmpty, true);
		assert.equal(enumerationEnded(end, 0), true);
	} finally {
		globals.document = undefined;
		globals.window = undefined;
	}

	const subscriptions = parseHTML(
		readFileSync(
			new URL(
				"./__fixtures__/real-shape/subscriptions-four-source-items.html",
				import.meta.url,
			),
			"utf8",
		),
	);
	globals.document = subscriptions.document;
	globals.window = subscriptions.window;
	try {
		const end = readListEnd("subscriptions");
		assert.equal(end.dataReadable, true);
		assert.equal(end.dataItemCount, 4);
		assert.equal(end.domItemCount, 4);
		assert.equal(enumerationEnded(end, 4), true);
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
		`<div class="yt-content-metadata-view-model__metadata-text">1,204 videos</div><div>1 unavailable video is hidden</div><script>var ytInitialData = ${JSON.stringify(data)};</script><ytd-channel-renderer></ytd-channel-renderer>`,
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
			domItemCount: 0,
			domHasEndMarker: false,
			verifiedEmpty: false,
		});
		assert.equal(readListEnd("history").declaredTotal, null);
		assert.equal(readListEnd("history").domItemCount, 0);
		assert.equal(readListEnd("subscriptions").domItemCount, 1);
	} finally {
		globals.document = undefined;
		globals.window = undefined;
	}
});
