// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Serves a synthetic www.mountainproject.com for the PageShim harness. Every
// HTML page carries the site's `window.ap.config` block with the current
// session (`isLoggedIn`, `userId`), which is what the connector's probe reads.
// The profile page is the connector's synthetic __fixtures__/profile.html with
// its counts set to the exports served here; the two CSV exports are the real
// exports of the project-owned test account (__fixtures__/canary-*.csv, no
// owner identifier in them). The live site answers `/user/<id>` with a 301 to
// the slug URL; Playwright cannot intercept the follow-up request of a
// fulfilled redirect, so here `/user/<id>` serves the profile page directly
// and the connector takes the slug from the page's canonical link, as it
// also does on a page whose response URL lacks the slug. An export requested
// signed out comes back as the signed-out page.

import { readFileSync } from "node:fs";

const FIXTURES = new URL(
	"../../../connectors/mountain_project/__fixtures__/",
	import.meta.url,
);
const read = (name) => readFileSync(new URL(name, FIXTURES), "utf8");

const ORIGIN = "https://www.mountainproject.com";
const USER_ID = "999000000001";
const PROFILE_PATH = `/user/${USER_ID}/alex-example`;
const TICK_CSV = read("canary-tick-export.csv");
const TODO_CSV = read("canary-todo-export.csv");
const PROFILE_HTML = read("profile.html")
	.replace("View All 7", "View All 5")
	.replace("Sort &amp; Filter All 2", "Sort &amp; Filter All 3");

let loggedIn = true;
// The session block is rendered into each page, so a page loaded before the
// change still shows the old session until it is loaded again; the harness
// hands over the target page when the simulated user signs out.
export const setLoggedIn = async (value, target) => {
	loggedIn = value;
	if (target) {
		await target.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
	}
};

const sessionScript = () =>
	`<script>(function(w){w.ap=w.ap||{};w.ap.config={'projectType':'climb','isLoggedIn':${loggedIn ? 1 : 0},'userId':${loggedIn ? USER_ID : "undefined"},'isAdmin':0,'env':'production'};})(window);</script>`;

const html = (body, status = 200) => ({
	status,
	contentType: "text/html; charset=UTF-8",
	body: `<!DOCTYPE html><html lang="en"><head><title>Mountain Project</title>${sessionScript()}</head><body>${body}</body></html>`,
});
const csv = (body, filename) => ({
	status: 200,
	contentType: "text/csv; charset=UTF-8",
	headers: { "content-disposition": `attachment; filename=${filename}` },
	body,
});

// The profile fixture declares a signed-in session; signed out, the same page
// shows the public profile with the session block saying so.
const profilePage = () => ({
	status: 200,
	contentType: "text/html; charset=UTF-8",
	body: loggedIn
		? PROFILE_HTML
		: PROFILE_HTML.replace("'isLoggedIn': 1", "'isLoggedIn': 0").replace(
				`'userId': ${USER_ID}`,
				"'userId': undefined",
			),
});

export const requests = [];

export function resolveFixture(raw, request = {}) {
	const url = new URL(raw);
	if (request.method === "OPTIONS")
		return { status: 204, contentType: "text/plain", body: "" };
	requests.push({ method: request.method ?? "GET", path: url.pathname });
	if (url.pathname === `/user/${USER_ID}` || url.pathname === PROFILE_PATH) {
		return profilePage();
	}
	const exportMatch = /^\/user\/(\d+)\/[^/]+\/(tick|todo)-export$/.exec(
		url.pathname,
	);
	if (exportMatch) {
		if (!loggedIn || exportMatch[1] !== USER_ID)
			return html("<h1>Sign in</h1>");
		return exportMatch[2] === "tick"
			? csv(TICK_CSV, "ticks.csv")
			: csv(TODO_CSV, "to-dos.csv");
	}
	if (url.pathname === "/auth/login")
		return html(
			loggedIn ? "<h1>You are signed in</h1>" : "<form>Sign in</form>",
		);
	return html("<h1>Mountain Project</h1>");
}

export const mountainProjectFixtures = {
	hosts: /^https:\/\/www\.mountainproject\.com\//,
	resolve: resolveFixture,
	setLoggedIn,
	loginUrl: `${ORIGIN}/auth/login`,
	homeUrl: `${ORIGIN}/`,
};

export const pageshimCase = {
	fixtures: mountainProjectFixtures,
	scopes: [
		"mountain_project.profile",
		"mountain_project.ticks",
		"mountain_project.saved_routes",
	],
	exportSummary: {
		count: 9,
		label: "records",
		details: { profile: 1, ticks: 5, saved_routes: 3 },
	},
	emptyExportSummary: {
		count: 0,
		label: "records",
		details: { profile: 0, ticks: 0, saved_routes: 0 },
	},
};
