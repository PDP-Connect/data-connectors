// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Synthetic replay of the four API v2 collection envelopes used by 3.1.2.
const json = (body, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
const html = (body = "") => ({ status: 200, contentType: "text/html; charset=utf-8", body: `<!doctype html><html><body>${body}</body></html>` });
const token = { accessToken: "synthetic-access", refreshToken: "synthetic-refresh", expiresAt: 4102444800000, clientId: "synthetic-app", clientSecret: "synthetic-secret" };
const appPage = () => html(`<script>localStorage.setItem('vana:oura-connector:token', ${JSON.stringify(JSON.stringify(token))})</script>`);
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const DATA = {
	sleep: [{ id: id(101), day: "2026-09-23", type: "long_sleep", bedtime_start: "2026-09-22T22:00:00+00:00", bedtime_end: "2026-09-23T06:00:00+00:00", total_sleep_duration: 28000, awake_time: 1200, deep_sleep_duration: 7200, light_sleep_duration: 12300, rem_sleep_duration: 8500, time_in_bed: 29000, efficiency: 96, latency: 500, average_heart_rate: 58, average_hrv: 42, lowest_heart_rate: 51, average_breath: 14, restless_periods: 3 }],
	daily_sleep: [{ id: id(201), day: "2026-09-23", score: 88, timestamp: "2026-09-23T08:15:00+00:00", contributors: { efficiency: 91 } }],
	daily_readiness: [{ id: id(301), day: "2026-09-23", score: 82, timestamp: "2026-09-23T08:15:00+00:00", temperature_deviation: 0.2, temperature_trend_deviation: 0.1, contributors: { recovery_index: 78 } }],
	daily_activity: [{ id: id(401), day: "2026-09-23", score: 76, timestamp: "2026-09-23T08:15:00+00:00", steps: 7200, active_calories: 250, total_calories: 1800, equivalent_walking_distance: 3800, high_activity_time: 1000, medium_activity_time: 2000, low_activity_time: 3000, sedentary_time: 4000, resting_time: 5000, inactivity_alerts: 2, contributors: { stay_active: 80 } }],
};
let loggedIn = true;
export const setLoggedIn = (value) => { loggedIn = value; };
function resolveApi(url, data = DATA) {
	const endpoint = url.pathname.split("/").at(-1);
	const start = url.searchParams.get("start_date") ?? "";
	const exclusiveEnd = url.searchParams.get("end_date") ?? "";
	return json({ data: (data[endpoint] ?? []).filter((row) => row.day >= start && row.day < exclusiveEnd), next_token: null });
}
export function resolveFixture(raw) {
	const url = new URL(raw);
	if (url.origin === "https://developer.ouraring.com") {
		if (url.pathname === "/api/auth/get-session") return json(loggedIn ? { user: { email: "synthetic@example.test" } } : null);
		if (url.pathname === "/api/extapi/v2/oauth/applications") return json([{ client_id: "synthetic-app", client_secret: "synthetic-secret", application_name: "Personal access", redirect_uris: ["https://vana.org/oauth/oura/callback"], scopes: ["extapi:daily"] }]);
		return appPage();
	}
	if (url.origin === "https://api.ouraring.com") return resolveApi(url);
	if (url.origin === "https://moi.ouraring.com") return html();
	return html();
}
export const ouraBrowserFixtures = {
	hosts: /^https:\/\/(?:developer|api|moi)\.ouraring\.com\//,
	resolve: resolveFixture,
	setLoggedIn,
	cors: true,
	loginUrl: "https://developer.ouraring.com/applications",
	homeUrl: "https://developer.ouraring.com/applications",
};
export const pageshimCase = {
	fixtures: ouraBrowserFixtures,
	scopes: ["oura.sleep", "oura.readiness", "oura.activity"],
	exportSummary: { count: 4, label: "records", details: { sleep: 2, readiness: 1, activity: 1 } },
	emptyExportSummary: { count: 0, label: "records", details: { sleep: 0, readiness: 0, activity: 0 } },
};

/** Deterministic API v2 replay, with an optional incomplete endpoint window. */
export function recordingDailyFixture({ failWindow = -1, extraDays = [] } = {}) {
	const windows = [];
	return {
		windows,
		cors: true,
		resolve(raw) {
			const url = new URL(raw);
			if (url.origin !== "https://api.ouraring.com") return resolveFixture(raw);
			const endpoint = url.pathname.split("/").at(-1);
			const start = url.searchParams.get("start_date");
			const end = url.searchParams.get("end_date");
			windows.push({ endpoint, start, end });
			if (windows.length - 1 === failWindow) return json({ error: "unavailable" }, 500);
			const days = [...extraDays];
			if (endpoint === "daily_sleep") for (let day = start; day < end;) {
				days.push(day);
				day = new Date(Date.parse(day) + 86_400_000).toISOString().slice(0, 10);
			}
			return json({ data: endpoint === "daily_sleep" ? days.map((day) => ({ id: id(Number(day.replaceAll("-", ""))), day, score: 88 })) : [], next_token: null });
		},
	};
}
