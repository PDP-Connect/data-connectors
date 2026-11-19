// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import {
	enumerationEnded,
	drainHistoryBrowseLog,
	installHistoryBrowseLog,
	readHistoryResponseEvidence,
	scanHistoryResponse,
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
	pageBlocked: false,
	latestHistoryResponse: null,
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

test("each LL wall fixture is the verified empty baseline plus exactly one blocker", () => {
	const fixture = (file: string) =>
		readFileSync(
			new URL(`./__fixtures__/real-shape/${file}`, import.meta.url),
			"utf8",
		);
	const baseline = fixture("liked-videos-empty-tab.html");
	const verifiedEmpty = (html: string) => {
		const page = parseHTML(html);
		const globals = globalThis as Record<string, unknown>;
		globals.document = page.document;
		globals.window = page.window;
		setPageLocation(page.window, "https://www.youtube.com/playlist?list=LL");
		try {
			return readListEnd("playlist").verifiedEmpty;
		} finally {
			globals.document = undefined;
			globals.window = undefined;
		}
	};
	assert.equal(verifiedEmpty(baseline), true, "wall-free baseline");
	for (const [file, blocker] of [
		[
			"liked-videos-consent-wall.html",
			'<ytd-consent-bump-v2-lightbox><div role="dialog">Consent required</div></ytd-consent-bump-v2-lightbox>\n',
		],
		[
			"liked-videos-sign-in-wall.html",
			'<a href="https://accounts.google.com/ServiceLogin">Sign in</a>\n',
		],
		["liked-videos-loading.html", "<tp-yt-paper-spinner></tp-yt-paper-spinner>\n"],
	] as const) {
		const html = fixture(file);
		assert.equal(html.replace(blocker, ""), baseline, `${file} adds only its blocker`);
		assert.equal(verifiedEmpty(html), false, file);
	}
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
	for (const [file, kind, expectedCount, url] of [
		[
			"playlist-index-view-model.html",
			"playlist-index",
			1,
			"https://www.youtube.com/feed/playlists",
		],
		[
			"watch-later-playlist-items.html",
			"playlist",
			2,
			"https://www.youtube.com/playlist?list=WL",
		],
	] as const) {
		const page = parseHTML(
			readFileSync(
				new URL(`./__fixtures__/real-shape/${file}`, import.meta.url),
				"utf8",
			),
		);
		globals.document = page.document;
		globals.window = page.window;
		setPageLocation(page.window, url);
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
	setPageLocation(subscriptions.window, "https://www.youtube.com/feed/channels");
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
			// The parsed page has no YouTube route.
			pageBlocked: true,
			latestHistoryResponse: null,
		});
		assert.equal(readListEnd("history").declaredTotal, null);
		assert.equal(readListEnd("history").domItemCount, 0);
		assert.equal(readListEnd("subscriptions").domItemCount, 1);
	} finally {
		globals.document = undefined;
		globals.window = undefined;
	}
});

test("latest history continuation response overrides stale bootstrap continuation evidence", () => {
	const initial = {
		contents: {
			twoColumnBrowseResultsRenderer: {
				tabs: [{ tabRenderer: { selected: true, content: {
					sectionListRenderer: { contents: [
						{ lockupViewModel: { contentId: "v1" } },
						{ lockupViewModel: { contentId: "v2" } },
						{ lockupViewModel: { contentId: "v3" } },
						{ continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: "stale-token" } } } },
					] },
				} } }],
			},
		},
	};
	const { document, window } = parseHTML(
		`<button id="avatar-btn"></button><ytd-item-section-renderer>${["v1", "v2", "v3"].map((id) => `<yt-lockup-view-model><a href="/watch?v=${id}"></a></yt-lockup-view-model>`).join("")}</ytd-item-section-renderer><script>var ytInitialData = ${JSON.stringify(initial)};</script>`,
	);
	setPageLocation(window, "https://www.youtube.com/feed/history");
	const globals = globalThis as Record<string, unknown>;
	const oldDocument = globals.document;
	const oldWindow = globals.window;
	globals.document = document;
	globals.window = window;
	try {
		const finalResponse = readHistoryResponseEvidence(
			{ onResponseReceivedActions: [{ appendContinuationItemsAction: { continuationItems: [{ lockupViewModel: {} }] } }] },
			"old-token",
			new Set(["old-token"]),
		);
		const end = readListEnd({
			kind: "history",
			sessionPresent: true,
			latestHistoryResponse: finalResponse,
		});
		assert.equal(end.dataHasContinuation, true, "bootstrap still contains its old token");
		assert.equal(end.latestHistoryResponse?.recognized, true);
		assert.equal(enumerationEnded(end, 3), true);
	} finally {
		globals.document = oldDocument;
		globals.window = oldWindow;
	}
});

