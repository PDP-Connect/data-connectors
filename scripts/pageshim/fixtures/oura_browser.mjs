// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Serves synthetic cloud.ouraring.com responses for the PageShim harness.
const json = (body, status = 200) => ({
	status,
	contentType: "application/json",
	body: JSON.stringify(body),
});
const html = (body = "") => ({
	status: 200,
	contentType: "text/html; charset=utf-8",
	body: `<!doctype html><html><body>${body}</body></html>`,
});

let loggedIn = true;
export const setLoggedIn = (value) => {
	loggedIn = value;
};

const dailyData = {
	sleeps: [
		{
			id: "00000000-0000-4000-8000-000000000101",
			day: "2026-09-23",
			total_sleep_duration: 28000,
			type: "long_sleep",
		},
	],
	daily_sleeps: [
		{
			id: "00000000-0000-4000-8000-000000000201",
			day: "2026-09-23",
			score: 88,
			timestamp: "2026-09-23T08:15:00+00:00",
			contributors: { efficiency: 91 },
		},
	],
	daily_readinesses: [
		{
			id: "00000000-0000-4000-8000-000000000301",
			day: "2026-09-23",
			score: 82,
			contributors: { recovery_index: 78 },
		},
	],
	daily_activities: [
		{
			id: "00000000-0000-4000-8000-000000000401",
			day: "2026-09-23",
				score: 76,
				steps: 7200,
				contributors: { stay_active: 80 },
		},
	],
};

export function resolveFixture(raw) {
	const url = new URL(raw);
	if (url.pathname === "/user/sign-in") return html('<form><input name="email"></form>');
	if (url.pathname === "/api/me") return json({ id: "synthetic-owner" }, loggedIn ? 200 : 401);
	if (url.pathname === "/api/account/daily-data") {
		if (!loggedIn) return json({ error: "unauthorized" }, 401);
		const start = url.searchParams.get("start") ?? "";
		const end = url.searchParams.get("end") ?? "";
		return json(
			Object.fromEntries(
				Object.entries(dailyData).map(([key, rows]) => [
					key,
					rows.filter((row) => row.day >= start && row.day <= end),
				]),
			),
		);
	}
	return html();
}

export const ouraBrowserFixtures = {
	hosts: /^https:\/\/cloud\.ouraring\.com\//,
	resolve: resolveFixture,
	setLoggedIn,
	loginUrl: "https://cloud.ouraring.com/user/sign-in",
	homeUrl: "https://cloud.ouraring.com/",
};

export const pageshimCase = {
	fixtures: ouraBrowserFixtures,
	scopes: ["oura.sleep", "oura.readiness", "oura.activity"],
	exportSummary: {
		count: 4,
		label: "records",
		details: { sleep: 2, readiness: 1, activity: 1 },
	},
	emptyExportSummary: {
		count: 0,
		label: "records",
		details: { sleep: 0, readiness: 0, activity: 0 },
	},
};

/** Deterministic daily responses, with optional failed windows and stray rows. */
export function recordingDailyFixture({ failWindow = -1, extraDays = [] } = {}) {
	const windows = [];
	return {
		windows,
		resolve(raw) {
			const url = new URL(raw);
			if (url.pathname !== "/api/account/daily-data") return resolveFixture(raw);
			const start = url.searchParams.get("start");
			const end = url.searchParams.get("end");
			windows.push({ start, end });
			if (windows.length - 1 === failWindow) return json({ error: "unavailable" }, 500);
			const days = [...extraDays];
			for (let day = start; day <= end;) {
				days.push(day);
				day = new Date(Date.parse(day) + 86_400_000).toISOString().slice(0, 10);
			}
			return json({ daily_sleeps: days.map((day) => ({
				id: "00000000-0000-4000-8000-" + day.replaceAll("-", "").padStart(12, "0"),
				day, score: 88,
			})) });
		},
	};
}
