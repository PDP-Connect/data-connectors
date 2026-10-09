// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Serves connectors/discord_browser/fixtures for discord.com, so the pageshim
// harness runs discord_browser with no network. Everything here is invented.
//
// The app page stands in for the Discord client: it holds a session token in
// a closure and sends an API request of its own only when the owner moves
// around the app. The API routes answer 401 unless a request carries that
// token and the client's X-Super-Properties, so a passing run proves the
// connector reused the client's headers.

import { readFileSync } from "node:fs";

const dir = new URL(
	"../../../connectors/discord_browser/fixtures/",
	import.meta.url,
);
const fx = (n) => readFileSync(new URL(n, dir), "utf8");
const user = JSON.parse(fx("user-me.json"));
const guilds = JSON.parse(fx("guilds.json")).slice(0, 2);
const connections = fx("connections.json");
const searchTemplate = JSON.parse(fx("search-messages.json"));
const searchEmpty = fx("search-empty.json");
const unauthorized = fx("unauthorized.json");

/** Invented. The harness asserts it never leaves the provider page. */
export const SYNTHETIC_TOKEN =
	"synthetic-session-token.not-a-real-credential.0123456789abcdef";
export const SYNTHETIC_SUPER_PROPERTIES =
	"c3ludGhldGljLXN1cGVyLXByb3BlcnRpZXMtbm90LXJlYWw=";

const DISCORD_EPOCH_MS = 1_420_070_400_000n;
const snowflakeAt = (ms, sequence) =>
	String(((BigInt(ms) - DISCORD_EPOCH_MS) << 22n) | BigInt(sequence));

/**
 * The fixture search page with send times moved inside the 90-day window.
 * Times count back from the start of the UTC day, so two runs agree.
 */
function recentSearchPage() {
	const page = structuredClone(searchTemplate);
	const now = Math.floor(Date.now() / 86_400_000) * 86_400_000;
	let sequence = 0;
	for (const [index, group] of page.messages.entries()) {
		for (const message of group) {
			sequence += 1;
			const ms = now - (index + 1) * 86_400_000 - sequence * 1000;
			message.id = snowflakeAt(ms, sequence);
			message.timestamp = new Date(ms).toISOString();
			message.edited_timestamp = null;
			delete message.message_reference;
		}
	}
	return JSON.stringify(page);
}

const html = (body) => ({
	status: 200,
	contentType: "text/html; charset=utf-8",
	body: `<!doctype html><html><head><title>Discord</title></head><body>${body}</body></html>`,
});
const json = (body, status = 200) => ({
	status,
	contentType: "application/json",
	body: typeof body === "string" ? body : JSON.stringify(body),
});

const appPage = () =>
	html(`<section aria-label="User area">${user.username}</section>
<nav><a href="/channels/@me">Friends</a><a href="/shop">Shop</a></nav>
<script>
(() => {
	// discord.com removes localStorage from the page.
	try { delete window.localStorage; } catch {}
	const token = ${JSON.stringify(SYNTHETIC_TOKEN)};
	// The header names discord.com's client sent when observed on 2026-10-08.
	const open = (method, path) => {
		const request = new XMLHttpRequest();
		request.open(method, path);
		request.setRequestHeader("Authorization", token);
		request.setRequestHeader("X-Super-Properties", ${JSON.stringify(SYNTHETIC_SUPER_PROPERTIES)});
		request.setRequestHeader("X-Installation-ID", "synthetic-installation-id");
		request.setRequestHeader("X-Discord-Locale", "en-US");
		request.setRequestHeader("X-Discord-Timezone", "Etc/UTC");
		request.setRequestHeader("X-Debug-Options", "bugReporterEnabled");
		return request;
	};
	const send = () => {
		if (!${JSON.stringify(behaviour.clientSendsRequests)}) return;
		// The client's own settings write on navigation comes first. Its
		// Content-Type must not be replayed on the connector's GETs.
		const settings = open("PATCH", "/api/v9/users/@me/settings-proto/1");
		settings.setRequestHeader("Content-Type", "application/json");
		settings.send("{}");
		open("GET", "/api/v9/collectibles-categories").send();
	};
	for (const link of document.querySelectorAll("nav a")) {
		link.addEventListener("click", (event) => {
			event.preventDefault();
			history.pushState(null, "", link.getAttribute("href"));
			send();
		});
	}
})();
</script>`);

