// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
const sample = (name) => readFileSync(new URL("../../../connectors/youtube/__fixtures__/real-shape/" + name + ".html", import.meta.url), "utf8");
const avatar = '<button id="avatar-btn" aria-label="Account menu"></button>';
const html = (body) => ({ status: 200, contentType: "text/html; charset=utf-8", body });
let loggedIn = true;
const withAvatar = (body) => body.replace("<body>", "<body>" + avatar);
export const setLoggedIn = (value) => { loggedIn = value; };
// The watch history page with no history. YouTube renders the page data's
// message in the message renderer, which the walk's readiness check reads.
const emptyHistoryPage = () => sample("liked-videos-empty-tab").replaceAll("No videos in this playlist", "No watch history")
	.replace("<ytd-message-renderer></ytd-message-renderer>", "<ytd-message-renderer>No watch history</ytd-message-renderer>");
export function resolveFixture(raw) {
	const url = new URL(raw);
	if (!loggedIn) return html('<!doctype html><a href="https://accounts.google.com/ServiceLogin">Sign in</a>');
	if (url.pathname === "/feed/channels") return html(withAvatar(sample("subscriptions-four-source-items")));
	if (url.pathname === "/feed/playlists") return html(withAvatar(sample("playlist-index-view-model")));
	if (url.pathname === "/feed/history") return html(emptyHistoryPage());
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
	let body = emptyHistoryPage();
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

// A synthetic watch history app. The page data holds the first rows and a
// continuation token; when a scroll brings the continuation near the
// viewport, the app sends POST /youtubei/v1/browse with that token and
// appends the rows of its response. `pages` lists each response's row count
// and transport; the last page has no continuation. `status` answers one
// token with an error status (the app shows nothing for it), `reloadOn`
// makes the app reload the document instead of appending, and `eager` makes
// it request the first continuation while the document loads.
export function historyAppFixture({
	first = 4,
	pages = [{ rows: 4, transport: "xhr" }, { rows: 3, transport: "fetch" }],
	status = {},
	reloadOn = null,
	eager = false,
} = {}) {
	const browseRequests = [];
	const id = (n) => "syntheticH" + String.fromCharCode(65 + n);
	const token = (n) => "synthetic-token-" + n;
	const videos = (from, count) => Array.from({ length: count }, (_, i) => ({ videoRenderer: { videoId: id(from + i) } }));
	const continuation = (n) => ({ continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: token(n) } } } });
	const starts = [first];
	for (const page of pages) starts.push(starts[starts.length - 1] + page.rows);
	const data = { contents: { twoColumnBrowseResultsRenderer: { tabs: [{ tabRenderer: { selected: true, content: { sectionListRenderer: { contents: [
		{ itemSectionRenderer: { contents: videos(0, first) } },
		...(pages.length > 0 ? [continuation(1)] : []),
	] } } } }] } } };
	const app = `(() => {
 const transports = ${JSON.stringify(pages.map((page) => page.transport))};
 const reloadOn = ${JSON.stringify(reloadOn)};
 const section = document.querySelector("ytd-item-section-renderer");
 const marker = document.querySelector("ytd-continuation-item-renderer");
 const row = (videoId) => '<ytd-video-renderer style="display:block;height:300px"><a href="/watch?v=' + videoId + '"></a><h3>Synthetic history ' + videoId + '</h3></ytd-video-renderer>';
 let next = ${pages.length > 0 ? 1 : 0};
 let loading = false;
 const append = (text) => {
  let body = null;
  try { body = JSON.parse(text); } catch (error) { return; }
  const items = body.onResponseReceivedActions[0].appendContinuationItemsAction.continuationItems;
  const ids = [];
  let token = null;
  for (const item of items) {
   for (const child of item.itemSectionRenderer?.contents ?? []) ids.push(child.videoRenderer.videoId);
   if (item.continuationItemRenderer) token = item.continuationItemRenderer.continuationEndpoint.continuationCommand.token;
  }
  section.insertAdjacentHTML("beforeend", ids.map(row).join(""));
  if (token) { next += 1; section.appendChild(marker); } else { next = 0; marker.remove(); }
 };
 const load = (force) => {
  if (loading || !next || (!force && marker.getBoundingClientRect().top > window.innerHeight + 300)) return;
  if (reloadOn === next) { location.reload(); return; }
  loading = true;
  const body = JSON.stringify({ context: { client: { clientName: "WEB" } }, continuation: "synthetic-token-" + next });
  const done = (status, text) => { loading = false; if (status === 200) append(text); };
  if (transports[next - 1] === "fetch") {
   fetch("/youtubei/v1/browse?prettyPrint=false", { method: "POST", body, headers: { "content-type": "application/json" } })
    .then((response) => response.text().then((text) => done(response.status, text)));
  } else {
   const xhr = new XMLHttpRequest();
   xhr.open("POST", "/youtubei/v1/browse?prettyPrint=false");
   xhr.setRequestHeader("content-type", "application/json");
   xhr.onload = () => done(xhr.status, xhr.responseText);
   xhr.send(body);
  }
 };
 window.addEventListener("scroll", () => load(false));
 if (${JSON.stringify(eager)}) load(true);
})();`;
	const historyPage = () => html('<!doctype html><html><body>' + avatar +
		'<ytd-item-section-renderer><div id="header"><span id="title">Today</span></div>' +
		videos(0, first).map(({ videoRenderer: { videoId } }) => '<ytd-video-renderer style="display:block;height:300px"><a href="/watch?v=' + videoId + '"></a><h3>Synthetic history ' + videoId + '</h3></ytd-video-renderer>').join("") +
		(pages.length > 0 ? '<ytd-continuation-item-renderer style="display:block;height:40px"></ytd-continuation-item-renderer>' : '') +
		'</ytd-item-section-renderer><script>window.ytInitialData=' + JSON.stringify(data) + '</script><script>' + app + '</script></body></html>');
	const resolve = (raw, request = {}) => {
		const url = new URL(raw);
		if (url.pathname === "/feed/history") return historyPage();
		if (url.pathname === "/youtubei/v1/browse") {
			let requested = null;
			try { requested = JSON.parse(request.postData ?? "null")?.continuation ?? null; } catch {}
			browseRequests.push(requested);
			const n = Number(String(requested).replace("synthetic-token-", ""));
			const page = pages[n - 1];
			if (!page) return { status: 404, contentType: "application/json", body: "{}" };
			if (status[requested]) return { status: status[requested], contentType: "application/json", body: '{"error":{}}' };
			const items = [{ itemSectionRenderer: { contents: videos(starts[n - 1], page.rows) } }, ...(n < pages.length ? [continuation(n + 1)] : [])];
			return { status: 200, contentType: "application/json",
				body: JSON.stringify({ onResponseReceivedActions: [{ appendContinuationItemsAction: { continuationItems: items } }] }) };
		}
		return resolveFixture(raw);
	};
	return { resolve, browseRequests, ids: Array.from({ length: starts[starts.length - 1] }, (_, n) => id(n)) };
}
