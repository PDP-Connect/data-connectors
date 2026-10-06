// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Provider-shaped ChatGPT responses for a projected export, including the
// `/conversations/batch` endpoint that the connector uses for detail reads.
// The sibling `chatgpt.mjs` fixture has no batch endpoint and tops out at 51
// one-message conversations; this one serves any size.

const respond = (status, body, contentType = "application/json") => ({
	status,
	contentType,
	body: typeof body === "string" ? body : JSON.stringify(body),
});

export function createChatGptReplayFixtures(projected) {
	let loggedIn = true;
	const requests = { search: 0, batch: 0, detail: 0 };
	const resolve = (raw, init = {}) => {
		const url = new URL(raw);
		if (url.pathname === "/" || url.pathname === "") {
			return respond(
				200,
				`<!doctype html><html><body><script id="client-bootstrap" type="application/json">${JSON.stringify({ session: { accessToken: "fixture-token" } })}</script></body></html>`,
				"text/html; charset=utf-8",
			);
		}
		if (url.pathname === "/auth/login") {
			return respond(200, "<!doctype html><html><body>login</body></html>", "text/html; charset=utf-8");
		}
		if (url.pathname === "/api/auth/session") {
			return loggedIn ? respond(200, { accessToken: "fixture-token" }) : respond(401, {});
		}
		if (!loggedIn) return respond(401, {});
		if (url.pathname === "/backend-api/memories") return respond(200, { memories: [] });
		if (url.pathname === "/backend-api/conversations/search") {
			requests.search++;
			return respond(200, projected.listPage(Number(url.searchParams.get("cursor") ?? 0)));
		}
		if (url.pathname === "/backend-api/conversations/batch") {
			requests.batch++;
			let body = {};
			try {
				body = JSON.parse(init.postData ?? "{}");
			} catch {}
			return respond(200, projected.batch(body.conversation_ids));
		}
		if (url.pathname.startsWith("/backend-api/conversation/")) {
			requests.detail++;
			const detail = projected.detail(
				decodeURIComponent(url.pathname.slice("/backend-api/conversation/".length)),
			);
			return detail ? respond(200, detail) : respond(404, {});
		}
		return respond(404, {});
	};
	return {
		hosts: /^https:\/\/chatgpt\.com\//,
		resolve,
		setLoggedIn: (value) => {
			loggedIn = value;
		},
		requests,
		loginUrl: "https://chatgpt.com/auth/login",
		homeUrl: "https://chatgpt.com/",
	};
}
