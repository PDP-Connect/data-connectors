// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import {
	readChannelAbout,
	readChannelPage,
	openSwitchAccount,
	readGoogleAccountEmail,
	readOwnAccount,
	readPlaylistLinks,
	readSubscriptions,
	readVideos,
} from "./browser-dom.ts";
import { validateRecord } from "./schemas.ts";

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
	assert.equal(about.video_count_text, null);
});

test("document-level About fallback never reads unrelated counts", () => {
	const about = readChannelAbout(
		dom(
			"<aside><span>999 views</span><span>77 videos</span></aside><span>Joined Jan 3, 2020</span>",
		),
	);
	assert.equal(about.joined_at, "Jan 3, 2020");
	assert.equal(about.view_count_text, null);
	assert.equal(about.video_count_text, null);
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

test("subscription renderers preserve displayed counts and omit missing text", () => {
	const html = readFileSync(
		new URL("./__fixtures__/subscriptions-subscriber-count.html", import.meta.url),
		"utf8",
	);
	const subscriptions = readSubscriptions(dom(html));
	assert.equal(subscriptions.length, 4);
	assert.equal(subscriptions[0]?.subscriber_count_text, "1.2M subscribers");
	assert.equal(subscriptions[3]?.subscriber_count_text, "1,2 M d’abonnés");
	for (const subscription of subscriptions.slice(1, 3))
		assert.equal(Object.hasOwn(subscription, "subscriber_count_text"), false);
});

test("subscription avatars that have not loaded read as null, not an empty URL", () => {
	// The scrubbed live captures hold avatar <img> elements with no src: YouTube
	// sets it only once the card nears the viewport. An empty src reads as "",
	// which the URL schema rejects, so every such card was a shape-check skip.
	for (const name of [
		"subscriptions-before-scroll.html",
		"subscriptions-after-scroll.html",
	]) {
		const html = readFileSync(
			new URL(`./__fixtures__/real-shape/${name}`, import.meta.url),
			"utf8",
		);
		const subscriptions = readSubscriptions(dom(html));
		assert.ok(subscriptions.length > 0, name);
		for (const channel of subscriptions) {
			assert.equal(channel.avatar_url, null, name);
			const { subscriber_count_text: _text, ...fields } = channel;
			const result = validateRecord("subscriptions", {
				id: channel.channel_url,
				...fields,
				subscriber_count: null,
			});
			assert.equal(result.ok, true, `${name}: ${JSON.stringify(result)}`);
		}
	}
});

test("subscription avatars keep a loaded https src", () => {
	const [channel] = readSubscriptions(
		dom(
			'<ytd-channel-renderer><a id="main-link" href="/@synthetic"></a><ytd-channel-name><yt-formatted-string id="text">Synthetic</yt-formatted-string></ytd-channel-name><yt-img-shadow><img src="https://yt3.ggpht.com/synthetic=s88"></yt-img-shadow></ytd-channel-renderer>',
		),
	);
	assert.equal(channel?.avatar_url, "https://yt3.ggpht.com/synthetic=s88");
});

test("video thumbnails without a loaded https src read as null", () => {
	const lockup = (img: string) =>
		`<yt-lockup-view-model class="content-id-abc123XYZ0"><a class="ytLockupViewModelContentImage" href="/watch?v=abc123XYZ0">${img}</a><h3 class="ytLockupMetadataViewModelHeadingReset" title="Title"></h3></yt-lockup-view-model>`;
	const thumbnail = (img: string) =>
		readVideos("playlist", dom(lockup(img)))[0]?.thumbnail_url;
	assert.equal(thumbnail('<img class="yt-core-image">'), null);
	assert.equal(thumbnail('<img class="yt-core-image" src="">'), null);
	assert.equal(
		thumbnail(
			'<img class="yt-core-image" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">',
		),
		null,
	);
	assert.equal(
		thumbnail(
			'<img class="yt-core-image" src="https://i.ytimg.com/vi/abc123XYZ0/hqdefault.jpg">',
		),
		"https://i.ytimg.com/vi/abc123XYZ0/hqdefault.jpg",
	);
	const [legacy] = readVideos(
		"playlist",
		dom(
			'<ytd-playlist-video-renderer><a id="video-title" href="/watch?v=abc123XYZ0">Old</a><ytd-thumbnail><img id="img"></ytd-thumbnail></ytd-playlist-video-renderer>',
		),
	);
	assert.equal(legacy?.thumbnail_url, null);
});

test("channel page avatar without a loaded src reads as null", () => {
	const page = (img: string) => {
		const doc = dom(
			`<h1>Owner</h1><yt-img-shadow id="avatar">${img}</yt-img-shadow>`,
		);
		Object.defineProperty(doc, "location", {
			value: new URL("https://www.youtube.com/@owner"),
			configurable: true,
		});
		return readChannelPage(doc).avatar_url;
	};
	assert.equal(page("<img>"), null);
	assert.equal(
		page('<img src="https://yt3.ggpht.com/owner=s88">'),
		"https://yt3.ggpht.com/owner=s88",
	);
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

test("current lockup view-model playlist cards expose only synthetic owner playlist links", () => {
	const html = readFileSync(
		new URL(
			"./__fixtures__/real-shape/playlist-index-view-model.html",
			import.meta.url,
		),
		"utf8",
	);
	assert.deepEqual(readPlaylistLinks(dom(html)), [
		{
			id: "PL_SYNTHETIC_OWNER_001",
			url: "https://www.youtube.com/playlist?list=PL_SYNTHETIC_OWNER_001",
		},
	]);
});

test("current lockup playlist cards are retained when classic playlist cards also render", () => {
	const doc = dom(`
		<ytd-playlist-renderer><a href="/playlist?list=PL_SYNTHETIC_CLASSIC_001"></a></ytd-playlist-renderer>
		<yt-lockup-view-model><a href="/playlist?list=PL_SYNTHETIC_LOCKUP_002"></a><yt-collection-thumbnail-view-model></yt-collection-thumbnail-view-model></yt-lockup-view-model>`);
	assert.deepEqual(
		readPlaylistLinks(doc).map((playlist) => playlist.id),
		["PL_SYNTHETIC_CLASSIC_001", "PL_SYNTHETIC_LOCKUP_002"],
	);
});

test("modern video lockups with list parameters are excluded beside classic playlists", () => {
	const html = readFileSync(
		new URL(
			"./__fixtures__/real-shape/playlist-index-video-lockup-mixed.html",
			import.meta.url,
		),
		"utf8",
	);
	assert.deepEqual(
		readPlaylistLinks(dom(html)).map((playlist) => playlist.id),
		["PL_SYNTHETIC_CLASSIC_001"],
	);
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

test("current Watch Later playlist renderer shape yields synthetic video rows", () => {
	const html = readFileSync(
		new URL(
			"./__fixtures__/real-shape/watch-later-playlist-items.html",
			import.meta.url,
		),
		"utf8",
	);
	assert.deepEqual(
		readVideos("playlist", dom(html)).map((video) => video.video_id),
		["VIDEO_SYNTHETIC_001", "VIDEO_SYNTHETIC_002"],
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

test("switch-account view yields only the signed-in account header's email", async () => {
	const doc = dom(`
		<ytd-active-account-header-renderer><span id="email"></span></ytd-active-account-header-renderer>
		<ytd-multi-page-menu-renderer>
			<ytd-compact-link-renderer><a><span id="label">Your channel</span></a></ytd-compact-link-renderer>
			<ytd-compact-link-renderer><a><span id="label"> Switch  account </span></a></ytd-compact-link-renderer>
		</ytd-multi-page-menu-renderer>`);
	assert.equal(readGoogleAccountEmail(doc), null);
	let clicked = 0;
	for (const item of doc.querySelectorAll("ytd-compact-link-renderer"))
		item.addEventListener("click", () => {
			clicked += 1;
		});
	doc.querySelector("ytd-compact-link-renderer:last-child")?.addEventListener(
		"click",
		() =>
			doc.body.insertAdjacentHTML("beforeend", SWITCH_VIEW),
	);
	assert.equal(await openSwitchAccount(doc), true);
	assert.equal(clicked, 1);
	assert.equal(readGoogleAccountEmail(doc), "owner@example.com");
});

const SWITCH_VIEW =
	'<ytd-account-section-list-renderer><ytd-google-account-header-renderer><yt-formatted-string id="email">owner@example.com</yt-formatted-string></ytd-google-account-header-renderer><ytd-account-item-renderer><span id="email">other@example.com</span></ytd-account-item-renderer></ytd-account-section-list-renderer>';

for (const placement of ["renderer", "nested anchor"] as const) {
	test(`switch-account opens when the handler sits on the ${placement}`, async () => {
		const doc = dom(`
			<ytd-multi-page-menu-renderer>
				<ytd-compact-link-renderer><a id="endpoint"><span id="label">Switch account</span></a></ytd-compact-link-renderer>
				<ytd-account-item-renderer><a id="endpoint">other</a></ytd-account-item-renderer>
			</ytd-multi-page-menu-renderer>`);
		const target =
			placement === "renderer"
				? doc.querySelector("ytd-compact-link-renderer")
				: doc.querySelector("ytd-compact-link-renderer a#endpoint");
		let listed = 0;
		doc
			.querySelector("ytd-account-item-renderer a")
			?.addEventListener("click", () => {
				listed += 1;
			});
		target?.addEventListener("click", (event) => {
			// A handler on the anchor must not fire for a renderer-only click.
			if (placement === "nested anchor" && event.target !== target) return;
			doc.body.insertAdjacentHTML("beforeend", SWITCH_VIEW);
		});
		assert.equal(await openSwitchAccount(doc), true);
		assert.equal(readGoogleAccountEmail(doc), "owner@example.com");
		assert.equal(listed, 0);
	});
}

test("switch-account reports not opened when the view never appears", async () => {
	const doc = dom(
		'<ytd-multi-page-menu-renderer><ytd-compact-link-renderer><a id="endpoint"><span id="label">Switch account</span></a></ytd-compact-link-renderer></ytd-multi-page-menu-renderer>',
	);
	assert.equal(await openSwitchAccount(doc, 150), false);
});

test("switch-account email reader rejects non-email header text and a missing menu item", async () => {
	assert.equal(await openSwitchAccount(dom("<div></div>")), false);
	assert.equal(
		readGoogleAccountEmail(
			dom(
				'<ytd-google-account-header-renderer><span id="email">Signed in</span></ytd-google-account-header-renderer>',
			),
		),
		null,
	);
});
