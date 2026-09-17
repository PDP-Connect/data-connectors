// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Parsing for the Strava account export's `activities.csv`.
 *
 * THE TRAP THIS FILE EXISTS TO AVOID. `activities.csv` has REPEATED column
 * headers: `Distance` and `Elapsed Time` each appear twice. The first
 * occurrence is in the athlete's own display units — which may be miles — and
 * the second is canonical metres and seconds. A header-name-to-index map keeps
 * whichever occurrence it saw last or first, and either way produces a number
 * that is unlabelled, plausible and wrong: a five-mile run read as five metres
 * is absurd enough to notice, but read as 8047 metres it is simply correct, and
 * read as `5` it is a number nobody questions until they do.
 *
 * So rows are carried as positional `string[]`, never as `Record<header,
 * value>`, and {@link resolveColumns} resolves each logical field to an
 * explicit index, taking the LAST occurrence for the repeated pair. The
 * resolution is returned rather than hidden, so parsers.test.ts can assert
 * which index each field came from and fail if the layout shifts.
 */

/** Logical fields this connector reads out of the export. */
export interface ColumnIndex {
	readonly activityDate: number;
	readonly activityType: number;
	readonly averageHeartRate: number | null;
	readonly calories: number | null;
	readonly distanceM: number;
	readonly elapsedTimeS: number;
	/**
	 * The FIRST `Elapsed Time` column, read only when {@link elapsedTimeS} is
	 * empty for a row. It is a display rendering, so it is not always seconds —
	 * `numberOrNull` refuses a `MM:SS` cell, which is what makes the fallback
	 * safe rather than a guess.
	 */
	readonly elapsedTimeDisplayS: number | null;
	readonly elevationGainM: number | null;
	readonly gear: number | null;
	readonly id: number;
	readonly maxHeartRate: number | null;
	readonly movingTimeS: number | null;
	/** Every index each header name occupies, for tests and diagnostics. */
	readonly occurrences: ReadonlyMap<string, readonly number[]>;
}

export interface ColumnError {
	readonly message: string;
	readonly missing: readonly string[];
}

/**
 * Headers whose absence makes the file unreadable rather than merely thin. A
 * record with no id cannot be deduped against a later export, and one with no
 * date cannot be placed in a window, so neither is recoverable by nulling.
 */
const REQUIRED_HEADERS = [
	"Activity ID",
	"Activity Date",
	"Activity Type",
	"Distance",
	"Elapsed Time",
] as const;

/**
 * The headers Strava repeats. Named one by one rather than handled by a general
 * "last wins" rule, so that a header Strava *starts* repeating later is a
 * visible failure to investigate rather than a silent change of meaning.
 *
 * Every entry was decided against a real account export (layout observed in
 * September 2026), and the reasoning is recorded per header because it does
 * not generalise — one takes the first occurrence and two take the last.
 *
 * - `Distance` — the LAST is canonical. The first is the athlete's display
 *   unit: measured across the archive, last/first is 1000, so the first was
 *   kilometres. Reading it would report a 9 km ride as 9 metres.
 * - `Elapsed Time` — the LAST is canonical seconds. The first is a display
 *   rendering, which in some archives is `MM:SS`, so it is read only as a
 *   fallback for a row the last leaves empty, and only when it is a bare
 *   number. Both columns were seconds and agreed on every row that carried
 *   both.
 * - `Max Heart Rate` — the FIRST is canonical. The last is a strict subset of
 *   it: every row carrying both agreed, many carried only the first, and none
 *   carried only the last. Taking the last would discard readings to no
 *   purpose. There is no unit hazard — both are bpm.
 * - `Relative Effort` and `Commute` are not read by this connector. They are
 *   named so that their repetition does not block a parse of the fields that
 *   are, and so the next person knows they were looked at rather than missed.
 */
export const REPEATED_HEADERS = [
	"Commute",
	"Distance",
	"Elapsed Time",
	"Max Heart Rate",
	"Relative Effort",
] as const;

const NUMERIC_ID_RE = /^\d{1,30}$/;
const ISO_WITH_ZONE_RE =
	/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;
