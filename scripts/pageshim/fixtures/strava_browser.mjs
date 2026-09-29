// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Serves connectors/strava_browser/fixtures for www.strava.com, so the
// pageshim harness runs strava_browser with no network.

import { readFileSync } from "node:fs";

const dir = new URL(
	"../../../connectors/strava_browser/fixtures/",
	import.meta.url,
);
const fx = (n) => readFileSync(new URL(n, dir), "utf8");
const pages = {
	1: fx("training-activities-page-1.json"),
	2: fx("training-activities-page-2.json"),
};
const login = fx("login.html");

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
	if (p === "/login") return html(login);
	if (p === "/athlete/training_activities" && !loggedIn) {
		return {
			status: 401,
			contentType: "application/json",
			body: '{"message":"Unauthorized"}',
		};
	}
	// Signed out, strava.com sends every page to the sign-in form.
	if (!loggedIn) return html(login);
	if (p === "/athlete/training_activities") {
		return {
			status: 200,
			contentType: "application/json; charset=utf-8",
			body:
				pages[url.searchParams.get("page")] ??
				'{"models":[],"page":3,"perPage":3,"total":5}',
		};
	}
	if (p === "/athlete/training" || p === "/dashboard")
		return html("<!doctype html><html><body></body></html>");
	return { status: 404, contentType: "text/html", body: "<html></html>" };
}

export const stravaBrowserFixtures = {
	hosts: /^https:\/\/www\.strava\.com\//,
	resolve: resolveFixture,
	setLoggedIn,
	loginUrl: "https://www.strava.com/login",
	homeUrl: "https://www.strava.com/dashboard",
};

/** What pageshim.test.mjs needs to gate strava_browser. */
export const pageshimCase = {
	fixtures: stravaBrowserFixtures,
	scopes: ["strava.activities"],
	exportSummary: { count: 5, label: "activities", details: { activities: 5 } },
	emptyExportSummary: {
		count: 0,
		label: "activities",
		details: { activities: 0 },
	},
};
