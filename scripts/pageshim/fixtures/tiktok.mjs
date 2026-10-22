// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Synthetic only. Serves www.tiktok.com for the pageshim harness with the
// response shapes the tiktok connector reads (copied from its own synthetic
// __fixtures__, values invented). Every page stands in for the TikTok web
// app: it makes one API request of its own carrying the web client fields
// (aid, app_name, device_id, ...), which the connector's page reader copies.
// The API routes answer an empty body (TikTok's refusal) to a request that
// does not carry those client fields, so a passing run proves the reader
// copied them. The account endpoint names the person when signed in and
// answers an error object, naming no one, when signed out. The real web app,
// its request signing and a WebView on a device are not exercised here.

import { readFileSync } from "node:fs";

const ORIGIN = "https://www.tiktok.com";
const dir = new URL(
	"../../../connectors/tiktok/__fixtures__/",
	import.meta.url,
);
const fx = (name) => JSON.parse(readFileSync(new URL(name, dir), "utf8"));

// A secUid is URL-safe base64 (the page reader refuses anything else); the
// shared fixture's placeholder text is replaced with an invented one.
const SEC_UID = "MS4wLjABAAAASyntheticSecUidOnlyForThePageShimFixture000000";
const sharedAccount = fx("passport-account-info-v2.json");
const account = {
	...sharedAccount,
	data: { ...sharedAccount.data, sec_user_id: SEC_UID },
};
const settings = fx("user-settings.json");
const posts = fx("post-item-list.json");
const liked = fx("favorite-item-list.json");
const users = fx("user-list.json");

/** Client fields the page's own request carries; invented values. */
const CLIENT_QUERY =
	"WebIdLastTime=1792600000&aid=1988&app_language=en&app_name=tiktok_web&browser_language=en-US&browser_name=Mozilla&browser_online=true&browser_platform=MacIntel&channel=tiktok_web&cookie_enabled=true&device_id=7000000000000000001&device_platform=web_pc&os=mac&region=CA&tz_name=Etc%2FUTC&user_is_login=true";

const itemPage = (items, hasMore, cursor) => ({
	...posts,
	cursor,
	hasMore,
	itemList: items,
});

const renumber = (items, base) =>
	items.map((item, index) => ({ ...item, id: String(base + index) }));

const VIDEOS_PAGE_1 = itemPage(
	posts.itemList.slice(0, 2),
	true,
	"1781904178000",
);
const VIDEOS_PAGE_2 = itemPage(posts.itemList.slice(2), false, "1781830907000");
const LIKES = itemPage(liked.itemList, false, "1781998438000");
const FAVORITES = itemPage(
	renumber(liked.itemList.slice(0, 1), 500001),
	false,
	"0",
);

const following = { ...users, total: 1 };
const followers = {
	...users,
	total: 2,
	userList: [
		users.userList[0],
		{
			...users.userList[0],
			user: {
				...users.userList[0].user,
				id: "100099",
				uniqueId: "synthetic.follower",
			},
		},
	],
};

const signedOutAccount = {
	data: { description: "Synthetic: please sign in.", error_code: 1 },
	message: "error",
};

const html = (body) => ({
	status: 200,
	contentType: "text/html; charset=utf-8",
	body: `<!doctype html><html><head><title>TikTok</title></head><body>${body}</body></html>`,
});
const json = (value) => ({
	status: 200,
	contentType: "application/json",
	body: JSON.stringify(value),
});
const refused = () => ({
	status: 200,
	contentType: "application/json",
	body: "",
});

const appPage = () =>
	html(`<div id="app">TikTok</div>
<script>
// The web app's own request on load, as www.tiktok.com makes on every page.
fetch("/api/user/settings/?${CLIENT_QUERY}", { credentials: "include" }).catch(() => {});
</script>`);

/** Every API request the connector or the page made: `path?query`. */
export const apiRequests = [];

let loggedIn = true;

function answerApi(url) {
	apiRequests.push(`${url.pathname}${url.search}`);
	const q = url.searchParams;
	if (url.pathname === "/passport/account/info/v2/")
		return json(loggedIn ? account : signedOutAccount);
	// TikTok answers a request without its web client fields with no body.
	if (q.get("aid") !== "1988" || q.get("device_id") === null) return refused();
	if (!loggedIn) return json({ statusCode: 8, status_code: 8, status_msg: "" });
	switch (url.pathname) {
		case "/api/user/settings/":
			return json(settings);
		case "/api/post/item_list/":
			if (q.get("secUid") !== SEC_UID) break;
			if (q.get("cursor") === "0") return json(VIDEOS_PAGE_1);
			if (q.get("cursor") === VIDEOS_PAGE_1.cursor) return json(VIDEOS_PAGE_2);
			break;
		case "/api/favorite/item_list/":
			if (q.get("secUid") === SEC_UID && q.get("cursor") === "0")
				return json(LIKES);
			break;
		case "/api/user/collect/item_list/":
			if (q.get("secUid") === SEC_UID && q.get("cursor") === "0")
				return json(FAVORITES);
			break;
		case "/api/user/list/":
			if (q.get("scene") === "21") return json(following);
			if (q.get("scene") === "67") return json(followers);
			break;
		default:
			break;
	}
	return json({ statusCode: 10201, status_code: 10201, status_msg: "" });
}

export function resolveFixture(raw) {
	const url = new URL(raw);
	if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/passport/"))
		return answerApi(url);
	return appPage();
}

export const tiktokFixtures = {
	hosts: /^https:\/\/www\.tiktok\.com\//,
	loginUrl: `${ORIGIN}/login`,
	homeUrl: `${ORIGIN}/profile`,
	resolve: resolveFixture,
	async setLoggedIn(value, page) {
		loggedIn = value;
		if (page) await page.reload({ waitUntil: "load" });
	},
};

const STREAMS = [
	"profile",
	"videos",
	"likes",
	"favorites",
	"following",
	"followers",
];

export const pageshimCase = {
	fixtures: tiktokFixtures,
	scopes: STREAMS.map((stream) => `tiktok.${stream}`),
	exportSummary: {
		count: 11,
		label: "records",
		details: {
			profile: 1,
			videos: 3,
			likes: 3,
			favorites: 1,
			following: 1,
			followers: 2,
		},
	},
	emptyExportSummary: {
		count: 0,
		label: "records",
		details: {
			profile: 0,
			videos: 0,
			likes: 0,
			favorites: 0,
			following: 0,
			followers: 0,
		},
	},
};