const ISO_NAKED_RE = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.\d+)?$/;
/** Strava's own rendering, e.g. "Aug 12, 2020, 7:30:00 AM". No zone marker. */
const US_LONG_RE =
	/^([A-Z][a-z]{2}) (\d{1,2}), (\d{4}), (\d{1,2}):(\d{2}):(\d{2}) ([AP]M)$/;

const MONTHS: Readonly<Record<string, number>> = {
	Jan: 1,
	Feb: 2,
	Mar: 3,
	Apr: 4,
	May: 5,
	Jun: 6,
	Jul: 7,
	Aug: 8,
	Sep: 9,
	Oct: 10,
	Nov: 11,
	Dec: 12,
};

/**
 * RFC 4180 CSV reader returning positional rows.
 *
 * Deliberately returns `string[][]` and not keyed records — see the file
 * header. Handles quoted fields containing commas, newlines and doubled
 * quotes, which Strava's gear and type values do produce.
 */
export function parseCsvRows(text: string): {
	error?: string;
	rows: string[][];
} {
	const parser = new CsvRowParser();
	const rows = parser.push(text);
	const finished = parser.finish();
	rows.push(...finished.rows);
	return finished.error ? { error: finished.error, rows } : { rows };
}

interface CsvParseResult {
	readonly error?: string;
	readonly rows: string[][];
}

/**
 * Stateful RFC 4180 parser shared by the buffer and file-backed paths.
 * `push()` returns only the rows completed by that chunk; it never retains a
 * completed row after handing it to the caller. A chunk can contain more than
 * one row, so the streaming wrapper awaits each returned row before reading
 * the next input chunk, keeping parser memory bounded by one input chunk plus
 * the current field.
 */
class CsvRowParser {
	private field = "";
	private inQuotes = false;
	private pendingQuote = false;
	private row: string[] = [];
	private sawAnyChar = false;

	push(text: string): string[][] {
		const rows: string[][] = [];
		for (let i = 0; i < text.length; i += 1) {
			const ch = text[i];
			if (!this.sawAnyChar && ch === "\uFEFF") {
				continue;
			}
			this.sawAnyChar = true;

			// A quote at the end of a chunk may be either an escaped quote or the
			// closing quote. Defer that decision until the next chunk arrives.
			if (this.pendingQuote) {
				this.pendingQuote = false;
				if (ch === '"') {
					this.field += '"';
					continue;
				}
				this.inQuotes = false;
			}

			if (this.inQuotes) {
				if (ch === '"') {
					if (text[i + 1] === '"') {
						this.field += '"';
						i += 1;
					} else if (i + 1 === text.length) {
						this.pendingQuote = true;
					} else {
						this.inQuotes = false;
					}
				} else {
					this.field += ch;
				}
				continue;
			}

			if (ch === '"') {
				this.inQuotes = true;
			} else if (ch === ",") {
				this.row.push(this.field);
				this.field = "";
			} else if (ch === "\n") {
				this.row.push(this.field);
				rows.push(this.row);
				this.row = [];
				this.field = "";
			} else if (ch !== "\r") {
				this.field += ch;
			}
		}
		return rows;
	}

	finish(): CsvParseResult {
		if (this.pendingQuote) {
			this.pendingQuote = false;
			this.inQuotes = false;
		}
		if (this.inQuotes) {
			return { error: "CSV ended inside a quoted field", rows: [] };
		}
		const rows: string[][] = [];
		if (this.field !== "" || this.row.length > 0) {
			this.row.push(this.field);
			rows.push(this.row);
		}
		if (!this.sawAnyChar) {
			return { error: "CSV file is empty", rows };
		}
		return { rows };
	}
}

/**
 * Parse a file-backed CSV incrementally. The callback is awaited after each
 * completed row, so a slow protocol emit cannot make the reader race ahead
 * and accumulate the remainder of a large export.
 */
export async function streamCsvRows(
	chunks: AsyncIterable<string>,
	onRow: (row: string[]) => Promise<void> | void,
): Promise<{ error?: string; rowCount: number }> {
	const parser = new CsvRowParser();
	let rowCount = 0;
	for await (const chunk of chunks) {
		for (const row of parser.push(chunk)) {
			await onRow(row);
			rowCount += 1;
		}
	}
	const finished = parser.finish();
	for (const row of finished.rows) {
		await onRow(row);
		rowCount += 1;
	}
	return finished.error ? { error: finished.error, rowCount } : { rowCount };
}

