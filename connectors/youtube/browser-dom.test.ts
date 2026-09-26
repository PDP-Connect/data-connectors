// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import {
	readChannelAbout,
	readChannelPage,
	readOwnAccount,
	readSubscriptions,
	readPlaylistLinks,
	readVideos,
} from "./browser-dom.ts";

function dom(html: string): Document {
	return parseHTML(`<html><body>${html}</body></html>`)
		.document as unknown as Document;
}

test("own channel prefers the active account header over generic page links", () => {
	const doc = dom(
		'<a href="/@someone-else">sidebar</a><ytd-active-account-header-renderer><span id="channel-handle">@owner</span><span id="email">owner@example.com</span></ytd-active-account-header-renderer>',
	);
	assert.deepEqual(readOwnAccount(doc), {
		channel_url: "https://www.youtube.com/@owner",
		email: "owner@example.com",
	});
	assert.equal(
		readOwnAccount(dom('<a href="/@someone-else">sidebar</a>')).channel_url,
		null,
	);
});

test("own channel falls back to the authenticated menu's labeled Your channel link", () => {
	const doc = dom(`
		<a href="/@subscribed">subscribed channel</a>
		<ytd-active-account-header-renderer><span id="email">owner@example.com</span></ytd-active-account-header-renderer>
		<ytd-multi-page-menu-renderer>
			<ytd-compact-link-renderer><a href="/@other"><span id="label">Switch account</span></a></ytd-compact-link-renderer>
			<ytd-compact-link-renderer><a href="/channel/UCowner"><span id="label">Your channel</span></a></ytd-compact-link-renderer>
		</ytd-multi-page-menu-renderer>`);
	assert.deepEqual(readOwnAccount(doc), {
		channel_url: "https://www.youtube.com/channel/UCowner",
		email: "owner@example.com",
	});
});

test("own channel menu fallback rejects unlabeled channel links", () => {
	const doc = dom(`
		<ytd-active-account-header-renderer></ytd-active-account-header-renderer>
		<ytd-multi-page-menu-renderer><ytd-compact-link-renderer><a href="/@not-owner"><span id="label">Switch account</span></a></ytd-compact-link-renderer></ytd-multi-page-menu-renderer>
		<a href="/@subscribed">subscribed channel</a>`);
	assert.equal(readOwnAccount(doc).channel_url, null);
});

test("own channel About fields retain their source text", () => {
	const about = readChannelAbout(
		dom(
			'<ytd-channel-about-metadata-renderer><span>Joined Jan 3, 2020</span><span>1.2K subscribers</span><span>32 videos</span><span>4K views</span><span id="country">United States</span></ytd-channel-about-metadata-renderer>',
		),
	);
	assert.equal(about.joined_at, "Jan 3, 2020");
	assert.equal(about.subscriber_count_text, "1.2K subscribers");
	assert.equal(about.country, "United States");
});

test("own channel About fields can be read outside legacy renderers", () => {
	const about = readChannelAbout(
		dom("<span>Joined Jan 3, 2020</span><span>32 videos</span>"),
	);
	assert.equal(about.joined_at, "Jan 3, 2020");
	assert.equal(about.video_count_text, "32 videos");
});

test("channel page title skips empty headings before the page header title", () => {
	const doc = dom(`
		<link rel="canonical" href="https://www.youtube.com/channel/UCowner">
		<h1></h1>
		<h1>   </h1>
		<yt-page-header-view-model>
			<div class="yt-page-header-view-model__page-header-title">
				<h1><span>Real Owner</span></h1>
			</div>
		</yt-page-header-view-model>`);
	Object.defineProperty(doc, "location", {
		value: new URL("https://www.youtube.com/@owner"),
		configurable: true,
	});

	assert.equal(readChannelPage(doc).title, "Real Owner");
});

test("subscription controls distinguish known false from missing evidence", () => {
	const doc = dom(`
		<ytd-channel-renderer><ytd-channel-name><yt-formatted-string id="text">A</yt-formatted-string></ytd-channel-name><a id="main-link" href="/channel/UC123"></a><button aria-label="All notifications"></button></ytd-channel-renderer>
		<ytd-channel-renderer><ytd-channel-name><yt-formatted-string id="text">B</yt-formatted-string></ytd-channel-name><a id="main-link" href="/@b"></a></ytd-channel-renderer>`);
	const [a, b] = readSubscriptions(doc);
	assert.equal(a?.channel_id, "UC123");
	assert.equal(a?.notifications, true);
	assert.equal(a?.is_verified, false);
	assert.equal(b?.channel_id, null);
	assert.equal(b?.notifications, null);
});

test("playlist links exclude LL and WL and keep native IDs", () => {
	const links = readPlaylistLinks(
		dom(
			'<a href="/playlist?list=PL1">one</a><a href="/playlist?list=PL1">duplicate</a><a href="/playlist?list=LL">likes</a>',
		),
	);
	assert.deepEqual(links, [
		{ id: "PL1", url: "https://www.youtube.com/playlist?list=PL1" },
	]);
});

test("video and playlist URLs must resolve to YouTube", () => {
	const doc = dom(
		'<a href="https://other.example/playlist?list=PL1">outside</a><yt-lockup-view-model><a href="https://other.example/watch?v=abc123XYZ0"></a><h3 title="outside"></h3></yt-lockup-view-model>',
	);
	assert.deepEqual(readPlaylistLinks(doc), []);
	assert.deepEqual(readVideos("playlist", doc), []);
});

test("old and lockup playlist cards supply real video titles and URLs", () => {
	const doc = dom(`
		<ytd-playlist-video-renderer><a href="/watch?v=abc123XYZ0"><span id="video-title">Old title</span></a></ytd-playlist-video-renderer>
		<yt-lockup-view-model class="content-id-xyz987ABC0"><a class="ytLockupViewModelContentImage" href="/watch?v=xyz987ABC0"></a><h3 class="ytLockupMetadataViewModelHeadingReset" title="New title"></h3></yt-lockup-view-model>`);
	const videos = readVideos("playlist", doc);
	assert.deepEqual(
		videos.map((v) => [v.video_id, v.video_title]),
		[
			["abc123XYZ0", "Old title"],
			["xyz987ABC0", "New title"],
		],
	);
});

test("history attaches a day label from the containing section", () => {
	const doc = dom(
		'<ytd-item-section-renderer><ytd-item-section-header-renderer><div id="header"><div id="title">Yesterday</div></div></ytd-item-section-header-renderer><yt-lockup-view-model><a href="/watch?v=abc123XYZ0"></a><h3 title="History title"></h3></yt-lockup-view-model></ytd-item-section-renderer>',
	);
	const [video] = readVideos("history", doc);
	assert.equal(video?.watched_date_label, "Yesterday");
	assert.equal(video?.video_title, "History title");
});
