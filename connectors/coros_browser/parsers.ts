// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure parsing for COROS Training Hub's own JSON API (teamapi.coros.com and its regional twins).
 * Every answer is an envelope `{ result, message, data }` whose `result` is "0000" on success.
 * Zod checks each answer at the boundary; record builders then map COROS's field names and units
 * onto the streams' own. Field names and units come from the Training Hub web bundle (v2.12.0,
 * read 2026-11-11) and are inferred until a live account confirms them: see fixtures/README.md.
 */

import { z } from "zod";
import type { RecordData } from "../../packages/polyfill-connectors/src/connector-runtime.ts";

// ── Regions ────────────────────────────────────────────────────────────────
/**
 * Training Hub's REGIONCONFIG, production entries only: the region id the site keeps in the
 * `CPL-coros-region` cookie (or its own initial state) picks the API host for the account.
 */
export const REGIONS = {
	1: { key: "us", api: "https://teamapi.coros.com" },
	2: { key: "cn", api: "https://teamcnapi.coros.com" },
	3: { key: "eu", api: "https://teameuapi.coros.com" },
	4: { key: "sg", api: "https://teamsgapi.coros.com" },
} as const;
export type RegionId = keyof typeof REGIONS;
export type RegionKey = (typeof REGIONS)[RegionId]["key"];

export function regionKey(id: number): RegionKey | null {
	return id === 1 || id === 2 || id === 3 || id === 4 ? REGIONS[id].key : null;
}

// ── Sports ─────────────────────────────────────────────────────────────────
/** Training Hub's sport-type table (Definition.getSportNameByType), categories left out. */
export const SPORT_NAMES: Readonly<Record<number, string>> = {
	98: "Custom_Sport",
	100: "Run",
	101: "Indoor_Run",
	102: "Trail_Run",
	103: "Track_Run",
	104: "Hike",
	105: "Mtn_Climb",
	106: "Climb",
	200: "Bike",
	201: "Indoor_Bike",
	202: "Road_Ebike",
	203: "Gravel_Road_Bike",
	204: "Mountain_Riding",
	205: "Mountain_Ebike",
	299: "Helmet_Bike",
	300: "Pool_Swim",
	301: "Open_Water",
	400: "Gym_Cardio",
	401: "GPS_Cardio",
	402: "Strength",
	500: "Ski",
	501: "Snowboard",
	502: "XC_Ski",
	503: "Ski_Touring",
	700: "Row",
	701: "Indoor_Row",
	702: "Whitewater",
	704: "Flatwater",
	705: "Windsurfing",
	706: "Speedsurfing",
	707: "Boat_Fishing_Lure",
	708: "Shore_Fishing_Lure",
	709: "Pond_Fishing_Lure",
	710: "Kayak_Fishing_Lure",
	711: "Inshore_Fishing",
	712: "Offshore_Fishing",
	713: "Boat_Fly_Fishing",
	714: "Shore_Fly_Fishing",
	715: "Surf_Fishing",
	800: "IndoorClimb",
	801: "Bouldering",
	802: "Outdoor_Climb",
	900: "Walk",
	901: "Jump_Rope",
	902: "Climb_Stairs",
	903: "Elliptical",
	904: "Yoga",
	905: "Pilates",
	906: "Boxing",
	1000: "Badminton",
	1001: "TableTennis",
	1002: "Basketball",
	1003: "Football",
	1004: "Pickleball",
	1005: "Tennis",
	1006: "Padel",
	1100: "Frisbee",
	1101: "Skateboarding",
	1200: "Hyrox",
	10000: "Triathlon",
	10001: "Multi_Sport",
	10002: "Ski_Touring_Old",
	10003: "Multi_Pitch",
};

/** COROS's name for a sport type; custom sports (98, 9800-9930) share one. Unknown: null. */
export function sportName(type: number | null): string | null {
	if (type === null) return null;
	if (type >= 9800 && type <= 9930) return "Custom_Sport";
	return SPORT_NAMES[type] ?? null;
}

/**
 * A planned workout's sport: Training Hub reads the workout categories (sportCategoryConfig,
 * 1 to 9) first and falls back to the activity sport types, as its calendar does.
 */
const PLAN_CATEGORIES: Readonly<Record<number, string>> = {
	1: "Run",
	2: "Bike",
	3: "Swim",
	4: "Strength",
	5: "Trail_Run",
	6: "IndoorClimb",
	7: "Bouldering",
	8: "XC_Ski",
	9: "Hyrox",
};
export function planSportName(type: number | null): string | null {
	if (type === null) return null;
	return PLAN_CATEGORIES[type] ?? sportName(type);
}

// ── Envelope ───────────────────────────────────────────────────────────────
const envelopeSchema = z.object({
	result: z.string(),
	message: z.string().nullish(),
	data: z.unknown().optional(),
});

/** Training Hub's codes for a session that must sign in again ("1019" it first tries to refresh). */
export const LOGIN_EXPIRED = "1019";
export const TOKEN_INVALID = "ACCESS_TOKEN_IS_INVALID";

