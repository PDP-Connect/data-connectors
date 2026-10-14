// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Placing daily readings on the owner's local days.
 *
 * Steps and distance are exported as UTC minutes, while a daily summary is a
 * local day. So each minute is admitted once (MinuteWindow), placed on its
 * local day in the profile's time zone (LocalDayClock) and summed there
 * (DayBook). The active-minutes and resting-heart-rate files already name
 * Fitbit's local day, one row a day.
 *
 * THE ZONE STAYS HERE. The profile's zone is held only inside an
 * `Intl.DateTimeFormat`; it is never returned, logged or emitted. Every other
 * date here is UTC arithmetic on `YYYY-MM-DD` strings, so no answer depends
 * on the zone of the machine running the import.
 *
 * A PARTLY READ FILE NEVER GIVES A DAY'S FIGURE. When a daily file was not
 * read in full, the days it could have held are tainted (familyTaint): the
 * days it placed a row on, and the span its file name places it over. On a
 * tainted day a sum is null and named unreadable, since a partial total is a
 * wrong number delivered as Fitbit's; a one-row field keeps the row that was
 * read, and is null and named unreadable where no row reached the day. Every
 * other day keeps its values.
 */

import {
	type Built,
	calendarDate,
	compareText,
	type Reading,
	utcDayStart,
} from "./parsers.ts";
import {
	DAILY_FIELDS,
	type DailyField,
	type DailySummaryRecord,
} from "./schemas.ts";

const ZONE_RE = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const LAST_MINUTE_OF_HOUR_MS = 59 * 60_000;
const CM_PER_M = 100;

/**
 * The profile zone's local calendar day for a UTC instant.
 *
 * Offsets, not dates, are cached: a local midnight can fall inside a UTC hour
 * (Asia/Colombo's is at 18:30Z), so a date cached per UTC hour would be
 * wrong. An offset is constant between changes, so if the offsets at an
 * hour's first and last minutes agree, it holds for the whole hour;
 * otherwise (Australia/Lord_Howe changes at half past an hour) each instant
 * in that hour is computed. Minute files are nearly in time order, so this
 * costs about two `formatToParts` calls per UTC hour of data.
 */
export class LocalDayClock {
	/**
	 * A clock for an IANA zone name, or null when the zone is unusable: not
	 * name-shaped (an offset such as `+05:30`, which `Intl` would accept, or
	 * the literal `null` a profile writes for an absent value), or unknown to
	 * this runtime.
	 */
	static fromZone(zone: string | null): LocalDayClock | null {
		if (zone === null || !ZONE_RE.test(zone)) {
			return null;
		}
		try {
			return new LocalDayClock(
				new Intl.DateTimeFormat("en-US", {
					timeZone: zone,
					hourCycle: "h23",
					year: "numeric",
					month: "2-digit",
					day: "2-digit",
					hour: "2-digit",
					minute: "2-digit",
					second: "2-digit",
				}),
			);
		} catch {
			// RangeError: not a zone this runtime knows.
			return null;
		}
	}

	private readonly format: Intl.DateTimeFormat;
	/** The start of the UTC hour the cache describes. */
	private hour = Number.NaN;
	private hourOffsetMs = 0;
	/** The offset changes inside that hour. */
	private hourSplit = false;

	// No parameter property: the package's erasableSyntaxOnly forbids them.
	private constructor(format: Intl.DateTimeFormat) {
		this.format = format;
	}

	/** The zone's offset from UTC at `utcMs`, in ms (positive east of UTC). */
	offsetMs(utcMs: number): number {
		const hour = utcMs - (((utcMs % HOUR_MS) + HOUR_MS) % HOUR_MS);
		if (hour !== this.hour) {
			const start = this.offsetAt(hour);
			this.hour = hour;
			this.hourOffsetMs = start;
			this.hourSplit = this.offsetAt(hour + LAST_MINUTE_OF_HOUR_MS) !== start;
		}
		return this.hourSplit ? this.offsetAt(utcMs) : this.hourOffsetMs;
	}

	/** The local calendar day of `utcMs`, `YYYY-MM-DD`. */
	localDate(utcMs: number): string {
		return new Date(utcMs + this.offsetMs(utcMs)).toISOString().slice(0, 10);
	}

	private offsetAt(utcMs: number): number {
		const parts = { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0 };
		for (const part of this.format.formatToParts(utcMs)) {
			if (Object.hasOwn(parts, part.type)) {
				parts[part.type as keyof typeof parts] = Number(part.value);
			}
		}
		const wall = Date.UTC(
			parts.year,
			parts.month - 1,
			parts.day,
			parts.hour,
			parts.minute,
			parts.second,
		);
		return wall - (utcMs - (((utcMs % 1000) + 1000) % 1000));
	}
}

