// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure builders from the JSON app.whoop.com loads to the four streams' records. Every field is set
 * by hand: the runtime ships the object passed to emitRecord, not Zod's parsed copy.
 *
 * Tolerant of what WHOOP leaves out (any metric null or absent, an open cycle, a recovery not yet
 * scored); strict about what it changes: a value of the wrong JSON type, an id or range that does
 * not parse, marks the record unreadable instead of emitting a guess.
 */

import type { RecordData } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import type { Stream } from "./schemas.ts";

type Obj = Record<string, unknown>;
/** An unreadable record keeps its start when that much parsed, so it is counted only within its stream's grant. */
export type Built =
	| { kind: "record"; record: RecordData }
	| { kind: "unreadable"; startAt?: string };

const isObj = (value: unknown): value is Obj =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** Marks a field that came in a shape this parser does not know; a record holding one is unreadable. */
const DRIFT = Symbol("drift");
type Field<T> = T | null | typeof DRIFT;

function built(record: Record<string, unknown>): Built {
	if (!Object.values(record).includes(DRIFT)) {
		return { kind: "record", record: record as RecordData };
	}
	return typeof record.start_at === "string"
		? { kind: "unreadable", startAt: record.start_at }
		: { kind: "unreadable" };
}

function number(value: unknown): Field<number> {
	if (value === null || value === undefined) return null;
	return typeof value === "number" && Number.isFinite(value) ? value : DRIFT;
}

/** A count or duration WHOOP may send with a fraction: rounded. */
function rounded(value: unknown): Field<number> {
	const n = number(value);
	return typeof n === "number" ? Math.round(n) : n;
}

function boolean(value: unknown): Field<boolean> {
	if (value === null || value === undefined) return null;
	return typeof value === "boolean" ? value : DRIFT;
}

/** Average and maximum heart rate; WHOOP sometimes sends an average above the maximum, which says neither is sound. */
function heartRates(
	average: unknown,
	maximum: unknown,
): [Field<number>, Field<number>] {
	const avg = rounded(average);
	const max = rounded(maximum);
	if (typeof avg === "number" && typeof max === "number" && avg > max)
		return [null, null];
	return [avg === 0 ? null : avg, max === 0 ? null : max];
}

// ── Ranges, instants, offsets, ids ─────────────────────────────────────────
const RANGE = /^([[(])\s*([^,]*?)\s*,\s*([^,]*?)\s*([\])])$/;

