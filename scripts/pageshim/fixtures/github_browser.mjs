// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Serves connectors/github_browser/__fixtures__/synthetic for github.com and
// api.github.com, so the pageshim harness runs github_browser with no network.

import { readFileSync } from "node:fs";

const dir = new URL(
	"../../../connectors/github_browser/__fixtures__/synthetic/",
	import.meta.url,
);
const fx = (n) => readFileSync(new URL(n, dir), "utf8");
const profile = fx("profile.html");
const repositories = fx("repositories.html");
const starredEmpty = fx("starred-empty-current-github.html");
const events = fx("events.json");
const history = JSON.parse(fx("history-issue.json"));

function cells(start, end) {
	let html = "";
	for (
		let d = new Date(`${start}T00:00:00Z`);
		d.toISOString().slice(0, 10) <= end;
		d.setUTCDate(d.getUTCDate() + 1)
	) {
		const iso = d.toISOString().slice(0, 10);
		html += `<td class="ContributionCalendar-day" data-date="${iso}" data-count="1" data-level="1"></td>`;
	}
	return `<table class="ContributionCalendar-grid"><tbody><tr>${html}</tr></tbody></table>`;
}
const html = (body) => ({
	status: 200,
	contentType: "text/html; charset=utf-8",
	body: `<!doctype html><html><head>${body.startsWith("<meta") ? "" : '<meta name="user-login" content="sample-user">'}</head><body>${body}</body></html>`,
});
const json = (v) => ({
	status: 200,
	contentType: "application/json",
	body: typeof v === "string" ? v : JSON.stringify(v),
});

let loggedIn = true;
export const setLoggedIn = (v) => {
	loggedIn = v;
};
const loggedOut = {
	status: 200,
	contentType: "text/html",
	body: '<!doctype html><html><head></head><body><a href="/login">Sign in</a></body></html>',
};
export function resolveFixture(raw) {
	const url = new URL(raw);
	const tab = url.searchParams.get("tab");
	if (url.hostname === "api.github.com") {
		if (/^\/users\/sample-user\/events\/public$/.test(url.pathname)) {
			return json(
				url.searchParams.get("page") === "1" || !url.searchParams.get("page")
					? events
					: "[]",
			);
		}
		if (url.pathname === "/search/issues") {
			const q = url.searchParams.get("q") || "";
			return q.includes("type:pr")
				? json({ items: [], total_count: 0, incomplete_results: false })
				: json({
						...history,
						total_count: history.items.length,
						incomplete_results: false,
					});
		}
		return {
			status: 404,
			contentType: "application/json",
			body: '{"message":"Not Found"}',
		};
	}
	const p = url.pathname;
	if (!loggedIn && url.hostname === "github.com" && p !== "/login")
		return loggedOut;
	if (p === "/" || p === "/settings/profile") return html(profile);
	if (p === "/login")
		return {
			status: 200,
			contentType: "text/html",
			body: '<html><body><form action="/session"><input name="login"></form></body></html>',
		};
	if (p === "/sample-user" && tab === "repositories") return html(repositories);
	if ((p === "/sample-user" && tab === "stars") || p === "/stars/sample-user")
		return html(starredEmpty);
	if (p === "/sample-user") {
		const from = url.searchParams.get("from");
		if (from) {
			const y = from.slice(0, 4);
			return html(
				`<h2 class="f4 text-normal mb-2">${365} contributions in ${y}</h2>${cells(`${y}-01-01`, `${y}-12-31`)}`,
			);
		}
		const today = new Date().toISOString().slice(0, 10);
		const start = new Date(`${today}T00:00:00Z`);
		start.setUTCDate(start.getUTCDate() - 364);
		// Real profile pages carry the profile AND the rolling-year calendar.
		return html(`${profile}${cells(start.toISOString().slice(0, 10), today)}`);
	}
	return {
		status: 404,
		contentType: "text/html",
		body: "<html><body>Not Found</body></html>",
	};
}

export const githubBrowserFixtures = {
	hosts: /^https:\/\/(api\.)?github\.com\//,
	resolve: resolveFixture,
	setLoggedIn,
	loginUrl: "https://github.com/login",
	homeUrl: "https://github.com/",
};

/** What pageshim.test.mjs needs to gate github_browser. */
export const pageshimCase = {
	fixtures: githubBrowserFixtures,
	scopes: [
		"profile",
		"repositories",
		"starred",
		"events",
		"contributions",
		"history",
	].map((s) => `github.${s}`),
	exportSummary: {
		count: 2,
		label: "items",
		details: { repositories: 1, starred: 0, events: 1, contributions: 1234 },
	},
	emptyExportSummary: {
		count: 0,
		label: "items",
		details: { repositories: 0, starred: 0, events: 0, contributions: 0 },
	},
};
