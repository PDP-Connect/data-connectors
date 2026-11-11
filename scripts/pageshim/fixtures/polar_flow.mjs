// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Serves a synthetic flow.polar.com and sleep-api.flow.polar.com for the
// PageShim harness, with the same fake API the connector's own tests use
// (connectors/polar_flow/fake-polar.ts over its synthetic fixtures/api/*.json;
// every value is invented). The fixture records fall in the first week of
// November 2026; the gate runs on the real clock with the connector's default
// history (90 days of daily activity), so every day from that week is moved
// forward to end two days before today, keeping the counts the same on any
// run date. Signed out, the API answers 401 as Flow does; pages on
// flow.polar.com answer a plain page, since the harness serves no
// auth.polar.com.

import { fixtureData, polarApi } from "../../../connectors/polar_flow/fake-polar.ts";

const ORIGIN = "https://flow.polar.com";
const DAY_MS = 86_400_000;
const LAST_FIXTURE_DAY = "2026-11-06";

const shiftDays = (() => {
	const today = new Date().toISOString().slice(0, 10);
	return Math.round(
		(Date.parse(`${today}T00:00:00Z`) - 2 * DAY_MS - Date.parse(`${LAST_FIXTURE_DAY}T00:00:00Z`)) / DAY_MS,
	);
})();

const shift = (day) =>
	new Date(Date.parse(`${day}T00:00:00Z`) + shiftDays * DAY_MS).toISOString().slice(0, 10);

// Only the fixture week moves: the profile's other dates (birthday, settings)
// are not activity days.
const shifted = JSON.parse(
	JSON.stringify(fixtureData()).replace(/2026-1[01]-\d{2}/g, (day) => shift(day)),
);
const api = polarApi(shifted);

let loggedIn = true;
export const setLoggedIn = async (value, target) => {
	loggedIn = value;
	if (target) {
		await target.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
	}
};

const page = (body) => ({
	status: 200,
	contentType: "text/html; charset=UTF-8",
	body: `<!DOCTYPE html><html lang="en"><head><title>Polar Flow</title></head><body>${body}</body></html>`,
});

export const requests = [];

export function resolveFixture(raw, request = {}) {
	const url = new URL(raw);
	const method = request.method ?? "GET";
	if (method === "OPTIONS") return { status: 204, contentType: "text/plain", body: "" };
	requests.push({ method, host: url.host, path: url.pathname });
	if (url.origin === ORIGIN && !url.pathname.startsWith("/api/")) {
		return page(loggedIn ? "<h1>Diary</h1>" : "<form>Sign in</form>");
	}
	const answer = api(
		raw,
		{ method, headers: request.headers ?? {}, body: request.postData ?? undefined },
		loggedIn,
	);
	return { status: answer.status, contentType: answer.contentType || "text/plain", body: answer.body };
}

export const polarFlowFixtures = {
	hosts: /^https:\/\/(?:flow|sleep-api\.flow)\.polar\.com\//,
	resolve: resolveFixture,
	setLoggedIn,
	loginUrl: `${ORIGIN}/login`,
	homeUrl: `${ORIGIN}/diary`,
};

export const pageshimCase = {
	fixtures: polarFlowFixtures,
	scopes: [
		"polar_flow.profile",
		"polar_flow.training_sessions",
		"polar_flow.daily_activity",
		"polar_flow.sleep",
		"polar_flow.nightly_recharge",
	],
	exportSummary: {
		count: 9,
		label: "records",
		details: { profile: 1, training_sessions: 2, daily_activity: 2, sleep: 2, nightly_recharge: 2 },
	},
	emptyExportSummary: {
		count: 0,
		label: "records",
		details: { profile: 0, training_sessions: 0, daily_activity: 0, sleep: 0, nightly_recharge: 0 },
	},
};