/** A Postgres range literal, `['<a>','<b>')`; an empty or infinite bound is null (an open cycle's end). */
export function parseRange(
	value: unknown,
): { lower: string | null; upper: string | null } | null {
	if (typeof value !== "string") return null;
	const match = RANGE.exec(value.trim());
	if (!match) return null;
	const bound = (raw: string | undefined): string | null => {
		const text = (raw ?? "").replace(/^(['"])(.*)\1$/, "$2").trim();
		return text === "" || /^[+-]?infinity$/i.test(text) ? null : text;
	};
	return { lower: bound(match[2]), upper: bound(match[3]) };
}

const INSTANT =
	/^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i;

/**
 * An instant WHOOP writes as `…Z` or `…+0000`, re-written as RFC 3339 UTC with milliseconds. Null
 * when it is not one: without a zone it would be read in the host's, and a day the calendar lacks
 * would roll into the next month.
 */
export function toInstant(value: unknown): string | null {
	const match = typeof value === "string" ? INSTANT.exec(value) : null;
	const day = match?.[1];
	if (!match || !day) return null;
	const midnight = Date.parse(`${day}T00:00:00Z`);
	if (
		!Number.isFinite(midnight) ||
		new Date(midnight).toISOString().slice(0, 10) !== day
	) {
		return null;
	}
	const ms = Date.parse(match[0].replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
	return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** `±HHMM` (cycles) or `±HH:MM` (sleeps, workouts) or `Z`, as `±HH:MM`; anything else null, since no field depends on it. */
export function toOffset(value: unknown): string | null {
	if (value === "Z") return "+00:00";
	if (typeof value !== "string") return null;
	const match = /^([+-])(\d{2}):?(\d{2})$/.exec(value);
	return match ? `${match[1]}${match[2]}:${match[3]}` : null;
}

/** A range's start and end as instants: a missing or unreadable start, or an unreadable end, is drift. */
function interval(value: unknown): [Field<string>, Field<string>] {
	const range = parseRange(value);
	if (!range || range.lower === null) return [DRIFT, DRIFT];
	const start = toInstant(range.lower);
	const end = range.upper === null ? null : toInstant(range.upper);
	return [start ?? DRIFT, range.upper === null ? null : (end ?? DRIFT)];
}

function positiveInteger(value: unknown): string | null {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0
		? String(value)
		: null;
}

/** Sleep and workout ids are UUIDs; old history may hold integers. */
function activityId(value: unknown): Field<string> {
	if (typeof value === "string" && value.trim() !== "") return value;
	return positiveInteger(value) ?? DRIFT;
}

// ── Account summary ────────────────────────────────────────────────────────
/** The user id the cycles call takes, and when the account began. Null when the ids are missing or disagree. */
export function bootstrapFacts(
	json: unknown,
): { userId: string; createdAt: string | null } | null {
	if (!isObj(json)) return null;
	const user = isObj(json.user) ? json.user : {};
	const account = isObj(json.account) ? json.account : {};
	const profile = isObj(json.profile) ? json.profile : {};
	const ids = [user.id, account.user_id, profile.user_id]
		.filter((value) => value !== undefined && value !== null)
		.map(positiveInteger);
	const userId = ids[0];
	if (!userId || ids.some((id) => id !== userId)) return null;
	return {
		userId,
		createdAt: toInstant(account.created_at) ?? toInstant(user.created_at),
	};
}

// ── Cycles ─────────────────────────────────────────────────────────────────
/** The list of cycle elements: `{ records: [...] }`, or a bare array. Null for anything else. */
export function cycleElements(json: unknown): unknown[] | null {
	if (Array.isArray(json)) return json;
	return isObj(json) && Array.isArray(json.records) ? json.records : null;
}

export interface Cycle {
	id: string;
	startAt: string;
	startMs: number;
	/** Still under way: its range has no end yet. */
	open: boolean;
	updatedMs: number;
	element: Obj;
}

/** How many records a nested list holds: none when absent, one unreadable when it is not a list. */
const listSize = (value: unknown): number =>
	value === null || value === undefined
		? 0
		: Array.isArray(value)
			? value.length
			: 1;

/** What an unreadable element costs each stream: the records recordsFor would have built from it. */
function nested(element: unknown): Record<Stream, number> {
	const source = isObj(element) ? element : {};
	const { recovery } = source;
	return {
		cycles: 1,
		recoveries:
			recovery === null || recovery === undefined
				? 0
				: isObj(recovery) && !hasMeasure(recoveryMetrics(recovery))
					? 0
					: 1,
		sleeps: listSize(source.sleeps),
		workouts: listSize(source.workouts),
	};
}

/** One element of the answer: its cycle's id and start, or what it cost each stream when those do not parse. */
export function readElement(
	element: unknown,
):
	| { kind: "cycle"; cycle: Cycle }
	| { kind: "unreadable"; lost: Record<Stream, number> } {
	const cycle = isObj(element) && isObj(element.cycle) ? element.cycle : null;
	const id = cycle ? positiveInteger(cycle.id) : null;
	const [startAt, endAt] = cycle ? interval(cycle.during) : [DRIFT, DRIFT];
	if (!isObj(element) || !id || typeof startAt !== "string") {
		return { kind: "unreadable", lost: nested(element) };
	}
	const updated = toInstant(cycle?.updated_at);
	return {
		kind: "cycle",
		cycle: {
			id,
			startAt,
			startMs: Date.parse(startAt),
			open: endAt === null,
			updatedMs: updated ? Date.parse(updated) : Number.NEGATIVE_INFINITY,
			element,
		},
	};
}

function cycleRecord({ id, element }: Cycle): Built {
	const cycle = element.cycle as Obj;
	const [startAt, endAt] = interval(cycle.during);
	// Absent is undefined, so a days that does not parse (null) reads as drift.
	const days =
		cycle.days === null || cycle.days === undefined
			? undefined
			: parseRange(cycle.days);
	const day =
		days === undefined
			? null
			: days?.lower && /^\d{4}-\d{2}-\d{2}$/.test(days.lower)
				? days.lower
				: DRIFT;
	const [average, maximum] = heartRates(
		cycle.day_avg_heart_rate,
		cycle.day_max_heart_rate,
	);
	return built({
		id,
		start_at: startAt,
		end_at: endAt,
		day,
		timezone_offset: toOffset(cycle.timezone_offset),
		strain: number(cycle.scaled_strain),
		kilojoules: number(cycle.day_kilojoules),
		average_heart_rate: average,
		max_heart_rate: maximum,
	});
}

function recoveryMetrics(recovery: Obj) {
	const hrv = number(recovery.hrv_rmssd);
	const resting = rounded(recovery.resting_heart_rate);
	return {
		recovery_score: number(recovery.recovery_score),
		// Seconds to milliseconds, kept to the microsecond; 0 is WHOOP's "no reading".
		hrv_rmssd_ms:
			typeof hrv === "number"
				? hrv === 0
					? null
					: Math.round(hrv * 1e6) / 1e3
				: hrv,
		// 0 is WHOOP's "no reading".
		resting_heart_rate: resting === 0 ? null : resting,
		spo2_percentage: number(recovery.spo2),
		skin_temp_celsius: number(recovery.skin_temp_celsius),
	};
}

/** A recovery WHOOP has not scored yet carries no measure: nothing to record until it has. */
const hasMeasure = (metrics: Record<string, unknown>): boolean =>
	Object.values(metrics).some((value) => value !== null);

function recoveryRecord({ id, startAt }: Cycle, recovery: Obj): Built[] {
	const metrics = recoveryMetrics(recovery);
	if (!hasMeasure(metrics)) return [];
	const sleepId =
		recovery.activity_id === null || recovery.activity_id === undefined
			? null
			: activityId(recovery.activity_id);
	return [built({ id, start_at: startAt, sleep_id: sleepId, ...metrics })];
}

function sleepRecord(cycleIdValue: string, sleep: unknown): Built {
	if (!isObj(sleep)) return { kind: "unreadable" };
	const [startAt, endAt] = interval(sleep.during);
	return built({
		id: activityId(sleep.activity_id),
		cycle_id: cycleIdValue,
		start_at: startAt,
		end_at: endAt,
		timezone_offset: toOffset(sleep.timezone_offset),
		is_nap: boolean(sleep.is_nap),
		performance_percentage: number(sleep.score),
		respiratory_rate: number(sleep.respiratory_rate),
		in_bed_ms: rounded(sleep.time_in_bed),
		awake_ms: rounded(sleep.wake_duration),
		light_ms: rounded(sleep.light_sleep_duration),
		slow_wave_ms: rounded(sleep.slow_wave_sleep_duration),
		rem_ms: rounded(sleep.rem_sleep_duration),
	});
}

function workoutRecord(cycleIdValue: string, workout: unknown): Built {
	if (!isObj(workout)) return { kind: "unreadable" };
	const [startAt, endAt] = interval(workout.during);
	const [average, maximum] = heartRates(
		workout.average_heart_rate,
		workout.max_heart_rate,
	);
	const sport = number(workout.sport_id);
	return built({
		id: activityId(workout.activity_id),
		cycle_id: cycleIdValue,
		start_at: startAt,
		end_at: endAt,
		timezone_offset: toOffset(workout.timezone_offset),
		// -1 is a generic activity and 0 is running: never test it for truthiness.
		sport_id:
			typeof sport === "number" && !Number.isInteger(sport) ? DRIFT : sport,
		strain: number(workout.score),
		kilojoules: number(workout.kilojoules),
		average_heart_rate: average,
		max_heart_rate: maximum,
	});
}

/** A nested list: absent or null is none; anything but a list is one unreadable record. */
function list(value: unknown, build: (item: unknown) => Built): Built[] {
	if (value === null || value === undefined) return [];
	return Array.isArray(value) ? value.map(build) : [{ kind: "unreadable" }];
}

/** The records one cycle element holds for a stream. */
export function recordsFor(stream: Stream, cycle: Cycle): Built[] {
	const { element } = cycle;
	if (stream === "cycles") return [cycleRecord(cycle)];
	if (stream === "recoveries") {
		const { recovery } = element;
		if (recovery === null || recovery === undefined) return [];
		return isObj(recovery)
			? recoveryRecord(cycle, recovery)
			: [{ kind: "unreadable" }];
	}
	if (stream === "sleeps")
		return list(element.sleeps, (item) => sleepRecord(cycle.id, item));
	return list(element.workouts, (item) => workoutRecord(cycle.id, item));
}