function indexOccurrences(header: readonly string[]): Map<string, number[]> {
	const occurrences = new Map<string, number[]>();
	for (const [index, rawName] of header.entries()) {
		const name = rawName.trim();
		const seen = occurrences.get(name);
		if (seen) {
			seen.push(index);
		} else {
			occurrences.set(name, [index]);
		}
	}
	return occurrences;
}

/**
 * Resolve each logical field to a column index.
 *
 * A header that repeats is resolved per field, not by a blanket rule: which
 * occurrence is canonical differs between them, and {@link REPEATED_HEADERS}
 * records the evidence for each. For every other header the first (and only)
 * occurrence is used, and a header that repeats *without* being named there is
 * reported rather than silently resolved — the file's layout has changed and
 * guessing which column now means what is how a five-mile run becomes a five.
 */
export function resolveColumns(
	header: readonly string[],
): ColumnIndex | ColumnError {
	const occurrences = indexOccurrences(header);
	const missing = REQUIRED_HEADERS.filter((name) => !occurrences.has(name));
	if (missing.length > 0) {
		return {
			missing,
			message: `activities.csv is missing expected column(s): ${missing.join(", ")}. Found: ${[...occurrences.keys()].join(", ") || "(no header row)"}`,
		};
	}

	const unexpectedRepeats = [...occurrences.entries()]
		.filter(
			([name, at]) =>
				at.length > 1 &&
				!(REPEATED_HEADERS as readonly string[]).includes(name),
		)
		.map(([name]) => name);
	if (unexpectedRepeats.length > 0) {
		return {
			missing: [],
			message: `activities.csv repeats column(s) this connector does not know how to disambiguate: ${unexpectedRepeats.join(", ")}. Strava may have changed the export format; refusing to guess which occurrence is canonical.`,
		};
	}

	const first = (name: string): number | null =>
		occurrences.get(name)?.[0] ?? null;
	const last = (name: string): number | null =>
		occurrences.get(name)?.at(-1) ?? null;

	// Non-null assertions are safe for the REQUIRED_HEADERS checked above.
	return {
		occurrences,
		id: first("Activity ID") as number,
		activityDate: first("Activity Date") as number,
		activityType: first("Activity Type") as number,
		// Repeated headers: see REPEATED_HEADERS for which occurrence is
		// canonical and why. These two take the last — metres and seconds.
		distanceM: last("Distance") as number,
		elapsedTimeS: last("Elapsed Time") as number,
		elapsedTimeDisplayS: first("Elapsed Time"),
		movingTimeS: first("Moving Time"),
		elevationGainM: first("Elevation Gain"),
		averageHeartRate: first("Average Heart Rate"),
		maxHeartRate: first("Max Heart Rate"),
		calories: first("Calories"),
		gear: first("Activity Gear"),
	};
}

/**
 * An empty cell means the reading was never taken — a ride with no strap, a
 * manually entered activity with no calories. It becomes null and never 0,
 * because a zero here would reach an observation as though the owner's heart
 * rate had been measured at zero.
 */
export function numberOrNull(cell: string | undefined): number | null {
	if (cell === undefined) {
		return null;
	}
	const trimmed = cell.trim();
	if (trimmed === "") {
		return null;
	}
	const value = Number(trimmed);
	return Number.isFinite(value) ? value : null;
}

export function textOrNull(cell: string | undefined): string | null {
	const trimmed = cell?.trim() ?? "";
	return trimmed === "" ? null : trimmed;
}

export interface ParsedStart {
	/** ISO-8601. Carries an offset only when the source stated one. */
	readonly iso: string;
	/** What the source actually told us about the clock — never a guess. */
	readonly basis: "utc" | "local" | "unknown";
}