const loginPage = html(
	'<form action="/api/v9/auth/login"><input name="email"><input name="password" type="password"></form>',
);
const signedOutApp = html('<script>location.replace("/login");</script>');

let loggedIn = true;
export const setLoggedIn = (v) => {
	loggedIn = v;
};

/** Per-test switches; `reset()` restores the defaults. */
const behaviour = {
	clientSendsRequests: true,
	/** Requests answered normally before the session expires (401). */
	expireAfterRequests: Number.POSITIVE_INFINITY,
};
/** Every API request the page made: `METHOD path?query`. */
export const apiRequests = [];
let answered = 0;
export const configure = (next) => Object.assign(behaviour, next);
export const reset = () => {
	behaviour.clientSendsRequests = true;
	behaviour.expireAfterRequests = Number.POSITIVE_INFINITY;
	apiRequests.length = 0;
	answered = 0;
};

function api(url, request) {
	const method = request?.method ?? "GET";
	const path = url.pathname.replace(/^\/api\/v9/, "");
	apiRequests.push(`${method} ${path}${url.search}`);
	const headers = request?.headers ?? {};
	if (
		!loggedIn ||
		headers.authorization !== SYNTHETIC_TOKEN ||
		headers["x-super-properties"] !== SYNTHETIC_SUPER_PROPERTIES
	)
		return json(unauthorized, 401);
	// The client's own requests are not the connector's.
	if (path === "/collectibles-categories") return json("[]");
	if (path === "/users/@me/settings-proto/1" && method === "PATCH")
		return json("{}");
	if (method !== "GET" || "content-type" in headers)
		return json({ message: "405: Method Not Allowed", code: 0 }, 405);
	answered += 1;
	if (answered > behaviour.expireAfterRequests) return json(unauthorized, 401);
	if (path === "/users/@me") return json(user);
	if (path === "/users/@me/guilds") return json(guilds);
	if (path === "/users/@me/connections") return json(connections);
	const search = /^\/guilds\/(\d+)\/messages\/search$/.exec(path);
	if (search) {
		if (
			url.searchParams.get("author_id") !== user.id ||
			url.searchParams.get("offset") !== "0"
		)
			return json(searchEmpty);
		return json(search[1] === guilds[0].id ? recentSearchPage() : searchEmpty);
	}
	return json({ message: "404: Not Found", code: 0 }, 404);
}

export function resolveFixture(raw, request) {
	const url = new URL(raw);
	const p = url.pathname;
	if (p.startsWith("/api/")) return api(url, request);
	if (p === "/login") return loginPage;
	if (!loggedIn) return signedOutApp;
	return appPage();
}

export const discordBrowserFixtures = {
	hosts: /^https:\/\/discord\.com\//,
	resolve: resolveFixture,
	setLoggedIn,
	loginUrl: "https://discord.com/login",
	homeUrl: "https://discord.com/channels/@me",
};

/** What pageshim.test.mjs needs to gate discord_browser. */
export const pageshimCase = {
	fixtures: discordBrowserFixtures,
	scopes: ["profile", "servers", "connections", "messages"].map(
		(s) => `discord.${s}`,
	),
	exportSummary: {
		count: 7,
		label: "items",
		details: { profile: 1, servers: 2, connections: 2, messages: 2 },
	},
	emptyExportSummary: {
		count: 0,
		label: "items",
		details: { profile: 0, servers: 0, connections: 0, messages: 0 },
	},
};