test("history response accepts bounded continuation tokens above four KiB", () => {
	const reply = (token: string) => ({
		onResponseReceivedActions: [{ appendContinuationItemsAction: { continuationItems: [
			{ continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token } } } },
		] } }],
	});
	const bounded = "x".repeat(5000);
	assert.equal(readHistoryResponseEvidence(reply(bounded), "previous", new Set()).nextContinuation, bounded);
	assert.equal(readHistoryResponseEvidence(reply("x".repeat(16385)), "previous", new Set()).nextContinuation, null);
});


test("a blocked page vetoes every kind of end evidence", () => {
	const blocked = { ...NO_EVIDENCE, pageBlocked: true };
	assert.equal(enumerationEnded({ ...blocked, domHasEndMarker: true }, 2), false);
	assert.equal(enumerationEnded(blocked, 2, true), false, "continuation removed");
	assert.equal(
		enumerationEnded({ ...blocked, dataReadable: true, dataItemCount: 2 }, 2),
		false,
	);
	assert.equal(enumerationEnded({ ...blocked, verifiedEmpty: true }, 0), false);
	const { pageBlocked: _omitted, ...unknown } = {
		...NO_EVIDENCE,
		domHasEndMarker: true,
	};
	assert.equal(
		enumerationEnded(unknown as ListEnd, 2),
		false,
		"a missing block fact is not a clear page",
	);
});

test("only an authenticated selected history empty message proves a zero-row end", () => {
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
															text: { runs: [{ text: "No watch history" }] },
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
	setPageLocation(window, "https://www.youtube.com/feed/history");
	try {
		const end = readListEnd({ kind: "history", sessionPresent: true });
		assert.equal(end.verifiedEmpty, true);
		assert.equal(end.pageBlocked, false);
		assert.equal(enumerationEnded(end, 0), true);

		const signedOut = readListEnd({
			kind: "history",
			sessionPresent: false,
		});
		assert.equal(signedOut.verifiedEmpty, false);
		assert.equal(signedOut.pageBlocked, true);
		assert.equal(enumerationEnded(signedOut, 0), false);
	} finally {
		globals.document = undefined;
		globals.window = undefined;
	}
});

const BROWSE_URL = "https://www.youtube.com/youtubei/v1/browse?prettyPrint=false";
const continuationBody = (next: string | null) => ({
	onResponseReceivedActions: [
		{
			appendContinuationItemsAction: {
				continuationItems: [
					{ lockupViewModel: {} },
					{ lockupViewModel: {} },
					...(next
						? [{ continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: next } } } }]
						: []),
				],
			},
		},
	],
});

/** Run the page-side wrapper against a fake window, as the page would. */
async function withFakeWindow<T>(
	respond: (input: unknown) => Promise<Response>,
	run: (window: Record<string, any>) => Promise<T>,
): Promise<T> {
	const globals = globalThis as Record<string, unknown>;
	const previous = globals.window;
	const fakeWindow: Record<string, any> = { fetch: respond };
	globals.window = fakeWindow;
	try {
		return await run(fakeWindow);
	} finally {
		globals.window = previous;
	}
}

async function drainAll() {
	// Let every started call finish, then take the log once.
	await new Promise((resolve) => setTimeout(resolve, 100));
	const drained = drainHistoryBrowseLog();
	assert.ok(drained);
	assert.equal(drained.completed, drained.sent, "every call finished");
	return drained;
}

