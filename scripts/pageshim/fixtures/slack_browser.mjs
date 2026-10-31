// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Serves connectors/slack_browser/fixtures/api for app.slack.com, so the
// pageshim harness runs slack_browser with no network. Everything here is
// invented.
//
// The /client page stands in for the Slack web client: once the owner is
// signed in it writes the workspace and its session token to
// localStorage.localConfig_v2, as the real client does. The Web API routes
// answer `not_authed` unless a call carries that token, so a passing run
// proves the connector used the page's own session.
//
// The fixtures describe a week ending at FIXTURE_NOW. Every Slack time in
// them (message ts, thread_ts, created, latest) is moved forward by the time
// since then, so the connector's real clock sees the same week on any day.

import { readFileSync } from "node:fs";

const dir = new URL(
	"../../../connectors/slack_browser/fixtures/api/",
	import.meta.url,
);

/** Invented. The harness asserts it never leaves the provider page. */
export const SYNTHETIC_TOKEN =
	"xoxc-synthetic-session-token-not-a-real-credential";
const TEAM_ID = "T0123456789";
const FIXTURE_NOW_SECONDS = 1_790_553_600; // 2026-09-28T00:00:00Z
const SHIFT = Math.floor(Date.now() / 1000) - FIXTURE_NOW_SECONDS;
// Slack seconds from 2026 (17xxxxxxxx), with or without the .ffffff suffix.
const SLACK_TIME = /\b(17\d{8})(\.\d{6})?\b/g;
const shift = (text, by) =>
	text.replace(SLACK_TIME, (_m, s, f = "") => `${Number(s) + by}${f}`);

const read = (name) => {
	try {
		return shift(readFileSync(new URL(`${name}.json`, dir), "utf8"), SHIFT);
	} catch {
		return undefined;
	}
};

/** The fixture that answers one call; params arrive in shifted time. */
function answer(method, params) {
	const p = Object.fromEntries(
		Object.entries(params).map(([k, v]) => [k, shift(v, -SHIFT)]),
	);
	switch (method) {
		case "conversations.history": {
			if (p.latest !== undefined) {
				return (
					read(`conversations.history-${p.channel}-threads`) ??
					JSON.stringify({ ok: true, messages: [], has_more: false })
				);
			}
			return read(
				`conversations.history-${p.channel}-${p.cursor === undefined ? "p1" : "p2"}`,
			);
		}
		case "search.messages":
			return (
				read(`search.messages-p${p.page ?? "1"}`) ??
				JSON.stringify({
					ok: true,
					messages: { total: 0, matches: [], paging: { page: 1, pages: 1 } },
				})
			);
		case "conversations.replies":
			return (
				read(`conversations.replies-${p.channel}-${p.ts}`) ??
				JSON.stringify({ ok: false, error: "thread_not_found" })
			);
		default:
			return read(method);
	}
}

const json = (body, status = 200) => ({
	status,
	contentType: "application/json; charset=utf-8",
	body,
});
const html = (body = "") => ({
	status: 200,
	contentType: "text/html; charset=utf-8",
	body: `<!doctype html><html><head><title>Slack</title></head><body>${body}</body></html>`,
});

let loggedIn = true;
export async function setLoggedIn(value, page) {
	loggedIn = value;
	if (!value && page) {
		await page
			.evaluate(() => localStorage.removeItem("localConfig_v2"))
			.catch(() => {});
	}
}

const clientPage = () =>
	html(`<main>Slack</main>
<script>
(() => {
	if (${JSON.stringify(loggedIn)}) {
		localStorage.setItem("localConfig_v2", JSON.stringify({
			teams: { ${JSON.stringify(TEAM_ID)}: {
				id: ${JSON.stringify(TEAM_ID)},
				name: "Acme",
				domain: "acme",
				url: "https://acme.slack.com/",
				token: ${JSON.stringify(SYNTHETIC_TOKEN)},
			} },
		}));
	} else {
		localStorage.removeItem("localConfig_v2");
	}
})();
</script>`);

export function resolveFixture(raw, request = {}) {
	const url = new URL(raw);
	const api = /^\/api\/([a-zA-Z.]+)$/.exec(url.pathname);
	if (api) {
		const params = Object.fromEntries(
			new URLSearchParams(request.postData ?? url.search.slice(1)),
		);
		const { token, ...rest } = params;
		if (!loggedIn || token !== SYNTHETIC_TOKEN) {
			return json(JSON.stringify({ ok: false, error: "not_authed" }));
		}
		return (
			(() => {
				const body = answer(api[1], rest);
				return body === undefined ? undefined : json(body);
			})() ?? json(JSON.stringify({ ok: false, error: "unknown_method" }))
		);
	}
	if (url.pathname === "/robots.txt") {
		return { status: 200, contentType: "text/plain", body: "User-agent: *\n" };
	}
	if (url.pathname.startsWith("/client")) return clientPage();
	return html();
}

export const slackBrowserFixtures = {
	hosts: /^https:\/\/app\.slack\.com\//,
	resolve: resolveFixture,
	setLoggedIn,
	loginUrl: "https://app.slack.com/client",
	homeUrl: "https://app.slack.com/client",
};

const STREAMS = [
	"workspace",
	"channels",
	"users",
	"messages",
	"message_attachments",
	"reactions",
	"files",
	"user_groups",
	"reminders",
	"stars",
];

export const pageshimCase = {
	fixtures: slackBrowserFixtures,
	scopes: STREAMS.map((s) => `slack.${s}`),
	// C0555555555 answers not_in_channel: refused, reported, not required.
	exportSummary: {
		count: 28,
		label: "items",
		details: {
			workspace: 1,
			channels: 5,
			users: 3,
			messages: 10,
			message_attachments: 2,
			reactions: 3,
			files: 1,
			user_groups: 1,
			reminders: 0,
			stars: 2,
		},
	},
	emptyExportSummary: {
		count: 0,
		label: "items",
		details: Object.fromEntries(STREAMS.map((s) => [s, 0])),
	},
};
