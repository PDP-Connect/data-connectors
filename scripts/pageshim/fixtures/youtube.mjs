// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
const sample = (name) => readFileSync(new URL("../../../connectors/youtube/__fixtures__/real-shape/" + name + ".html", import.meta.url), "utf8");
const avatar = '<button id="avatar-btn" aria-label="Account menu"></button>';
const html = (body) => ({ status: 200, contentType: "text/html; charset=utf-8", body });
let loggedIn = true;
const withAvatar = (body) => body.replace("<body>", "<body>" + avatar);
// The rendered empty-history message carries its text, as YouTube's does; the
// full traversal waits for that rendered text before it trusts the page data.
const emptyHistoryBody = () => sample("liked-videos-empty-tab").replaceAll("No videos in this playlist", "No watch history")
	.replace("<ytd-message-renderer></ytd-message-renderer>", "<ytd-message-renderer>No watch history</ytd-message-renderer>");
export const setLoggedIn = (value) => { loggedIn = value; };
export function resolveFixture(raw) {
	const url = new URL(raw);
	if (!loggedIn) return html('<!doctype html><a href="https://accounts.google.com/ServiceLogin">Sign in</a>');
	if (url.pathname === "/feed/channels") return html(withAvatar(sample("subscriptions-four-source-items")));
	if (url.pathname === "/feed/playlists") return html(withAvatar(sample("playlist-index-view-model")));
	if (url.pathname === "/feed/history") return html(emptyHistoryBody());
	if (url.pathname === "/playlist") return html(withAvatar(sample("watch-later-playlist-items").replaceAll("WL", url.searchParams.get("list"))).replace("</body>", '<h1 id="title">Synthetic playlist</h1></body>'));
	return accountHomeFixture();
}
export const youtubeFixtures = {
	hosts: /^https:\/\/www\.youtube\.com\//,
	resolve: resolveFixture,
	setLoggedIn,
	loginUrl: "https://www.youtube.com/",
	homeUrl: "https://www.youtube.com/",
};
const details = { profile: 1, subscriptions: 4, playlists: 1, playlist_items: 2, likes: 2, watch_later: 2, watch_history: 0 };
export const pageshimCase = {
	fixtures: youtubeFixtures,
	scopes: Object.keys(details).map((s) => "youtube." + s),
	exportSummary: { count: 12, label: "records", details },
	emptyExportSummary: { count: 0, label: "records", details: Object.fromEntries(Object.keys(details).map((s) => [s, 0])) },
};
export function historyPrefixFixture(count = 1) {
	const videos = Array.from({ length: count }, (_, index) => ({ videoRenderer: { videoId: count === 1 ? "synthetic-history" : `synthetic-history-${index}` } }));
	const rows = videos.map(({ videoRenderer: { videoId } }) => `<ytd-video-renderer><a href="/watch?v=${videoId}"></a><h3>Synthetic history</h3></ytd-video-renderer>`).join("");
	const data = { contents: { twoColumnBrowseResultsRenderer: { tabs: [{ tabRenderer: { selected: true, content: { sectionListRenderer: { contents: [{ itemSectionRenderer: { contents: [
		...videos,
		{ continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: "synthetic-next" } } } },
	] } }] } } } }] } } };
	return html('<!doctype html><html><body>' + avatar + '<ytd-item-section-renderer><div id="header"><span id="title">Today</span></div>' + rows + '<ytd-continuation-item-renderer></ytd-continuation-item-renderer></ytd-item-section-renderer><script>window.ytInitialData=' + JSON.stringify(data) + '</script></body></html>');
}

export function accountHomeFixture(ownChannel = false) {
	const header = '<ytd-active-account-header-renderer><span id="email">synthetic@example.test</span>' +
		(ownChannel ? '<a href="/@synthetic-owner">Your channel</a>' : '') + '</ytd-active-account-header-renderer>';
	// A no-op avatar click must not expose the account identity.
	return html('<!doctype html><html><body>' + avatar + '<script>document.querySelector("#avatar-btn").onclick = () => {' +
		'document.body.insertAdjacentHTML("beforeend", ' + JSON.stringify(header) + ');' +
		'}</script></body></html>');
}
export function ownChannelFixture(raw) {
	const path = new URL(raw).pathname;
	if (path === "/") return accountHomeFixture(true);
	if (path === "/@synthetic-owner") return html('<!doctype html><html><head><link rel="canonical" href="https://www.youtube.com/channel/UCsyntheticOwner"></head><body>' +
		avatar + '<h1>Synthetic owner</h1></body></html>');
	if (path === "/@synthetic-owner/about") return html('<!doctype html><html><body>' + avatar +
		'<ytd-channel-about-metadata-renderer><div id="description">Owner about-page description</div>' +
		'<span>Joined Jan 2, 2020</span><span id="country">Canada</span><span>123 subscribers</span>' +
		'<span>456 views</span><span>7 videos</span></ytd-channel-about-metadata-renderer></body></html>');
	return resolveFixture(raw);
}
// Current YouTube: the avatar menu header has no email text; the Switch account
// view shows the signed-in account's email in its own header, above a list of
// other accounts.
export function switchAccountEmailFixture(raw, handlerOn = "renderer") {
	if (new URL(raw).pathname !== "/") return ownChannelFixture(raw);
	const menu = '<ytd-active-account-header-renderer><span id="email"></span><a href="/@synthetic-owner">Your channel</a></ytd-active-account-header-renderer>' +
		'<ytd-multi-page-menu-renderer><ytd-compact-link-renderer id="switch"><a id="endpoint"><span id="label">Switch account</span></a></ytd-compact-link-renderer></ytd-multi-page-menu-renderer>';
	const view = '<ytd-google-account-header-renderer><yt-formatted-string id="email">synthetic@example.test</yt-formatted-string></ytd-google-account-header-renderer>' +
		'<ytd-account-item-renderer><span id="email">other-account@example.test</span></ytd-account-item-renderer>';
	return html('<!doctype html><html><body>' + avatar + '<script>document.querySelector("#avatar-btn").onclick = () => {' +
		'document.body.insertAdjacentHTML("beforeend", ' + JSON.stringify(menu) + ');' +
		'document.querySelector(' + JSON.stringify(handlerOn === "anchor" ? "#switch a#endpoint" : "#switch") + ').onclick = () => document.body.insertAdjacentHTML("beforeend", ' + JSON.stringify(view) + ');' +
		'}</script></body></html>');
}
export function historyEvidenceLossFixture(kind) {
	let body = emptyHistoryBody();
	const login = '<a href="https://accounts.google.com/ServiceLogin">Sign in</a>';
	if (kind === "login-wall") body = body.replace(avatar, login);
	else if (kind === "consent-wall") body = body.replace("</body>", '<div id="consent-bump">Consent required</div></body>');
	else {
		if (!["evidence-mid-read", "session-mid-read"].includes(kind)) throw new Error("Unknown history loss fixture");
		// Trigger during the actual row read, after the first empty proof, without
		// timing races or replacing collector return values. Restore the DOM method.
		body = body.replace("</body>", '<script>(' + (() => {
			const original = document.querySelectorAll;
			document.querySelectorAll = function(selector) {
				const rows = original.call(this, selector);
				if (selector === "ytd-item-section-renderer") {
					document.querySelectorAll = original;
					if (LOSS_KIND === "evidence-mid-read") {
						window.ytInitialData = null;
						original.call(document, "script").forEach(node => node.remove());
					} else {
						document.querySelector("#avatar-btn").remove();
						document.body.insertAdjacentHTML("beforeend", LOGIN_WALL);
					}
				}
				return rows;
			};
		}).toString().replaceAll("LOSS_KIND", JSON.stringify(kind)).replaceAll("LOGIN_WALL", JSON.stringify(login)) + ')()</script></body>');
	}
	return html(body);
}