/**
 * Which minutes have been seen, over the member being read and the one
 * before it. Adjacent step and distance files overlap at their boundary, so
 * a repeat there is a copy and is dropped. A repeat two or more members back
 * is not caught: that keeps memory to two members' minutes, each bounded by
 * the member size cap.
 */
export class MinuteWindow {
	private previous = new Set<number>();
	private current = new Set<number>();

	/** "new" admits the minute; "duplicate" was seen in this member or the previous one. */
	admit(utcMs: number): "new" | "duplicate" {
		const seen = this.current.has(utcMs) || this.previous.has(utcMs);
		// A repeat joins this member's set too, so the next member still sees it.
		this.current.add(utcMs);
		return seen ? "duplicate" : "new";
	}

	/** Called between members: the current set becomes the previous one. */
	nextMember(): void {
		this.previous = this.current;
		this.current = new Set();
	}
}

/** The fields summed from UTC minutes. */
export type MinuteField = "steps" | "distance_m";

/** An inclusive run of `YYYY-MM-DD` days; a null end is unbounded. */
interface DaySpan {
	readonly from: string | null;
	readonly to: string | null;
}
/** The days on which a field's family may have lost a row. */
export interface DayTaint {
	readonly days: ReadonlySet<string>;
	readonly spans: readonly DaySpan[];
}
/** Every day: steps and distance_m when there is no usable zone. */
export const WHOLE_HISTORY: DayTaint = {
	days: new Set<string>(),
	spans: [{ from: null, to: null }],
};

/** One member of a daily family; a member duplicated across parts is tainted and placed nothing. */
export interface MemberTaint {
	/** The `YYYY-MM-DD` in its file name, as written. */
	readonly nameDate: string;
	/** Not read in full, or holding a row that could not be placed. */
	readonly tainted: boolean;
	/** The days it placed a row on. Only a tainted member's are read, so the collector keeps no others. */
	readonly days: ReadonlySet<string>;
}

/** One field of one day. */
interface FieldCell {
	/** The row's value, or the running sum (distance in cm); null until a value arrives. */
	value: number | null;
	/** A value that could not be read reached this day, so the field stays null. */
	unreadable: boolean;
}
/** A field's key is there once a row of its family reached the day. */
type DayCell = Partial<Record<DailyField, FieldCell>>;

const NO_ROW: Reading = { value: null, unreadable: false, present: false };

/** `day` moved by `n` days, or null if either is not a real calendar day. */
function shiftDay(day: string, n: number): string | null {
	const start = utcDayStart(day);
	return start === null
		? null
		: calendarDate(new Date(start + n * DAY_MS).toISOString().slice(0, 10));
}

/** The last day a reading can plausibly belong to: a day of slack past the export's UTC date covers zones east of UTC. */
function lastPlausibleDay(exportedAt: string | null): string | null {
	return exportedAt === null ? null : shiftDay(exportedAt.slice(0, 10), 1);
}

function covers(taint: DayTaint | undefined, day: string): boolean {
	if (taint === undefined) {
		return false;
	}
	return (
		taint.days.has(day) ||
		taint.spans.some(
			(span) =>
				(span.from === null || span.from <= day) &&
				(span.to === null || day <= span.to),
		)
	);
}

/** Builds a value for each daily field, in schema order. */
function perField<T>(build: (field: DailyField) => T): Record<DailyField, T> {
	return {
		steps: build("steps"),
		distance_m: build("distance_m"),
		lightly_active_minutes: build("lightly_active_minutes"),
		moderately_active_minutes: build("moderately_active_minutes"),
		very_active_minutes: build("very_active_minutes"),
		resting_heart_rate_bpm: build("resting_heart_rate_bpm"),
	};
}

/** A field's reading for the day as read: a sum, or the one row's value. */
function readingOf(field: DailyField, cell: FieldCell | undefined): Reading {
	if (cell === undefined) {
		return NO_ROW;
	}
	if (cell.unreadable || cell.value === null) {
		return { value: null, unreadable: cell.unreadable, present: true };
	}
	const value =
		field === "distance_m" ? Math.round(cell.value) / CM_PER_M : cell.value;
	return { value, unreadable: false, present: true };
}

/**
 * The field on a day its family's taint covers. A sum is null and
 * unreadable. A one-row field keeps the row read for the day (a value, a
 * padding row's null, or an unreadable value, already flagged); with no
 * row, the lost row may have been this day's, so it is unreadable.
 */
function tainted(field: DailyField, reading: Reading): Reading {
	const summed = field === "steps" || field === "distance_m";
	return summed || !reading.present
		? { value: null, unreadable: true, present: reading.present }
		: reading;
}

/**
 * The day cells: the one row per day of each daily family, and the sums of
 * each minute family's minutes on each local day.
 */
export class DayBook {
	private readonly cells = new Map<string, DayCell>();

