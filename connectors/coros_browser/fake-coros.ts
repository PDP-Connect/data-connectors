// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * COROS Training Hub's read API over the synthetic fixtures, for tests only (index.ts never
 * imports it). It answers each path as the web bundle says the live API does: the account, the
 * dashboard, the activity list filtered by local day and paged by size and pageNumber, day details
 * and the training calendar filtered by day, an error envelope for a path it does not know. The
 * shapes are inferred from the bundle (fixtures/README.md); every value it serves is invented.
 */

import { readFileSync } from "node:fs";

export interface Answer {
	status: number;
	contentType: string;
	body: string;
}

/** What the fake account holds. */
export interface SiteData {
	account: unknown;
	dashboard: unknown;
	/** Activity rows, newest first, each with its local `date`. */
	activities: unknown[];
	/** Day rows (`happenDay`). */
	days: unknown[];
	/** The calendar: entries (`happenDay`) and the workouts they point at. */
	schedule: { entities: unknown[]; programs: unknown[] };
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
	const schedule = fixture("schedule.json");
	return {
		account: field(fixture("account.json"), "data"),
		dashboard: field(fixture("dashboard.json"), "data"),
		activities: fixture("activities.json") as unknown[],
		days: fixture("day-detail.json") as unknown[],
		schedule: {
			entities: field(schedule, "entities") as unknown[],
			programs: field(schedule, "programs") as unknown[],
		},
	};
}

const ok = (data: unknown): Answer => ({
	status: 200,
	contentType: "application/json;charset=UTF-8",
	body: JSON.stringify({ result: "0000", message: "OK", data }),
});
/** COROS answers a request it refuses with HTTP 200 and its own code. */
export const coded = (result: string): Answer => ({
	status: 200,
	contentType: "application/json;charset=UTF-8",
	body: JSON.stringify({ result, message: "E".concat(result) }),
});

const DAY = /^\d{8}$/;
const within = (day: unknown, from: string, to: string): boolean =>
	(typeof day === "number" || typeof day === "string") &&
	String(day) >= from &&
	String(day) <= to;

/**
 * Answers one API path as COROS would for the account `data` describes. `change`, called with
 * each path before it is answered, may edit `data` or return an answer of its own (an outage, a
 * rate limit, an expired session).
 */
export function corosApi(
	data: SiteData = fixtureData(),
	change: (data: SiteData, path: string) => Answer | undefined = () =>
		undefined,
): (path: string) => Answer {
	return (path) => {
		const override = change(data, path);
		if (override) return override;
		const url = new URL(path, "https://teamapi.coros.com");
		const at = url.pathname;
		const query = url.searchParams;
		if (at === "/account/query") return ok(data.account);
		if (at === "/dashboard/query") return ok(data.dashboard);
		if (at === "/activity/query") {
			const from = query.get("startDay") ?? "";
			const to = query.get("endDay") ?? "";
			const size = Number(query.get("size"));
			const pageNumber = Number(query.get("pageNumber"));
			if (
				!DAY.test(from) ||
				!DAY.test(to) ||
				!(size > 0) ||
				!(pageNumber > 0)
			) {
				return coded("1001");
			}
			const rows = data.activities.filter((row) =>
				within(field(row, "date"), from, to),
			);
			const start = (pageNumber - 1) * size;
			return ok({
				count: rows.length,
				pageNumber,
				totalPage: Math.ceil(rows.length / size),
				dataList: rows.slice(start, start + size),
			});
		}
		if (at === "/analyse/dayDetail/query") {
			const from = query.get("startDay") ?? "";
			const to = query.get("endDay") ?? "";
			if (!DAY.test(from) || !DAY.test(to)) return coded("1001");
			return ok({
				dayList: data.days.filter((row) =>
					within(field(row, "happenDay"), from, to),
				),
				weekList: [],
			});
		}
		if (at === "/training/schedule/query") {
			const from = query.get("startDate") ?? "";
			const to = query.get("endDate") ?? "";
			if (!DAY.test(from) || !DAY.test(to)) return coded("1001");
			return ok({
				entities: data.schedule.entities.filter((row) =>
					within(field(row, "happenDay"), from, to),
				),
				programs: data.schedule.programs,
				sportDatasNotInPlan: [],
			});
		}
		return coded("1001");
	};
}