export type Envelope =
	| { kind: "ok"; data: unknown }
	| { kind: "error"; result: string }
	| { kind: "unreadable" };

export function readEnvelope(json: unknown): Envelope {
	const parsed = envelopeSchema.safeParse(json);
	if (!parsed.success) return { kind: "unreadable" };
	const { result, data } = parsed.data;
	return result === "0000" ? { kind: "ok", data } : { kind: "error", result };
}

// ── Values ─────────────────────────────────────────────────────────────────
const finite = (value: unknown): number | null =>
	typeof value === "number" && Number.isFinite(value) ? value : null;
/** COROS writes 0 for a reading it does not have (heart rate, HRV, VO2max, power). */
const reading = (value: unknown): number | null => {
	const n = finite(value);
	return n === null || n === 0 ? null : n;
};
/** A number, or a decimal string such as Training Hub's completion rate. */
const numeric = (value: unknown): number | null => {
	if (typeof value === "string" && DECIMAL.test(value.trim())) {
		return Number(value.trim());
	}
	return finite(value);
};
const DECIMAL = /^-?\d+(?:\.\d+)?$/;
const integer = (value: unknown): number | null => {
	const n = finite(value);
	return n !== null && Number.isInteger(n) ? n : null;
};
const text = (value: unknown): string | null => {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed === "" ? null : trimmed;
};
/** An id COROS sends as a number or a string. */
const idOf = (value: unknown): string | null => {
	if (typeof value === "string" && value.trim() !== "") return value.trim();
	if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
		return String(value);
	}
	return null;
};

/** COROS's day, YYYYMMDD as a number or a string, as YYYY-MM-DD; anything else null. */
export function corosDay(value: unknown): string | null {
	const raw = typeof value === "number" ? String(value) : value;
	if (typeof raw !== "string" || !/^\d{8}$/.test(raw)) return null;
	const iso = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
	const ms = Date.parse(`${iso}T00:00:00Z`);
	return Number.isFinite(ms) && new Date(ms).toISOString().startsWith(iso)
		? iso
		: null;
}

/** YYYY-MM-DD as COROS's YYYYMMDD query form. */
export const queryDay = (day: string): string => day.replaceAll("-", "");

const epochIso = (seconds: unknown): string | null => {
	const s = finite(seconds);
	if (s === null || s <= 0) return null;
	const d = new Date(s * 1000);
	return Number.isFinite(d.getTime()) ? d.toISOString() : null;
};

// ── Records ────────────────────────────────────────────────────────────────
type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** `/account/query` and `/dashboard/query` together: the owner and their current thresholds. */
export function profileRecord(
	account: unknown,
	dashboard: unknown,
	region: RegionKey,
): RecordData | null {
	if (!isObj(account)) return null;
	const id = idOf(account.userId);
	if (id === null) return null;
	const summary =
		isObj(dashboard) && isObj(dashboard.summaryInfo)
			? dashboard.summaryInfo
			: {};
	const unit = integer(account.unit);
	const count = isObj(account.sportDataSummary)
		? integer(account.sportDataSummary.count)
		: null;
	return {
		id,
		nickname: text(account.nickname),
		region,
		unit_system: unit === 0 ? "metric" : unit === 1 ? "imperial" : null,
		activity_count: count,
		resting_heart_rate_bpm: reading(summary.rhr),
		threshold_heart_rate_bpm: reading(summary.lthr),
		max_heart_rate_bpm: reading(summary.fitnessMaxHr),
	};
}

const activityPageSchema = z.object({
	count: z.number().nullish(),
	pageNumber: z.number().nullish(),
	totalPage: z.number().nullish(),
	dataList: z.array(z.unknown()).nullish(),
});
export interface ActivityPage {
	rows: unknown[];
	/** Pages COROS says the window has, or null when it did not say (absent, zero or negative). */
	totalPage: number | null;
}
const positivePages = (value: number | null | undefined): number | null => {
	if (typeof value !== "number" || !Number.isFinite(value)) return null;
	const pages = Math.trunc(value);
	return pages > 0 ? pages : null;
};
/** `/activity/query`: one page of the activity list. A list with no activities may omit dataList. */
export function activityPage(data: unknown): ActivityPage | null {
	const parsed = activityPageSchema.safeParse(data);
	if (!parsed.success) return null;
	return {
		rows: parsed.data.dataList ?? [],
		totalPage: positivePages(parsed.data.totalPage),
	};
}

/**
 * One activity-list row. `startTimezone` is COROS's offset in quarter hours; the local day comes
 * from it, else from the row's own `date`, else stays null. Calories arrive in calories.
 */