	/** A daily family's row: the first for (date, field) wins. */
	setDaily(
		date: string,
		field: DailyField,
		reading: Reading,
	): "set" | "duplicate" {
		const cell = this.cell(date);
		if (cell[field] !== undefined) {
			return "duplicate";
		}
		cell[field] = { value: reading.value, unreadable: reading.unreadable };
		return "set";
	}

	/** A minute: summed into (date, field); an unreadable value marks the field unreadable. */
	addMinute(date: string, field: MinuteField, reading: Reading): void {
		const cell = this.cell(date);
		const sum = cell[field] ?? { value: null, unreadable: false };
		if (reading.unreadable) {
			sum.unreadable = true;
		}
		if (reading.value !== null) {
			sum.value = (sum.value ?? 0) + reading.value;
		}
		cell[field] = sum;
	}

	/**
	 * Every day in date order, built by the day rules. `taint` holds, per field,
	 * the days on which part of its family may not have been read: on such a day
	 * a sum (steps, distance_m) is null and unreadable; any other field keeps the
	 * row read for the day and is null and unreadable where no row set it. Other
	 * days are untouched. Taint applies to records only: whether a day is a
	 * record is judged on the readings as read.
	 *
	 * A day with no reading that is non-zero or unreadable is `zero_only`: the
	 * daily files are padded with zeros. A day more than one day after the
	 * export's UTC date is a record only with a readable non-zero value: the
	 * files are padded past the export date, and an unreadable padding value is
	 * not a reading.
	 */
	*days(
		exportedAt: string | null,
		taint: ReadonlyMap<DailyField, DayTaint>,
	): Iterable<Built<DailySummaryRecord>> {
		const lastDay = lastPlausibleDay(exportedAt);
		const days = [...this.cells].sort(([a], [b]) => compareText(a, b));
		for (const [date, cell] of days) {
			const read = perField((field) => readingOf(field, cell[field]));
			const present = DAILY_FIELDS.filter((field) => read[field].present);
			const nonZero = DAILY_FIELDS.some((field) => {
				const { value } = read[field];
				return value !== null && value !== 0;
			});
			const unreadable = DAILY_FIELDS.some((field) => read[field].unreadable);
			const afterExport = lastDay !== null && date > lastDay;
			if (!nonZero && (!unreadable || afterExport)) {
				yield { kind: "no_reading", timeKey: date, present };
				continue;
			}
			const out = perField((field) =>
				covers(taint.get(field), date)
					? tainted(field, read[field])
					: read[field],
			);
			const record: DailySummaryRecord = {
				id: date,
				date,
				steps: out.steps.value,
				distance_m: out.distance_m.value,
				lightly_active_minutes: out.lightly_active_minutes.value,
				moderately_active_minutes: out.moderately_active_minutes.value,
				very_active_minutes: out.very_active_minutes.value,
				resting_heart_rate_bpm: out.resting_heart_rate_bpm.value,
				freshness: "snapshot",
				exported_at: exportedAt,
			};
			yield {
				kind: "record",
				record,
				timeKey: date,
				unreadable: DAILY_FIELDS.filter((field) => out[field].unreadable),
				present,
			};
		}
	}

	private cell(date: string): DayCell {
		let cell = this.cells.get(date);
		if (cell === undefined) {
			cell = {};
			this.cells.set(date, cell);
		}
		return cell;
	}
}

/**
 * The taint of one daily family: the days its tainted members placed rows
 * on, and their name spans. Members may come in any order; they are sorted
 * by name date, duplicated members included. A member's span runs from its
 * name date − 1 day through the next member's name date. The last member's
 * runs through the export's UTC date + 1 day, or is unbounded when
 * `exportedAt` is null. A span that needs a date that is not a real calendar
 * day (the file names allow `2026-02-30`) is the whole history.
 *
 * Every row a member holds is expected inside its span: a file is named by
 * the first local day of its batch and its UTC minutes can start the day
 * before, and the next file begins where it ends. The days a member actually
 * placed rows on are tainted too, for rows that stray outside it.
 */
export function familyTaint(
	members: readonly MemberTaint[],
	exportedAt: string | null,
): DayTaint {
	const sorted = [...members].sort((a, b) =>
		compareText(a.nameDate, b.nameDate),
	);
	const lastDay = lastPlausibleDay(exportedAt);
	const days = new Set<string>();
	const spans: DaySpan[] = [];
	for (const [index, member] of sorted.entries()) {
		if (!member.tainted) {
			continue;
		}
		for (const day of member.days) {
			days.add(day);
		}
		const next = sorted[index + 1];
		const from = shiftDay(member.nameDate, -1);
		const unbounded = next === undefined && exportedAt === null;
		const to = next === undefined ? lastDay : calendarDate(next.nameDate);
		spans.push(
			from === null || (to === null && !unbounded)
				? { from: null, to: null }
				: { from, to },
		);
	}
	return { days, spans };
}
