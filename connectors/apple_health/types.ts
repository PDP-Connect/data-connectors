// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Shared types for the Apple Health connector. Kept out of index.ts so the
// pure parsers in parsers.ts can import them without pulling in the
// runtime entry point or the streaming XML reader.

export type AppleHealthAttrs = Record<string, string | undefined>;

/** A parsed `<MetadataEntry key="..." value="..."/>` child. */
export interface AppleHealthMetadataEntry {
	key: string;
	value: string;
}

/** A parsed `<WorkoutEvent type="..." date="..." .../>` child. */
export interface AppleHealthWorkoutEvent {
	date: string | null;
	duration_minutes: number | null;
	type: string | null;
}

/**
 * A parsed `<WorkoutStatistics type="..." .../>` child, bounded to the typed
 * quantity Apple records. The raw attribute bag would be an open shape on a
 * published stream, forwarding whatever a third-party application chose to
 * write.
 */
export interface AppleHealthWorkoutStatistics {
	average: number | null;
	maximum: number | null;
	minimum: number | null;
	sum: number | null;
	type: string | null;
	unit: string | null;
}

/** A published field left null because its unit was absent or could not be converted. */
export interface AppleHealthUnitGap {
	/** The published field that was left null. */
	field: string;
	/** The unit as the export wrote it, or "(absent)". */
	unit: string;
}

/**
 * What one element could not fill, held on the element and charged to its
 * stream's receipt only if the element is emitted. A receipt describes the
 * records a reader received: a gap in a record outside the requested window,
 * not asked for, discarded as a duplicate or rejected by the schema would
 * otherwise disown a field on records that are complete.
 */
export interface AppleHealthElementGaps {
	/** WorkoutEvent children beyond the per-workout cap, dropped at parse time. */
	eventsTruncated: number;
	/**
	 * Published fields this element leaves null for a reason other than its
	 * unit, such as "value" when the export's value attribute was blank.
	 */
	fields: string[];
	/** A MetadataEntry too large to read, so was_user_entered may be null. */
	oversizedMetadata: number;
	/** WorkoutEvent children too large to read. */
	oversizedEvents: number;
	/** WorkoutStatistics children too large to read. */
	oversizedStatistics: number;
	/** WorkoutStatistics children beyond the per-workout cap. */
	statisticsTruncated: number;
	units: AppleHealthUnitGap[];
}

/** A `Record` or `Workout` element together with its nested children, as assembled by the scanner in index.ts. */
export interface AppleHealthElement {
	attrs: AppleHealthAttrs;
	metadata: AppleHealthMetadataEntry[];
	pending: AppleHealthElementGaps;
	tag: "Record" | "Workout";
	/**
	 * The open tag could not be decoded, so the element was counted as
	 * unreadable when it opened. Held open only so its children and close tag
	 * are consumed; it is never built or emitted.
	 */
	unreadable: boolean;
	workoutEvents: AppleHealthWorkoutEvent[];
	workoutStatistics: AppleHealthWorkoutStatistics[];
	/**
	 * The distance and active-energy statistics of the workout's
	 * WorkoutActivity children, for a workout total when the workout has
	 * none of its own (workoutTotal in parsers.ts). Never published.
	 */
	activityStatistics: AppleHealthWorkoutStatistics[];
	/**
	 * A statistic of the workout or of one of its activities was not kept, or
	 * states a figure but no type, so a total summed from either level could
	 * be short (workoutTotal in parsers.ts).
	 */
	statisticsIncomplete: boolean;
}

/**
 * Provenance carried on every emitted record of every stream. A reader holds
 * records, not a manifest, so the age of the data has to travel with it.
 */
export interface AppleHealthProvenance {
	/** The export's own `<ExportDate>`, i.e. when the OWNER took the dump. */
	exported_at: string | null;
}

