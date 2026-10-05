// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The Fitbit collector: from the upload to the streams and what each covered.
 *
 * One upload is chosen (archive.ts), every part of it is checked and listed,
 * and then each requested stream reads its families one member at a time
 * (read.ts), builds records (parsers.ts, days.ts) and ends with one
 * `phase=coverage` PROGRESS line saying what it covered and why it stops
 * there, after a SKIP_RESULT when it skipped anything. A failure that stops
 * the whole upload ends every requested stream the same way (`failAll`).
 *
 * HOW A STREAM'S REASON IS FOUND. Each family keeps a FamilyTally: how its
 * walk ended, and whether its rows could be placed and read. A stream's state
 * is the union of its families, and its reason is the first match of
 * `reasonFor`, in the order of the owner's next action: the device, then
 * size, then a cut file, then a changed layout, then entries that could not
 * be read, then values that could not be read, then success.
 *
 * WHAT THE COVERAGE LINE COUNTS. Only the records the runtime keeps. Each
 * record is validated here first, then offered to the runtime's own id,
 * resource and time gate (`ctx.isRecordSelected`), and counted only when
 * kept. This connector also works out the window itself, an activity's start
 * to the instant, and emits only what both keep. The runtime's answer must
 * follow its date rule or the exact-instant rule wherever no resource filter
 * explains a difference: if it ever selects by another time rule, the
 * coverage line would describe a window the reader did not get, so the run
 * stops with `time_range_semantics_changed` instead of carrying on silently.
 *
 * NAMES AND VALUES STAY HERE. Every SKIP_RESULT message is a constant per
 * reason, its diagnostics are numbers, null or fixed tokens, and every
 * PROGRESS line names the stream, a family's fixed key, fixed reason and
 * status tokens and schema field names, and gives counts and dates. An error
 * is reported by its code alone.
 */

