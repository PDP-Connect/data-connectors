// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

const conversation = (id, title, updateTime, currentNode) => ({
	id,
	title,
	create_time: updateTime,
	update_time: updateTime,
	is_archived: false,
	is_starred: false,
	workspace_id: null,
	current_node: currentNode,
	gizmo_id: null,
});

const conversations = Array.from({ length: 51 }, (_, index) => {
	const id = `conv-${index + 1}`;
	return conversation(
		id,
		`Mobile fixture ${index + 1}`,
		1780000000 - index,
		`msg-${index + 1}-a`,
	);
});

const detail = (c, content) => ({
	...c,
	mapping: {
		root: {
			id: "root",
			parent: null,
			children: [c.current_node],
			message: null,
		},
		[c.current_node]: {
			id: c.current_node,
			parent: "root",
			children: [],
			message: {
				id: c.current_node,
				author: { role: "user" },
				content: { content_type: "text", parts: [content] },
				create_time: c.create_time,
				end_turn: true,
				metadata: {},
			},
		},
	},
});

const details = Object.fromEntries(
	conversations.map((c, i) => [c.id, detail(c, `fixture message ${i + 1}`)]),
);

const html = (body) => ({
	status: 200,
	contentType: "text/html; charset=utf-8",
	body,
});

const json = (value) => ({
	status: 200,
	contentType: "application/json; charset=utf-8",
	body: JSON.stringify(value),
});

let loggedIn = true;
let conversationCount = 2;
let emptySession = false;
export const setLoggedIn = (value) => {
	loggedIn = value;
};
export const useConversationCount = (value) => {
	conversationCount = value;
};
export const setEmptySession = (value) => {
	emptySession = value;
};

export function resolveFixture(raw) {
	const url = new URL(raw);
	const path = url.pathname;
	if (!loggedIn && path !== "/auth/login") {
		return { status: 401, contentType: "application/json", body: "{}" };
	}
	if (path === "/auth/login") {
		return html("<!doctype html><html><body>login</body></html>");
	}
	if (path === "/" || path === "") {
		return html(
			`<!doctype html><html><body><script id="client-bootstrap" type="application/json">${JSON.stringify({ session: { accessToken: "fixture-token" } })}</script></body></html>`,
		);
	}
	if (path === "/api/auth/session") {
		return json(emptySession ? {} : { accessToken: "fixture-token" });
	}
	if (
		path === "/backend-api/conversations" ||
		path === "/backend-api/conversations/search"
	) {
		const search = path.endsWith("/search");
		const offset = Number(
			url.searchParams.get(search ? "cursor" : "offset") ?? "0",
		);
		const limit = search
			? 30
			: Number(url.searchParams.get("limit") ?? "100");
		const visible = conversations.slice(0, conversationCount);
		return json({
			items: visible.slice(offset, offset + limit),
			total: visible.length,
			...(search
				? {
					has_more: offset + limit < visible.length,
					next_cursor:
						offset + limit < visible.length ? offset + limit : null,
				}
				: {}),
		});
	}
	const detailMatch = path.match(/^\/backend-api\/conversation\/([^/]+)$/);
	if (detailMatch) {
		const id = decodeURIComponent(detailMatch[1]);
		return details[id]
			? json(details[id])
			: { status: 404, contentType: "application/json", body: "{}" };
	}
	return { status: 404, contentType: "text/html", body: "<html></html>" };
}

export const chatgptFixtures = {
	hosts: /^https:\/\/chatgpt\.com\//,
	resolve: resolveFixture,
	setLoggedIn,
	loginUrl: "https://chatgpt.com/auth/login",
	homeUrl: "https://chatgpt.com/",
};

export const pageshimCase = {
	fixtures: chatgptFixtures,
	scopes: ["chatgpt.conversations", "chatgpt.messages"],
	exportSummary: {
		count: 2,
		label: "conversations",
		details: { conversations: 2, messages: 2 },
	},
	emptyExportSummary: {
		count: 0,
		label: "conversations",
		details: { conversations: 0, messages: 0 },
	},
};
