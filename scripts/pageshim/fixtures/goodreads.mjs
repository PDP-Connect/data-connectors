// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Serves connectors/goodreads/fixtures/html for www.goodreads.com, so the
// pageshim harness runs goodreads with no network. Everything here is
// invented.
//
// Signed out, every page except the sign-in form answers with the sign-in
// form and no sign-out link, which is how the connector's probe tells the
// two states apart. The harness cannot follow a redirect, so /review/list
// answers directly with the library page; the connector then reads the owner
// id from the page header's profile link.

import { readFileSync } from "node:fs";

const dir = new URL("../../../connectors/goodreads/fixtures/html/", import.meta.url);
const fx = (n) => readFileSync(new URL(n, dir), "utf8");
const pages = { 1: fx("library-page-1.html"), 2: fx("library-page-2.html") };
const sidebar = fx("library-sidebar.html");
const noRows = fx("library-no-rows.html");
const profile = fx("profile.html");
const settings = fx("settings.html");
const signin = fx("signin.html");

const html = (body) => ({
	status: 200,
	contentType: "text/html; charset=utf-8",
	body,
});

let loggedIn = true;
export const setLoggedIn = (v) => {
	loggedIn = v;
};

export function resolveFixture(raw) {
	const url = new URL(raw);
	const p = url.pathname;
	if (p === "/user/sign_in" || !loggedIn) return html(signin);
	if (p === "/review/list") return html(sidebar);
	if (p === "/review/list/90000001") {
		return html(url.searchParams.has("print") ? pages[url.searchParams.get("page")] ?? noRows : sidebar);
	}
	if (p === "/user/show/90000001") return html(profile);
	if (p === "/user/edit") return html(settings);
	if (p === "/robots.txt") return { status: 200, contentType: "text/plain", body: "User-agent: *\n" };
	return { status: 404, contentType: "text/html", body: "<html></html>" };
}

export const goodreadsFixtures = {
	hosts: /^https:\/\/www\.goodreads\.com\//,
	resolve: resolveFixture,
	setLoggedIn,
	loginUrl: "https://www.goodreads.com/user/sign_in",
	homeUrl: "https://www.goodreads.com/review/list",
};

/** What pageshim.test.mjs needs to gate goodreads. */
export const pageshimCase = {
	fixtures: goodreadsFixtures,
	scopes: ["books", "shelves", "account_profile", "usage_summary"].map((s) => `goodreads.${s}`),
	// tenure_months counts from the day the run happens.
	volatileRecordFields: ["tenure_months"],
	exportSummary: { count: 5, label: "books", details: { books: 5, shelves: 6 } },
	emptyExportSummary: { count: 0, label: "books", details: { books: 0, shelves: 0 } },
};
