// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Polar Flow's read API over the synthetic fixtures, for tests only (index.ts never imports it).
 * It answers as the endpoints are described in fixtures/README.md: 401 JSON without the session,
 * 403 (Flow) or 401 (sleep API) without `X-Requested-With`, the training history filtered by start
 * day, loadFour's [day-2, day+1], the sleep report's 30-to-365-day rule, Nightly Recharge's 404
 * for a range with nothing in it, and a 404 page for any path it does not know. Every value it
 * serves is invented.
 */

import { readFileSync } from "node:fs";

export interface Answer {
	status: number;
	contentType: string;
	body: string;
}

export interface SiteData {
	user: unknown;
	/** History rows; each row's start day is the first ten characters of `startDate`. */
	training: Array<Record<string, unknown>>;
	/** Analysis summaries by session id; a missing one answers 404. */
	summaries: Record<string, unknown>;
	/** Activity days by YYYY-MM-DD; any other day answers a day with nothing recorded. */
	activity: Record<string, unknown>;
	sleep: Array<Record<string, unknown>>;
	nightly: Array<Record<string, unknown>>;
}

const fixture = (name: string): unknown =>
	JSON.parse(
		readFileSync(new URL(`./fixtures/api/${name}`, import.meta.url), "utf8"),
	) as unknown;

/** A fresh copy of the fixtures, safe to edit. */
export function fixtureData(): SiteData {
	return {
		user: fixture("current-user.json"),
		training: fixture("training-history.json") as Array<
			Record<string, unknown>
		>,
		summaries: {
			"8349588454": fixture("training-summary-8349588454.json"),
			"8351200017": fixture("training-summary-8351200017.json"),
		},
		activity: fixture("activity-loadfour.json") as Record<string, unknown>,
		sleep: fixture("sleep-report.json") as Array<Record<string, unknown>>,
		nightly: fixture("nightly-recovery.json") as Array<Record<string, unknown>>,
	};
}

export const USER_ID = 11111111;

const json = (value: unknown, status = 200): Answer => ({
	status,
	contentType: "application/json; charset=utf-8",
	body: JSON.stringify(value),
});
const EMPTY_400: Answer = { status: 400, contentType: "", body: "" };
const NOT_FOUND: Answer = {
	status: 404,
	contentType: "text/html; charset=UTF-8",
	body: "<!doctype html><title>Not Found</title>",
};
export const UNAUTHENTICATED: Answer = json(
	{ error: "NotAuthenticated", redirect: "/" },
	401,
);

const DAY_MS = 86_400_000;
const addDays = (day: string, n: number): string =>
	new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS)
		.toISOString()
		.slice(0, 10);
const daysBetween = (from: string, to: string): number =>
	(Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

function nothingRecorded(): unknown {
	return {
		dataPanelData: {
			dailyActivityGoal: 0,
			activeTime: 0,
			distanceFromSteps: 0,
			stepCount: 0,
			kiloCalories: 0,
			sleepDuration: 0,
			inactivityAlertCount: 0,
			sleepPlus: false,
		},
		activityGraphData: {
			lastSync: null,
			heartRateSummary: { dayMinimum: 0, dayMaximum: 0, nightMinimum: 0 },
		},
		activityScoreData: {
			sedentaryDuration: 0,
			lightDuration: 0,
			moderateDuration: 0,
			vigorousDuration: 0,
		},
	};
}

/**
 * Answers one request as Polar Flow would for the account `data` describes. `url` is a
 * flow.polar.com path or a full sleep-api.flow.polar.com URL, as the page's fetch is given it.
 */
export function polarApi(data: SiteData = fixtureData()) {
	return (url: string, init: RequestInit, signedIn: boolean): Answer => {
		const parsed = new URL(url, "https://flow.polar.com");
		const headers = new Headers(init.headers);
		const xhr = headers.get("x-requested-with") === "XMLHttpRequest";
		const method = init.method ?? "GET";
		if (parsed.origin === "https://sleep-api.flow.polar.com") {
			if (!signedIn || !xhr) {
				return {
					status: 401,
					contentType: "text/html",
					body: "<!DOCTYPE html>",
				};
			}
			const from = parsed.searchParams.get("from") ?? "";
			const to = parsed.searchParams.get("to") ?? "";
			if (parsed.pathname !== "/api/sleep/report") return NOT_FOUND;
			if (!DAY.test(from) || !DAY.test(to)) return EMPTY_400;
			const span = daysBetween(from, to);
			if (span < 30 || span > 365) return EMPTY_400;
			return json(
				data.sleep.filter(
					(n) => typeof n.date === "string" && n.date >= from && n.date <= to,
				),
			);
		}
		if (!parsed.pathname.startsWith("/api/")) return NOT_FOUND;
		if (!signedIn) return UNAUTHENTICATED;
		if (!xhr && method !== "GET")
			return { status: 403, contentType: "", body: "" };
		const path = parsed.pathname;
		if (path === "/api/account/users/current/user") return json(data.user);
		if (path === "/api/training/history" && method === "POST") {
			const body = JSON.parse(String(init.body)) as {
				userId?: unknown;
				fromDate?: unknown;
				toDate?: unknown;
			};
			if (body.userId !== USER_ID)
				return { status: 403, contentType: "", body: "" };
			const from = String(body.fromDate);
			const to = String(body.toDate);
			return json(
				data.training.filter((row) => {
					const day = String(row.startDate).slice(0, 10);
					return day >= from && day <= to;
				}),
			);
		}
		const summary = /^\/api\/training\/analysis\/(\d+)\/summary$/.exec(path);
		if (summary?.[1]) {
			const found = data.summaries[summary[1]];
			return found === undefined ? NOT_FOUND : json(found);
		}
		if (path === "/api/activity-timeline/loadFour") {
			const day = parsed.searchParams.get("day") ?? "";
			if (!DAY.test(day)) return EMPTY_400;
			const out: Record<string, unknown> = {};
			for (let i = -2; i <= 1; i += 1) {
				const d = addDays(day, i);
				out[d] = data.activity[d] ?? nothingRecorded();
			}
			return json(out);
		}
		const nightly = /^\/api\/nightly-recovery\/([\d-]+)\/([\d-]+)$/.exec(path);
		if (nightly?.[1] && nightly[2]) {
			const [from, to] = [nightly[1], nightly[2]];
			const rows = data.nightly.filter(
				(n) => typeof n.date === "string" && n.date >= from && n.date <= to,
			);
			return rows.length === 0
				? { status: 404, contentType: "", body: "" }
				: json(rows);
		}
		return NOT_FOUND;
	};
}