test("the page browse log decodes a gzip Request body and summarizes the response", async () => {
	const token = "T".repeat(5000);
	const body = continuationBody("next-token");
	let pageSawBody = "";
	await withFakeWindow(
		async (input) => {
			// The page's own fetch consumes the body after the wrapper cloned it.
			if (typeof input !== "string")
				pageSawBody = String((await (input as Request).arrayBuffer()).byteLength > 0);
			return new Response(JSON.stringify(body), { status: 200 });
		},
		async (window) => {
			assert.equal(installHistoryBrowseLog(), true);
			const wrapped = window.fetch;
			assert.equal(installHistoryBrowseLog(), true);
			assert.equal(window.fetch, wrapped, "install is idempotent");
			await window.fetch(
				new Request(BROWSE_URL, {
					method: "POST",
					body: gzipSync(JSON.stringify({ continuation: token })),
					headers: { "content-encoding": "gzip" },
				}),
			);
			await window.fetch("https://www.youtube.com/youtubei/v1/next");
			const drained = await drainAll();
			assert.equal(pageSawBody, "true");
			assert.equal(drained.sent, 1);
			assert.equal(drained.entries.length, 1);
			const [entry] = drained.entries;
			assert.deepEqual(entry?.requestBody, { continuation: token });
			assert.equal(entry?.status, 200);
			// One implementation: the page summary equals the host's evidence.
			const host = readHistoryResponseEvidence(body, token, new Set());
			assert.deepEqual(entry?.summary, scanHistoryResponse(body));
			assert.equal(entry?.summary?.recognized, host.recognized);
			assert.equal(entry?.summary?.hasContinuation, host.hasContinuation);
			assert.equal(entry?.summary?.itemCount, host.itemCount);
			assert.equal(entry?.summary?.nextContinuation, host.nextContinuation);
			assert.equal(drainHistoryBrowseLog()?.entries.length, 0, "a drain takes the entries");
		},
	);
});

test("the page browse log keeps a plain init body, an undecodable body and a bounded log", async () => {
	await withFakeWindow(
		async () => new Response("not json", { status: 200 }),
		async (window) => {
			assert.equal(installHistoryBrowseLog(), true);
			await window.fetch(BROWSE_URL, { method: "POST", body: JSON.stringify({ browseId: "FEhistory" }) });
			await window.fetch(BROWSE_URL, { method: "POST", body: "{broken" });
			await window.fetch(BROWSE_URL, { method: "POST", body: JSON.stringify({ continuation: "x".repeat(16385) }) });
			const first = await drainAll();
			assert.deepEqual(first.entries.map((entry) => entry.requestBody), [
				{ browseId: "FEhistory" },
				null,
				{ continuationTooLong: true },
			]);
			assert.ok(first.entries.every((entry) => entry.summary === null), "an unreadable body has no summary");
			for (let call = 0; call < 40; call += 1)
				await window.fetch(BROWSE_URL, { method: "POST", body: "{}" });
			const flood = await drainAll();
			assert.equal(flood.entries.length, 32);
			assert.equal(flood.overflow, true);
			assert.equal(flood.sent, 43);
		},
	);
});

test("the page browse log counts XHR browse sends without a body", async () => {
	const globals = globalThis as Record<string, unknown>;
	const previous = globals.XMLHttpRequest;
	class FakeXhr {
		open(_method: string, _url: string) {}
		private loadend: Array<() => void> = [];
		send() {
			queueMicrotask(() => this.loadend.forEach((listener) => listener()));
		}
		addEventListener(event: string, listener: () => void) {
			if (event === "loadend") this.loadend.push(listener);
		}
	}
	globals.XMLHttpRequest = FakeXhr;
	try {
		await withFakeWindow(
			async () => new Response("{}"),
			async () => {
				assert.equal(installHistoryBrowseLog(), true);
				const xhr = new FakeXhr();
				xhr.open("POST", BROWSE_URL);
				xhr.send();
				const other = new FakeXhr();
				other.open("GET", "https://www.youtube.com/other");
				other.send();
				const drained = await drainAll();
				assert.equal(drained.sent, 1);
				assert.deepEqual(drained.entries.map((entry) => entry.requestBody), [null]);
			},
		);
	} finally {
		globals.XMLHttpRequest = previous;
	}
});

test("the page browse log is absent until installed", async () => {
	await withFakeWindow(async () => new Response("{}"), async () => {
		assert.equal(drainHistoryBrowseLog(), null);
	});
});

test("a response is recognized only when it carries rows or a continuation item", () => {
	const keyOnly = [
		{ onResponseReceivedActions: [{ appendContinuationItemsAction: { continuationItems: [] } }] },
		{ onResponseReceivedActions: [{ reloadContinuationItemsCommand: {} }] },
		{ contents: { twoColumnBrowseResultsRenderer: { tabs: [] } } },
		{ contents: { singleColumnBrowseResultsRenderer: { tabs: [] } } },
		{ continuationContents: { itemSectionContinuation: { continuations: [{}] } } },
	];
	for (const value of keyOnly) {
		const scan = scanHistoryResponse(value);
		assert.equal(scan.recognized, false, JSON.stringify(value));
		assert.equal(scan.hasContinuation, false, JSON.stringify(value));
	}
	assert.equal(
		scanHistoryResponse({
			onResponseReceivedActions: [
				{ appendContinuationItemsAction: { continuationItems: [{ lockupViewModel: {} }] } },
			],
		}).recognized,
		true,
	);
	assert.equal(
		scanHistoryResponse({
			onResponseReceivedActions: [
				{
					appendContinuationItemsAction: {
						continuationItems: [
							{ continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: "next" } } } },
						],
					},
				},
			],
		}).recognized,
		true,
	);
});

