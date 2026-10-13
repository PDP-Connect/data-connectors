// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Garmin Connect's read API over the synthetic fixtures, for tests only (index.ts never imports
 * it). It answers each path as the live site was seen to on 3 October 2026: one day per daily
 * read, a range read cut to the rows inside it (sleep refuses more than 28 days), HRV's 204 for a
 * window with no nights, activities filtered by local start day and paged by start and limit, a
 * 404 page for a path it does not know. Every value it serves is invented.
 */

import { readFileSync } from "node:fs";

export interface Answer {
	status: number;
	contentType: string;
	body: string;
}

/** What the fake account holds. */
export interface SiteData {
	settings: unknown;
	/** Daily summaries by day; any other day answers an all-null summary dated that day. */
	daily: Record<string, unknown>;
	/** Training status by day; any other day answers one with no status. */
	trainingStatus: Record<string, unknown>;
	/** Sleep rows (`individualStats`), ascending by calendarDate. */
	sleep: unknown[];
	/** HRV rows (`hrvSummaries`), ascending by calendarDate. */
	hrv: unknown[];
	/** Activity rows, newest first. */
	activities: unknown[];
}

const fixture = (name: string): unknown =>
	JSON.parse(
		readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"),
	) as unknown;

type Obj = Record<string, unknown>;
const field = (value: unknown, key: string): unknown =>
	typeof value === "object" && value !== null ? (value as Obj)[key] : undefined;

/** A fresh copy of the fixtures, safe to edit. */
export function fixtureData(): SiteData {
	return {
		settings: fixture("settings.json"),
		daily: { "2026-09-16": fixture("daily-summary.json") },
		trainingStatus: { "2026-09-16": fixture("training-status.json") },
		sleep: field(fixture("sleep-stats.json"), "individualStats") as unknown[],
		hrv: field(fixture("hrv-daily.json"), "hrvSummaries") as unknown[],
		activities: fixture("activities.json") as unknown[],
	};
}

const json = (value: unknown, status = 200): Answer => ({
	status,
	contentType: "application/json;charset=UTF-8",
	body: JSON.stringify(value),
});
const NOT_FOUND: Answer = {
	status: 404,
	contentType: "text/html",
	body: "<!doctype html><title>Not Found</title>",
};
const BAD_RANGE = json({ message: "Invalid range", error: "BadRequest" }, 400);

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const days = (from: string, to: string): number =>
	(Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
		86_400_000 +
	1;
const within = (day: unknown, from: string, to: string): boolean =>
	typeof day === "string" && day >= from && day <= to;

/**
 * Answers one same-origin path as Garmin would for the account `data` describes. `change`, called
 * with each path before it is answered, may edit `data`: the account changing between requests,
 * as when a watch syncs an activity while a run reads a window piece by piece.
 */
export function garminApi(
	data: SiteData = fixtureData(),
	change: (data: SiteData, path: string) => void = () => {},
): (path: string) => Answer {
	return (path) => {
		change(data, path);
		const url = new URL(path, "https://connect.garmin.com");
		const at = url.pathname;
		const query = url.searchParams;
		if (at === "/gc-api/userprofile-service/userprofile/settings") {
			return json(data.settings);
		}
		if (at === "/gc-api/usersummary-service/usersummary/daily") {
			const day = query.get("calendarDate") ?? "";
			if (!DAY.test(day)) return BAD_RANGE;
			return json(
				data.daily[day] ?? {
					...(fixture("daily-summary-empty.json") as Obj),
					calendarDate: day,
				},
			);
		}
		let match =
			/^\/gc-api\/metrics-service\/metrics\/trainingstatus\/daily\/(\d{4}-\d{2}-\d{2})$/.exec(
				at,
			);
		if (match?.[1]) {
			return json(
				data.trainingStatus[match[1]] ?? fixture("training-status-empty.json"),
			);
		}
		match =
			/^\/gc-api\/sleep-service\/stats\/sleep\/daily\/(\d{4}-\d{2}-\d{2})\/(\d{4}-\d{2}-\d{2})$/.exec(
				at,
			);
		if (match?.[1] && match[2]) {
			const [, from, to] = match;
			if (days(from, to) < 1 || days(from, to) > 28) return BAD_RANGE;
			const rows = data.sleep.filter((row) =>
				within(field(row, "calendarDate"), from, to),
			);
			return json(
				rows.length === 0
					? fixture("sleep-stats-empty.json")
					: { overallStats: {}, individualStats: rows },
			);
		}
		match =
			/^\/gc-api\/hrv-service\/hrv\/daily\/(\d{4}-\d{2}-\d{2})\/(\d{4}-\d{2}-\d{2})$/.exec(
				at,
			);
		if (match?.[1] && match[2]) {
			const [, from, to] = match;
			if (days(from, to) < 1) return BAD_RANGE;
			const rows = data.hrv.filter((row) =>
				within(field(row, "calendarDate"), from, to),
			);
			return rows.length === 0
				? { status: 204, contentType: "", body: "" }
				: json({ hrvSummaries: rows, userProfilePk: 41001 });
		}
		if (at === "/gc-api/activitylist-service/activities/search/activities") {
			const from = query.get("startDate") ?? "";
			const to = query.get("endDate") ?? "";
			const start = Number(query.get("start"));
			const limit = Number(query.get("limit"));
			if (!DAY.test(from) || !DAY.test(to) || !(limit > 0) || !(start >= 0)) {
				return BAD_RANGE;
			}
			const rows = data.activities.filter((row) => {
				const local = field(row, "startTimeLocal");
				return (
					typeof local === "string" && within(local.slice(0, 10), from, to)
				);
			});
			return json(rows.slice(start, start + limit));
		}
		return NOT_FOUND;
	};
}