import { closeSync, fstatSync, mkdtempSync, openSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { resourceSet } from "@pdpp/connector-protocol";
import {
	type CollectContext,
	createConnectorFailure,
	type RecordData,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import {
	type ExportInspection,
	errorCode,
	type FamilyKey,
	findUploadSet,
	type InspectFailure,
	inspectExport,
	isDeviceError,
	MEMBER_MAX_BYTES,
	type MemberRef,
	MINUTE_MEMBER_MAX_BYTES,
	type OpenPart,
	PROFILE_MAX_BYTES,
	removeScratch,
	SLEEP_SCORE_MAX_BYTES,
	STREAM_FAMILIES,
	type UploadPart,
	type UploadSearch,
} from "./archive.ts";
import {
	DayBook,
	type DayTaint,
	familyTaint,
	LocalDayClock,
	type MemberTaint,
	MinuteWindow,
	WHOLE_HISTORY,
} from "./days.ts";
import {
	type Built,
	buildExercise,
	buildSleepLog,
	calendarDate,
	countText,
	type KeyedRow,
	measureText,
	profileZone,
	type Reading,
	readDailyRow,
	readMinuteRow,
	readRestingHeartRateRow,
	readScoreRow,
	resolveScoreColumns,
	type ScoreColumns,
	type SourceObject,
} from "./parsers.ts";
import {
	type ArchiveIo,
	emptyWalk,
	PROFILE_CSV_LIMITS,
	SLEEP_SCORE_CSV_LIMITS,
	type WalkResult,
	walkCsvMember,
	walkJsonFamily,
} from "./read.ts";
import {
	DATA_STREAMS,
	type DailyField,
	type DataStream,
	type FitbitRecord,
	OPTIONAL_READING_FIELDS,
	validateRecord,
} from "./schemas.ts";

/** The terminal failure's message when the runtime's time gate and this connector's disagree. */
const TIME_GATE_MESSAGE =
	"The runtime selected records by a different time rule from the one this import reports its coverage by, so the import stopped rather than report a wrong window.";

/** The reasons a SKIP_RESULT states: each says the stream skipped something. */
type SkipReason =
	| "awaiting_upload"
	| "source_unreadable"
	| "source_limit_reached"
	| "device_storage_unavailable"
	| "collection_interrupted"
	| "export_format_changed"
	| "records_unreadable";

/**
 * Why a stream's coverage ends where it does: a skip reason, or one of the
 * three outcomes that skip nothing (values blanked, everything delivered,
 * nothing in the window). Stated on every coverage line, including on
 * success, so a reader branches on the value and never on its absence.
 */
type CoverageReason =
	| SkipReason
	| "values_unreadable"
	| "covered_in_full"
	| "nothing_in_range";

type CoverageStatus = "complete" | "partial" | "empty";

/** A recovery hint, in the protocol's closed vocabulary. */
interface RecoveryHint {
	readonly action:
		| "manual_action_required"
		| "retry_by_runtime"
		| "retry_on_connector_upgrade"
		| "not_retriable";
	readonly retryable: boolean;
}

/**
 * Literal map so reason-emission-scan.ts can resolve every SKIP_RESULT
 * reason. It must stay a type-ANNOTATED plain object literal in the module
 * that emits: `as const` or `satisfies` wraps the literal in an expression
 * the scan does not read.
 */
const SKIP_REASON: Readonly<Record<SkipReason, string>> = {
	awaiting_upload: "awaiting_upload",
	source_unreadable: "source_unreadable",
	source_limit_reached: "source_limit_reached",
	device_storage_unavailable: "device_storage_unavailable",
	collection_interrupted: "collection_interrupted",
	export_format_changed: "export_format_changed",
	records_unreadable: "records_unreadable",
};

/** Constant per reason, so a message can never carry a path, a member name, a record value or an error's text. */
export const SKIP_MESSAGE: Readonly<Record<SkipReason, string>> = {
	awaiting_upload:
		"No Fitbit export has been uploaded yet. Upload the ZIP files from Google Takeout, or place them in the Fitbit import folder (FITBIT_EXPORT_DIR).",
	source_unreadable:
		"The newest Google Takeout export in the Fitbit import folder, if there is one, is not a Fitbit export this import can read.",
	source_limit_reached:
		"The export, or a file this stream reads, is larger than this import can read.",
	device_storage_unavailable:
		"This device could not read or unpack the export.",
	collection_interrupted:
		"Some of this stream's files ended early or could not be unpacked.",
	export_format_changed:
		"This stream's files are not in the layout this import expects, or a file it needs is not in the upload.",
	records_unreadable:
		"Some entries could not be placed in time or read, and were skipped.",
};

/**
 * Who can act on a skip. `read` is the stream's read, or null when the whole
 * upload was refused before any stream was read. Two reasons are judged by
 * their cause, as their owner copy is:
 *   - source_limit_reached: an upload refused before any stream is read (a
 *     part past this import's ZIP limits, or more than MAX_PARTS parts) is
 *     the owner's to change, as the copy says: request it again with 2 GB
 *     parts if larger ones were chosen, otherwise report it. A member too
 *     large, found while its stream is read, needs a new version of this
 *     import.
 *   - export_format_changed: an upload of only the Google-era layout is the
 *     owner's to check; content in a layout this import does not read needs
 *     a new version of it.
 * A file the stream needs that is not in the upload (a missing last part
 * looks like this) is the owner's to check first, whichever of the two
 * reasons the stream ends with.
 * Every cause of records_unreadable (an entry that could not be read or
 * placed, a member in two parts, a shape mismatch, no usable zone) gives the
 * same result from the same files, so a repeat import recovers nothing.
 *
 * An exhaustive switch with literal hints, so a static scan can read each
 * action at the call site, and a new reason without a hint does not
 * typecheck.
 */
function recoveryHint(
	reason: SkipReason,
	read: StreamRead | null,
): RecoveryHint {
	const owner: RecoveryHint = {
		action: "manual_action_required",
		retryable: false,
	};
	const upgrade: RecoveryHint = {
		action: "retry_on_connector_upgrade",
		retryable: false,
	};
	switch (reason) {
		case "awaiting_upload":
		case "source_unreadable":
		case "collection_interrupted":
			// Only the owner can act, with a different or a fresh export.
			return owner;
		case "source_limit_reached":
		case "export_format_changed":
			return read === null || read.fileMissing ? owner : upgrade;
		case "device_storage_unavailable":
			// Nothing is wrong with the export: a later run may succeed.
			return { action: "retry_by_runtime", retryable: true };
		case "records_unreadable":
			return { action: "not_retriable", retryable: false };
	}
}

/**
 * Why the whole upload failed, as a SKIP_RESULT's diagnostics name it: a
 * fixed token, never a name. Null when none applies: no upload yet, the
 * device, or a part that would not open.
 */
type UploadFailure =
	| Exclude<InspectFailure, "device">
	| Extract<UploadSearch, { kind: "unsupported" }>["failure"]
	| "too_many_parts";

/** The reason a refused listing gives every stream: the device, size, a changed layout, or not an export this import can read. */
const INSPECT_REASON: Readonly<Record<InspectFailure, SkipReason>> = {
	device: "device_storage_unavailable",
	zip64: "source_limit_reached",
	policy: "source_limit_reached",
	google_era_only: "export_format_changed",
	gzip: "source_unreadable",
	not_zip: "source_unreadable",
	unreadable_listing: "source_unreadable",
	unsafe_name: "source_unreadable",
	parts: "source_unreadable",
	not_fitbit: "source_unreadable",
	ambiguous_root: "source_unreadable",
};

type TimeRange = { since?: string; until?: string } | undefined;
type RecordBuilt = Extract<Built, { kind: "record" }>;

/** A family a stream reads rows from: a legacy family, or the sleep score file. */
export type FamilyName = FamilyKey | "sleep_score";
/** The families daily_summaries reads, whose members the day taint judges one by one. */
export type DailyFamily = Exclude<FamilyKey, "exercise" | "sleep">;

/** Each stream's families, in reading order: the score file before the sleep logs it joins. */
const STREAM_READ_ORDER: Readonly<Record<DataStream, readonly FamilyName[]>> = {
	activities: STREAM_FAMILIES.activities,
	daily_summaries: STREAM_FAMILIES.daily_summaries,
	sleep: ["sleep_score", ...STREAM_FAMILIES.sleep],
};

/** The daily summary field each daily family fills. */
const DAILY_FIELD: Readonly<Record<DailyFamily, DailyField>> = {
	steps: "steps",
	distance: "distance_m",
	lightly_active_minutes: "lightly_active_minutes",
	moderately_active_minutes: "moderately_active_minutes",
	very_active_minutes: "very_active_minutes",
	resting_heart_rate: "resting_heart_rate_bpm",
};

const NO_DAYS: ReadonlySet<string> = new Set<string>();

function isSkipReason(reason: CoverageReason): reason is SkipReason {
	return Object.hasOwn(SKIP_REASON, reason);
}

function isDailyFamily(key: FamilyKey): key is DailyFamily {
	return Object.hasOwn(DAILY_FIELD, key);
}

function isMinuteFamily(key: DailyFamily): key is "steps" | "distance" {
	return key === "steps" || key === "distance";
}

/**
 * The field a requested window is applied to: for activities `start_time`,
 * a UTC instant; for the daily streams `date`, Fitbit's local calendar day.
 * The runtime compares either by its first ten characters.
 */
export function timeRangeField(stream: string): string {
	return stream === "activities" ? "start_time" : "date";
}

/**
 * The runtime's reading of a window: inclusive `since`, exclusive `until`,
 * each by its first ten characters, and a row with no time key kept.
 */
function isOutsideRange(timeKey: string | null, range: TimeRange): boolean {
	if (timeKey === null || range === undefined) {
		return false;
	}
	if (range.since && timeKey < range.since.slice(0, 10)) {
		return true;
	}
	return Boolean(range.until && timeKey >= range.until.slice(0, 10));
}

/**
 * This connector's reading of a window for a UTC start: inclusive `since`,
 * exclusive `until`, each compared as an instant (Collection Profile §5.1),
 * and a row with no time key kept. A bound that is not an instant is read by
 * its first ten characters, as the runtime reads it.
 */
function isOutsideInstantRange(
	timeKey: string | null,
	range: TimeRange,
): boolean {
	if (timeKey === null || range === undefined) {
		return false;
	}
	const at = Date.parse(timeKey);
	const since = range.since ? Date.parse(range.since) : Number.NaN;
	const until = range.until ? Date.parse(range.until) : Number.NaN;
	if (
		Number.isNaN(at) ||
		(range.since && Number.isNaN(since)) ||
		(range.until && Number.isNaN(until))
	) {
		return isOutsideRange(timeKey, range);
	}
	return (
		(Boolean(range.since) && at < since) ||
		(Boolean(range.until) && at >= until)
	);
}

/** Whether a row falls outside the window as this connector reads it for the stream. */
function isOutsideWindow(
	stream: string,
	timeKey: string | null,
	range: TimeRange,
): boolean {
	return stream === "activities"
		? isOutsideInstantRange(timeKey, range)
		: isOutsideRange(timeKey, range);
}

/**
 * A requested bound as the coverage line states it: `none` when no bound was
 * requested (the runtime ignores an empty one), the date its first ten
 * characters name, which is how the runtime applies it, or `unparsed` when
 * they name no real date. The runtime still applies such a bound as text; the
 * line never echoes it.
 */
function windowBound(bound: string | undefined): string {
	if (!bound) {
		return "none";
	}
	return calendarDate(bound.slice(0, 10)) ?? "unparsed";
}

function timeGateFailure(): Error {
	return createConnectorFailure(
		"time_range_semantics_changed",
		TIME_GATE_MESSAGE,
		{ retryable: false },
	);
}

// ─── What was read ───────────────────────────────────────────────────────

/** One family's read: how its walk ended, and what its rows were. */
class FamilyTally {
	walk: WalkResult = emptyWalk();
	/** Members present in more than one part of one middle number; no copy is read. */
	duplicateMembers = 0;
	/**
	 * Rows whose key and value both read, zero and padding rows included; for
	 * exercise and sleep logs, records that validated.
	 */
	readable = 0;
	/** Rows whose key read but whose value did not. */
	valueUnreadable = 0;
	/**
	 * Rows whose key did not read; for exercise and sleep logs, also records
	 * the schema refused, which are counted unreadable too.
	 */
	unplaceable = 0;
	/** Repeated minutes, dates or score ids, dropped because the first wins. */
	duplicates = 0;
	/** sleep_score only: its two columns are missing or repeated. */
	headerUnknown = false;
}

/**
 * The family's layout is not the one this import reads: it had content, and
 * not one row of it both placed and read.
 */
function familyFormatChanged(family: FamilyTally): boolean {
	return (
		family.readable === 0 &&
		family.unplaceable + family.valueUnreadable + family.walk.shapeMismatch > 0
	);
}

/** One stream's families, and what beside them its reason depends on. */
export class StreamRead {
	readonly families: ReadonlyMap<FamilyName, FamilyTally>;
	/**
	 * Profile.csv, read for the zone only. It counts no rows and no files; its
	 * device error, cut read and duplicated copies count for the stream.
	 */
	readonly profile = new FamilyTally();
	/** None of the stream's legacy families is in the upload, and its Google-era counterpart is. */
	googleEra = false;
	/** daily_summaries: a minute family has members, and Profile.csv is absent or has no zone column or row. */
	zoneMissing = false;
	/** daily_summaries: a minute family has members, and Profile.csv is not in the upload (zoneMissing is set too). */
	profileAbsent = false;
	/** daily_summaries: a minute family has members, and no usable zone was read, for any cause. */
	zoneUnusable = false;
	/** sleep: score rows read, joined or not. */
	scores = 0;

	constructor(names: readonly FamilyName[]) {
		this.families = new Map(names.map((name) => [name, new FamilyTally()]));
	}

	family(name: FamilyName): FamilyTally {
		const family = this.families.get(name);
		if (family === undefined) {
			throw new RangeError("StreamRead: not one of this stream's families");
		}
		return family;
	}

	get deviceError(): boolean {
		return this.tallies().some((family) => family.walk.deviceError);
	}

	get deviceCode(): string | null {
		for (const family of this.tallies()) {
			if (family.walk.deviceCode !== null) {
				return family.walk.deviceCode;
			}
		}
		return null;
	}

	get files(): number {
		return this.sum((family) => family.walk.files);
	}

	get oversizedFiles(): number {
		return this.sum((family) => family.walk.oversizedFiles);
	}

	get interruptedFiles(): number {
		return this.sum((family) => family.walk.interruptedFiles);
	}

	get shapeMismatch(): number {
		return this.sum((family) => family.walk.shapeMismatch);
	}

	get duplicateMembers(): number {
		return this.sum((family) => family.duplicateMembers);
	}

	/** Repeated minutes, dates and score ids over the families. */
	get duplicates(): number {
		return this.sum((family) => family.duplicates);
	}

	/** The layout is not the one this import reads, or a file the stream needs is missing. */
	get formatChanged(): boolean {
		return (
			this.googleEra ||
			this.zoneMissing ||
			[...this.families.values()].some(
				(family) => familyFormatChanged(family) || family.headerUnknown,
			)
		);
	}

	/**
	 * Part of formatChanged: a file the stream needs is not in the upload, as
	 * when its last part was not uploaded. Its legacy files are absent while
	 * their Google-era counterpart is present, or Profile.csv is absent. A
	 * Profile.csv that is present but has no zone column or row is content in
	 * another layout, not an absence.
	 */
	get fileMissing(): boolean {
		return this.googleEra || this.profileAbsent;
	}

	/**
	 * Nothing the stream reads went unread or unrecognised: no device error, no
	 * member oversized, cut or duplicated, no shape mismatch, a usable zone
	 * whenever a minute family has members, and a known score header. Rows that
	 * could not be placed do not count here. An exercise or sleep log that
	 * could not be placed still reports the fields it carried. A daily or
	 * score row that could not be placed reports none, but its family either
	 * has a placed row, which marks the field carried, or has none, which is a
	 * changed layout, so fields_unavailable names nothing.
	 */
	get readInFull(): boolean {
		return (
			!this.deviceError &&
			this.oversizedFiles === 0 &&
			this.interruptedFiles === 0 &&
			this.duplicateMembers === 0 &&
			this.shapeMismatch === 0 &&
			!this.zoneUnusable &&
			[...this.families.values()].every((family) => !family.headerUnknown)
		);
	}

	/** The families and the profile, for the counters summed over them. */
	private tallies(): FamilyTally[] {
		return [...this.families.values(), this.profile];
	}

	private sum(counter: (family: FamilyTally) => number): number {
		let total = 0;
		for (const family of this.tallies()) {
			total += counter(family);
		}
		return total;
	}
}

/** What one stream delivered and dropped: its coverage line's facts and its done line's counters. */
class StreamTally {
	/** Objects built, whatever became of them: logs, and days for daily_summaries. */
	objects = 0;
	/**
	 * Output fields whose source was present in any object, in the window or
	 * not; for sleep_score, also in any placed score row.
	 */
	readonly present = new Set<string>();
	delivered = 0;
	outsideWindow = 0;
	/** Logs dropped because an earlier one had the same id. */
	duplicates = 0;
	/** Unreadable rows that could fall inside the requested scope. */
	unreadable = 0;
	/** Every unreadable row, whatever the window: a changed layout is not windowed. */
	unreadableTotal = 0;
	schemaRejected = 0;
	schemaIssues = 0;
	/** Days whose only readings were zeros or padding. */
	zeroOnly = 0;
	/** Exercises whose name was not on this import's list. */
	withheldTypes = 0;
	coveredFrom: string | null = null;
	coveredTo: string | null = null;
	/** Fields emitted as null because their value could not be read, over delivered records. */
	readonly unreadableFields = new Set<string>();

	deliveredOn(timeKey: string, unreadable: readonly string[]): void {
		const date = timeKey.slice(0, 10);
		this.delivered += 1;
		if (this.coveredFrom === null || date < this.coveredFrom) {
			this.coveredFrom = date;
		}
		if (this.coveredTo === null || date > this.coveredTo) {
			this.coveredTo = date;
		}
		for (const field of unreadable) {
			this.unreadableFields.add(field);
		}
	}
}

/** Turns one stream's build results into records, and counts everything else. */
export class StreamCollector {
	readonly tally = new StreamTally();
	private readonly ctx: CollectContext;
	private readonly stream: DataStream;
	private readonly range: TimeRange;
	/** The scope's resource filter, built as the runtime builds it; null when there is none. */
	private readonly resources: ReadonlySet<string> | null;
	/** The first record for an id wins; members are read in page or date order. */
	private readonly seen = new Set<string>();

	constructor(ctx: CollectContext, stream: DataStream) {
		this.ctx = ctx;
		this.stream = stream;
		const scope = ctx.requested.get(stream);
		this.range = scope?.time_range;
		this.resources = resourceSet(scope);
	}

	/**
	 * One built object. `family` is the family an exercise or sleep log came
	 * from, whose readable and unplaceable rows are counted here.
	 */
	async take(built: Built, family?: FamilyTally): Promise<void> {
		const { tally } = this;
		tally.objects += 1;
		for (const field of built.present) {
			tally.present.add(field);
		}
		if (built.kind === "record") {
			await this.takeRecord(built, family);
		} else if (built.kind === "no_reading") {
			tally.zeroOnly += 1;
		} else {
			if (family !== undefined) {
				family.unplaceable += 1;
			}
			this.countUnreadable(built.id, built.timeKey);
		}
	}

	/**
	 * An unreadable row counts against the stream's reason only when it could
	 * fall inside the requested scope, so one corrupt row from years back does
	 * not spoil every recent window; otherwise it is counted outside the
	 * window. A row with a readable id goes to the runtime as a record would,
	 * with its time key when it has one: no window can rule out a row that
	 * cannot be placed, but a resource filter still can.
	 */
	countUnreadable(id: string | null, timeKey: string | null): void {
		this.tally.unreadableTotal += 1;
		const placed =
			timeKey === null ? {} : { [timeRangeField(this.stream)]: timeKey };
		const inScope =
			id === null
				? !isOutsideWindow(this.stream, timeKey, this.range)
				: this.selected({ id, ...placed }, timeKey);
		if (inScope) {
			this.tally.unreadable += 1;
		} else {
			this.tally.outsideWindow += 1;
		}
	}

	private async takeRecord(
		built: RecordBuilt,
		family: FamilyTally | undefined,
	): Promise<void> {
		const { record, timeKey } = built;
		// Validated before selection or emission. The runtime's own check would
		// emit a SKIP_RESULT carrying the whole record, and its selection neither
		// validates nor keeps a record without an id, so such a record would be
		// counted outside the window. A retained anomaly would print its value.
		const validation = validateRecord(this.stream, record);
		if (
			!validation.ok ||
			validation.anomalies !== undefined ||
			typeof record.id !== "string" ||
			record.id === ""
		) {
			this.tally.schemaRejected += 1;
			// Counts only: an issue's path and message can quote the value.
			this.tally.schemaIssues += validation.ok ? 0 : validation.issues.length;
			if (family !== undefined) {
				family.unplaceable += 1;
			}
			this.countUnreadable(null, timeKey);
			return;
		}
		if (family !== undefined) {
			family.readable += 1;
		}
		if (this.seen.has(record.id)) {
			this.tally.duplicates += 1;
			return;
		}
		this.seen.add(record.id);
		if (built.withheld === true) {
			this.tally.withheldTypes += 1;
		}
		await this.deliver(record, timeKey, built.unreadable);
	}

	private async deliver(
		record: FitbitRecord,
		timeKey: string,
		unreadable: readonly string[],
	): Promise<void> {
		if (!this.selected(record, timeKey)) {
			this.tally.outsideWindow += 1;
			return;
		}
		await this.ctx.emitRecord(this.stream, record);
		this.tally.deliveredOn(timeKey, unreadable);
	}

	/**
	 * Whether a record is kept: the runtime's own id, resource and time gate,
	 * asked rather than re-implemented, and this connector's own reading of
	 * the window, so the coverage line counts exactly what a reader receives.
	 * The runtime reads a bound by its date, so on the bound's day it keeps an
	 * activity that starts before `since`; this connector drops it. The
	 * runtime's answer must match its date rule or the exact-instant rule
	 * unless the stream's `resources` leave the record's id out; otherwise it
	 * selects by another rule and the coverage line would be wrong, so the
	 * run stops.
	 */
	private selected(record: RecordData, timeKey: string | null): boolean {
		const byDay = !isOutsideRange(timeKey, this.range);
		const expected = !isOutsideWindow(this.stream, timeKey, this.range);
		if (this.ctx.isRecordSelected === undefined) {
			// Hand-built contexts only; the runtime always supplies it.
			return expected;
		}
		const kept = this.ctx.isRecordSelected(this.stream, record);
		if (
			kept !== byDay &&
			kept !== expected &&
			(this.resources === null || this.resources.has(String(record.id)))
		) {
			throw timeGateFailure();
		}
		return kept && expected;
	}
}

// ─── Reasons and the coverage line ───────────────────────────────────────

/** What a stream delivered, as its reason is judged. */
interface Delivery {
	/** Unreadable rows that could fall inside the requested scope. */
	readonly unreadable: number;
	readonly delivered: number;
	/** Fields named unreadable on the delivered records. */
	readonly unreadableFields: ReadonlySet<string>;
}

/**
 * Why a stream's coverage ends where it does. The first match wins, in order
 * of which next action matters most to the owner.
 */
export function reasonFor(
	read: StreamRead,
	delivery: Delivery,
): CoverageReason {
	if (read.deviceError) {
		return "device_storage_unavailable";
	}
	if (read.oversizedFiles > 0) {
		return "source_limit_reached";
	}
	if (read.interruptedFiles > 0) {
		return "collection_interrupted";
	}
	if (read.formatChanged) {
		return "export_format_changed";
	}
	if (
		delivery.unreadable > 0 ||
		read.shapeMismatch > 0 ||
		read.duplicateMembers > 0 ||
		read.zoneUnusable
	) {
		return "records_unreadable";
	}
	if (delivery.unreadableFields.size > 0) {
		return "values_unreadable";
	}
	return delivery.delivered > 0 ? "covered_in_full" : "nothing_in_range";
}

/**
 * The stream's optional reading fields that no object carried, whatever the
 * window: a device without the feature, or an export without the file.
 * Nothing can be said with nothing read, with any part of the stream unread,
 * or with its layout not understood: the unread part, or keys this import
 * does not know, may carry the field.
 */
export function fieldsUnavailable(
	stream: DataStream,
	read: StreamRead,
	seen: { readonly objects: number; readonly present: ReadonlySet<string> },
): string[] {
	if (seen.objects === 0 || !read.readInFull || read.formatChanged) {
		return [];
	}
	return OPTIONAL_READING_FIELDS[stream].filter(
		(field) => !seen.present.has(field),
	);
}

function statusFor(reason: CoverageReason, delivered: number): CoverageStatus {
	if (delivered === 0) {
		return "empty";
	}
	return reason === "covered_in_full" ? "complete" : "partial";
}

/** What a stream covered, as its coverage line states it. */
interface Coverage {
	readonly reason: CoverageReason;
	readonly delivered: number;
	readonly fieldsUnavailable: readonly string[];
	readonly fieldsUnreadable: readonly string[];
	/** The dates of the earliest and latest records delivered. */
	readonly coveredFrom: string | null;
	readonly coveredTo: string | null;
}

/** The coverage of a stream that a failed upload stopped: nothing, stated so no failure is silent. */
function nothingCovered(reason: SkipReason): Coverage {
	return {
		reason,
		delivered: 0,
		fieldsUnavailable: [],
		fieldsUnreadable: [],
		coveredFrom: null,
		coveredTo: null,
	};
}

/**
 * Ends a stream's report with one PROGRESS line: its status and reason, the
 * records delivered (also as `count`), the fields the export never carried
 * and those it could not read, and the requested and covered windows as
 * dates. Only fixed tokens, schema field names, counts and dates: never a
 * name, a zone or a value.
 */
async function emitCoverage(
	ctx: CollectContext,
	stream: DataStream,
	coverage: Coverage,
): Promise<void> {
	const range = ctx.requested.get(stream)?.time_range;
	await ctx.emit({
		type: "PROGRESS",
		stream,
		count: coverage.delivered,
		message: [
			`Fitbit phase=coverage stream=${stream}`,
			`status=${statusFor(coverage.reason, coverage.delivered)}`,
			`reason=${coverage.reason}`,
			`delivered=${String(coverage.delivered)}`,
			`fields_unavailable=${coverage.fieldsUnavailable.join(",") || "none"}`,
			`fields_unreadable=${coverage.fieldsUnreadable.join(",") || "none"}`,
			`window_requested_from=${windowBound(range?.since)}`,
			`window_requested_to=${windowBound(range?.until)}`,
			`window_covered_from=${coverage.coveredFrom ?? "none"}`,
			`window_covered_to=${coverage.coveredTo ?? "none"}`,
		].join(" "),
	});
}

/** Ends each stream with the same reason: a SKIP_RESULT, then its coverage line. */
async function failAll(
	ctx: CollectContext,
	streams: readonly DataStream[],
	reason: SkipReason,
	code: string | null,
	failure: UploadFailure | null,
): Promise<void> {
	for (const stream of streams) {
		await ctx.emit({
			type: "SKIP_RESULT",
			stream,
			reason: SKIP_REASON[reason],
			recovery_hint: recoveryHint(reason, null),
			message: SKIP_MESSAGE[reason],
			diagnostics: { code, failure },
		});
		await emitCoverage(ctx, stream, nothingCovered(reason));
	}
}

function counterLine(
	head: string,
	counters: Readonly<Record<string, number>>,
): string {
	const pairs = Object.entries(counters).map(
		([name, value]) => `${name}=${String(value)}`,
	);
	return `${head} ${pairs.join(" ")}`;
}

async function familyLine(
	ctx: CollectContext,
	stream: DataStream,
	name: FamilyName,
	family: FamilyTally,
): Promise<void> {
	await ctx.emit({
		type: "PROGRESS",
		stream,
		message: counterLine(
			`Fitbit phase=family stream=${stream} family=${name}`,
			{
				files: family.walk.files,
				rows: family.readable + family.valueUnreadable + family.unplaceable,
				readable: family.readable,
				value_unreadable: family.valueUnreadable,
				unplaceable: family.unplaceable,
				duplicates: family.duplicates,
			},
		),
	});
}

/** The counters a real-export run is measured by. Numbers only. */
function doneLine(
	stream: DataStream,
	read: StreamRead,
	tally: StreamTally,
): string {
	return counterLine(`Fitbit phase=done stream=${stream}`, {
		files: read.files,
		delivered: tally.delivered,
		outside_window: tally.outsideWindow,
		duplicates: read.duplicates + tally.duplicates,
		unreadable: tally.unreadable,
		unreadable_total: tally.unreadableTotal,
		schema_rejected: tally.schemaRejected,
		schema_issues: tally.schemaIssues,
		zero_only: tally.zeroOnly,
		withheld_types: tally.withheldTypes,
		shape_mismatch: read.shapeMismatch,
		duplicate_members: read.duplicateMembers,
		zone_unusable: read.zoneUnusable ? 1 : 0,
		scores: read.scores,
	});
}

// ─── The day taint: the days a daily file not read in full could have held

/**
 * Per daily field, the days on which part of its family may not have been
 * read. A member not read in full (cut, oversized, unread after a device
 * error, holding a shape mismatch or a row that could not be placed) taints
 * the days it placed rows on and the span its name places it over; a member
 * duplicated across parts was read from neither part and taints its span.
 * With no usable zone no minute can be placed on any day, so steps and
 * distance_m are tainted over the whole history when their family has a
 * member.
 */
export function dailyTaint(
	families: ReadonlyMap<DailyFamily, readonly MemberTaint[]>,
	hasClock: boolean,
	exportedAt: string | null,
): Map<DailyField, DayTaint> {
	const taint = new Map<DailyField, DayTaint>();
	for (const [family, members] of families) {
		const field = DAILY_FIELD[family];
		if (isMinuteFamily(family) && !hasClock && members.length > 0) {
			taint.set(field, WHOLE_HISTORY);
			continue;
		}
		taint.set(field, familyTaint(members, exportedAt));
	}
	return taint;
}

/**
 * A daily member's name date. Every daily family's file name carries one; an
 * empty date is not a real day, so a member without one would taint the
 * whole history rather than none of it.
 */
function spanDate(nameDate: string | null | undefined): string {
	return nameDate ?? "";
}

// ─── The streams ─────────────────────────────────────────────────────────

/** The upload and its listing, shared by every stream of one run. */
interface Upload {
	readonly io: ArchiveIo;
	readonly inspection: Extract<ExportInspection, { ok: true }>;
}

function membersOf(upload: Upload, name: FamilyName): readonly MemberRef[] {
	if (name === "sleep_score") {
		const score = upload.inspection.sleepScore;
		return score === null ? [] : [score];
	}
	return upload.inspection.families.get(name) ?? [];
}

function duplicatedOf(
	upload: Upload,
	name: FamilyName | "profile",
): readonly (string | null)[] {
	return upload.inspection.duplicates.get(name) ?? [];
}

function countValue(family: FamilyTally, reading: Reading): void {
	if (reading.unreadable) {
		family.valueUnreadable += 1;
	} else {
		family.readable += 1;
	}
}

async function collectActivities(
	ctx: CollectContext,
	upload: Upload,
	collector: StreamCollector,
	read: StreamRead,
): Promise<void> {
	const family = read.family("exercise");
	family.duplicateMembers = duplicatedOf(upload, "exercise").length;
	family.walk = await walkJsonFamily(
		upload.io,
		membersOf(upload, "exercise"),
		MEMBER_MAX_BYTES,
		{
			value: (obj) =>
				collector.take(buildExercise(obj, upload.io.exportedAt), family),
		},
	);
	await familyLine(ctx, "activities", "exercise", family);
}

function takeScoreRow(
	row: KeyedRow<string>,
	scores: Map<string, Reading>,
	collector: StreamCollector,
	read: StreamRead,
): void {
	const family = read.family("sleep_score");
	if (row.kind === "unplaceable") {
		family.unplaceable += 1;
		collector.countUnreadable(null, null);
		return;
	}
	// A placed row shows the files carry scores, whether or not it joins an
	// uploaded log. An unplaceable row need not: with none placed, the layout
	// has changed, and fields_unavailable names nothing.
	collector.tally.present.add("sleep_score");
	read.scores += 1;
	countValue(family, row.reading);
	if (scores.has(row.key)) {
		family.duplicates += 1;
		return;
	}
	scores.set(row.key, row.reading);
}

/**
 * Reads the score file into a map from log id to score, header first. The
 * header is resolved by name; when it is not the one this import reads, the
 * rest of the file is not read. A file with no header row is not in a known
 * layout either.
 */
async function readScores(
	upload: Upload,
	collector: StreamCollector,
	read: StreamRead,
): Promise<Map<string, Reading>> {
	const family = read.family("sleep_score");
	const scores = new Map<string, Reading>();
	const member = upload.inspection.sleepScore;
	if (member === null) {
		return scores;
	}
	const header: { columns: ScoreColumns | null | undefined } = {
		columns: undefined,
	};
	const walk = await walkCsvMember(
		upload.io,
		member,
		SLEEP_SCORE_MAX_BYTES,
		SLEEP_SCORE_CSV_LIMITS,
		(cells) => {
			if (header.columns === undefined) {
				header.columns = resolveScoreColumns(cells);
				return Promise.resolve(header.columns === null ? "stop" : "more");
			}
			const row =
				header.columns === null ? null : readScoreRow(cells, header.columns);
			if (row !== null) {
				takeScoreRow(row, scores, collector, read);
			}
			return Promise.resolve("more");
		},
	);
	family.walk = walk;
	const complete =
		!walk.deviceError &&
		walk.interruptedFiles === 0 &&
		walk.oversizedFiles === 0;
	family.headerUnknown =
		header.columns === null || (header.columns === undefined && complete);
	return scores;
}

async function collectSleep(
	ctx: CollectContext,
	upload: Upload,
	collector: StreamCollector,
	read: StreamRead,
): Promise<void> {
	const scoreFamily = read.family("sleep_score");
	scoreFamily.duplicateMembers = duplicatedOf(upload, "sleep_score").length;
	const scores = await readScores(upload, collector, read);
	await familyLine(ctx, "sleep", "sleep_score", scoreFamily);

	const sleepFamily = read.family("sleep");
	sleepFamily.duplicateMembers = duplicatedOf(upload, "sleep").length;
	// A device error stops the stream: the logs need the same scratch disk.
	if (!scoreFamily.walk.deviceError) {
		// Nothing of the score file can have gone unread: every member was read
		// to its end in a known layout, and every row was placed. A score file
		// that is absent counts as read in full.
		const scoresReadInFull =
			scoreFamily.walk.oversizedFiles === 0 &&
			scoreFamily.walk.interruptedFiles === 0 &&
			scoreFamily.duplicateMembers === 0 &&
			scoreFamily.unplaceable === 0 &&
			!scoreFamily.headerUnknown;
		sleepFamily.walk = await walkJsonFamily(
			upload.io,
			membersOf(upload, "sleep"),
			MEMBER_MAX_BYTES,
			{
				value: (obj) =>
					collector.take(
						buildSleepLog(obj, upload.io.exportedAt, scores, scoresReadInFull),
						sleepFamily,
					),
			},
		);
	}
	await familyLine(ctx, "sleep", "sleep", sleepFamily);
}

/**
 * The profile zone's clock, or null when there is no usable zone. Profile.csv
 * is read up to its first data row and only its `timezone` cell is used; the
 * zone never leaves the clock, and no other cell is kept.
 */
async function readZone(
	upload: Upload,
	read: StreamRead,
): Promise<LocalDayClock | null> {
	const duplicated = duplicatedOf(upload, "profile").length;
	if (duplicated > 0) {
		read.profile.duplicateMembers = duplicated;
		return null;
	}
	const member = upload.inspection.profile;
	if (member === null) {
		read.zoneMissing = true;
		read.profileAbsent = true;
		return null;
	}
	const rows: {
		header: readonly string[] | null;
		row: readonly string[] | null;
	} = { header: null, row: null };
	const walk = await walkCsvMember(
		upload.io,
		member,
		PROFILE_MAX_BYTES,
		PROFILE_CSV_LIMITS,
		(cells) => {
			if (rows.header === null) {
				rows.header = cells;
				return Promise.resolve("more");
			}
			rows.row = cells;
			return Promise.resolve("stop");
		},
	);
	// Only a device error and a cut read count beyond the zone itself: an
	// oversized profile, like an unusable zone, is the zone's problem alone.
	read.profile.walk = {
		...emptyWalk(),
		interruptedFiles: walk.interruptedFiles,
		deviceError: walk.deviceError,
		deviceCode: walk.deviceCode,
	};
	if (
		walk.deviceError ||
		walk.interruptedFiles > 0 ||
		walk.oversizedFiles > 0
	) {
		return null;
	}
	const zone = profileZone(rows.header ?? [], rows.row);
	if (zone === null) {
		read.zoneMissing = true;
	}
	return LocalDayClock.fromZone(zone);
}

/**
 * Places one row of a daily family. Returns the local day it reached, null
 * when it could not be placed, or undefined for a repeated minute, which
 * reaches no day.
 */
type RowPlacer = (obj: SourceObject) => string | null | undefined;

/**
 * A minute family's rows: each minute admitted once (against this member and
 * the one before), placed on the profile zone's local day and summed there.
 */
function minutePlacer(
	key: "steps" | "distance",
	family: FamilyTally,
	book: DayBook,
	clock: LocalDayClock,
	collector: StreamCollector,
	window: MinuteWindow,
): RowPlacer {
	const read = key === "steps" ? countText : measureText;
	const field = key === "steps" ? "steps" : "distance_m";
	return (obj) => {
		const row = readMinuteRow(obj, read);
		if (row.kind === "unplaceable") {
			family.unplaceable += 1;
			collector.countUnreadable(null, null);
			return null;
		}
		countValue(family, row.reading);
		if (window.admit(row.key) === "duplicate") {
			family.duplicates += 1;
			return undefined;
		}
		const day = clock.localDate(row.key);
		book.addMinute(day, field, row.reading);
		return day;
	};
}

/** An active-minutes or resting-heart-rate family's rows: one a day, the first row for a date winning. */
function dayPlacer(
	key: Exclude<DailyFamily, "steps" | "distance">,
	family: FamilyTally,
	book: DayBook,
	collector: StreamCollector,
): RowPlacer {
	const field = DAILY_FIELD[key];
	return (obj) => {
		const row =
			key === "resting_heart_rate"
				? readRestingHeartRateRow(obj)
				: readDailyRow(obj);
		if (row.kind === "unplaceable") {
			family.unplaceable += 1;
			collector.countUnreadable(null, null);
			return null;
		}
		countValue(family, row.reading);
		if (book.setDaily(row.key, field, row.reading) === "duplicate") {
			family.duplicates += 1;
		}
		return row.key;
	};
}

/**
 * Walks one daily family into the day book and says which members are
 * tainted: not read in full (any MemberEnd but "read") or holding a row that
 * could not be placed. Only a tainted member's placed days are kept, so
 * beyond those, one member's days are held at a time.
 */
async function readDailyFamily(
	upload: Upload,
	members: readonly MemberRef[],
	{ place, window, cap }: DailyPlan,
): Promise<{ readonly walk: WalkResult; readonly taints: MemberTaint[] }> {
	const taints: MemberTaint[] = [];
	let days = new Set<string>();
	let unplaceable = 0;
	const walk = await walkJsonFamily(upload.io, members, cap, {
		value: (obj) => {
			const day = place(obj);
			if (day === null) {
				unplaceable += 1;
			} else if (day !== undefined) {
				days.add(day);
			}
			return Promise.resolve();
		},
		memberDone: (index, end) => {
			// A member that was never read cannot have repeated a minute.
			if (end !== "unread") {
				window?.nextMember();
			}
			const tainted = end !== "read" || unplaceable > 0;
			taints.push({
				nameDate: spanDate(members[index]?.nameDate),
				tainted,
				days: tainted ? days : NO_DAYS,
			});
			days = new Set();
			unplaceable = 0;
		},
	});
	return { walk, taints };
}

/** A member no row was read from (not walked, or duplicated across parts): tainted, placing nothing. */
function unreadTaint(nameDate: string | null): MemberTaint {
	return { nameDate: spanDate(nameDate), tainted: true, days: NO_DAYS };
}

/** How a daily family is read: its rows' placer, its minute window, and its members' size cap. */
interface DailyPlan {
	readonly place: RowPlacer;
	readonly window: MinuteWindow | null;
	readonly cap: number;
}

/** Null for a minute family without a zone: no minute can be placed, so none is extracted. */
function dailyPlan(
	key: DailyFamily,
	family: FamilyTally,
	book: DayBook,
	clock: LocalDayClock | null,
	collector: StreamCollector,
): DailyPlan | null {
	if (!isMinuteFamily(key)) {
		return {
			place: dayPlacer(key, family, book, collector),
			window: null,
			cap: MEMBER_MAX_BYTES,
		};
	}
	if (clock === null) {
		return null;
	}
	const window = new MinuteWindow();
	return {
		place: minutePlacer(key, family, book, clock, collector, window),
		window,
		cap: MINUTE_MEMBER_MAX_BYTES,
	};
}

async function collectDaily(
	ctx: CollectContext,
	upload: Upload,
	collector: StreamCollector,
	read: StreamRead,
): Promise<void> {
	const hasMembers = (key: DailyFamily): boolean =>
		membersOf(upload, key).length + duplicatedOf(upload, key).length > 0;
	let clock: LocalDayClock | null = null;
	if (hasMembers("steps") || hasMembers("distance")) {
		clock = await readZone(upload, read);
		read.zoneUnusable = clock === null;
	}
	const book = new DayBook();
	const families = new Map<DailyFamily, readonly MemberTaint[]>();
	// A device error stops the stream: every later member needs the same disk.
	let stopped = read.profile.walk.deviceError;
	for (const key of STREAM_FAMILIES.daily_summaries.filter(isDailyFamily)) {
		const family = read.family(key);
		const members = membersOf(upload, key);
		const duplicated = duplicatedOf(upload, key);
		family.duplicateMembers = duplicated.length;
		const plan = stopped
			? null
			: dailyPlan(key, family, book, clock, collector);
		let taints: MemberTaint[];
		if (plan === null) {
			taints = members.map((member) => unreadTaint(member.nameDate));
		} else {
			const done = await readDailyFamily(upload, members, plan);
			family.walk = done.walk;
			taints = done.taints;
			stopped = done.walk.deviceError;
		}
		families.set(key, [...taints, ...duplicated.map(unreadTaint)]);
		await familyLine(ctx, "daily_summaries", key, family);
	}
	const taint = dailyTaint(families, clock !== null, upload.io.exportedAt);
	for (const built of book.days(upload.io.exportedAt, taint)) {
		await collector.take(built);
	}
}

/** Reads one stream's families and states what it covered. */
async function collectStream(
	ctx: CollectContext,
	stream: DataStream,
	upload: Upload,
): Promise<void> {
	const names = STREAM_READ_ORDER[stream];
	const read = new StreamRead(names);
	read.googleEra = upload.inspection.googleEra[stream];
	let planned = 0;
	for (const name of names) {
		planned += membersOf(upload, name).length;
	}
	await ctx.emit({
		type: "PROGRESS",
		stream,
		message: `Fitbit phase=read stream=${stream} files=${String(planned)}`,
	});
	const collector = new StreamCollector(ctx, stream);
	if (stream === "activities") {
		await collectActivities(ctx, upload, collector, read);
	} else if (stream === "daily_summaries") {
		await collectDaily(ctx, upload, collector, read);
	} else {
		await collectSleep(ctx, upload, collector, read);
	}
	const { tally } = collector;
	const reason = reasonFor(read, tally);
	if (isSkipReason(reason)) {
		await ctx.emit({
			type: "SKIP_RESULT",
			stream,
			reason: SKIP_REASON[reason],
			recovery_hint: recoveryHint(reason, read),
			message: SKIP_MESSAGE[reason],
			diagnostics: {
				files: read.files,
				unreadable: tally.unreadable,
				shape_mismatch: read.shapeMismatch,
				schema_rejected: tally.schemaRejected,
				interrupted_files: read.interruptedFiles,
				oversized_files: read.oversizedFiles,
				duplicate_members: read.duplicateMembers,
				zone_unusable: read.zoneUnusable ? 1 : 0,
				file_missing: read.fileMissing ? 1 : 0,
				device_code: read.deviceCode,
			},
		});
	}
	await emitCoverage(ctx, stream, {
		reason,
		delivered: tally.delivered,
		fieldsUnavailable: fieldsUnavailable(stream, read, tally),
		fieldsUnreadable: [...tally.unreadableFields].sort(),
		coveredFrom: tally.coveredFrom,
		coveredTo: tally.coveredTo,
	});
	await ctx.emit({
		type: "PROGRESS",
		stream,
		message: doneLine(stream, read, tally),
	});
}

// ─── The upload ──────────────────────────────────────────────────────────

function closeParts(parts: readonly { readonly fd: number }[]): void {
	for (const { fd } of parts) {
		try {
			closeSync(fd);
		} catch {
			// Nothing path-free to report, and the run is ending anyway.
		}
	}
}

/** Opens every part, or closes those already open and gives the error that stopped it. */
function openParts(
	parts: readonly UploadPart[],
):
	| { readonly ok: true; readonly open: OpenPart[] }
	| { readonly ok: false; readonly error: unknown } {
	const open: OpenPart[] = [];
	for (const part of parts) {
		let fd: number | null = null;
		try {
			fd = openSync(part.path, "r");
			open.push({ fd, size: fstatSync(fd).size, group: part.group });
		} catch (error) {
			closeParts(fd === null ? open : [...open, { fd }]);
			return { ok: false, error };
		}
	}
	return { ok: true, open };
}

/** Checks the opened parts form an export this import can read, then reads each stream. */
async function collectParts(
	ctx: CollectContext,
	streams: readonly DataStream[],
	parts: readonly OpenPart[],
	exportedAt: string | null,
): Promise<void> {
	const inspection = inspectExport(parts);
	if (!inspection.ok) {
		const { failure, code } = inspection;
		return failAll(
			ctx,
			streams,
			INSPECT_REASON[failure],
			code,
			failure === "device" ? null : failure,
		);
	}
	// Any failure to make scratch space is the device's: the export is untouched.
	// The folder is made with mode 0700, so a member's text, Profile.csv's
	// included, is readable by the owner alone while it is on scratch.
	let scratchDir: string;
	try {
		scratchDir = mkdtempSync(join(tmpdir(), "pdpp-fitbit-"));
	} catch (error) {
		return failAll(
			ctx,
			streams,
			"device_storage_unavailable",
			errorCode(error),
			null,
		);
	}
	const upload: Upload = {
		io: { parts, scratchDir, exportedAt, nextScratchIndex: 0 },
		inspection,
	};
	try {
		// One stream at a time, each member extracted and read before the next,
		// so a single scratch file exists at once.
		for (const stream of streams) {
			await collectStream(ctx, stream, upload);
		}
	} finally {
		removeScratch(scratchDir);
	}
}

/**
 * The collector `runConnector` runs. No STATE is ever emitted, and
 * `full_refresh` changes nothing: every export is a full-history snapshot,
 * so every run already reads the whole of it.
 */
export async function collectFitbit(ctx: CollectContext): Promise<void> {
	const streams = DATA_STREAMS.filter((stream) => ctx.requested.has(stream));
	if (streams.length === 0) {
		return;
	}
	const importDir =
		process.env.FITBIT_EXPORT_DIR ||
		join(homedir(), ".pdpp", "imports", "fitbit");
	const upload = findUploadSet(importDir);
	switch (upload.kind) {
		case "none":
			return failAll(ctx, streams, "awaiting_upload", null, null);
		case "unsupported":
			return failAll(ctx, streams, "source_unreadable", null, upload.failure);
		case "too_many_parts":
			return failAll(
				ctx,
				streams,
				"source_limit_reached",
				null,
				"too_many_parts",
			);
		case "device":
			return failAll(
				ctx,
				streams,
				"device_storage_unavailable",
				upload.code,
				null,
			);
		default:
			break;
	}
	const opened = openParts(upload.parts);
	if (!opened.ok) {
		return failAll(
			ctx,
			streams,
			isDeviceError(opened.error)
				? "device_storage_unavailable"
				: "source_unreadable",
			errorCode(opened.error),
			null,
		);
	}
	try {
		await collectParts(ctx, streams, opened.open, upload.exportedAt);
	} finally {
		closeParts(opened.open);
	}
}
