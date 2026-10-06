// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure parsers for what strava.com serves the owner's signed-in session.
 *
 * The list is `GET /athlete/training_activities?page=N&per_page=M`, the JSON
 * behind strava.com's own "My Activities" page. Its envelope is
 * `{ models, page, perPage, total }`. Each model carries the raw metric
 * fields read here (`distance_raw`, `moving_time_raw`, `elapsed_time_raw`,
 * `elevation_gain_raw`) beside display strings in the owner's units, which
 * are never read: a display string may be in miles.
 *
 * Everything unrecognised fails closed. An envelope of the wrong shape is a
 * page failure, not an empty page, and a model without a numeric id or a
 * zoned start time is counted as unreadable rather than emitted with guesses.
 */

import type { ActivityRecord } from "../strava/parsers.ts";

const NUMERIC_ID_RE = /^\d{1,30}$/;
// A start time with an explicit zone: `Z`, `+00:00` or `+0000`.
const ZONED_START_RE =
	/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

/**
 * Strava's finer `sport_type` values whose coarse activity type differs.
 * The list stopped filling `type` in October 2024 and sends only
 * `sport_type`, while the shared contract's `activity_type` is the coarse
 * type the export carries. Every other `sport_type` is its own coarse type.
 */
const COARSE_TYPE: Readonly<Record<string, string>> = {
	EMountainBikeRide: "EBikeRide",
	GravelRide: "Ride",
	MountainBikeRide: "Ride",
	TrailRun: "Run",
};

export interface TrainingActivitiesPage {
	readonly models: readonly unknown[];
	readonly perPage: number;
	readonly total: number;
}

export type PageParse =
	| ({ readonly ok: true } & TrainingActivitiesPage)
	| { readonly ok: false; readonly message: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const isCount = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** Parse one list response body. Anything but the known envelope fails. */
export function parseTrainingActivitiesPage(body: string): PageParse {
	let payload: unknown;
	try {
		payload = JSON.parse(body);
	} catch {
		return { ok: false, message: "The activity list was not JSON." };
	}
	if (!isRecord(payload) || !Array.isArray(payload.models)) {
		return { ok: false, message: "The activity list had no models array." };
	}
	if (
		!isCount(payload.total) ||
		!isCount(payload.perPage) ||
		payload.perPage === 0
	) {
		return {
			ok: false,
			message: "The activity list had no usable total or perPage.",
		};
	}
	return {
		ok: true,
		models: payload.models,
		perPage: payload.perPage,
		total: payload.total,
	};
}

/**
 * A start time as a UTC instant, `YYYY-MM-DDTHH:MM:SSZ`. Null when the value
 * carries no zone: the list is expected to state one, and a zoneless value
 * would be a changed format rather than something to guess a clock for.
 */
export function normalizeStartTime(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const match = ZONED_START_RE.exec(value.trim());
	if (!match) {
		return null;
	}
	const [, date, time, zone] = match;
	const offset = zone === "Z" ? "Z" : `${zone?.slice(0, 3)}:${zone?.slice(-2)}`;
	const instant = new Date(`${date}T${time}${offset}`);
	if (Number.isNaN(instant.getTime())) {
		return null;
	}
	return `${instant.toISOString().slice(0, 19)}Z`;
}

function numberOrNull(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function idOf(value: unknown): string | null {
	if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
		return String(value);
	}
	if (typeof value === "string" && NUMERIC_ID_RE.test(value)) {
		return value;
	}
	return null;
}

function activityTypeOf(model: Record<string, unknown>): string | null {
	const legacy = model.type;
	if (typeof legacy === "string" && legacy.trim() !== "") {
		return legacy.trim().slice(0, 64);
	}
	const sport = model.sport_type;
	if (typeof sport === "string" && sport.trim() !== "") {
		const trimmed = sport.trim();
		return (COARSE_TYPE[trimmed] ?? trimmed).slice(0, 64);
	}
	return null;
}

/** Offsets in the world are whole quarter hours within ±14 hours. */
const MAX_OFFSET_MIN = 14 * 60;

/**
 * The start on the athlete's own clock, with its offset, when the model's
 * `start_date_local_raw` gives it. That field is the local wall-clock time
 * written as epoch seconds, so its distance from the UTC start is the
 * offset. Null when it is absent or does not give a real offset.
 */
function localStart(utc: string, localRaw: unknown): string | null {
	if (typeof localRaw !== "number" || !Number.isSafeInteger(localRaw)) {
		return null;
	}
	const offsetMin = Math.round((localRaw * 1000 - Date.parse(utc)) / 60_000);
	if (Math.abs(offsetMin) > MAX_OFFSET_MIN || offsetMin % 15 !== 0) {
		return null;
	}
	const wall = new Date(localRaw * 1000).toISOString().slice(0, 19);
	const sign = offsetMin < 0 ? "-" : "+";
	const abs = Math.abs(offsetMin);
	const hh = String(Math.floor(abs / 60)).padStart(2, "0");
	const mm = String(abs % 60).padStart(2, "0");
	return `${wall}${sign}${hh}:${mm}`;
}

/**
 * True when the local and UTC starts differ by a whole number of minutes.
 * localStart rounds the difference; a value it had to round is not a real
 * offset, so the local day it implies is not trusted as the consent field.
 */
function hasExactOffset(utc: string, localRaw: unknown): boolean {
	return (
		typeof localRaw === "number" &&
		(localRaw * 1000 - Date.parse(utc)) % 60_000 === 0
	);
}

/** A record's start as a UTC instant, `YYYY-MM-DDTHH:MM:SSZ`, for ordering. */
export function startInstant(
	record: Pick<ActivityRecord, "start_time">,
): string {
	return `${new Date(record.start_time).toISOString().slice(0, 19)}Z`;
}

/**
 * One activity record from one list model, or null when the model cannot be
 * placed: no numeric id or no zoned start time. The caller counts nulls.
 *
 * `start_time` is on the athlete's local clock, with its offset, when the
 * model gives the local time (basis `local`, so `start_date` and
 * `start_date_local` are the local calendar day); otherwise it is UTC (basis
 * `utc`) and `start_date_local`, the consent-time field, is null. Either way
 * `start_time` is an instant.
 *
 * Heart rate, calories and gear are null because the list does not carry
 * them; the manifest documents those permanent list limitations.
 */
export function buildActivityRecord(model: unknown): ActivityRecord | null {
	if (!isRecord(model)) {
		return null;
	}
	const id = idOf(model.id);
	const utc = normalizeStartTime(model.start_time);
	if (!id || !utc) {
		return null;
	}
	const local = localStart(utc, model.start_date_local_raw);
	const start = local ?? utc;
	return {
		id,
		activity_type: activityTypeOf(model),
		start_date: start.slice(0, 10),
		start_date_local:
			local && hasExactOffset(utc, model.start_date_local_raw)
				? local.slice(0, 10)
				: null,
		start_time: start,
		start_time_basis: local ? "local" : "utc",
		distance_m: numberOrNull(model.distance_raw),
		moving_time_s: numberOrNull(model.moving_time_raw),
		elapsed_time_s: numberOrNull(model.elapsed_time_raw),
		total_elevation_gain_m: numberOrNull(model.elevation_gain_raw),
		average_heartrate: null,
		max_heartrate: null,
		calories_kcal: null,
		gear: null,
		freshness: "live",
		exported_at: null,
	};
}