test("the page browse log keeps both browseId and continuation from one request", async () => {
	await withFakeWindow(
		async () => new Response(JSON.stringify(continuationBody("next-token")), { status: 200 }),
		async (window) => {
			assert.equal(installHistoryBrowseLog(), true);
			await window.fetch(BROWSE_URL, {
				method: "POST",
				body: JSON.stringify({ browseId: "FEhistory", continuation: "both" }),
			});
			const drained = await drainAll();
			assert.deepEqual(drained.entries[0]?.requestBody, {
				browseId: "FEhistory",
				continuation: "both",
			});
		},
	);
});

test("a row nested in another row counts once", () => {
	const scan = scanHistoryResponse({
		onResponseReceivedActions: [
			{
				appendContinuationItemsAction: {
					continuationItems: [
						{ richItemRenderer: { content: { videoRenderer: {} } } },
						{ lockupViewModel: {} },
					],
				},
			},
		],
	});
	assert.equal(scan.itemCount, 2);
	assert.equal(scan.recognized, true);
});

test("the page browse log keeps the request body of a fetch that failed", async () => {
	await withFakeWindow(
		async () => {
			throw new TypeError("network down");
		},
		async (window) => {
			assert.equal(installHistoryBrowseLog(), true);
			await window.fetch(BROWSE_URL, {
				method: "POST",
				body: JSON.stringify({ continuation: "wanted" }),
			}).catch(() => undefined);
			const drained = await drainAll();
			assert.deepEqual(drained.entries[0]?.requestBody, { continuation: "wanted" });
			assert.equal(drained.entries[0]?.status, 0);
		},
	);
});

/** A minimal XHR whose outcome the test settles by hand. */
function installFakeXhr() {
	const listeners = new Map<string, Array<() => void>>();
	class FakeXhr {
		status = 0;
		responseType = "";
		responseText = "";
		response: unknown = null;
		open(_method: string, _url: string): void {}
		send(_body?: unknown): void {}
		addEventListener(event: string, listener: () => void): void {
			listeners.set(event, [...(listeners.get(event) ?? []), listener]);
		}
	}
	const globals = globalThis as Record<string, unknown>;
	const previous = globals.XMLHttpRequest;
	globals.XMLHttpRequest = FakeXhr;
	return {
		FakeXhr,
		loadend: () => (listeners.get("loadend") ?? []).forEach((listener) => listener()),
		restore: () => {
			globals.XMLHttpRequest = previous;
		},
	};
}

test("the page browse log records an XHR browse outcome on loadend", async () => {
	const xhr = installFakeXhr();
	try {
		await withFakeWindow(async () => new Response("{}"), async () => {
			assert.equal(installHistoryBrowseLog(), true);
			const body = continuationBody("next-token");
			const call = new xhr.FakeXhr();
			call.open("POST", BROWSE_URL);
			call.send(JSON.stringify({ continuation: "asked" }));
			const early = drainHistoryBrowseLog();
			assert.equal(early?.sent, 1);
			assert.equal(early?.completed, 0, "in flight until loadend");
			call.status = 200;
			call.responseText = JSON.stringify(body);
			xhr.loadend();
			const drained = await drainAll();
			assert.deepEqual(drained.entries[0]?.requestBody, { continuation: "asked" });
			assert.equal(drained.entries[0]?.status, 200);
			assert.deepEqual(drained.entries[0]?.summary, scanHistoryResponse(body));
		});
	} finally {
		xhr.restore();
	}
});

test("a failed XHR browse is logged with its body and status 0", async () => {
	const xhr = installFakeXhr();
	try {
		await withFakeWindow(async () => new Response("{}"), async () => {
			assert.equal(installHistoryBrowseLog(), true);
			const call = new xhr.FakeXhr();
			call.open("POST", BROWSE_URL);
			call.send(JSON.stringify({ browseId: "FEhistory" }));
			xhr.loadend();
			const drained = await drainAll();
			assert.deepEqual(drained.entries[0]?.requestBody, { browseId: "FEhistory" });
			assert.equal(drained.entries[0]?.status, 0);
			assert.equal(drained.entries[0]?.summary, null);
		});
	} finally {
		xhr.restore();
	}
});
