// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// A synthetic x.com for the pageshim harness, so x_browser runs with no
// network. x_browser makes no request of its own: it reads the responses of
// the requests the web app makes. So this fixture is a small web app. It
// routes on the client, fetches `/i/api/graphql/<queryId>/<Operation>` over
// XMLHttpRequest when a view opens, and fetches the next page with a `cursor`
// variable when the window nears the bottom of the list. The response bodies
// are connectors/x_browser/fixtures.
//
// It models what was seen on x.com on 2026-10-08 (see those fixtures'
// README). It is not x.com: a pass here says the connector and this model
// agree, not that x.com behaves this way.

import { readFileSync } from "node:fs";

const dir = new URL("../../../connectors/x_browser/fixtures/", import.meta.url);
const fx = (n) => readFileSync(new URL(n, dir), "utf8");

export const OWNER_ID = "1900000000000000001";
export const OWNER_HANDLE = "sample_owner";

const cursorOnly = (bookmarks, bottom) => {
	const instructions = [
		{
			type: "TimelineAddEntries",
			entries: [
				{
					entryId: "cursor-top-0",
					sortIndex: "9",
					content: {
						entryType: "TimelineTimelineCursor",
						value: `${bottom}-top`,
						cursorType: "Top",
					},
				},
				{
					entryId: "cursor-bottom-0",
					sortIndex: "0",
					content: {
						entryType: "TimelineTimelineCursor",
						value: bottom,
						cursorType: "Bottom",
					},
				},
			],
		},
	];
	return JSON.stringify(
		bookmarks
			? { data: { bookmark_timeline_v2: { timeline: { instructions } } } }
			: {
					data: {
						user: { result: { timeline: { timeline: { instructions } } } },
					},
				},
	);
};

/** Response bodies by operation, then by the request's `cursor` ("" for the first page). */
export const PAGES = {
	UserByScreenName: { "": fx("user-by-screen-name.json") },
	UserOriginalsTimeline: {
		"": fx("user-originals-timeline-page-1.json"),
		"synthetic-originals-bottom-1": cursorOnly(false, "synthetic-originals-end"),
	},
	UserRepliesTimeline: {
		"": fx("user-replies-timeline-page-1.json"),
		"synthetic-replies-bottom-1": cursorOnly(false, "synthetic-replies-end"),
	},
	Likes: {
		"": fx("likes-page-1.json"),
		"synthetic-likes-bottom-1": fx("likes-page-2.json"),
		"synthetic-likes-bottom-2": cursorOnly(false, "synthetic-likes-end"),
	},
	Bookmarks: {
		"": fx("bookmarks-page-1.json"),
		"synthetic-bookmarks-bottom-1": cursorOnly(true, "synthetic-bookmarks-end"),
	},
};

const html = (body) => ({
	status: 200,
	contentType: "text/html; charset=utf-8",
	body,
});
const json = (body, status = 200) => ({
	status,
	contentType: "application/json; charset=utf-8",
	body,
});

// Signed out, x.com sends every page to its sign-in flow. The session
// cookies are gone.
const SIGNED_OUT = `<!doctype html><html><body><form><input name="text" autocomplete="username"></form><script>
document.cookie = "twid=; path=/; max-age=0";
document.cookie = "ct0=; path=/; max-age=0";
if (location.pathname !== "/login") history.replaceState(null, "", "/i/flow/login");
</script></body></html>`;

/**
 * The signed-in web app. `sidebar: false` is a narrow layout: no primary
 * navigation, only a link named Profile. The request variables are the keys
 * seen on x.com; Bookmarks carries no userId.
 */
const webApp = ({ sidebar }) => `<!doctype html><html><head><meta charset="utf-8"><style>
body { margin: 0; font-family: sans-serif; }
.post { height: 480px; border-bottom: 1px solid #ccc; }
</style></head><body>
${
	sidebar
		? `<header><nav aria-label="Primary">