export function activityRecord(row: unknown): RecordData | null {
	if (!isObj(row)) return null;
	const id = idOf(row.labelId);
	const startAt = epochIso(row.startTime);
	const sportType = integer(row.sportType);
	if (id === null || startAt === null || sportType === null) return null;
	const quarters = integer(row.startTimezone);
	const offset = quarters === null ? null : quarters * 15;
	const startDate =
		offset !== null
			? new Date(Date.parse(startAt) + offset * 60_000)
					.toISOString()
					.slice(0, 10)
			: corosDay(row.date);
	const calories = finite(row.calorie);
	const steps = integer(row.step);
	return {
		id,
		sport_type: sportType,
		sport: sportName(sportType),
		start_at: startAt,
		end_at: epochIso(row.endTime),
		start_date: startDate,
		utc_offset_minutes: offset,
		total_time_s: finite(row.totalTime),
		workout_time_s: finite(row.workoutTime),
		// A strength or indoor session reports distance 0: no distance, not zero metres.
		distance_m: reading(row.distance),
		calories_kcal: calories === null ? null : Math.round(calories) / 1000,
		average_heart_rate_bpm: reading(row.avgHr),
		training_load: finite(row.trainingLoad),
		ascent_m: finite(row.ascent),
		descent_m: finite(row.descent),
		average_power_w: reading(row.avgPower),
		average_cadence: reading(row.cadence),
		steps: steps === 0 ? null : steps,
		device: text(row.device),
	};
}

const dayListSchema = z.object({ dayList: z.array(z.unknown()).nullish() });
/** `/analyse/dayDetail/query`: one row per day of the window asked for. */
export function dayList(data: unknown): unknown[] | null {
	const parsed = dayListSchema.safeParse(data);
	return parsed.success ? (parsed.data.dayList ?? []) : null;
}

/** One day of training and recovery metrics. HRV's normal range is the third and fourth of `sleepHrvIntervalList`. */
export function dailyRecord(row: unknown): RecordData | null {
	if (!isObj(row)) return null;
	const date = corosDay(row.happenDay);
	if (date === null) return null;
	const interval = Array.isArray(row.sleepHrvIntervalList)
		? row.sleepHrvIntervalList
		: [];
	return {
		id: date,
		date,
		resting_heart_rate_bpm: reading(row.rhr),
		hrv_ms: reading(row.avgSleepHrv),
		hrv_normal_low_ms: reading(interval[2]),
		hrv_normal_high_ms: reading(interval[3]),
		training_load: finite(row.trainingLoad),
		acute_load: finite(row.ati),
		chronic_load: finite(row.cti),
		fatigue: finite(row.tiredRateNew),
		load_ratio: finite(row.trainingLoadRatio),
		vo2max: reading(row.vo2max),
		threshold_heart_rate_bpm: reading(row.lthr),
		threshold_pace_s_per_km: reading(row.ltsp),
		stamina_level: finite(row.staminaLevel),
		stamina_level_7d: finite(row.staminaLevel7d),
	};
}

const scheduleSchema = z.object({
	entities: z.array(z.unknown()).nullish(),
	programs: z.array(z.unknown()).nullish(),
});
export interface Schedule {
	entities: unknown[];
	programs: unknown[];
}
/** `/training/schedule/query`: the calendar's planned entries and the workouts they point at. */
export function schedule(data: unknown): Schedule | null {
	const parsed = scheduleSchema.safeParse(data);
	if (!parsed.success) return null;
	return {
		entities: parsed.data.entities ?? [],
		programs: parsed.data.programs ?? [],
	};
}

/** A plan id for joining: a missing, empty or zero plan id all mean "no plan". */
const planKey = (value: unknown): string => {
	const id = idOf(value);
	return id === null || id === "0" ? "" : id;
};

/**
 * One planned workout: a calendar entry joined to its program by `idInPlan` and `planId`, as
 * Training Hub joins them. The id is the day, plan and place in the plan, which stay put across runs.
 */
export function plannedRecords(
	value: Schedule,
): Array<{ ok: true; record: RecordData } | { ok: false }> {
	const programs = new Map<string, Obj>();
	for (const program of value.programs) {
		if (!isObj(program)) continue;
		const inPlan = idOf(program.idInPlan);
		if (inPlan !== null) {
			programs.set(`${inPlan}&${planKey(program.planId)}`, program);
		}
	}
	return value.entities.map((entity) => {
		if (!isObj(entity)) return { ok: false };
		const date = corosDay(entity.happenDay);
		const inPlan = idOf(entity.idInPlan);
		if (date === null || inPlan === null) return { ok: false };
		const planId = planKey(entity.planId);
		const program = programs.get(`${inPlan}&${planId}`) ?? {};
		const sportType = integer(program.sportType);
		const done = isObj(entity.sportData) ? entity.sportData : null;
		// "-1.00" until COROS rates the workout: not yet rated, not a rate.
		const rate = numeric(entity.completeRate);
		return {
			ok: true,
			record: {
				id: `${date}:${planId}:${inPlan}`,
				date,
				name: text(program.name),
				sport_type: sportType,
				sport: planSportName(sportType),
				planned_training_load: finite(program.trainingLoad),
				completion_rate: rate !== null && rate >= 0 ? rate : null,
				completed_activity_id: done ? idOf(done.labelId) : null,
			},
		};
	});
}