/** Tally of real-format surface the connector saw but could not (or chose not to) turn into an emitted field. Reported honestly, never silently dropped. */
export interface AppleHealthGapCounts {
	/**
	 * Records dropped because a record with the same identity had already been
	 * seen in this import. Identity is the hash in parsers.ts: every published
	 * scalar of a health record, and a workout's type, device, start, offset,
	 * end and duration, the device by its manufacturer, model and hardware.
	 * Readings of one measurement from devices that differ in those are not
	 * reconciled and are not counted here; two devices alike in them cannot be
	 * told apart, and an identical reading from each is counted here. The
	 * manifest copy and the receipt description state the same identity.
	 */
	duplicatesDiscarded: number;
	/** Emitted records whose value attribute was blank, published as null. Progress line only; the receipt names "value". */
	emptyValues: number;
	/**
	 * Elements of any kind whose attributes carried a numeric character
	 * reference that names no XML character, as seen. Progress line only; a
	 * Record or Workout the reader would have received is also charged to its
	 * stream's receipt as unreadable.
	 */
	malformedElementsSkipped: number;
	/** Record elements dropped for missing/unparseable startDate. */
	recordsMissingStartDate: number;
	/**
	 * Delivered records whose `type` the area table does not list, by type,
	 * for at most MAX_NAMED_PER_TALLY distinct types. Progress line only.
	 */
	unrecognizedRecordTypes: Map<string, number>;
	/** Delivered records of further unlisted types, once that many are named. Progress line only. */
	unrecognizedRecordsUnnamed: number;
	/**
	 * Quantities on emitted records left null because the export stated no
	 * unit or one this connector does not know how to convert. Keyed by the
	 * unit string as the export wrote it. Progress line only; the receipt names
	 * the affected fields. Nulling one field is deliberate: labelling a value
	 * with a unit it is not in would be silently wrong, which is worse than
	 * absent.
	 */
	unrecognizedUnits: Map<string, number>;
	/** Such quantities whose unit is beyond the named ones. Progress line only. */
	unrecognizedUnitsUnnamed: number;
	/** WorkoutRoute elements (GPS route data nested under a Workout) seen but not captured — deliberately excluded, never parsed. */
	workoutRoutesUncaptured: number;
	/** Workout elements dropped for missing/unparseable startDate. */
	workoutsMissingStartDate: number;
	// The oversized* counters below: elements the scanner gave up on because
	// they exceeded the pending-tail ceiling without closing. The element is
	// dropped and scanning resumes at the next tag, rather than the whole run
	// aborting after a partial emit with no receipt and no checkpoint.
	//
	// Counted BY KIND, because what was lost decides which receipt says so. One
	// counter charged to a single stream would leave the workouts receipt
	// claiming full coverage after a dropped workout while another receipt
	// confessed to a loss it never had.
	/** A top-level Record the reader would have received; its stream's receipt counts it as unreadable. */
	oversizedRecordsSkipped: number;
	/** A top-level Workout the reader would have received; the workouts receipt counts it as unreadable. */
	oversizedWorkoutsSkipped: number;
	/**
	 * A MetadataEntry under an EMITTED Record: was_user_entered may be null for
	 * it. A child drop is held on its parent (AppleHealthElementGaps) and lands
	 * here, and on the receipt, only if the parent is emitted.
	 */
	oversizedRecordMetadataSkipped: number;
	/** A WorkoutEvent under an emitted Workout, which still emits, minus that marker. */
	oversizedWorkoutEventsSkipped: number;
	/** A WorkoutStatistics under an emitted Workout, which still emits, minus that statistic. */
	oversizedWorkoutStatisticsSkipped: number;
	/** Anything else, including a MetadataEntry under a Workout, of which nothing is published. Progress line only. */
	oversizedOtherSkipped: number;
	/**
	 * A Record or Workout dropped as oversized that the reader would never have
	 * received anyway, because its stream was not requested or it fell outside
	 * the requested window, or that cannot be matched to a requested record id
	 * because it has none; or a child dropped from a parent that was not
	 * emitted. Ordinary records are range-filtered before receipt accounting;
	 * this is the same filter applied to a drop. Progress line only, because
	 * the requested window lost nothing; charging it would degrade a fully
	 * covered window because of a drop dated years outside it.
	 */
	oversizedOutOfScopeSkipped: number;
	/**
	 * WorkoutEvent children beyond the per-workout cap on emitted workouts,
	 * for the progress line. The receipt of the stream that emitted the
	 * workout names "events" under fields_unavailable, so the owner-facing
	 * promise of "up to N markers" is checkable rather than a silent slice.
	 */
	workoutEventsTruncated: number;
	/** WorkoutStatistics children beyond the per-workout cap on emitted workouts. See workoutEventsTruncated. */
	workoutStatisticsTruncated: number;
}