// A history page that loads more rows by scrolling, the way YouTube does: each
// scroll sends one /youtubei/v1/browse POST whose body is a gzip Request, and
// the answer holds the next rows plus the next (5000-character) token. The host
// cannot read a gzip body here, so the Nth browse call returns the Nth batch.
// `nativeFetch` makes the page keep its own fetch from before any wrapper, so
// no wrapper can see its calls.
export function historyContinuationFixtures({ batches = 3, batchSize = 30, nativeFetch = false } = {}) {
	const token = (n) => String(n).padStart(4, "0") + "t".repeat(5000);
	const id = (index) => `synthetic-history-${index}`;
	const batch = (n) => Array.from({ length: batchSize }, (_, i) => id(n * batchSize + i));
	const row = (videoId) => `<ytd-video-renderer style="display:block;height:300px"><a href="/watch?v=${videoId}"></a><h3>Synthetic history</h3></ytd-video-renderer>`;
	const first = batch(0);
	const data = { contents: { twoColumnBrowseResultsRenderer: { tabs: [{ tabRenderer: { selected: true, content: { sectionListRenderer: { contents: [{ itemSectionRenderer: { contents: [
		...first.map((videoId) => ({ videoRenderer: { videoId } })),
		{ continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: token(1) } } } },
	] } }] } } } }] } } };
	const script = `(() => {
		const send = ${nativeFetch ? "window.fetch.bind(window)" : "((...args) => window.fetch(...args))"};
		let next = ${JSON.stringify(token(1))};
		let loading = false;
		const gzip = async (text) => new Response(new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
		const more = async () => {
			if (!next || loading) return;
			loading = true;
			const body = await gzip(JSON.stringify({ context: {}, continuation: next }));
			const response = await send(new Request("/youtubei/v1/browse?prettyPrint=false", { method: "POST", body, headers: { "content-encoding": "gzip", "content-type": "application/json" } }));
			const json = await response.json();
			const items = json.onResponseReceivedActions[0].appendContinuationItemsAction.continuationItems;
			const marker = document.querySelector("ytd-continuation-item-renderer");
			for (const item of items) if (item.videoRenderer) marker.insertAdjacentHTML("beforebegin", ${JSON.stringify(row("@@"))}.replace("@@", item.videoRenderer.videoId));
			const more = items.find((item) => item.continuationItemRenderer);
			next = more ? more.continuationItemRenderer.continuationEndpoint.continuationCommand.token : null;
			if (!next) marker.remove();
			loading = false;
		};
		window.addEventListener("scroll", () => { more(); });
	})();`;
	let calls = 0;
	return {
		...youtubeFixtures,
		browseCalls: () => calls,
		resolve(raw, request) {
			const url = new URL(raw);
			if (url.pathname === "/youtubei/v1/browse") {
				calls += 1;
				const items = batch(calls).map((videoId) => ({ videoRenderer: { videoId } }));
				if (calls < batches) items.push({ continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: token(calls + 1) } } } });
				return { status: 200, contentType: "application/json", body: JSON.stringify({ onResponseReceivedActions: [{ appendContinuationItemsAction: { continuationItems: items } }] }) };
			}
			if (url.pathname !== "/feed/history") return resolveFixture(raw, request);
			return html('<!doctype html><html><body>' + avatar + '<ytd-item-section-renderer><div id="header"><span id="title">Today</span></div>' + first.map(row).join("") + '<ytd-continuation-item-renderer></ytd-continuation-item-renderer></ytd-item-section-renderer><script>window.ytInitialData=' + JSON.stringify(data) + '</script><script>' + script + '</script></body></html>');
		},
	};
}