<a href="/home">Home</a>
<a href="/i/history">History</a>
<a href="/${OWNER_HANDLE}" data-testid="AppTabBar_Profile_Link">Profile</a>
</nav>
<button data-testid="SideNav_AccountSwitcher_Button">Sample Owner<br>@${OWNER_HANDLE}</button></header>`
		: `<footer><a href="/${OWNER_HANDLE}" aria-label="Profile">Profile</a></footer>`
}
<main><div id="tabs"></div><div id="list"></div></main>
<script>
document.cookie = "twid=u%3D${OWNER_ID}; path=/";
document.cookie = "ct0=synthetic-csrf-token; path=/";
(() => {
	const HANDLE = ${JSON.stringify(OWNER_HANDLE)};
	const OWNER = ${JSON.stringify(OWNER_ID)};
	const QUERY_ID = "SyntheticQueryId" + Math.random().toString(36).slice(2, 8);
	const tabs = document.getElementById("tabs");
	const list = document.getElementById("list");
	let view = 0;
	let timeline = null;
	const request = (operation, variables, done) => {
		const xhr = new XMLHttpRequest();
		xhr.open(
			"GET",
			"/i/api/graphql/" + QUERY_ID + "/" + operation +
				"?variables=" + encodeURIComponent(JSON.stringify(variables)) +
				"&features=" + encodeURIComponent("{}"),
		);
		xhr.onloadend = () => done(xhr.status, xhr.responseText);
		xhr.send();
	};
	const instructionsOf = (payload) => {
		const data = payload && payload.data;
		if (data && data.bookmark_timeline_v2) return data.bookmark_timeline_v2.timeline.instructions;
		return data && data.user && data.user.result.timeline.timeline.instructions;
	};
	const loadPage = () => {
		const current = timeline;
		if (!current || current.loading || current.ended) return;
		current.loading = true;
		const variables = Object.assign({ count: 20 }, current.variables);
		if (current.cursor) variables.cursor = current.cursor;
		request(current.operation, variables, (status, text) => {
			current.loading = false;
			if (current.view !== view) return;
			let instructions = null;
			try {
				instructions = status === 200 ? instructionsOf(JSON.parse(text)) : null;
			} catch (error) {}
			if (!Array.isArray(instructions)) {
				current.ended = true;
				return;
			}
			let posts = 0;
			let bottom = null;
			for (const instruction of instructions) {
				const entries = instruction.entries || (instruction.entry ? [instruction.entry] : []);
				for (const entry of entries) {
					const content = entry.content || {};
					if (content.entryType === "TimelineTimelineCursor") {
						if (content.cursorType === "Bottom") bottom = content.value;
						continue;
					}
					posts += 1;
					const row = document.createElement("div");
					row.className = "post";
					row.textContent = entry.entryId;
					list.appendChild(row);
				}
			}
			current.cursor = bottom;
			if (posts === 0 || !bottom) current.ended = true;
			else maybeLoadMore();
		});
	};
	const maybeLoadMore = () => {
		const root = document.documentElement;
		if (root.scrollHeight - (window.scrollY + window.innerHeight) < 400) loadPage();
	};
	const tabLinks = (links) => {
		tabs.innerHTML = "";
		if (links.length === 0) return;
		const bar = document.createElement("div");
		bar.setAttribute("role", "tablist");
		for (const [href, label] of links) {
			const link = document.createElement("a");
			link.setAttribute("href", href);
			link.setAttribute("role", "tab");
			link.textContent = label;
			bar.appendChild(link);
		}
		tabs.appendChild(bar);
	};
	const open = (operation, variables) => {
		timeline = { view, operation, variables, cursor: null, loading: false, ended: false };
		loadPage();
	};
	const render = () => {
		view += 1;
		timeline = null;
		list.innerHTML = "";
		window.scrollTo(0, 0);
		const path = location.pathname;
		const profileTabs = [["/" + HANDLE, "Posts"], ["/" + HANDLE + "/with_replies", "Replies"]];
		const historyTabs = [["/i/history", "Bookmarks"], ["/i/history/likes", "Likes"]];
		if (path === "/" + HANDLE) {
			tabLinks(profileTabs);
			request("UserByScreenName", { screen_name: HANDLE }, () => {});
			open("UserOriginalsTimeline", { userId: OWNER, includePromotedContent: true, withQuickPromoteEligibilityTweetFields: true, withVoice: true });
		} else if (path === "/" + HANDLE + "/with_replies") {
			tabLinks(profileTabs);
			open("UserRepliesTimeline", { userId: OWNER, includePromotedContent: true, withCommunity: true, withVoice: true });
		} else if (path === "/i/history") {
			tabLinks(historyTabs);
			open("Bookmarks", { includePromotedContent: true });
		} else if (path === "/i/history/likes") {
			tabLinks(historyTabs);
			open("Likes", { userId: OWNER, includePromotedContent: false, withClientEventToken: false, withBirdwatchNotes: false, withVoice: true });
		} else {
			tabLinks([]);
			// The app makes other GraphQL requests the connector does not read.
			request("HomeTimeline", { count: 20 }, () => {});
		}
	};
	document.addEventListener("click", (event) => {
		const link = event.target && event.target.closest ? event.target.closest("a") : null;
		if (!link || link.origin !== location.origin) return;
		event.preventDefault();
		if (link.pathname === location.pathname) return;
		history.pushState({}, "", link.pathname);
		render();
	});
	window.addEventListener("popstate", render);
	window.addEventListener("scroll", maybeLoadMore);
	render();
})();
</script></body></html>`;

