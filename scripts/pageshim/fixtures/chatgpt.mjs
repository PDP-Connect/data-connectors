// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { projectChatGptExport } from "../chatgpt-replay.mjs";

const SAFE_SYNTHETIC_CONTENT = {
	"chatgpt.conversations": {
		conversations: [
			{
				id: "conv-sample",
				title: "Synthetic conversation",
				create_time: "2025-01-01T00:00:00.000Z",
				update_time: "2025-01-01T00:01:00.000Z",
				current_node: "msg-answer",
				message_count_on_current_branch: 2,
			},
		],
	},
	"chatgpt.messages": {
		messages: [
			{
				id: "msg-question",
				conversation_id: "conv-sample",
				parent_id: null,
				children_ids: ["msg-answer"],
				role: "user",
				content: "Synthetic prompt",
				content_type: "text",
				create_time: "2025-01-01T00:00:00.000Z",
				on_current_branch: true,
			},
			{
				id: "msg-answer",
				conversation_id: "conv-sample",
				parent_id: "msg-question",
				children_ids: [],
				role: "assistant",
				content: "Synthetic response",
				content_type: "text",
				create_time: "2025-01-01T00:01:00.000Z",
				on_current_branch: true,
			},
		],
	},
};

export function createChatGptFixtures(projected) {
	let loggedIn = true;
	const homeUrl = "https://chatgpt.com/";
	const loginUrl = "https://chatgpt.com/";
	const hosts = /^https:\/\/chatgpt\.com\//;
	const setLoggedIn = (value) => {
		loggedIn = value;
	};
	const respond = (status, body, contentType = "application/json") => ({
		status,
		contentType,
		body: typeof body === "string" ? body : JSON.stringify(body),
	});
	const resolveRequest = (request) => {
		const url = new URL(request.url());
		if (url.pathname === "/") {
			const body = loggedIn
				? '<!doctype html><html><body><script id="client-bootstrap" type="application/json">{"accessToken":"harness-token"}</script></body></html>'
				: "<!doctype html><html><body>Sign in</body></html>";
			return respond(200, body, "text/html; charset=utf-8");
		}
		if (url.pathname === "/api/auth/session") {
			return loggedIn
				? respond(200, { accessToken: "harness-token" })
				: respond(401, {});
		}
		if (!loggedIn) return respond(401, { detail: "Unauthorized" });
		if (url.pathname === "/backend-api/conversations/search") {
			const cursor = Number(url.searchParams.get("cursor") ?? 0);
			return respond(200, projected.listPage(cursor));
		}
		if (url.pathname === "/backend-api/conversations/batch") {
			let body = {};
			try {
				body = JSON.parse(request.postData() ?? "{}");
			} catch {}
			return respond(200, projected.batch(body.conversation_ids));
		}
		if (url.pathname.startsWith("/backend-api/conversation/")) {
			const id = decodeURIComponent(url.pathname.slice("/backend-api/conversation/".length));
			const detail = projected.detail(id);
			return detail ? respond(200, detail) : respond(404, {});
		}
		return respond(404, {});
	};
	return { hosts, resolve: (raw) => resolveRequest({ url: () => raw, postData: () => null }), resolveRequest, setLoggedIn, loginUrl, homeUrl };
}

const projected = projectChatGptExport(SAFE_SYNTHETIC_CONTENT);
export const chatGptFixtures = createChatGptFixtures(projected);
export const pageshimCase = {
	fixtures: chatGptFixtures,
	scopes: ["chatgpt.conversations", "chatgpt.messages"],
	exportSummary: {
		count: 1,
		label: "conversation",
		details: { conversations: 1, messages: 2 },
	},
	emptyExportSummary: {
		count: 0,
		label: "conversations",
		details: { conversations: 0, messages: 0 },
	},
};
