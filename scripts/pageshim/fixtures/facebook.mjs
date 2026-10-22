// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Synthetic only. Facebook's web app preloads each list's first page into the
// page HTML (Relay payloads under RelayPrefetchedStreamCache in
// <script type="application/json"> blocks) and pages the rest with persisted
// GraphQL queries POSTed to /api/graphql/. These pages carry the same shapes
// the connector reads, with invented values: the signed-in person
// (CurrentUserInitialData), the page tokens, a page-level `require` that
// resolves the friends pagination query id, and one paginated list (friends)
// so the in-page GraphQL fetch is exercised. The signed-out answer is a
// sign-in form whose page names no person (USER_ID "0"). Real WebView
// behavior against facebook.com needs a device run.

const ORIGIN = "https://www.facebook.com";
const VIEWER = "100476";
const DTSG = "SYNTHETIC_DTSG_TOKEN";
const FRIENDS_DOC_ID = "1111111111111";
const FRIENDS_QUERY = "ProfileCometAppCollectionSelfFriendsListRendererPaginationQuery";
const FRIENDS_COLLECTION = "YXBwX2NvbGxlY3Rpb246MTAwNDc2OjI=";
const NOW = 1792600000;

const html = (body = "", status = 200) => ({
	status,
	contentType: "text/html; charset=utf-8",
	body: `<!doctype html><html><head><title>Facebook</title></head><body>${body}</body></html>`,
});
const graphql = (value) => ({
	status: 200,
	contentType: "text/html; charset=utf-8",
	body: `for (;;);${JSON.stringify(value)}`,
});

const friend = (n, name) => ({
	node: {
		id: `YXBwX2NvbGxlY3Rpb25faXRlbTo${n}`,
		title: { text: name },
		url: `${ORIGIN}/profile.php?id=${n}`,
		actions_renderer: { action: { profile_owner: { id: String(n), name, friendship_status: "ARE_FRIENDS" } } },
		node: { id: String(n), __isEntity: "User", __isNode: "User", url: `${ORIGIN}/profile.php?id=${n}` },
	},
	cursor: `friend-cursor-${n}`,
});

const activity = (n, title, extra = {}) => ({
	node: {
		id: `S:_I${VIEWER}:VK:${n}`,
		post_id: String(200000 + n),
		creation_time: NOW - n * 3600,
		title: { text: title },
		url: `${ORIGIN}/${VIEWER}/posts/${200000 + n}`,
		attached_story: { message: { text: "A friend's synthetic post" } },
		message: null,
		...extra,
	},
	cursor: `activity-cursor-${n}`,
});

/** Each page's preloaded Relay payload (the `data` of its root query). */
const PRELOADED = {
	"/me": {
		user: { id: VIEWER, profile_intro_card: { bio: { text: "Synthetic bio." }, context_items: { nodes: [{ renderer: { context_item: { title: { text: "Lives in Lisbon" } } } }] } } },
		node: {
			id: VIEWER,
			timeline_list_feed_units: {
				edges: [
					{
						node: {
							id: "UzpfSTEwMDQ3NjoyMDAwMDE=",
							post_id: "200001",
							creation_time: NOW,
							permalink_url: `${ORIGIN}/${VIEWER}/posts/200001`,
							actors: [{ id: VIEWER, name: "Ada Example" }],
							comet_sections: {
								content: { story: { message: { text: "A synthetic post." }, attachments: [] } },
								context_layout: { story: { comet_sections: { title: { story: { title: { text: "Ada Example updated her status." } } } } } },
							},
						},
						cursor: "timeline-cursor-1",
					},
				],
				page_info: { end_cursor: null, has_next_page: false },
			},
		},
	},
	"/me/friends_all": {
		node: {
			id: FRIENDS_COLLECTION,
			pageItems: {
				edges: [friend(100501, "Ben Example"), friend(100502, "Cleo Example")],
				page_info: { end_cursor: "friends-c1", has_next_page: true },
			},
		},
	},
	"/groups/joins/": {
		// The joined-groups list sits at viewer.all_joined_groups.tab_groups_list (observed live);
		// nonAdminGroups is a second group list on the same page that is not the membership list.
		viewer: {
			all_joined_groups: {
				tab_groups_list: {
					edges: [
						{
							node: {
								__typename: "Group",
								id: "300001",
								name: "Lake swimmers",
								url: `${ORIGIN}/groups/300001/`,
								viewer_join_state: "MEMBER",
								subspace_type: "NONE",
								viewer_last_visited_time: NOW,
							},
							cursor: "g1",
						},
					],
					page_info: { end_cursor: null, has_next_page: false },
				},
			},
		},
		nonAdminGroups: {
			groups_tab: {
				tab_groups_list: {
					edges: [{ node: { id: "300002", name: "Pinned group", url: `${ORIGIN}/groups/300002/`, has_viewer_pinned: true } }],
					page_info: { end_cursor: null, has_next_page: false },
				},
			},
		},
	},
	[`/${VIEWER}/allactivity?category_key=LIKEDPOSTS`]: {
		node: {
			id: VIEWER,
			activity_log_stories: {
				edges: [activity(1, "Ada Example likes a post.")],
				page_info: { end_cursor: null, has_next_page: false },
			},
		},
	},
	[`/${VIEWER}/allactivity?category_key=COMMENTSCLUSTER`]: {
		node: {
			id: VIEWER,
			activity_log_stories: {
				edges: [activity(2, "Ada Example commented on a post.", { message: { text: "Lovely!" } })],
				page_info: { end_cursor: null, has_next_page: false },
			},
		},
	},
};