/**
 * A resolver for the synthetic x.com.
 *
 * @param {object} [o]
 * @param {boolean} [o.sidebar] false serves the narrow layout
 * @param {Record<string, Record<string, string>>} [o.pages] bodies by operation and cursor
 * @param {(request: {operation: string, cursor: string, variables: object}) => ({status: number, contentType: string, body: string} | undefined)} [o.graphql]
 *   answers a GraphQL request before the fixture pages do
 */
export function makeResolver({ sidebar = true, pages = PAGES, graphql } = {}) {
	return function resolve(raw) {
		const url = new URL(raw);
		const match = /^\/i\/api\/graphql\/[^/]+\/([A-Za-z0-9_]+)$/.exec(
			url.pathname,
		);
		if (match) {
			if (!loggedIn) return json('{"errors":[{"code":32}]}', 401);
			let variables = {};
			try {
				variables = JSON.parse(url.searchParams.get("variables") || "{}");
			} catch {}
			const operation = match[1];
			const cursor = typeof variables.cursor === "string" ? variables.cursor : "";
			const override = graphql?.({ operation, cursor, variables });
			if (override) return override;
			const body = pages[operation]?.[cursor];
			// Operations the connector does not read get an empty answer.
			return json(body ?? '{"data":{"viewer":{}}}');
		}
		if (!loggedIn || url.pathname === "/login" || url.pathname === "/i/flow/login")
			return html(SIGNED_OUT);
		return html(webApp({ sidebar }));
	};
}

let loggedIn = true;
export const setLoggedIn = (v) => {
	loggedIn = v;
};

export const resolveFixture = makeResolver();

export const xBrowserFixtures = {
	hosts: /^https:\/\/x\.com\//,
	resolve: resolveFixture,
	setLoggedIn,
	loginUrl: "https://x.com/login",
	homeUrl: "https://x.com/home",
};

/** What pageshim.test.mjs needs to gate x_browser. */
export const pageshimCase = {
	fixtures: xBrowserFixtures,
	scopes: ["x.profile", "x.posts", "x.likes", "x.bookmarks"],
	exportSummary: {
		count: 14,
		label: "items",
		details: { profile: 1, posts: 7, likes: 5, bookmarks: 2 },
	},
	emptyExportSummary: {
		count: 0,
		label: "items",
		details: { profile: 0, posts: 0, likes: 0, bookmarks: 0 },
	},
};
