// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

const UUID = (day, n) =>
	`00000000-0000-4000-8000-${day.replaceAll("-", "")}${String(n).padStart(4, "0")}`;

const html = (body) => ({
	status: 200,
	contentType: "text/html; charset=utf-8",
	body,
});

const json = (body, status = 200) => ({
	status,
	contentType: "application/json; charset=utf-8",
	body: JSON.stringify(body),
});

function addDays(value, days) {
	const date = new Date(`${value}T00:00:00.000Z`);
	date.setUTCDate(date.getUTCDate() + days);
	return date.toISOString().slice(0, 10);
}

let loggedIn = true;
let dailyDataStatus = 200;
export const setLoggedIn = (v) => {
	loggedIn = v;
};
export const setDailyDataStatus = (value) => {
	dailyDataStatus = value;
};

export function resolveFixture(raw) {
	const url = new URL(raw);
	if (url.pathname === "/user/sign-in")
		return html("<!doctype html><html><body>Oura sign in</body></html>");
	if (!loggedIn) return json({ error: "unauthorized" }, 401);
	if (url.pathname === "/" || url.pathname === "/dashboard")
		return html("<!doctype html><html><body>Oura dashboard</body></html>");
	if (url.pathname === "/api/me") return json({ id: "owner" });
	if (url.pathname === "/api/account/daily-data") {
		if (dailyDataStatus !== 200)
			return json({ error: "fixture unavailable" }, dailyDataStatus);
		const start = url.searchParams.get("start") ?? "";
		const end = url.searchParams.get("end") ?? "";
		if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || start > end)
			return json({
				sleeps: [],
				daily_sleeps: [],
				daily_readinesses: [],
				daily_activities: [],
			});
		const day = end;
		const timestamp = `${addDays(day, 1)}T08:15:00+00:00`;
		return json({
			sleeps: [
				{
					id: UUID(day, 1),
					day,
					total_sleep_duration: 28000,
					awake_time: 1200,
				},
			],
			daily_sleeps: [
				{
					id: UUID(day, 2),
					day,
					score: 88,
					timestamp,
					contributors: { efficiency: 91 },
				},
			],
			daily_readinesses: [
				{ id: UUID(day, 3), day, score: 82 },
			],
			daily_activities: [
				{ id: UUID(day, 4), day, score: 79, steps: 7000 },
			],
		});
	}
	return { status: 404, contentType: "text/html", body: "<html></html>" };
}

export const ouraBrowserFixtures = {
	hosts: /^https:\/\/cloud\.ouraring\.com\//,
	resolve: resolveFixture,
	setLoggedIn,
	loginUrl: "https://cloud.ouraring.com/",
	homeUrl: "https://cloud.ouraring.com/dashboard",
};

export const pageshimCase = {
	fixtures: ouraBrowserFixtures,
	scopes: ["oura.sleep", "oura.readiness", "oura.activity"],
	exportSummary: {
		count: 12,
		label: "records",
		details: { sleep: 6, readiness: 3, activity: 3 },
	},
	emptyExportSummary: {
		count: 0,
		label: "records",
		details: { sleep: 0, readiness: 0, activity: 0 },
	},
};
