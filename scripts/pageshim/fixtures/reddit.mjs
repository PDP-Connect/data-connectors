// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Synthetic only. Serves www.reddit.com and old.reddit.com for the PageShim
// harness. Every page sets the session cookie on reddit.com; `/api/me.json`
// and the account's listing JSON answer only a request that carries it while
// the fixture is signed in, so a passing run proves the connector reads the
// account name and its listings from the signed-in page with its cookies.
// Signed out, `/api/me.json` answers `{}` and the listings 403. Each listing
// holds one invented item. Reddit's real JSON, its login and a WebView on a
// device are not exercised here.

const ACCOUNT = "synthetic_owner";
const SESSION_COOKIE = "reddit_session=synthetic-session";
const CREATED_UTC = 1767225600;

let loggedIn = true;
const setLoggedIn = (value) => {
	loggedIn = value;
};

const json = (body, status = 200) => ({
	status,
	contentType: "application/json",
	body: JSON.stringify(body),
});

const post = (id) => ({
	kind: "t3",
	data: {
		name: `t3_${id}`,
		subreddit: "test",
		title: `Synthetic post ${id}`,
		permalink: `/r/test/comments/${id}/synthetic_post/`,
		url: `https://www.reddit.com/r/test/comments/${id}/synthetic_post/`,
		domain: "self.test",
		selftext: "Synthetic body",
		is_self: true,
		over_18: false,
		score: 3,
		num_comments: 1,
		upvote_ratio: 1,
		created_utc: CREATED_UTC,
	},
});

const comment = (id) => ({
	kind: "t1",
	data: {
		name: `t1_${id}`,
		subreddit: "test",
		body: "Synthetic comment",
		link_id: "t3_post01",
		parent_id: "t3_post01",
		permalink: `/r/test/comments/post01/synthetic_post/${id}/`,
		score: 2,
		created_utc: CREATED_UTC,
	},
});

const LISTINGS = {
	submitted: post("submitted01"),
	comments: comment("comment01"),
	saved: post("saved01"),
	upvoted: post("upvoted01"),
	downvoted: post("downvoted01"),
	hidden: post("hidden01"),
};

function resolve(raw, request = {}) {
	const url = new URL(raw);
	const signedIn =
		loggedIn &&
		String(request.headers?.cookie ?? "")
			.split(/;\s*/)
			.includes(SESSION_COOKIE);
	if (url.pathname === "/api/me.json") {
		return json(signedIn ? { kind: "t2", data: { name: ACCOUNT } } : {});
	}
	const listing = url.pathname.match(
		new RegExp(`^/user/${ACCOUNT}/(\\w+)\\.json$`),
	);
	if (listing) {
		if (url.hostname !== "old.reddit.com") return json({ error: 404 }, 404);
		if (!signedIn) return json({ error: 403 }, 403);
		const child = LISTINGS[listing[1]];
		return child
			? json({ kind: "Listing", data: { children: [child], after: null } })
			: json({ error: 404 }, 404);
	}
	return {
		status: 200,
		contentType: "text/html",
		body: `<!doctype html><html><body><script>document.cookie = "${SESSION_COOKIE}; domain=reddit.com; path=/; Secure; SameSite=Lax";</script>Reddit fixture</body></html>`,
	};
}

const STREAMS = [
	"submitted",
	"submitted_stats",
	"comments",
	"comments_stats",
	"saved",
	"upvoted",
	"upvoted_stats",
	"downvoted",
	"downvoted_stats",
	"hidden",
	"hidden_stats",
];

export const pageshimCase = {
	fixtures: {
		hosts: /^https:\/\/(?:www|old)\.reddit\.com\//,
		resolve,
		setLoggedIn,
		loginUrl: "https://www.reddit.com/login/",
		homeUrl: "https://www.reddit.com/",
	},
	scopes: STREAMS.map((stream) => `reddit.${stream}`),
	exportSummary: {
		count: STREAMS.length,
		label: "records",
		details: Object.fromEntries(STREAMS.map((stream) => [stream, 1])),
	},
	emptyExportSummary: {
		count: 0,
		label: "records",
		details: Object.fromEntries(STREAMS.map((stream) => [stream, 0])),
	},
};