const FRIENDS_PAGE_2 = {
	data: {
		node: {
			__typename: "AppCollection",
			id: FRIENDS_COLLECTION,
			pageItems: {
				edges: [friend(100503, "Dara Example")],
				page_info: { end_cursor: "friends-c2", has_next_page: false },
			},
		},
	},
	extensions: { is_final: true },
};

const MODULES = {
	CurrentUserInitialData: { USER_ID: VIEWER, ACCOUNT_ID: VIEWER, NAME: "Ada Example", SHORT_NAME: "Ada" },
	DTSGInitialData: { token: DTSG },
	LSD: { token: "SYNTHETIC_LSD" },
	[`${FRIENDS_QUERY}_facebookRelayOperation`]: FRIENDS_DOC_ID,
};

function signedInPage(data) {
	const payload = {
		require: [
			[
				"ScheduledServerJS",
				"handle",
				null,
				[
					{
						__bbox: {
							define: [
								["CurrentUserInitialData", [], MODULES.CurrentUserInitialData, 270],
								["DTSGInitialData", [], MODULES.DTSGInitialData, 258],
								["LSD", [], MODULES.LSD, 323],
							],
							require: [
								["RelayPrefetchedStreamCache", "next", [], ["adp_synthetic", { __bbox: { complete: true, result: { data, extensions: { is_final: true } }, sequence_number: 0 } }]],
							],
						},
					},
				],
			],
		],
	};
	const requireScript = `window.require = (function (modules) { return function (name) { if (!Object.prototype.hasOwnProperty.call(modules, name)) throw new Error("Requiring unknown module \\"" + name + "\\""); return modules[name]; }; })(${JSON.stringify(MODULES)});`;
	return html(
		`<div id="mount_0_0">Facebook</div><script>${requireScript}</script><script type="application/json" data-sjs>${JSON.stringify(payload)}</script>`,
	);
}

const signedOutPage = () =>
	html(
		`<form id="login_form" action="/login/device-based/regular/login/" method="post"><input name="email"><input name="pass" type="password"></form><script type="application/json" data-sjs>${JSON.stringify({ define: [["CurrentUserInitialData", [], { USER_ID: "0", ACCOUNT_ID: "0" }, 270]] })}</script>`,
	);

/** Every GraphQL request the connector sent: `friendly name doc_id`. */
export const graphqlRequests = [];

function answerGraphql(request) {
	const form = new URLSearchParams(request?.postData ?? "");
	const name = form.get("fb_api_req_friendly_name") ?? "";
	graphqlRequests.push(`${name} ${form.get("doc_id")}`);
	if (request?.method !== "POST" || /Mutation/.test(name)) return { status: 405, contentType: "text/plain", body: "" };
	if (!loggedIn || form.get("fb_dtsg") !== DTSG || form.get("av") !== VIEWER)
		return graphql({ __ar: 1, error: 1357001, errorSummary: "Not logged in" });
	let variables = {};
	try {
		variables = JSON.parse(form.get("variables") ?? "{}");
	} catch {
		variables = {};
	}
	if (form.get("doc_id") === FRIENDS_DOC_ID && name === FRIENDS_QUERY && variables.cursor === "friends-c1" && variables.id === FRIENDS_COLLECTION)
		return graphql(FRIENDS_PAGE_2);
	return graphql({ errors: [{ message: "PersistedQueryNotFound", severity: "CRITICAL", path: [] }], data: null });
}

let loggedIn = true;

export function resolveFixture(raw, request) {
	const url = new URL(raw);
	if (url.pathname === "/api/graphql/") return answerGraphql(request);
	if (!loggedIn) return signedOutPage();
	const data = PRELOADED[`${url.pathname}${url.search}`] ?? PRELOADED[url.pathname];
	if (data) return signedInPage(data);
	// Home and any other page: signed in, nothing preloaded.
	return signedInPage({});
}

export const facebookFixtures = {
	hosts: /^https:\/\/www\.facebook\.com\//,
	loginUrl: `${ORIGIN}/login/`,
	homeUrl: `${ORIGIN}/`,
	resolve: resolveFixture,
	async setLoggedIn(value, page) {
		loggedIn = value;
		if (page) await page.reload({ waitUntil: "load" });
	},
};

const STREAMS = ["profile", "posts", "friends", "groups", "reactions", "comments"];

export const pageshimCase = {
	fixtures: facebookFixtures,
	scopes: STREAMS.map((stream) => `facebook.${stream}`),
	exportSummary: {
		count: 8,
		label: "records",
		details: { profile: 1, posts: 1, friends: 3, groups: 1, reactions: 1, comments: 1 },
	},
	emptyExportSummary: {
		count: 0,
		label: "records",
		details: { profile: 0, posts: 0, friends: 0, groups: 0, reactions: 0, comments: 0 },
	},
};