export interface StreamParseArgs {
	gaps: AppleHealthGapCounts;
	onProgress: (recordCount: number, workoutCount: number) => Promise<void>;
	onRecord: (el: AppleHealthElement) => Promise<void>;
	onWorkout: (el: AppleHealthElement) => Promise<void>;
	path: string;
	/**
	 * Account for a Record or Workout that could not be read, too large or
	 * undecodable, given the head of its open tag. Charges the element to its
	 * stream's receipt as unreadable and returns true when the reader would have
	 * received it; returns false, charging nothing, when its stream was not
	 * requested, it falls outside the requested window, or the host asked for
	 * specific record ids, which an element with no id cannot be matched to. A
	 * start that cannot be read counts as inside the window. A dropped child is
	 * held on its parent instead and follows the parent's fate.
	 */
	chargeUnreadable: (kind: "Record" | "Workout", head: string) => boolean;
}

/**
 * Shape emitted on every health-area stream (activity, sleep, other and the
 * rest; see areas.ts). The streams differ in which records they carry, not
 * in shape.
 *
 * `source_name`, `source_version` and the free-form `metadata` bag are
 * deliberately absent — see the exclusion notes in schemas.ts. `sourceName` is
 * not read at all, not even for identity.
 */
export interface HealthRecordOut {
	creation_date: string | null;
	device: string | null;
	end_date: string | null;
	exported_at: string | null;
	freshness: "snapshot";
	id: string;
	start_date: string;
	/** Minutes east of UTC at the moment recorded, so a reader can render local wall-clock time. Null when the export stated no offset. */
	start_utc_offset_minutes: number | null;
	type: string;
	unit: string | null;
	value: number | null;
	value_raw: string | null;
	/** From the HKWasUserEntered metadata entry: typed in by a person, or recorded by a sensor. */
	was_user_entered: boolean | null;
}

/** Shape emitted on the `workouts` stream. */
export interface WorkoutRecordOut {
	device: string | null;
	duration_minutes: number | null;
	end_date: string | null;
	events: AppleHealthWorkoutEvent[] | null;
	exported_at: string | null;
	freshness: "snapshot";
	id: string;
	start_date: string;
	start_utc_offset_minutes: number | null;
	statistics: AppleHealthWorkoutStatistics[] | null;
	total_distance_km: number | null;
	total_energy_burned_kcal: number | null;
	workout_activity_type: string | null;
}

/** Why a stream's covered window ends where it does. Closed set; always populated, including on success. */
export type AppleHealthCoverageReason =
	| "awaiting_upload"
	| "collection_interrupted"
	| "covered_in_full"
	| "export_extraction_failed"
	| "newer_upload_too_large"
	| "nothing_in_range"
	| "records_unreadable"
	| "source_unreadable"
	| "window_unavailable";

/** Shape emitted on the `coverage_diagnostics` stream: one receipt per stream per import. */
export interface CoverageDiagnosticOut {
	duplicates_discarded: number | null;
	exported_at: string | null;
	fields_unavailable: string[];
	freshness: "snapshot";
	id: string;
	reason: AppleHealthCoverageReason;
	record_count: number | null;
	records_skipped_unreadable: number | null;
	/** Delivered records whose type the area table does not list. Only the other stream can have any. */
	records_type_unrecognized: number | null;
	status: "complete" | "empty" | "partial";
	stream: string | null;
	window_covered_from: string | null;
	window_covered_to: string | null;
	window_requested_from: string | null;
	window_requested_to: string | null;
}
