#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PDPP Apple Health Connector: an import of the export the Health app makes.
 *
 * The owner opens Health on their iPhone, taps their picture and chooses
 * "Export All Health Data", then uploads the `export.zip`, or the
 * `export.xml` inside it, through the console's manual-upload flow, or places
 * it under APPLE_HEALTH_EXPORT_DIR (default ~/.pdpp/imports/apple_health/).
 * Apple offers no cloud API for Health data; HealthKit is reachable only from
 * an app on the device that holds it, so the export is the only route to the
 * data off the device.
 *
 * No network request is made and only the `filesystem` binding is declared,
 * so the reachability probe and the mock-mutation check report UNKNOWN by
 * design: there is no endpoint to probe and no request path to mutate. See
 * the exemption rule in packages/polyfill-connectors/CONNECTOR-CHECKLIST.md.
 *
 * Each Record goes to the stream of its type's health area (areas.ts), so an
 * owner can share sleep without sharing reproductive health; workouts have a
 * stream of their own, and coverage_diagnostics one receipt per data stream.
 * The XML is scanned as a stream and never held whole, and an uploaded `.zip`
 * is streamed to disk (uploads.ts, which also chooses the upload read).
 *
 * Not collected: device and application names, free-form record metadata,
 * workout weather, GPS routes, and the `<Me>` element's date of birth, blood
 * type and biological sex; schemas.ts gives each reason. Route files are
 * counted, never parsed.
 */

