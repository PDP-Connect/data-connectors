// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
const sample = (name) => readFileSync(new URL("../../../connectors/youtube/__fixtures__/real-shape/" + name + ".html", import.meta.url), "utf8");
const avatar = '<button id="avatar-btn" aria-label="Account menu"></button>';
const html = (body) => ({ status: 200, contentType: "text/html; charset=utf-8", body });
let loggedIn = true;
const withAvatar = (body) => body.replace("<body>", "<body>" + avatar);
export const setLoggedIn = (value) => { loggedIn = value; };
export function resolveFixture(raw) {
	const url = new URL(raw);
	if (!loggedIn) return html('<!doctype html><a href="https://accounts.google.com/ServiceLogin">Sign in</a>');
	if (url.pathname === "/feed/channels") return html(withAvatar(sample("subscriptions-four-source-items")));
	if (url.pathname === "/feed/playlists") return html(withAvatar(sample("playlist-index-view-model")));
	if (url.pathname === "/feed/history") return html(sample("liked-videos-empty-tab").replaceAll("No videos in this playlist", "No watch history"));
	if (url.pathname === "/playlist") return html(withAvatar(sample("watch-later-playlist-items").replaceAll("WL", url.searchParams.get("list"))).replace("</body>", '<h1 id="title">Synthetic playlist</h1></body>'));
	return html('<!doctype html><html><body>' + avatar + '<ytd-active-account-header-renderer><span id="email">synthetic@example.test</span></ytd-active-account-header-renderer></body></html>');
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
export function historyPrefixFixture() {
	const data = { contents: { twoColumnBrowseResultsRenderer: { tabs: [{ tabRenderer: { selected: true, content: { sectionListRenderer: { contents: [{ itemSectionRenderer: { contents: [
		{ videoRenderer: { videoId: "synthetic-history" } },
		{ continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: "synthetic-next" } } } },
	] } }] } } } }] } } };
	return html('<!doctype html><html><body>' + avatar + '<ytd-item-section-renderer><div id="header"><span id="title">Today</span></div><ytd-video-renderer><a href="/watch?v=synthetic-history"></a><h3>Synthetic history</h3></ytd-video-renderer><ytd-continuation-item-renderer></ytd-continuation-item-renderer></ytd-item-section-renderer><script>window.ytInitialData=' + JSON.stringify(data) + '</script></body></html>');
}