/**
 * Parse the export's single `Activity Date` column.
 *
 * The basis is DERIVED, never assumed. Strava's own rendering carries no zone
 * marker at all, so it yields `unknown` — which is the honest answer and the
 * one a reader needs in order to decline time-of-day claims. Asserting UTC
 * here would be right for everyone who never travels and wrong by up to twelve
 * hours for everyone who does, which is the worst available failure: invisible
 * in testing, wrong in production.
 */
export function parseActivityDate(raw: string | undefined): ParsedStart | null {
	const value = raw?.trim() ?? "";
	if (value === "") {
		return null;
	}

	const zoned = ISO_WITH_ZONE_RE.exec(value);
	if (zoned) {
		const [, date, time, zone] = zoned;
		return {
			iso: zone === "Z" ? `${date}T${time}Z` : `${date}T${time}${zone}`,
			basis: "utc",
		};
	}

	const naked = ISO_NAKED_RE.exec(value);
	if (naked) {
		const [, date, time] = naked;
		return { iso: `${date}T${time}`, basis: "unknown" };
	}

	const us = US_LONG_RE.exec(value);
	if (us) {
		const [, mon, day, year, hour12, minute, second, meridiem] = us;
		const month = MONTHS[mon as string];
		if (month === undefined) {
			return null;
		}
		let hour = Number(hour12) % 12;
		if (meridiem === "PM") {
			hour += 12;
		}
		const pad = (n: number, width = 2) => String(n).padStart(width, "0");
		return {
			iso: `${year}-${pad(month)}-${pad(Number(day))}T${pad(hour)}:${minute}:${second}`,
			basis: "unknown",
		};
	}

	return null;
}

export interface ActivityRecord {
	activity_type: string | null;
	average_heartrate: number | null;
	calories_kcal: number | null;
	distance_m: number | null;
	elapsed_time_s: number | null;
	exported_at: string | null;
	freshness: "live" | "snapshot";
	gear: string | null;
	id: string;
	max_heartrate: number | null;
	moving_time_s: number | null;
	start_date: string;
	start_time: string;
	start_time_basis: "utc" | "local" | "unknown";
	total_elevation_gain_m: number | null;
}

const at = (
	row: readonly string[],
	index: number | null,
): string | undefined => (index === null ? undefined : row[index]);

/**
 * Build one emitted record, or null when the row cannot be placed — no usable
 * id, or no parseable date. A null return is counted by the caller and
 * reported, never silently dropped.
 */
export function buildActivityRecord(
	row: readonly string[],
	columns: ColumnIndex,
	exportedAt: string | null,
): ActivityRecord | null {
	const id = at(row, columns.id)?.trim() ?? "";
	if (!NUMERIC_ID_RE.test(id)) {
		return null;
	}
	const start = parseActivityDate(at(row, columns.activityDate));
	if (!start) {
		return null;
	}
	return {
		id,
		activity_type: textOrNull(at(row, columns.activityType)),
		// The calendar day, carried separately because `start_time` deliberately
		// does not claim to be an instant. Filtering and grouping need a field the
		// server can treat as a date without one being invented for it.
		start_date: start.iso.slice(0, 10),
		start_time: start.iso,
		start_time_basis: start.basis,
		distance_m: numberOrNull(at(row, columns.distanceM)),
		moving_time_s: numberOrNull(at(row, columns.movingTimeS)),
		// The canonical column is empty on a few rows that the display column
		// still carries — all of them, in the export this was verified against,
		// runs whose moving time was present. Falling back recovers them;
		// `numberOrNull` returning null for a non-numeric cell is what keeps a
		// `MM:SS` display rendering from being read as a count of seconds.
		elapsed_time_s:
			numberOrNull(at(row, columns.elapsedTimeS)) ??
			numberOrNull(at(row, columns.elapsedTimeDisplayS)),
		total_elevation_gain_m: numberOrNull(at(row, columns.elevationGainM)),
		average_heartrate: numberOrNull(at(row, columns.averageHeartRate)),
		max_heartrate: numberOrNull(at(row, columns.maxHeartRate)),
		calories_kcal: numberOrNull(at(row, columns.calories)),
		gear: textOrNull(at(row, columns.gear)),
		freshness: "snapshot",
		exported_at: exportedAt,
	};
}