import { createReadStream } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resourceSet } from "@pdpp/connector-protocol";
import {
	runConnector,
	type StreamScope,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import {
	HEALTH_AREA_STREAMS,
	healthAreaOf,
	isListedHealthType,
} from "./areas.ts";
import { IdentityTable } from "./identity-table.ts";
import {
	APPLE_HEALTH_PENDING_TAG_RE,
	buildHealthRecord,
	buildWorkoutEvent,
	buildWorkoutRecord,
	buildWorkoutStatistics,
	detachedAttrs,
	hashId,
	isoDate,
	isTotalStatistic,
	isUntypedFigure,
	MAX_PENDING_TAG_BYTES,
	MAX_TRACKED_CHILDREN_PER_ELEMENT,
	newElementGaps,
	newGapCounts,
	nextTag,
	noteField,
	parseAttrs,
	ScanBuffer,
	type ScannedTag,
	sniffLeadingAttrs,
	tallyUnconvertibleUnit,
	tallyUnrecognizedType,
	wasUserEnteredEntry,
} from "./parsers.ts";
import { validateRecord } from "./schemas.ts";
import type {
	AppleHealthAttrs,
	AppleHealthCoverageReason,
	AppleHealthElement,
	AppleHealthGapCounts,
	AppleHealthProvenance,
	CoverageDiagnosticOut,
	HealthRecordOut,
	StreamParseArgs,
	WorkoutRecordOut,
} from "./types.ts";
import { resolveUploadedExport, UPLOAD_LIMITS } from "./uploads.ts";

// Streaming buffer size — 64 KB balances memory and syscalls on large exports.
const READ_BUFFER_SIZE = 65_536;
// Emit a PROGRESS every N events so operators see progress on multi-GB exports.
const PROGRESS_INTERVAL_EVENTS = 10_000;
/**
 * Duplicate suppression remembers each stream's identities in one of two
 * fixed tables (identity-table.ts): one shared by the thirteen health-area
 * streams, one reserved for workouts. Memory is bounded by the budgets, not
 * the stream count: a table per stream, each able to hold the budget, would
 * cost thirteen times as much, while a shared one costs the same whichever
 * streams spend it. Workouts have their own because records precede them in
 * an export and could spend a shared budget before the first workout is
 * checked. The worst case, both spent, is measured against the bound by the
 * identity-budget test in index.test.ts.
 *
 * Past its budget a stream still emits every record, so a later copy of an
 * identity it could not remember is re-sent under the same id and upserted,
 * and its receipt lists duplicates_discarded under fields_unavailable, since
 * that count is then a floor.
 */
const MAX_REMEMBERED_RECORD_IDS = 400_000;
const MAX_REMEMBERED_WORKOUT_IDS = 100_000;

/** Every data stream, in the order the manifest declares them; each gets its own receipt. */
const DATA_STREAMS = [...HEALTH_AREA_STREAMS, "workouts"] as const;
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const COVERAGE_STREAM = "coverage_diagnostics";
// A character XML does not count as whitespace (XML 1.0 production S).
const XML_NON_WHITESPACE_RE = /[^\t\n\r ]/;

function newElement(
	tag: "Record" | "Workout",
	attrs: AppleHealthAttrs,
): AppleHealthElement {
	return {
		tag,
		attrs,
		metadata: [],
		pending: newElementGaps(),
		unreadable: false,
		workoutEvents: [],
		workoutStatistics: [],
		activityStatistics: [],
		statisticsIncomplete: false,
	};
}

/** Attach a nested MetadataEntry/WorkoutEvent/WorkoutStatistics child to whichever Record/Workout is currently open. WorkoutRoute (GPS geometry) is counted in `gaps`, never captured. */
function attachChild(
	current: AppleHealthElement,
	openTag: string,
	attrString: string | null,
	gaps: AppleHealthGapCounts,
): void {
	if (openTag === "WorkoutRoute") {
		gaps.workoutRoutesUncaptured += 1;
		return;
	}
	const attrs = parseAttrs(attrString);
	if (attrs === null) {
		// A child that could not be decoded is dropped, and the field it would
		// have filled is named on the parent's receipt if the parent is emitted.
		// A lost statistic may be one a workout total needs.
		gaps.malformedElementsSkipped += 1;
		const field = UNDECODABLE_CHILD_FIELD[`${current.tag}/${openTag}`];
		if (field) {
			noteField(current.pending, field);
		}
		current.statisticsIncomplete ||= openTag === "WorkoutStatistics";
		return;
	}
	if (openTag === "MetadataEntry" && attrs.key !== undefined) {
		// Only HKWasUserEntered is published, so only its first entry is kept:
		// others kept up to a cap could crowd it out and turn was_user_entered
		// null, and every copy kept would grow without bound.
		if (attrs.key === "HKWasUserEntered" && current.metadata.length === 0) {
			current.metadata.push(wasUserEnteredEntry(attrs.value));
		}
		return;
	}
	// Capped as each child is attached, so a list never grows past the cap in
	// memory; the element's gaps name the list that was cut.
	if (openTag === "WorkoutEvent") {
		if (current.workoutEvents.length >= MAX_TRACKED_CHILDREN_PER_ELEMENT) {
			current.pending.eventsTruncated += 1;
			return;
		}
		current.workoutEvents.push(buildWorkoutEvent(attrs, current.pending));
	} else if (openTag === "WorkoutStatistics") {
		if (current.workoutStatistics.length >= MAX_TRACKED_CHILDREN_PER_ELEMENT) {
			current.pending.statisticsTruncated += 1;
			return;
		}
		current.statisticsIncomplete ||= isUntypedFigure(attrs);
		// Bounded at parse time: unknown attributes are dropped here rather than
		// forwarded onto a published stream.
		current.workoutStatistics.push(
			buildWorkoutStatistics(attrs, current.pending),
		);
	}
}

/**
 * Keep aside a statistic from inside one of the workout's WorkoutActivity
 * children if a workout total may need it: one of distance or active energy,
 * for a workout with no statistic of that kind of its own (workoutTotal in
 * parsers.ts). Nothing else an activity holds is kept. A statistic that
 * cannot be kept, or that states a figure but no type, marks the rest
 * incomplete, so no total is summed short.
 */
function attachActivityChild(
	current: AppleHealthElement,
	openTag: string,
	attrString: string | null,
	gaps: AppleHealthGapCounts,
): void {
	if (openTag !== "WorkoutStatistics") {
		return;
	}
	const attrs = parseAttrs(attrString);
	if (attrs === null) {
		gaps.malformedElementsSkipped += 1;
		current.statisticsIncomplete = true;
		return;
	}
	if (isUntypedFigure(attrs)) {
		current.statisticsIncomplete = true;
		return;
	}
	const statistic = buildWorkoutStatistics(attrs);
	if (!isTotalStatistic(statistic.type)) {
		return;
	}
	if (current.activityStatistics.length >= MAX_TRACKED_CHILDREN_PER_ELEMENT) {
		current.statisticsIncomplete = true;
		return;
	}
	current.activityStatistics.push(statistic);
}

/**
 * The published field an undecodable child would have filled, by parent and
 * child. A MetadataEntry under a Record may have been HKWasUserEntered; one
 * under a Workout feeds nothing published.
 */
const UNDECODABLE_CHILD_FIELD: Readonly<Record<string, string>> = {
	"Record/MetadataEntry": "was_user_entered",
	"Workout/WorkoutEvent": "events",
	"Workout/WorkoutStatistics": "statistics",
};

/**
 * Count a Record or Workout whose open tag could not be decoded. Its stream's
 * receipt is charged only if the reader would have received it, the same test
 * a dropped oversized element gets; what that needs is read from the raw tag,
 * since a startDate never needs a character reference.
 */
function countUndecodable(
	kind: "Record" | "Workout",
	attrString: string,
	gaps: AppleHealthGapCounts,
	chargeUnreadable: StreamParseArgs["chargeUnreadable"],
): void {
	gaps.malformedElementsSkipped += 1;
	chargeUnreadable(kind, `<${kind}${attrString}`);
}

/** Mutable scan state threaded through one streamParse pass. */
interface ScanState {
	/**
	 * How many WorkoutActivity elements are open inside the current Workout.
	 * While any is, children belong to the activity and are not the
	 * workout's; see attachActivityChild.
	 */
	activityDepth: number;
	/** Whether </HealthData> has been read. */
	closed: boolean;
	current: AppleHealthElement | null;
	/**
	 * A WorkoutActivity under the current Workout, dropped as oversized, whose
	 * tag is still being read to the next '<': whether its first '>' has been
	 * read and whether a '/' came before it, whether the text before that '>'
	 * so far ends with a '/', and whether anything but whitespace has followed
	 * it. Null when none is.
	 */
	droppedActivity: {
		ended: boolean;
		selfClosing: boolean;
		slash: boolean;
		unclear: boolean;
	} | null;
	recordCount: number;
	workoutCount: number;
}

/** Close out `state.current` on its matching `</Record>`/`</Workout>`, emitting the assembled element. */
async function handleCloseTag(
	closeTag: "Record" | "Workout",
	state: ScanState,
	onRecord: StreamParseArgs["onRecord"],
	onWorkout: StreamParseArgs["onWorkout"],
): Promise<void> {
	if (!(state.current && state.current.tag === closeTag)) {
		return;
	}
	if (state.current.unreadable) {
		// Already counted when it opened.
	} else if (closeTag === "Record") {
		await onRecord(state.current);
		state.recordCount += 1;
	} else {
		await onWorkout(state.current);
		state.workoutCount += 1;
	}
	state.current = null;
	state.activityDepth = 0;
}

/** Handle a Record/Workout open tag: emit immediately if self-closing, otherwise open a span for nested children. */
async function handleTopLevelOpenTag(
	openTag: "Record" | "Workout",
	attrs: AppleHealthAttrs,
	selfClose: string,
	state: ScanState,
	onRecord: StreamParseArgs["onRecord"],
	onWorkout: StreamParseArgs["onWorkout"],
): Promise<void> {
	if (selfClose !== "/") {
		// Non-self-closing: children (MetadataEntry/WorkoutEvent/
		// WorkoutStatistics) arrive before the matching close tag, perhaps many
		// chunks later, so its attributes are held as detached copies.
		state.current = newElement(openTag, detachedAttrs(attrs));
		state.activityDepth = 0;
		return;
	}
	if (openTag === "Record") {
		await onRecord(newElement("Record", attrs));
		state.recordCount += 1;
	} else {
		await onWorkout(newElement("Workout", attrs));
		state.workoutCount += 1;
	}
}

/** Handle one tag against the running scan state, emitting a completed Record/Workout when its span closes. */
async function handleTagMatch(
	tag: ScannedTag,
	state: ScanState,
	gaps: AppleHealthGapCounts,
	onRecord: StreamParseArgs["onRecord"],
	onWorkout: StreamParseArgs["onWorkout"],
	chargeUnreadable: StreamParseArgs["chargeUnreadable"],
): Promise<void> {
	const { open: openTag, attrs: attrString, close: closeTag } = tag;
	const selfClose = tag.selfClosing ? "/" : "";
	if (closeTag === "HealthData") {
		state.closed = true;
		return;
	}
	if (closeTag === "WorkoutActivity") {
		state.activityDepth = Math.max(0, state.activityDepth - 1);
		return;
	}
	if (closeTag === "Record" || closeTag === "Workout") {
		await handleCloseTag(closeTag, state, onRecord, onWorkout);
		return;
	}
	if (openTag === "WorkoutActivity") {
		// iOS 16 and later nest a WorkoutActivity in a Workout, with children
		// of its own that are not the workout's: attached, a single-activity
		// workout's markers and statistics would count twice. Only statistics a
		// total may need are kept aside (attachActivityChild).
		if (selfClose !== "/" && state.current?.tag === "Workout") {
			state.activityDepth += 1;
		}
		return;
	}
	if (openTag === "Record" || openTag === "Workout") {
		const attrs = parseAttrs(attrString);
		if (attrs === null) {
			countUndecodable(openTag, attrString ?? "", gaps, chargeUnreadable);
			if (selfClose !== "/") {
				state.current = { ...newElement(openTag, {}), unreadable: true };
				state.activityDepth = 0;
			}
			return;
		}
		await handleTopLevelOpenTag(
			openTag,
			attrs,
			selfClose ?? "",
			state,
			onRecord,
			onWorkout,
		);
		return;
	}
	if (state.current && openTag) {
		if (state.activityDepth === 0) {
			attachChild(state.current, openTag, attrString, gaps);
		} else {
			attachActivityChild(state.current, openTag, attrString, gaps);
		}
	}
}

/**
 * Read on through the rest of a dropped WorkoutActivity's tag, which runs to
 * the next '<'. Only one not closed by `/>` has children to come, so only
 * that one opens an activity, as for one that is read.
 *
 * Apple writes only whitespace between a tag and the next. Anything else
 * after the first '>' leaves the tag's end unknown, as text may hold a '>'
 * and so may a value: the activity state is then left as it was, and the
 * workout's totals are marked incomplete rather than summed from statistics
 * that may be misfiled.
 */
function skipDroppedActivity(text: string, state: ScanState): void {
	const dropped = state.droppedActivity;
	if (dropped === null) {
		return;
	}
	const next = text.indexOf("<");
	const rest = next === -1 ? text : text.slice(0, next);
	let after = 0;
	if (!dropped.ended) {
		const end = rest.indexOf(">");
		if (end !== -1) {
			dropped.ended = true;
			dropped.selfClosing = end === 0 ? dropped.slash : rest[end - 1] === "/";
			after = end + 1;
		} else if (rest.length > 0) {
			dropped.slash = rest.endsWith("/");
		}
	}
	dropped.unclear ||=
		dropped.ended && XML_NON_WHITESPACE_RE.test(rest.slice(after));
	if (next !== -1) {
		if (dropped.unclear && state.current) {
			state.current.statisticsIncomplete = true;
		} else if (!dropped.selfClosing) {
			state.activityDepth += 1;
		}
		state.droppedActivity = null;
	}
}

/**
 * Walk Record and Workout tags, their children and their close tags in
 * document order across chunk boundaries. Apple nests neither Record nor
 * Workout in the other, so the one element open is context enough to
 * attribute a child, and no tree is built. Returns whether the document is
 * truncated: a file that stops before its end is an interrupted copy, with a
 * different next action from an export that held nothing.
 */
async function streamParse({
	path,
	onRecord,
	onWorkout,
	onProgress,
	gaps,
	chargeUnreadable,
}: StreamParseArgs): Promise<{ truncated: boolean }> {
	// Async iteration pauses the stream between awaits, so no chunk is lost to
	// an async handler.
	const stream = createReadStream(path, { highWaterMark: READ_BUFFER_SIZE });
	const pending = new ScanBuffer();
	const state: ScanState = {
		activityDepth: 0,
		closed: false,
		current: null,
		droppedActivity: null,
		recordCount: 0,
		workoutCount: 0,
	};
	const scan = async (): Promise<void> => {
		const text = pending.text();
		skipDroppedActivity(text, state);
		let at = 0;
		for (let tag = nextTag(text, at); tag !== null; tag = nextTag(text, at)) {
			await handleTagMatch(
				tag,
				state,
				gaps,
				onRecord,
				onWorkout,
				chargeUnreadable,
			);
			at = tag.end;
		}
		// Keep from the last '<': no tag can start before it, as XML forbids a
		// raw '<' in an attribute value. Otherwise a long run of elements the
		// scanner ignores, such as a GPS route's thousands of <Location>s, would
		// accumulate in memory. This reads tag-shaped text, not XML: comments,
		// CDATA and processing instructions, which Apple's export does not use,
		// are not understood, and Record-shaped text inside one would be read.
		pending.keep(text, at);
	};
	for await (const chunk of stream as AsyncIterable<Buffer>) {
		if (!pending.push(chunk)) {
			continue;
		}
		await scan();
		if (pending.bytes > MAX_PENDING_TAG_BYTES) {
			// An element still open at the ceiling. Throwing would end the run
			// after a partial emit with no receipt, so it is dropped and counted
			// where the element would have been published, and scanning resumes
			// at the next tag. The tail begins at a '<', so its head names it.
			const head = pending.head();
			const kind = APPLE_HEALTH_PENDING_TAG_RE.exec(head)?.[1];
			const parent = state.current;
			if (kind === "Record" || kind === "Workout") {
				// Charged only if the reader would have received it, the test a
				// record that is read passes; otherwise a drop dated outside the
				// window would degrade a window covered in full.
				if (!chargeUnreadable(kind, head)) {
					gaps.oversizedOutOfScopeSkipped += 1;
				} else if (kind === "Record") {
					gaps.oversizedRecordsSkipped += 1;
				} else {
					gaps.oversizedWorkoutsSkipped += 1;
				}
			} else if (kind === "WorkoutActivity" && parent?.tag === "Workout") {
				// Its children, read after it, are still the activity's and never
				// the workout's, as for one that is read. Whether it has any is
				// known once its tag's end arrives (skipDroppedActivity).
				gaps.oversizedOtherSkipped += 1;
				state.droppedActivity = {
					ended: false,
					selfClosing: false,
					slash: pending.endsWithSlash(),
					unclear: false,
				};
			} else if (state.activityDepth > 0) {
				// A child of a WorkoutActivity, which is never published. A lost
				// statistic may be one a workout total needs, so no total is
				// summed from the activities without it.
				gaps.oversizedOtherSkipped += 1;
				if (kind === "WorkoutStatistics" && parent) {
					parent.statisticsIncomplete = true;
				}
			} else if (kind === "MetadataEntry" && parent?.tag === "Record") {
				// A child is held on its parent and reaches a receipt only if the
				// parent is emitted, like any other gap in that record.
				parent.pending.oversizedMetadata += 1;
			} else if (kind === "WorkoutEvent" && parent?.tag === "Workout") {
				parent.pending.oversizedEvents += 1;
			} else if (kind === "WorkoutStatistics" && parent?.tag === "Workout") {
				parent.pending.oversizedStatistics += 1;
			} else {
				// A MetadataEntry under a Workout, a route, or an element this
				// connector never publishes. Nothing a reader would have received
				// was lost, so it goes on the progress line and no receipt.
				gaps.oversizedOtherSkipped += 1;
			}
			pending.clear();
		}
		const total = state.recordCount + state.workoutCount;
		if (total > 0 && total % PROGRESS_INTERVAL_EVENTS === 0) {
			await onProgress(state.recordCount, state.workoutCount);
		}
	}
	// Whatever arrived since the last scan.
	await scan();
	await onProgress(state.recordCount, state.workoutCount);
	// Truncated when a Record or Workout is still open, the tail is a tag with
	// no '>', or </HealthData> was never read. The first alone would call a
	// file cut between two self-closing Records complete.
	const partialTag = pending.bytes > 0 && !pending.hasClose();
	return {
		truncated: state.current !== null || partialTag || !state.closed,
	};
}

/** Per-stream tally, mutated across callbacks. */
interface StreamRef {
	/** Emitted, after the requested time range AND schema validation. */
	emitted: number;
	/** Built and in range, but rejected by the schema, so never emitted. */
	failedValidation: number;
	/** Dropped because an identical record had already been seen this run. */
	duplicates: number;
	/** Earliest and latest start_date actually emitted. */
	coveredFrom: string | undefined;
	coveredTo: string | undefined;
	/**
	 * Earliest start_date of any readable element of this stream in the export,
	 * before the requested window or resource list is applied. Whether the
	 * export reaches back to the requested start is a fact about the export,
	 * not about what the window let through.
	 */
	earliestSeen: string | undefined;
	/** Published fields left null or cut short on at least one EMITTED record. */
	fieldsUnavailable: Set<string>;
	/**
	 * Elements of this stream that could not be read at all: no parseable
	 * start date, too large to read, or an attribute that could not be
	 * decoded. The latter two only when the reader would have received them,
	 * and none under a resource list (see chargeUnreadable).
	 */
	unreadable: number;
	/**
	 * This stream met a new identity after its identity budget was spent. That
	 * identity was not remembered, so a later copy of it is emitted and the
	 * stream's duplicates count is a floor; its receipt says so.
	 */
	duplicateCapReached: boolean;
	/**
	 * Emitted records whose type the area table does not list. They belong to
	 * `other`, so only its count can be non-zero.
	 */
	typeUnrecognized: number;
}

function newStreamRef(): StreamRef {
	return {
		emitted: 0,
		failedValidation: 0,
		duplicates: 0,
		coveredFrom: undefined,
		coveredTo: undefined,
		earliestSeen: undefined,
		fieldsUnavailable: new Set(),
		unreadable: 0,
		duplicateCapReached: false,
		typeUnrecognized: 0,
	};
}

interface TimeRange {
	since?: string | undefined;
	until?: string | undefined;
}

function rangeOf(scope: StreamScope | undefined): TimeRange {
	const tr = scope?.time_range;
	return { since: tr?.since, until: tr?.until };
}

/**
 * Whether a record falls inside the window the runtime applies, so a receipt
 * counts what the runtime keeps. It mirrors `isOutsideTimeRange` in
 * connector-runtime.ts, bounds cut to their ten-character date and `until`
 * exclusive; any divergence would set the receipt against the records.
 */
function withinRange(startDate: string, range: TimeRange): boolean {
	if (range.since && startDate < range.since.slice(0, 10)) {
		return false;
	}
	if (range.until && startDate >= range.until.slice(0, 10)) {
		return false;
	}
	return true;
}

function noteSeen(ref: StreamRef, startDate: string): void {
	if (ref.earliestSeen === undefined || startDate < ref.earliestSeen) {
		ref.earliestSeen = startDate;
	}
}

/** One requested data stream: what was asked of it and what it has done. */
interface Lane {
	/** The table remembering this stream's identities, on the budget it draws on. */
	identities: IdentityTable;
	range: TimeRange;
	ref: StreamRef;
	/**
	 * The runtime's resource filter for this stream, built with its own
	 * helper, or null for everything. The runtime drops records not asked for
	 * inside emitRecord, so the receipt applies the same filter first.
	 */
	resources: ReadonlySet<string> | null;
	/** This stream's tag in its table: its place in DATA_STREAMS, from 1. */
	tag: number;
}

type DataStream = (typeof DATA_STREAMS)[number];

/** A lane for each requested data stream, and none for any other. */
function buildLanes(
	requested: ReadonlyMap<string, StreamScope>,
): Map<DataStream, Lane> {
	// The area streams share one table and workouts have their own (see
	// MAX_REMEMBERED_RECORD_IDS).
	const areaIdentities = new IdentityTable(MAX_REMEMBERED_RECORD_IDS);
	const workoutIdentities = new IdentityTable(MAX_REMEMBERED_WORKOUT_IDS);
	const lanes = new Map<DataStream, Lane>();
	for (const [index, stream] of DATA_STREAMS.entries()) {
		if (requested.has(stream)) {
			const scope = requested.get(stream);
			lanes.set(stream, {
				identities: stream === "workouts" ? workoutIdentities : areaIdentities,
				range: rangeOf(scope),
				ref: newStreamRef(),
				resources: resourceSet(scope),
				tag: index + 1,
			});
		}
	}
	return lanes;
}

/** Remember the identity of a record the reader is receiving. Bounded; stops remembering rather than growing without limit. */
function remember(lane: Lane, id: string): void {
	if (!lane.identities.add(lane.tag, id)) {
		// Past the budget: a later copy of this identity will be emitted, so
		// the receipt says its duplicate count is a floor.
		lane.ref.duplicateCapReached = true;
	}
}

/** What every handler needs for one run. */
interface RunContext {
	emitRecord: (stream: string, rec: Record<string, unknown>) => Promise<void>;
	gaps: AppleHealthGapCounts;
	lanes: ReadonlyMap<DataStream, Lane>;
	provenance: AppleHealthProvenance;
}

/** Route a Record to the stream of its health area (see areas.ts), if that stream was requested. */
async function handleRecord(
	el: AppleHealthElement,
	run: RunContext,
): Promise<void> {
	const stream = healthAreaOf(el.attrs.type);
	const lane = run.lanes.get(stream);
	if (!lane) {
		return;
	}
	const rec = buildHealthRecord(el, run.gaps, run.provenance);
	if (!rec) {
		chargeUnreadable(lane);
		return;
	}
	const emitted = await admit(stream, el, rec, lane, run);
	// Counted once delivered, like everything else on a receipt: a type no
	// area claims still arrives, on other, and the owner can see how many.
	if (emitted && !isListedHealthType(el.attrs.type)) {
		lane.ref.typeUnrecognized += 1;
		tallyUnrecognizedType(el.attrs.type, run.gaps);
	}
}

async function handleWorkout(
	el: AppleHealthElement,
	run: RunContext,
): Promise<void> {
	const lane = run.lanes.get("workouts");
	if (!lane) {
		return;
	}
	const rec = buildWorkoutRecord(el, run.gaps, run.provenance);
	if (!rec) {
		chargeUnreadable(lane);
		return;
	}
	await admit("workouts", el, rec, lane, run);
}

/**
 * Count an element of this stream that could not be read, on its receipt;
 * not under a resource list, where an element with no id cannot be matched
 * to one the host asked for. Returns whether it was charged.
 */
function chargeUnreadable(lane: Lane): boolean {
	if (lane.resources !== null) {
		return false;
	}
	lane.ref.unreadable += 1;
	return true;
}

/**
 * Charge a Record or Workout that could not be read to its stream, if the
 * reader would have received it (StreamParseArgs.chargeUnreadable). A Record
 * whose type cannot be read is charged to `other`, as an unlisted type is,
 * so one receipt states the loss rather than none or all of them.
 */
function chargeUnreadableElement(
	lanes: ReadonlyMap<DataStream, Lane>,
	kind: "Record" | "Workout",
	head: string,
): boolean {
	const { startDate, type } = sniffLeadingAttrs(head);
	const lane = lanes.get(kind === "Record" ? healthAreaOf(type) : "workouts");
	if (!lane) {
		return false;
	}
	const startIso = startDate === undefined ? null : isoDate(startDate);
	if (startIso !== null && !withinRange(startIso, lane.range)) {
		return false;
	}
	return chargeUnreadable(lane);
}

/**
 * Emit a built record if the reader is to receive it, and account for it on
 * the receipt only then. Window and resource list come first, since they
 * decide whether the reader receives it; identity and schema are judged only
 * for records it does, so no count or gap on the receipt comes from a record
 * the reader does not hold. The identity is remembered last, once the schema
 * accepts the record, so a rejected one spends no budget and makes no later
 * copy a duplicate. Returns whether the record was emitted.
 */
async function admit(
	stream: string,
	el: AppleHealthElement,
	rec: HealthRecordOut | WorkoutRecordOut,
	lane: Lane,
	run: RunContext,
): Promise<boolean> {
	const { ref, range, resources } = lane;
	const { gaps, emitRecord } = run;
	noteSeen(ref, rec.start_date);
	// Not asked for: the runtime would drop it inside emitRecord.
	const outOfScope =
		!withinRange(rec.start_date, range) ||
		(resources !== null && !resources.has(rec.id));
	if (outOfScope) {
		settleNotEmitted(el, gaps);
		return false;
	}
	if (lane.identities.has(lane.tag, rec.id)) {
		ref.duplicates += 1;
		gaps.duplicatesDiscarded += 1;
		settleNotEmitted(el, gaps);
		return false;
	}
	// Validated before it is counted: the runtime turns a failure into a
	// SKIP_RESULT, not a RECORD.
	if (!validateRecord(stream, { ...rec }).ok) {
		ref.failedValidation += 1;
		settleNotEmitted(el, gaps);
		return false;
	}
	remember(lane, rec.id);
	ref.emitted += 1;
	ref.coveredFrom =
		ref.coveredFrom === undefined || rec.start_date < ref.coveredFrom
			? rec.start_date
			: ref.coveredFrom;
	ref.coveredTo =
		ref.coveredTo === undefined || rec.start_date > ref.coveredTo
			? rec.start_date
			: ref.coveredTo;
	settleEmitted(el, ref, gaps);
	await emitRecord(stream, { ...rec });
	return true;
}

/** Charge an emitted element's gaps to its stream's receipt and the progress line. */
function settleEmitted(
	el: AppleHealthElement,
	ref: StreamRef,
	gaps: AppleHealthGapCounts,
): void {
	const p = el.pending;
	for (const field of p.fields) {
		ref.fieldsUnavailable.add(field);
	}
	if (p.fields.includes("value")) {
		gaps.emptyValues += 1;
	}
	for (const { field, unit } of p.units) {
		tallyUnconvertibleUnit(unit, gaps);
		ref.fieldsUnavailable.add(field);
	}
	if (p.oversizedMetadata > 0) {
		// The entry that would have said so could not be read, so
		// was_user_entered may be null where the export had a value.
		ref.fieldsUnavailable.add("was_user_entered");
	}
	if (p.eventsTruncated > 0 || p.oversizedEvents > 0) {
		ref.fieldsUnavailable.add("events");
	}
	if (p.statisticsTruncated > 0 || p.oversizedStatistics > 0) {
		ref.fieldsUnavailable.add("statistics");
	}
	gaps.oversizedRecordMetadataSkipped += p.oversizedMetadata;
	gaps.oversizedWorkoutEventsSkipped += p.oversizedEvents;
	gaps.oversizedWorkoutStatisticsSkipped += p.oversizedStatistics;
	gaps.workoutEventsTruncated += p.eventsTruncated;
	gaps.workoutStatisticsTruncated += p.statisticsTruncated;
}

/**
 * An element that was not emitted costs no receipt anything. A child dropped
 * as oversized from it stays visible on the progress line as out of scope.
 */
function settleNotEmitted(
	el: AppleHealthElement,
	gaps: AppleHealthGapCounts,
): void {
	const p = el.pending;
	gaps.oversizedOutOfScopeSkipped +=
		p.oversizedMetadata + p.oversizedEvents + p.oversizedStatistics;
}

/** Render the gap tally as a single human-readable progress line. Never silent — an empty tally still reports "no gaps". */
function formatGapSummary(gaps: AppleHealthGapCounts): string {
	const parts: string[] = [];
	if (gaps.recordsMissingStartDate > 0) {
		parts.push(
			`records_dropped_missing_start_date=${gaps.recordsMissingStartDate}`,
		);
	}
	if (gaps.workoutsMissingStartDate > 0) {
		parts.push(
			`workouts_dropped_missing_start_date=${gaps.workoutsMissingStartDate}`,
		);
	}
	if (gaps.unrecognizedRecordTypes.size > 0) {
		const byType = [...gaps.unrecognizedRecordTypes.entries()]
			.map(([type, count]) => `${type}:${count}`)
			.join(",");
		parts.push(`unrecognized_record_types=${byType}`);
	}
	if (gaps.unrecognizedRecordsUnnamed > 0) {
		parts.push(
			`unrecognized_records_of_unnamed_types=${gaps.unrecognizedRecordsUnnamed}`,
		);
	}
	if (gaps.unrecognizedUnits.size > 0) {
		const byUnit = [...gaps.unrecognizedUnits.entries()]
			.map(([unit, count]) => `${unit}:${count}`)
			.join(",");
		parts.push(`unconvertible_units=${byUnit}`);
	}
	if (gaps.unrecognizedUnitsUnnamed > 0) {
		parts.push(
			`unconvertible_quantities_of_unnamed_units=${gaps.unrecognizedUnitsUnnamed}`,
		);
	}
	if (gaps.emptyValues > 0) {
		parts.push(`empty_values=${gaps.emptyValues}`);
	}
	if (gaps.malformedElementsSkipped > 0) {
		parts.push(`malformed_elements_skipped=${gaps.malformedElementsSkipped}`);
	}
	if (gaps.workoutRoutesUncaptured > 0) {
		parts.push(`workout_routes_uncaptured=${gaps.workoutRoutesUncaptured}`);
	}
	if (gaps.duplicatesDiscarded > 0) {
		parts.push(`duplicates_discarded=${gaps.duplicatesDiscarded}`);
	}
	const oversized: Array<[string, number]> = [
		["records", gaps.oversizedRecordsSkipped],
		["workouts", gaps.oversizedWorkoutsSkipped],
		["record_metadata", gaps.oversizedRecordMetadataSkipped],
		["workout_events", gaps.oversizedWorkoutEventsSkipped],
		["workout_statistics", gaps.oversizedWorkoutStatisticsSkipped],
		["other", gaps.oversizedOtherSkipped],
		["out_of_scope", gaps.oversizedOutOfScopeSkipped],
	];
	const oversizedParts = oversized
		.filter(([, n]) => n > 0)
		.map(([k, n]) => `${k}:${n}`);
	if (oversizedParts.length > 0) {
		parts.push(`oversized_elements_skipped=${oversizedParts.join(",")}`);
	}
	if (gaps.workoutEventsTruncated > 0) {
		parts.push(`workout_events_truncated=${gaps.workoutEventsTruncated}`);
	}
	if (gaps.workoutStatisticsTruncated > 0) {
		parts.push(
			`workout_statistics_truncated=${gaps.workoutStatisticsTruncated}`,
		);
	}
	if (parts.length === 0) {
		return "Apple Health phase=emit pass=emit gaps=none";
	}
	return `Apple Health phase=emit pass=emit gaps: ${parts.join(" ")}`;
}

/**
 * Fields of this stream that this import left empty on a record it emitted
 * (see admit), each named by the gap that hit it, so a column of nulls is
 * never taken for readings never recorded.
 */
function fieldsUnavailable(
	ref: StreamRef,
	provenance: AppleHealthProvenance,
): string[] {
	const out: string[] = [];
	if (provenance.exported_at === null) {
		out.push("exported_at");
	}
	out.push(...[...ref.fieldsUnavailable].sort());
	if (ref.duplicateCapReached) {
		// The one entry naming a field of the receipt: its identity budget ran
		// out, so duplicates_discarded is a floor.
		out.push("duplicates_discarded");
	}
	return out;
}

/**
 * A requested window bound as the date-time the receipt's schema requires.
 * A bare date is the midnight UTC the runtime applies; passed through, it
 * would fail the schema and cost the receipt itself. An unparseable bound is
 * null.
 */
function requestedBound(value: string | undefined): string | null {
	if (!value) {
		return null;
	}
	if (DATE_ONLY_RE.test(value)) {
		return `${value}T00:00:00.000Z`;
	}
	const instant = Date.parse(value);
	return Number.isNaN(instant) ? null : new Date(instant).toISOString();
}

interface StreamOutcome {
	reason: AppleHealthCoverageReason;
	status: CoverageDiagnosticOut["status"];
}

interface ReceiptArgs extends StreamOutcome {
	lane: Lane;
	provenance: AppleHealthProvenance;
	stream: string;
}

function buildReceipt(args: ReceiptArgs): CoverageDiagnosticOut {
	const { stream, status, reason, lane, provenance } = args;
	const { ref, range } = lane;
	const requestedFrom = requestedBound(range.since);
	const requestedTo = requestedBound(range.until);
	return {
		id: hashId(
			`${stream}|${provenance.exported_at ?? ""}|${requestedFrom ?? ""}|${requestedTo ?? ""}|${reason}`,
		),
		stream,
		status,
		reason,
		record_count: ref.emitted,
		duplicates_discarded: ref.duplicates,
		// Rows that could not be used: unreadable elements, or records rejected
		// by the schema. Both fail identically on every retry, so to an owner
		// they are one category with one next action, which is none.
		records_skipped_unreadable: ref.unreadable + ref.failedValidation,
		records_type_unrecognized: ref.typeUnrecognized,
		fields_unavailable: fieldsUnavailable(ref, provenance),
		window_requested_from: requestedFrom,
		window_requested_to: requestedTo,
		window_covered_from: ref.coveredFrom ?? null,
		window_covered_to: ref.coveredTo ?? null,
		freshness: "snapshot",
		exported_at: provenance.exported_at,
	};
}

/**
 * Each stream's own outcome, chosen by the owner's next action, most needed
 * first: a truncated file; unreadable rows, which outrank "nothing in range"
 * since what was there could not be read; a window the data does not reach
 * back to; then a newer .zip refused for its size, whose export may
 * supersede what was read, in place of covered_in_full or nothing_in_range
 * only, so it never hides worse news. One outcome stamped on every receipt
 * would tell the owner of an export with no workouts that every workout was
 * imported.
 */
function outcomeOf(
	lane: Lane,
	truncated: boolean,
	newerTooLarge: boolean,
): StreamOutcome {
	const { ref, range } = lane;
	const emitted = ref.emitted > 0;
	const skipped = ref.unreadable + ref.failedValidation;
	// Asked for history the data does not reach. Judged on the earliest
	// record in the export, emitted or not, since every one emitted is inside
	// the window, and by date, as the runtime applies the bound.
	const short = Boolean(
		range.since &&
			ref.earliestSeen &&
			ref.earliestSeen.slice(0, 10) > range.since.slice(0, 10),
	);
	if (truncated) {
		return {
			reason: "collection_interrupted",
			status: emitted ? "partial" : "empty",
		};
	}
	if (skipped > 0) {
		return {
			reason: "records_unreadable",
			status: emitted ? "partial" : "empty",
		};
	}
	if (short) {
		return {
			reason: "window_unavailable",
			status: emitted ? "partial" : "empty",
		};
	}
	if (newerTooLarge) {
		return {
			reason: "newer_upload_too_large",
			status: emitted ? "partial" : "empty",
		};
	}
	if (!emitted) {
		return { reason: "nothing_in_range", status: "empty" };
	}
	return { reason: "covered_in_full", status: "complete" };
}

runConnector({
	name: "apple_health",
	validateRecord,
	/**
	 * Without this the runtime filters on a field named `date`, which no
	 * record has, and every record would be out of range. Receipts carry no
	 * start_date and the runtime keeps a record without the field, so a
	 * receipt, which describes the import rather than a moment in the window,
	 * is never filtered out.
	 */
	timeRangeField: "start_date",
	// collection_mode is not read: with no cursor, full_refresh and
	// incremental emit the same records (see the note on cursors in collect()).
	async collect({ requested, emit, emitRecord, progress }) {
		const dir =
			process.env.APPLE_HEALTH_EXPORT_DIR ||
			join(homedir(), ".pdpp/imports/apple_health");
		const gaps = newGapCounts();
		const lanes = buildLanes(requested);

		/** One receipt per requested data stream, each with its own outcome. Every exit path goes through here. */
		const emitReceipts = async (
			outcome: (lane: Lane) => StreamOutcome,
			provenance: AppleHealthProvenance = { exported_at: null },
		): Promise<void> => {
			if (!requested.has(COVERAGE_STREAM)) {
				return;
			}
			for (const [stream, lane] of lanes) {
				await emitRecord(
					COVERAGE_STREAM,
					buildReceipt({
						stream,
						lane,
						provenance,
						...outcome(lane),
					}) as unknown as Record<string, unknown>,
				);
			}
		};
		/** The receipts of an import that read nothing. */
		const empty = (reason: AppleHealthCoverageReason) => (): StreamOutcome => ({
			reason,
			status: "empty",
		});
		// The protocol names one stream on a SKIP_RESULT. A skip here is the
		// whole import's, so it names the first data stream the host asked for;
		// every requested stream's receipt carries the same reason.
		const skipStream =
			DATA_STREAMS.find((stream) => requested.has(stream)) ?? DATA_STREAMS[0];

		const unreadableDirectories: string[] = [];
		const resolved = await resolveUploadedExport(dir, UPLOAD_LIMITS, (path) => {
			unreadableDirectories.push(path);
		});
		if (unreadableDirectories.length > 0) {
			await progress(
				`Apple Health phase=discover skipped directories that could not be read: ${unreadableDirectories.join(", ")}`,
			);
		}

		if (resolved.kind === "failed") {
			await emitReceipts(empty("export_extraction_failed"));
			await emit({
				type: "SKIP_RESULT",
				stream: skipStream,
				reason: "export_extraction_failed",
				message: resolved.message,
			});
			return;
		}
		// A folder among the uploads that could not be listed may hold the
		// export, so the owner is told of it beside what was found.
		const unlisted = unreadableDirectories.length > 0;
		if (resolved.kind === "not_export") {
			await emitReceipts(empty("source_unreadable"));
			await emit({
				type: "SKIP_RESULT",
				stream: skipStream,
				reason: "source_unreadable",
				message: unlisted
					? "That file isn't an Apple Health export we can read. Upload the export.zip your iPhone produced, or the export.xml from inside it. Some folders among your uploads could not be read."
					: "That file isn't an Apple Health export we can read. Upload the export.zip your iPhone produced, or the export.xml from inside it.",
			});
			return;
		}
		if (resolved.kind === "none") {
			// The likeliest first-run state, and the one a real person is most
			// likely to see. It is an ordinary waiting state, not a failure.
			await emitReceipts(empty("awaiting_upload"));
			await emit({
				type: "SKIP_RESULT",
				stream: skipStream,
				reason: "awaiting_upload",
				message: unlisted
					? "No Apple Health export was found, and some folders among your uploads could not be read. Produce an export from the Health app on your iPhone and upload it here."
					: "No Apple Health export has been uploaded yet. Produce one from the Health app on your iPhone and upload it here.",
			});
			return;
		}
		const { path } = resolved;
		if (resolved.newerTooLarge !== undefined) {
			await progress(
				`Apple Health phase=discover reading an older export; a newer upload could not be opened: ${resolved.newerTooLarge}`,
			);
		}

		// The age of the data, read with the head that identified the export,
		// before anything is emitted, so every record can carry it.
		const provenance: AppleHealthProvenance = {
			exported_at: resolved.exportedAt,
		};

		// No cursor and no STATE: every import emits every record in the
		// window. A later export carries records dated before the newest an
		// earlier export held, from a watch that syncs late or a reading entered
		// by hand, and a cursor would skip them for good. Re-sending is safe:
		// the streams are mutable_state and ids hash published fields, so a
		// record already held is upserted. No tombstone is emitted, so a record
		// deleted in Health stays; an edit to a field in a record's id arrives
		// beside the old record, and an edit to a workout that leaves its type,
		// its device's maker, model and hardware, and its start, offset, end and
		// duration alone replaces it.
		const run: RunContext = { emitRecord, gaps, lanes, provenance };

		await progress(
			`Apple Health phase=emit pass=emit starting stream parse exported_at=${provenance.exported_at ?? "unknown"}`,
		);

		const { truncated } = await streamParse({
			gaps,
			path,
			// The same test an ordinary record passes before it is counted, so a
			// dropped element is judged by the same standard.
			chargeUnreadable: (kind, head): boolean =>
				chargeUnreadableElement(lanes, kind, head),
			onProgress: (rc, wc): Promise<void> =>
				progress(
					`Apple Health phase=emit pass=emit records_parsed=${rc} workouts_parsed=${wc}`,
				),
			onRecord: (el): Promise<void> => handleRecord(el, run),
			onWorkout: (el): Promise<void> => handleWorkout(el, run),
		});

		await progress(formatGapSummary(gaps));
		const newerTooLarge = resolved.newerTooLarge !== undefined;
		await emitReceipts(
			(lane) => outcomeOf(lane, truncated, newerTooLarge),
			provenance,
		);
	},
});
