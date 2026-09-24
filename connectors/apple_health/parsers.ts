// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pure parsers for the Apple Health connector, free of Node I/O so they can
// be tested alone (parsers.test.ts). The streaming reader and emitter live in
// index.ts, and finding and unpacking an upload in uploads.ts. The exception
// is scanExportXmlSummary, the upload preview's count of an export, kept
// beside the tag grammar it shares with the scanner.

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { isListedHealthType } from "./areas.ts";
import {
	MAX_TYPE_LENGTH,
	MAX_UNIT_LENGTH,
	MAX_UTC_OFFSET_MINUTES,
} from "./schemas.ts";
import type {
	AppleHealthAttrs,
	AppleHealthElement,
	AppleHealthElementGaps,
	AppleHealthGapCounts,
	AppleHealthMetadataEntry,
	AppleHealthProvenance,
	AppleHealthWorkoutEvent,
	AppleHealthWorkoutStatistics,
	HealthRecordOut,
	WorkoutRecordOut,
} from "./types.ts";

// ─── Module-scoped regexes (Biome useTopLevelRegex) ────────────────────

// The tags the streaming scanners (nextTag below) track: the open tags of
// Record and Workout and of their children (MetadataEntry, WorkoutEvent,
// WorkoutStatistics), the close tags that end a Record or Workout, and
// </HealthData>, without which a file is incomplete. WorkoutActivity (iOS 16
// and later) is matched open and closed only so the scanner knows when it is
// inside one; WorkoutRoute only open, so a GPS route is counted once and its
// Location children are never read. Names are listed longest first, since
// alternation takes the first match: "Workout" would otherwise shadow
// "WorkoutStatistics" and "WorkoutEvent" and lose those elements.
//
// Attributes are matched as well-formed pairs only, `key="value"` or
// `key='value'`, with any whitespace XML allows around the `=`, so a tag's
// end depends on quote structure and not on what a value holds: Apple's units
// hold `/` (`count/min`, `mL/min·kg`), and an attribute span of `[^/>]*`
// would fail to match, and so drop, every Record carrying one. A close tag
// may hold whitespace before its `>`.
//
// The pairs are matched at most 64 at a time. The regex engine keeps a
// backtracking entry per repetition of a group, so one unbounded repetition
// would exhaust the stack on an element with a million or so attributes and
// end the run with no receipt. nextTag reads on through
// APPLE_HEALTH_MORE_ATTRS_RE only for an element with more than 64.
const APPLE_HEALTH_TAG_RE =
	/<(?:(WorkoutStatistics|WorkoutActivity|WorkoutEvent|MetadataEntry|WorkoutRoute|Workout|Record)((?:\s+[\w:-]+\s*=\s*(?:"[^"]*"|'[^']*')){0,64})(?:\s*(\/?)>)?|\/(WorkoutActivity|HealthData|Workout|Record)\s*>)/g;
const APPLE_HEALTH_MORE_ATTRS_RE =
	/(?:\s+[\w:-]+\s*=\s*(?:"[^"]*"|'[^']*')){1,64}/y;
const APPLE_HEALTH_TAG_END_RE = /\s*(\/?)>/y;
const APPLE_HEALTH_ATTR_RE = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const XML_ENTITY_RE = /&(lt|gt|amp|quot|apos|#x[0-9a-fA-F]+|#\d+);/g;
const APPLE_HEALTH_TYPE_PREFIX_RE =
	/^HKQuantityTypeIdentifier|^HKCategoryTypeIdentifier|^HKDataType/;
const APPLE_HEALTH_WORKOUT_PREFIX_RE = /^HKWorkoutActivityType/;
// Trailing UTC offset on an Apple Health timestamp: "2024-06-05 13:45:22 -0700".
const APPLE_HEALTH_TZ_OFFSET_RE = /([+-])(\d{2}):?(\d{2})\s*$/;
// The leading run of well-formed attributes of a pending tail, in the tag
// regex's own grammar, so a dropped element can be range-checked, and a
// Record assigned to its area's stream, before it is charged to a receipt.
// It is read pair by pair (sniffLeadingAttrs), so text inside a value is
// never taken for an attribute, and it stops at the first thing the scanner
// would not accept: a startDate or type beyond that point, or past
// LEADING_ATTRS_SNIFF_BYTES, is not found, and the drop counts as in scope.
// The byte bound also bounds this pattern's repetition.
const APPLE_HEALTH_LEADING_ATTRS_RE =
	/^<[\w:-]+((?:\s+[\w:-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)/;
const LEADING_ATTRS_SNIFF_BYTES = 8192;
// The element kind at the head of a pending tail the scanner is about to
// drop as oversized. Longest-name-first for the same reason as the tag
// regex, with a lookahead so "Workout" cannot match "WorkoutEvent".
export const APPLE_HEALTH_PENDING_TAG_RE =
	/^<(WorkoutStatistics|WorkoutActivity|WorkoutEvent|MetadataEntry|WorkoutRoute|Workout|Record)(?=[\s/>])/;
const APPLE_HEALTH_WORKOUT_EVENT_PREFIX_RE = /^HKWorkoutEventType/;
// Apple's HKDevice description, whole: `<<HKDevice: 0x…>, name:…, …>`,
// its fields captured, ending at its own closing `>` with nothing after it.
const HKDEVICE_RE = /^<<HKDevice: 0x[0-9A-Fa-f]+>((?:, [\s\S]*)?)>$/;
// A `, key:` boundary in that description. Keys are words, `creation date`
// among them, so a key is any run of letters and spaces.
const HKDEVICE_FIELD_RE = /, ([A-Za-z][A-Za-z ]*):/g;

// Bound nested-child accumulation per element so one pathological export
// (e.g. thousands of MetadataEntry on a single Workout) cannot balloon
// memory — the streaming design must survive a 500MB export.
export const MAX_TRACKED_CHILDREN_PER_ELEMENT = 500;

/**
 * Ceiling on the unparsed tail a scan holds between chunks, which in a
 * well-formed export is one partial element. Generous, since a third-party
 * writer may put a very large value in a MetadataEntry, and a ceiling that
 * rejects a genuine export costs more than the memory it saves; it still
 * bounds a document that never closes an element.
 */
export const MAX_PENDING_TAG_BYTES = 16 * 1_048_576;

const EMPTY_BYTES = Buffer.alloc(0);
const LT_BYTE = 0x3c;
const GT_BYTE = 0x3e;
const SLASH_BYTE = 0x2f;

/**
 * What a streaming scan has read and not yet finished with, for both
 * scanners (streamParse in index.ts, scanExportXmlSummary below). Held as
 * bytes and decoded only when scanned: appended to a string chunk by chunk,
 * an element spanning many chunks would be held as that many strings,
 * several times its size in heap.
 *
 * A scan is due once a '>' has arrived since the last one, as no tag ends
 * without one, and what is held has doubled since that scan left some; or
 * once it passes MAX_PENDING_TAG_BYTES. An element growing over many chunks
 * is then scanned about twice its length in all, where a scan per chunk would
 * cost time in the square of its length. A '<' is one byte in UTF-8 and no
 * byte of a longer character, so the bytes from the last '<' decode to the
 * text from it, and a character cut by a chunk boundary decodes whole later.
 */
export class ScanBuffer {
	/** Bytes held. */
	bytes = 0;
	/** Whether a '>' has been read since the last scan. */
	private closed = false;
	private parts: Buffer[] = [];
	/** Bytes the last scan left for the next. */
	private unread = 0;

	/** Hold a chunk. Returns whether a scan is due. */
	push(chunk: Buffer): boolean {
		this.parts.push(chunk);
		this.bytes += chunk.length;
		this.closed ||= chunk.includes(GT_BYTE);
		return (
			(this.closed && this.bytes >= 2 * this.unread) ||
			this.bytes > MAX_PENDING_TAG_BYTES
		);
	}

	/** Everything held, decoded, for a scan. */
	text(): string {
		const whole = Buffer.concat(this.parts, this.bytes);
		this.parts = [whole];
		return whole.toString("utf8");
	}

	/**
	 * After a scan of `text` (the last text()) read tags up to `at`, keep only
	 * what a later scan can need: from the last '<', unless a tag already read
	 * holds it.
	 */
	keep(text: string, at: number): void {
		const whole = this.parts[0] ?? EMPTY_BYTES;
		const kept =
			text.lastIndexOf("<") < at
				? EMPTY_BYTES
				: Buffer.from(whole.subarray(whole.lastIndexOf(LT_BYTE)));
		this.parts = [kept];
		this.bytes = kept.length;
		this.unread = kept.length;
		this.closed = false;
	}

	/** Let go of everything held. */
	clear(): void {
		this.parts = [];
		this.bytes = 0;
		this.unread = 0;
		this.closed = false;
	}

	/** The start of what is held, decoded: enough to tell what element it is. */
	head(): string {
		return Buffer.concat(
			this.parts,
			Math.min(this.bytes, LEADING_ATTRS_SNIFF_BYTES),
		).toString("utf8");
	}

	/** Whether what is held includes a '>'. */
	hasClose(): boolean {
		return this.parts.some((part) => part.includes(">"));
	}

	/** Whether what is held ends with a '/'. */
	endsWithSlash(): boolean {
		return (
			this.parts.findLast((part) => part.length > 0)?.at(-1) === SLASH_BYTE
		);
	}
}

// Record ID length (hex). 24 chars = 96 bits of entropy — safe for a user's
// personal health-event set.
const RECORD_ID_HASH_LENGTH = 24;

// ─── Small pure helpers ────────────────────────────────────────────────

/**
 * A copy of `s` that shares no memory with the text it was cut from. V8 can
 * represent a substring as a view of the string it came from, so a short
 * value kept after the scan has moved on, such as a tally's names or a
 * workout's statistics, would otherwise keep a scan buffer of up to
 * MAX_PENDING_TAG_BYTES alive with it.
 */
export function detached(s: string): string {
	return Buffer.from(s, "utf8").toString("utf8");
}

/**
 * An element's attribute values as copies detached from the scan buffer, for
 * a Record or Workout held open while its children are read, which may take
 * many chunks. Attribute names need no copy: an object's property names are
 * held as strings of their own.
 */
export function detachedAttrs(attrs: AppleHealthAttrs): AppleHealthAttrs {
	const held: AppleHealthAttrs = {};
	for (const [key, value] of Object.entries(attrs)) {
		held[key] = value === undefined ? undefined : detached(value);
	}
	return held;
}

/**
 * The one metadata entry a record keeps until it closes (see
 * extractWasUserEntered), with its value detached from the scan buffer.
 */
export function wasUserEnteredEntry(
	value: string | undefined,
): AppleHealthMetadataEntry {
	return { key: "HKWasUserEntered", value: detached(value ?? "") };
}

/**
 * A published string held until its element closes: detached, and cut one
 * character past `max`, the longest its schema accepts. It then holds at
 * most that much memory, and a value the schema rejects for its length is
 * still rejected.
 */
function heldForSchema(s: string, max: number): string {
	return detached(s.slice(0, max + 1));
}

/**
 * Name a published field on an element's gaps, once. An element can carry
 * any number of children that fail the same way, so a list with an entry per
 * failure would grow with the export rather than with the fields.
 */
export function noteField(
	pending: AppleHealthElementGaps,
	field: string,
): void {
	if (!pending.fields.includes(field)) {
		pending.fields.push(field);
	}
}

/**
 * The fields of Apple's device description that are published, in the order
 * they are published. They describe the hardware: what made it, what it is,
 * and which firmware and software it ran.
 */
const PUBLISHED_DEVICE_FIELDS = [
	"manufacturer",
	"model",
	"hardware",
	"firmware",
	"software",
] as const;
const PUBLISHED_DEVICE_FIELD_SET: ReadonlySet<string> = new Set(
	PUBLISHED_DEVICE_FIELDS,
);
/**
 * The published device fields a record's identity includes. Firmware and
 * software are left out: an export that states a device's current versions
 * rather than those it ran when it recorded would otherwise give every
 * reading from it a new id after each update.
 */
const IDENTITY_DEVICE_FIELDS = ["manufacturer", "model", "hardware"] as const;

/** A device description as published, and the part of it that identity includes. */
export interface NormalisedDevice {
	readonly identity: string | null;
	readonly published: string | null;
}

const NO_DEVICE: NormalisedDevice = { identity: null, published: null };

/**
 * The published `device`: the hardware fields of the export's HKDevice
 * description as `key:value` pairs in PUBLISHED_DEVICE_FIELDS order, or null
 * when it has none; and its identity, the IDENTITY_DEVICE_FIELDS among them.
 *
 * Apple writes `<<HKDevice: 0x…>, name:…, manufacturer:…, model:…,
 * hardware:…, firmware:…, software:…, localIdentifier:…,
 * UDIDeviceIdentifier:…>`. The rest is left out: `0x…` is an in-memory
 * address that differs between exports of one reading, and in an id would
 * give the whole history a new id per export; `name` may be a name a person
 * gave the device; the two identifiers identify the device itself.
 *
 * Fields are split at `, key:` boundaries and Apple does not escape values,
 * so a name holding `, model:` could pass as a model. A description in which
 * a published key appears twice, or that is not a whole HKDevice description
 * closed by its own `>`, is not published, and `device` is named among the
 * element's gaps. A key never published may repeat.
 */
export function normaliseDevice(
	raw: string | undefined,
	pending: AppleHealthElementGaps,
): NormalisedDevice {
	if (!raw) {
		return NO_DEVICE;
	}
	const body = HKDEVICE_RE.exec(raw)?.[1];
	if (body === undefined) {
		noteField(pending, "device");
		return NO_DEVICE;
	}
	const fields = new Map<string, string>();
	const re = new RegExp(HKDEVICE_FIELD_RE.source, "g");
	const marks = [...body.matchAll(re)];
	for (const [index, mark] of marks.entries()) {
		const key = mark[1] ?? "";
		if (!PUBLISHED_DEVICE_FIELD_SET.has(key)) {
			continue;
		}
		if (fields.has(key)) {
			noteField(pending, "device");
			return NO_DEVICE;
		}
		const start = (mark.index ?? 0) + mark[0].length;
		const end = marks[index + 1]?.index ?? body.length;
		fields.set(key, body.slice(start, end).trim());
	}
	const describe = (keys: readonly string[]): string | null =>
		keys
			.filter((key) => fields.get(key))
			.map((key) => `${key}:${fields.get(key)}`)
			.join(", ") || null;
	return {
		identity: describe(IDENTITY_DEVICE_FIELDS),
		published: describe(PUBLISHED_DEVICE_FIELDS),
	};
}

/**
 * The startDate and type of an element the scanner could not read, taken raw
 * from the leading run of well-formed attributes in its first
 * LEADING_ATTRS_SNIFF_BYTES only. Either is undefined when it is not there:
 * an unknown start counts as inside the window, and an unknown type as one
 * the area table does not list, which belongs to `other`.
 */
export function sniffLeadingAttrs(head: string): {
	startDate: string | undefined;
	type: string | undefined;
} {
	const found: { startDate: string | undefined; type: string | undefined } = {
		startDate: undefined,
		type: undefined,
	};
	const leading =
		APPLE_HEALTH_LEADING_ATTRS_RE.exec(
			head.slice(0, LEADING_ATTRS_SNIFF_BYTES),
		)?.[1] ?? "";
	for (const [, key, double, single] of leading.matchAll(
		APPLE_HEALTH_ATTR_RE,
	)) {
		if (key === "startDate" || key === "type") {
			found[key] ??= double ?? single;
		}
	}
	return found;
}

/** The first 96 bits of the SHA-256 of `s`, as 24 hex characters. */
export function hashId(s: string): string {
	return createHash("sha256")
		.update(s)
		.digest()
		.subarray(0, RECORD_ID_HASH_LENGTH / 2)
		.toString("hex");
}

// Attribute values are XML text: real exports carry entity-escaped `<`,
// `>`, `&`, `"`, `'` (e.g. a device string embedding a Swift description
// like "<<HKDevice: ...>>", or a Withings deep-link URL with `&` between
// query params). Decoding here — the one place every attribute value
// passes through — means every downstream consumer sees the real
// character, not its escaped form.
//
// Null when a numeric reference names no XML character (the XML 1.0 Char
// production): String.fromCodePoint throws above U+10FFFF, which would end
// the run with no receipt, and a surrogate or control character would
// publish a string that is not text.
function decodeXmlEntities(s: string): string | null {
	let readable = true;
	const decoded = s.replace(XML_ENTITY_RE, (_entity, name: string) => {
		switch (name) {
			case "lt":
				return "<";
			case "gt":
				return ">";
			case "amp":
				return "&";
			case "quot":
				return '"';
			case "apos":
				return "'";
			default: {
				const codePoint = name.startsWith("#x")
					? Number.parseInt(name.slice(2), 16)
					: Number.parseInt(name.slice(1), 10);
				if (!isXmlChar(codePoint)) {
					readable = false;
					return "";
				}
				return String.fromCodePoint(codePoint);
			}
		}
	});
	return readable ? decoded : null;
}

function isXmlChar(codePoint: number): boolean {
	return (
		codePoint === 0x9 ||
		codePoint === 0xa ||
		codePoint === 0xd ||
		(codePoint >= 0x20 && codePoint <= 0xd7_ff) ||
		(codePoint >= 0xe0_00 && codePoint <= 0xff_fd) ||
		(codePoint >= 0x1_00_00 && codePoint <= 0x10_ff_ff)
	);
}

/**
 * The element's attributes, decoded. Null when they could not be read (see
 * nextTag), or when any value carries a numeric character reference that
 * names no XML character: the element is then unreadable as a whole, and the
 * caller counts it rather than publishing a record built from the attributes
 * that happened to decode. Null too if reading them throws, so one element
 * never ends the run.
 */
export function parseAttrs(tag: string | null): AppleHealthAttrs | null {
	if (tag === null) {
		return null;
	}
	try {
		const attrs: AppleHealthAttrs = {};
		const re = new RegExp(APPLE_HEALTH_ATTR_RE.source, "g");
		let m: RegExpExecArray | null = re.exec(tag);
		while (m !== null) {
			const [, key, double, single] = m;
			if (key) {
				const decoded = decodeXmlEntities(double ?? single ?? "");
				if (decoded === null) {
					return null;
				}
				attrs[key] = decoded;
			}
			m = re.exec(tag);
		}
		return attrs;
	} catch {
		return null;
	}
}

// ─── Tag scanning ───────────────────────────────────────────────────────

/** A tag the streaming scanners track, as read from their buffer. */
export interface ScannedTag {
	/** For an open tag, its attributes as written; null when they could not be read. */
	readonly attrs: string | null;
	/** For a close tag, the element it closes. */
	readonly close: string | undefined;
	/** Where the tag ends: the index in the buffer just past its `>`. */
	readonly end: number;
	/** For an open tag, the element it opens. */
	readonly open: string | undefined;
	readonly selfClosing: boolean;
}

/**
 * The first complete tag the scanners track in `buf` at or after `from`, or
 * null when there is none: the rest of `buf` then holds, at most, a tag
 * still arriving. A tag with more than 64 attributes is read on 64 at a time
 * (see APPLE_HEALTH_TAG_RE). Reading one tag should never throw; if it does,
 * that tag is returned with null attributes, which the scanners count as an
 * unreadable element, and the scan resumes at the next `<`, since a tag holds
 * none.
 */
export function nextTag(buf: string, from: number): ScannedTag | null {
	const re = APPLE_HEALTH_TAG_RE;
	re.lastIndex = from;
	for (let m = re.exec(buf); m !== null; m = re.exec(buf)) {
		const [whole, open, attrs, selfClose, close] = m;
		const headEnd = m.index + whole.length;
		if (close !== undefined) {
			return { attrs: null, close, end: headEnd, open, selfClosing: false };
		}
		if (selfClose !== undefined) {
			return {
				attrs: attrs ?? "",
				close,
				end: headEnd,
				open,
				selfClosing: selfClose === "/",
			};
		}
		let tag: ScannedTag | null;
		try {
			tag = readLongTag(buf, open, m.index + 1 + (open ?? "").length, headEnd);
		} catch {
			const next = buf.indexOf("<", headEnd);
			tag =
				next === -1
					? null
					: { attrs: null, close, end: next, open, selfClosing: true };
		}
		if (tag !== null) {
			return tag;
		}
		re.lastIndex = m.index + 1;
	}
	return null;
}

/**
 * The rest of an open tag whose first 64 attributes end at `at`: its further
 * attributes, then its `>` or `/>`. Null when no `>` follows the attributes
 * in `buf`, because the tag is still arriving or is not one.
 */
function readLongTag(
	buf: string,
	open: string | undefined,
	attrsStart: number,
	at: number,
): ScannedTag | null {
	const more = APPLE_HEALTH_MORE_ATTRS_RE;
	let attrsEnd = at;
	more.lastIndex = attrsEnd;
	while (more.test(buf)) {
		attrsEnd = more.lastIndex;
	}
	const end = APPLE_HEALTH_TAG_END_RE;
	end.lastIndex = attrsEnd;
	const closing = end.exec(buf);
	if (closing === null) {
		return null;
	}
	return {
		attrs: buf.slice(attrsStart, attrsEnd),
		close: undefined,
		end: end.lastIndex,
		open,
		selfClosing: closing[1] === "/",
	};
}

export function healthTypeShort(t: string | undefined): string | null {
	if (!t) {
		return null;
	}
	return t.replace(APPLE_HEALTH_TYPE_PREFIX_RE, "");
}

export function isoDate(v: string | undefined): string | null {
	if (!v) {
		return null;
	}
	// Apple Health dates look like "2024-06-05 13:45:22 -0700"
	const d = new Date(v);
	if (!Number.isNaN(d.getTime())) {
		return d.toISOString();
	}
	return null;
}

/**
 * Minutes east of UTC from an Apple Health timestamp's trailing offset, or
 * null when it states none. `isoDate` keeps the instant but not the wall
 * clock the owner lived in, which for health data is often the fact: a sleep
 * record at 23:00 local is not the same claim as one at 13:00 UTC.
 */
export function utcOffsetMinutes(v: string | undefined): number | null {
	if (!v) {
		return null;
	}
	const m = APPLE_HEALTH_TZ_OFFSET_RE.exec(v);
	if (!m) {
		return null;
	}
	const sign = m[1] === "-" ? -1 : 1;
	const hours = Number(m[2]);
	const minutes = Number(m[3]);
	if (!Number.isFinite(hours) || !Number.isFinite(minutes)) {
		return null;
	}
	return sign * (hours * 60 + minutes);
}

/**
 * An element's start offset as published. One beyond MAX_UTC_OFFSET_MINUTES,
 * which no time zone uses, is null and named on the element's gaps: the
 * schema would reject the whole record for it, and the reading is still
 * good without it.
 */
function startOffsetMinutes(el: AppleHealthElement): number | null {
	const offset = utcOffsetMinutes(el.attrs.startDate);
	if (offset !== null && Math.abs(offset) > MAX_UTC_OFFSET_MINUTES) {
		noteField(el.pending, "start_utc_offset_minutes");
		return null;
	}
	return offset;
}

// ─── Unit handling ──────────────────────────────────────────────────────

/**
 * Apple states units per record, and they vary by locale: an imperial export
 * carries `mi` and `Cal` where a metric one carries `km` and `kcal`. The
 * published fields are named `_minutes`, `_km` and `_kcal`, so a figure is
 * converted from the unit stated, and is null, with the gap named on the
 * receipt, when that unit is absent or unknown: a 5 mile run published as
 * 5 km would be wrong in the direction that flatters. A gap costs the field,
 * never the record.
 */
const DURATION_TO_MINUTES: Readonly<Record<string, number>> = {
	min: 1,
	sec: 1 / 60,
	s: 1 / 60,
	hr: 60,
	h: 60,
	ms: 1 / 60000,
};

const DISTANCE_TO_KM: Readonly<Record<string, number>> = {
	km: 1,
	m: 0.001,
	cm: 0.00001,
	mi: 1.609344,
	ft: 0.0003048,
	yd: 0.0009144,
};

// Apple writes dietary/active energy as "kcal"; some locales and some
// third-party writers use "Cal" (a food Calorie, i.e. one kilocalorie) or SI
// joules. "cal" lowercase is a gram-calorie, a thousandth of a kcal — the case
// distinction is real and getting it wrong is a factor-of-1000 error.
const ENERGY_TO_KCAL: Readonly<Record<string, number>> = {
	kcal: 1,
	Cal: 1,
	cal: 0.001,
	kJ: 0.239006,
	J: 0.000239006,
};

function convertQuantity(
	raw: string | undefined,
	unit: string | undefined,
	table: Readonly<Record<string, number>>,
	pending: AppleHealthElementGaps,
	field: string,
): number | null {
	// Blank is absent: Number("") and Number(" ") are both 0.
	if (raw === undefined || raw.trim() === "") {
		return null;
	}
	// Present but not a finite number: the export stated a figure that cannot
	// be read, which is a gap in the field, not an absence.
	const n = Number(raw);
	if (!Number.isFinite(n)) {
		noteField(pending, field);
		return null;
	}
	return convertNumber(n, unit, table, pending, field);
}

/** Convert a number from the unit the export states; see convertQuantity. */
function convertNumber(
	n: number,
	unit: string | null | undefined,
	table: Readonly<Record<string, number>>,
	pending: AppleHealthElementGaps,
	field: string,
): number | null {
	// The gap is named by the field it leaves null, so a marker with no
	// duration unit never disowns a distance that is fine, and it reaches a
	// receipt only if the element is emitted.
	if (!unit) {
		// No stated unit. Do not assume one: record the gap and emit null.
		pending.units.push({ field, unit: "(absent)" });
		return null;
	}
	const factor = table[unit];
	if (factor === undefined) {
		// Held until the element closes, so held as a bounded copy.
		pending.units.push({
			field,
			unit: detached(unit.slice(0, MAX_TALLIED_NAME_LENGTH)),
		});
		return null;
	}
	return n * factor;
}

// ─── Workout totals ─────────────────────────────────────────────────────

const DISTANCE_STATISTIC_RE = /^Distance/;

/** A statistic of a workout's total distance: any HealthKit distance type (DistanceWalkingRunning, DistanceSwimming, ...). */
function isDistanceStatistic(type: string | null): boolean {
	return type !== null && DISTANCE_STATISTIC_RE.test(type);
}

/** A statistic of a workout's total energy, which is active energy only. */
function isActiveEnergyStatistic(type: string | null): boolean {
	return type === "ActiveEnergyBurned";
}

/** Whether a WorkoutStatistics of this (prefix-stripped) type can feed a workout total. */
export function isTotalStatistic(type: string | null): boolean {
	return isDistanceStatistic(type) || isActiveEnergyStatistic(type);
}

/**
 * Whether a WorkoutStatistics states a sum or a unit, whatever its value, but
 * no type to tell what it measures. It may be the distance or energy a total
 * needs, so no total is summed beside it.
 */
export function isUntypedFigure(attrs: AppleHealthAttrs): boolean {
	return (
		!attrs.type?.trim() && (attrs.sum !== undefined || attrs.unit !== undefined)
	);
}

/** Whether `level` has a statistic of every type that `other` has. */
function hasEveryType(
	level: readonly AppleHealthWorkoutStatistics[],
	other: readonly AppleHealthWorkoutStatistics[],
): boolean {
	const types = new Set(level.map((s) => s.type));
	return other.every((s) => types.has(s.type));
}

/**
 * A workout's total distance or active energy.
 *
 * HealthKit deprecates the workout-level totals in favour of statistics per
 * quantity type, and from iOS 16 a workout holds activities with statistics
 * of their own:
 *   https://developer.apple.com/documentation/healthkit/hkworkout/totalenergyburned
 *   https://developer.apple.com/documentation/healthkit/hkworkout/totaldistance
 *   https://developer.apple.com/documentation/healthkit/hkworkout/allstatistics
 *   https://developer.apple.com/documentation/healthkit/hkworkout/workoutactivities
 * An older export states the totals as Workout attributes; a newer one
 * carries WorkoutStatistics under the Workout and under each WorkoutActivity.
 *
 * So: the Workout's own attribute where stated. Otherwise the sum of one
 * level's statistics of this kind, so a swim, ride and run add up: the
 * workout's own where they have every type its activities have, else the
 * activities' where they have every type the workout's own have, and no
 * total where each has a type the other lacks. Never both levels, since the
 * activities divide the workout's statistics between them.
 *
 * Every statistic summed must state a sum and a unit this connector converts,
 * and every statistic of both levels must have been kept, and have a type if
 * it states a sum or unit: one lost, or of unknown type, may be of a type the
 * other level lacks. Otherwise the total is null and the field is named on
 * the element's gaps.
 */
function workoutTotal(
	el: AppleHealthElement,
	raw: string | undefined,
	unit: string | undefined,
	isKind: (type: string | null) => boolean,
	table: Readonly<Record<string, number>>,
	field: string,
): number | null {
	if (raw !== undefined && raw.trim() !== "") {
		return convertQuantity(raw, unit, table, el.pending, field);
	}
	const p = el.pending;
	const complete =
		p.statisticsTruncated === 0 &&
		p.oversizedStatistics === 0 &&
		!el.statisticsIncomplete;
	const own = el.workoutStatistics.filter((s) => isKind(s.type));
	const fromActivities = el.activityStatistics.filter((s) => isKind(s.type));
	let statistics: AppleHealthWorkoutStatistics[] | null = null;
	if (complete && hasEveryType(own, fromActivities)) {
		statistics = own;
	} else if (complete && hasEveryType(fromActivities, own)) {
		statistics = fromActivities;
	}
	if (statistics === null) {
		noteField(p, field);
		return null;
	}
	if (statistics.length === 0) {
		return null;
	}
	let total = 0;
	for (const statistic of statistics) {
		if (statistic.sum === null) {
			noteField(p, field);
			return null;
		}
		const value = convertNumber(statistic.sum, statistic.unit, table, p, field);
		if (value === null) {
			return null;
		}
		total += value;
	}
	return total;
}

// ─── Metadata / nested-child helpers ────────────────────────────────────

/**
 * Read the one metadata key published. Any application can write arbitrary
 * keys and values into a record's metadata, so an open bag could not be
 * audited in advance. HKWasUserEntered is kept because whether a person typed
 * a reading in or a sensor recorded it changes how it should be weighed.
 * Further keys can be added one at a time: adding a property is non-breaking,
 * removing one is not.
 */
function extractWasUserEntered(
	entries: readonly { key: string; value: string }[],
): boolean | null {
	// The scanner keeps only this key, so the list holds one entry at most.
	for (const e of entries) {
		if (e.key === "HKWasUserEntered") {
			// Apple writes "1"/"0"; be tolerant of "true"/"false".
			const v = e.value.trim().toLowerCase();
			if (v === "1" || v === "true") {
				return true;
			}
			if (v === "0" || v === "false") {
				return false;
			}
			return null;
		}
	}
	return null;
}

/**
 * Build a bounded WorkoutStatistics child from its raw attribute bag.
 *
 * Only the typed quantity Apple records is kept. Unknown attributes are dropped
 * here rather than forwarded, so a third-party writer cannot put arbitrary text
 * onto a published stream. A figure stated but not a number is named on
 * `pending`, for a statistic that is published.
 */
export function buildWorkoutStatistics(
	attrs: AppleHealthAttrs,
	pending?: AppleHealthElementGaps,
): AppleHealthWorkoutStatistics {
	const num = (v: string | undefined): number | null => {
		if (v === undefined || v.trim() === "") {
			return null;
		}
		const n = Number(v);
		if (Number.isFinite(n)) {
			return n;
		}
		// Stated but not a number: a gap in the published list, not an absence.
		if (pending) {
			noteField(pending, "statistics");
		}
		return null;
	};
	// Held until the workout closes, up to MAX_TRACKED_CHILDREN_PER_ELEMENT of
	// them, so each string is held as a bounded copy.
	const type = attrs.type ? healthTypeShort(attrs.type) || attrs.type : null;
	return {
		type: type ? heldForSchema(type, MAX_TYPE_LENGTH) : null,
		unit: attrs.unit ? heldForSchema(attrs.unit, MAX_UNIT_LENGTH) : null,
		sum: num(attrs.sum),
		average: num(attrs.average),
		minimum: num(attrs.minimum),
		maximum: num(attrs.maximum),
	};
}

/**
 * Build a WorkoutEvent from its raw attrs, its duration converted from the
 * `durationUnit` stated, as a workout's is: a pause stated in seconds and
 * published as minutes would be wrong by sixty.
 */
export function buildWorkoutEvent(
	attrs: AppleHealthAttrs,
	pending: AppleHealthElementGaps,
): AppleHealthWorkoutEvent {
	// Held until the workout closes, up to MAX_TRACKED_CHILDREN_PER_ELEMENT of
	// them, so the type is held as a bounded copy, as a statistic's is.
	return {
		type: attrs.type
			? heldForSchema(
					attrs.type.replace(APPLE_HEALTH_WORKOUT_EVENT_PREFIX_RE, ""),
					MAX_TYPE_LENGTH,
				)
			: null,
		date: isoDate(attrs.date),
		duration_minutes: convertQuantity(
			attrs.duration,
			attrs.durationUnit,
			DURATION_TO_MINUTES,
			pending,
			"events",
		),
	};
}

/**
 * How many distinct names a progress-line tally names, and how much of each.
 * Every name comes from the export, so an export of a million invented types
 * or units would otherwise grow a tally without limit; occurrences of further
 * names are counted together.
 */
export const MAX_NAMED_PER_TALLY = 20;
export const MAX_TALLIED_NAME_LENGTH = 100;

/**
 * Count one occurrence of `name` in a tally of at most MAX_NAMED_PER_TALLY
 * names. Returns false, counting nothing, when the name is new and the tally
 * is full, for the caller to count among the unnamed. A new name is kept as
 * a detached copy of at most MAX_TALLIED_NAME_LENGTH characters, since it
 * outlives the scan buffer it came from.
 */
function countNamed(tally: Map<string, number>, name: string): boolean {
	const key = name.slice(0, MAX_TALLIED_NAME_LENGTH);
	const count = tally.get(key);
	if (count !== undefined) {
		tally.set(key, count + 1);
		return true;
	}
	if (tally.size >= MAX_NAMED_PER_TALLY) {
		return false;
	}
	tally.set(detached(key), 1);
	return true;
}

/**
 * Tally a delivered record whose `type` the area table (areas.ts) does not
 * list, as HealthKit's identifiers grow with each release. Such a record is
 * delivered on `other`, never dropped; this names its type on the progress
 * line, and the other stream's receipt counts the records.
 */
export function tallyUnrecognizedType(
	type: string | undefined,
	gaps: AppleHealthGapCounts,
): void {
	if (!type || isListedHealthType(type)) {
		return;
	}
	if (!countNamed(gaps.unrecognizedRecordTypes, type)) {
		gaps.unrecognizedRecordsUnnamed += 1;
	}
}

/**
 * Tally, for the progress line, a unit that left a quantity on a DELIVERED
 * record null: absent, or one this connector cannot convert. Bounded like
 * the unrecognised-type tally.
 */
export function tallyUnconvertibleUnit(
	unit: string,
	gaps: AppleHealthGapCounts,
): void {
	if (!countNamed(gaps.unrecognizedUnits, unit)) {
		gaps.unrecognizedUnitsUnnamed += 1;
	}
}

export function newElementGaps(): AppleHealthElementGaps {
	return {
		eventsTruncated: 0,
		fields: [],
		oversizedEvents: 0,
		oversizedMetadata: 0,
		oversizedStatistics: 0,
		statisticsTruncated: 0,
		units: [],
	};
}

export function newGapCounts(): AppleHealthGapCounts {
	return {
		unrecognizedRecordTypes: new Map(),
		unrecognizedRecordsUnnamed: 0,
		unrecognizedUnits: new Map(),
		unrecognizedUnitsUnnamed: 0,
		recordsMissingStartDate: 0,
		workoutsMissingStartDate: 0,
		workoutRoutesUncaptured: 0,
		duplicatesDiscarded: 0,
		emptyValues: 0,
		malformedElementsSkipped: 0,
		oversizedRecordsSkipped: 0,
		oversizedWorkoutsSkipped: 0,
		oversizedRecordMetadataSkipped: 0,
		oversizedWorkoutEventsSkipped: 0,
		oversizedWorkoutStatisticsSkipped: 0,
		oversizedOtherSkipped: 0,
		oversizedOutOfScopeSkipped: 0,
		workoutEventsTruncated: 0,
		workoutStatisticsTruncated: 0,
	};
}

// ─── Record / workout builders ─────────────────────────────────────────

/**
 * Build a health-area record (for whichever stream areas.ts assigns its type
 * to) from a parsed HKRecord element (attrs + any nested MetadataEntry
 * children). Returns null when startDate is missing or unparseable; index.ts
 * counts that in `gaps` rather than dropping it silently, since Apple Health
 * emits some records without a usable timestamp (e.g. metadata rows).
 */
export function buildHealthRecord(
	el: AppleHealthElement,
	gaps: AppleHealthGapCounts,
	provenance: AppleHealthProvenance,
): HealthRecordOut | null {
	const { attrs } = el;
	const startDate = isoDate(attrs.startDate);
	if (!startDate) {
		gaps.recordsMissingStartDate += 1;
		return null;
	}
	const type = healthTypeShort(attrs.type) || attrs.type || "Unknown";
	// A blank value attribute is absent, not zero. Number("") is 0, so passing
	// it through would publish a plausible reading of 0 for a value the export
	// left empty. It is recorded as a gap in `value` instead, the way an absent
	// unit is recorded as a gap in `unit`.
	const blank = attrs.value !== undefined && attrs.value.trim() === "";
	if (blank) {
		noteField(el.pending, "value");
	}
	const rawValue = blank ? undefined : attrs.value;
	const value = rawValue === undefined ? null : Number(rawValue);
	const finite = value !== null && Number.isFinite(value);
	const endDate = isoDate(attrs.endDate);
	// A quantity with a number and no unit gives a reader no way to tell mg/dL
	// from mmol/L, so the gap is charged to `unit`; record units are carried
	// verbatim, never converted.
	if (finite && !attrs.unit) {
		el.pending.units.push({ field: "unit", unit: "(absent)" });
	}
	const device = normaliseDevice(attrs.device, el.pending);
	const published = {
		type,
		device: device.published,
		// The export's own unit attribute, verbatim. Never inferred, and never
		// converted: unlike a workout total there is no canonical unit per record
		// type to convert toward.
		unit: attrs.unit || null,
		value: finite && value !== null ? value : null,
		value_raw: !finite && rawValue ? rawValue : null,
		was_user_entered: extractWasUserEntered(el.metadata),
		start_date: startDate,
		start_utc_offset_minutes: startOffsetMinutes(el),
		end_date: endDate,
		creation_date: isoDate(attrs.creationDate),
		freshness: "snapshot" as const,
		exported_at: provenance.exported_at,
	};
	// Identity is the record's published content: every published scalar, read
	// back from the object that is emitted, with the device represented by its
	// maker, model and hardware (IDENTITY_DEVICE_FIELDS). A description that is
	// absent or cannot be read is null here, so readings that differ only in
	// such descriptions share an id, and two physical devices with the same
	// maker, model and hardware are one device: telling them apart would take
	// the identifier that is withheld. The manifest says both.
	//
	// creation_date is in: without it, two readings a person entered
	// separately, which Health shows as two, would be one. The offset is in
	// because the local wall clock is often the fact itself.
	//
	// Published values only. With a withheld field such as sourceName in the
	// hash and every other input published, a reader could test candidate
	// names against the id. The normalised number is hashed, so value="1" and
	// value="1.0" are one reading. JSON rather than a delimiter, so no value
	// can move a boundary: model "D|E" with unit "U" and model "D" with unit
	// "E|U" would otherwise give one id to two readings.
	const id = hashId(
		JSON.stringify([
			published.type,
			device.identity,
			published.unit,
			published.start_date,
			published.start_utc_offset_minutes,
			published.end_date,
			published.creation_date,
			published.value,
			published.value_raw,
			published.was_user_entered,
		]),
	);
	return { id, ...published };
}

/**
 * Build a single `workouts`-stream record from a parsed HKWorkout element
 * (attrs + nested MetadataEntry/WorkoutEvent/WorkoutStatistics children).
 * Returns null when startDate is missing or unparseable.
 */
export function buildWorkoutRecord(
	el: AppleHealthElement,
	gaps: AppleHealthGapCounts,
	provenance: AppleHealthProvenance,
): WorkoutRecordOut | null {
	const { attrs } = el;
	const startDate = isoDate(attrs.startDate);
	if (!startDate) {
		gaps.workoutsMissingStartDate += 1;
		return null;
	}
	const endDate = isoDate(attrs.endDate);
	const device = normaliseDevice(attrs.device, el.pending);
	const published = {
		workout_activity_type: attrs.workoutActivityType
			? attrs.workoutActivityType.replace(APPLE_HEALTH_WORKOUT_PREFIX_RE, "")
			: null,
		device: device.published,
		// Bounded at attach time in index.ts, with a tally per kind; nothing is
		// sliced here.
		events: el.workoutEvents.length > 0 ? el.workoutEvents : null,
		statistics: el.workoutStatistics.length > 0 ? el.workoutStatistics : null,
		// Each quantity is converted FROM the unit the export states; the raw
		// number under a field named for a unit nobody checked would report
		// miles as kilometres on an imperial export. An unrecognised or absent
		// unit yields null and a tally entry rather than a plausible wrong
		// number.
		duration_minutes: convertQuantity(
			attrs.duration,
			attrs.durationUnit,
			DURATION_TO_MINUTES,
			el.pending,
			"duration_minutes",
		),
		// From the workout's own attributes on an older export, and from its
		// statistics on a newer one (see workoutTotal).
		total_energy_burned_kcal: workoutTotal(
			el,
			attrs.totalEnergyBurned,
			attrs.totalEnergyBurnedUnit,
			isActiveEnergyStatistic,
			ENERGY_TO_KCAL,
			"total_energy_burned_kcal",
		),
		total_distance_km: workoutTotal(
			el,
			attrs.totalDistance,
			attrs.totalDistanceUnit,
			isDistanceStatistic,
			DISTANCE_TO_KM,
			"total_distance_km",
		),
		start_date: startDate,
		start_utc_offset_minutes: startOffsetMinutes(el),
		end_date: endDate,
		freshness: "snapshot" as const,
		exported_at: provenance.exported_at,
	};
	// As on records: published values only, the device by its maker, model and
	// hardware, the offset included, serialised as JSON. The duration is
	// hashed as converted, or duration="1" min and duration="1" h would be one
	// workout. End date and duration separate back-to-back intervals of one
	// type on one device, such as a swim set, that would otherwise share a
	// start.
	//
	// Distance and energy are left out. Apple states them differently between
	// exports, as the workout's attributes on older ones and as statistics of
	// the workout or its activities on newer ones (see workoutTotal), each
	// giving a slightly different figure or none; in the id, an unchanged
	// workout would take a new id per representation, and a reader, never
	// sent a deletion, would keep every copy. The events and statistics lists
	// are left out as detail rather than identity: in the id, their order
	// would matter, and a workout that gained a marker past the cap of 500
	// would change identity without changing.
	const id = hashId(
		JSON.stringify([
			published.workout_activity_type,
			device.identity,
			published.start_date,
			published.start_utc_offset_minutes,
			published.end_date,
			published.duration_minutes,
		]),
	);
	return { id, ...published };
}

// ─── Manual-upload validation summary scan ─────────────────────────────

const SCAN_READ_BUFFER_SIZE = 65_536;
const HEALTH_DATA_ROOT_RE = /<HealthData[\s/>]/;
// How far the summary scan reads looking for the <HealthData root before
// giving up, so a large wrong file is not scanned to its end. The upload
// preview judges an upload by its root element first (uploads.ts); this is
// the scan's own backstop.
const ROOT_SNIFF_WINDOW_BYTES = 1024 * 1024;

export interface ExportXmlSummary {
	readonly earliestStartDate: string | null;
	readonly latestStartDate: string | null;
	readonly looksLikeHealthExport: boolean;
	readonly recordCount: number;
	readonly workoutCount: number;
}

/** Mutable accumulator threaded through one scanExportXmlSummary pass. */
interface SummaryScanState {
	earliestStartDate: string | null;
	latestStartDate: string | null;
	looksLikeHealthExport: boolean;
	recordCount: number;
	sniffedBytes: number;
	workoutCount: number;
}

function recordStartDateBounds(
	state: SummaryScanState,
	startDate: string,
): void {
	if (!state.earliestStartDate || startDate < state.earliestStartDate) {
		state.earliestStartDate = startDate;
	}
	if (!state.latestStartDate || startDate > state.latestStartDate) {
		state.latestStartDate = startDate;
	}
}

/**
 * Count a Record or Workout on its open tag only, once per element whether
 * or not it is self-closing, as index.ts's handleTopLevelOpenTag does;
 * counting its close tag too would count an element with children twice.
 */
function applyTagMatch(state: SummaryScanState, tag: ScannedTag): void {
	const openTag = tag.open;
	if (!(openTag === "Record" || openTag === "Workout")) {
		return;
	}
	// An unreadable element is still an element: the preview counts it and
	// takes no date from it.
	const attrs = parseAttrs(tag.attrs) ?? {};
	const startDate = isoDate(attrs.startDate);
	if (openTag === "Record") {
		state.recordCount += 1;
	} else {
		state.workoutCount += 1;
	}
	if (startDate) {
		recordStartDateBounds(state, startDate);
	}
}

/** Count every tag nextTag finds in `text`; returns where the last one ends. */
function scanTagMatches(state: SummaryScanState, text: string): number {
	let at = 0;
	for (let tag = nextTag(text, at); tag !== null; tag = nextTag(text, at)) {
		applyTagMatch(state, tag);
		at = tag.end;
	}
	return at;
}

/**
 * Stream-scan an export XML for the upload preview: counts and a date range
 * only, never a record, with streamParse's tag scanner, chunk size and
 * ScanBuffer, so memory stays bounded whatever the export's size.
 */
export async function scanExportXmlSummary(
	path: string,
): Promise<ExportXmlSummary> {
	const stream = createReadStream(path, {
		highWaterMark: SCAN_READ_BUFFER_SIZE,
	});
	const state: SummaryScanState = {
		earliestStartDate: null,
		latestStartDate: null,
		looksLikeHealthExport: false,
		recordCount: 0,
		sniffedBytes: 0,
		workoutCount: 0,
	};
	const pending = new ScanBuffer();
	const scan = (): void => {
		const text = pending.text();
		// Held to the import scanner's bound (streamParse in index.ts): only
		// from the last '<', and nothing of an element still open past
		// MAX_PENDING_TAG_BYTES, which is then left uncounted. Otherwise a long
		// run the tag pattern never matches, such as a GPS route's locations,
		// would be held whole.
		pending.keep(text, scanTagMatches(state, text));
		if (!state.looksLikeHealthExport && HEALTH_DATA_ROOT_RE.test(text)) {
			state.looksLikeHealthExport = true;
		}
	};

	for await (const chunk of stream as AsyncIterable<Buffer>) {
		const due = pending.push(chunk);
		if (state.looksLikeHealthExport && !due) {
			continue;
		}
		scan();
		if (pending.bytes > MAX_PENDING_TAG_BYTES) {
			pending.clear();
		}
		if (!state.looksLikeHealthExport) {
			state.sniffedBytes += chunk.length;
			if (state.sniffedBytes > ROOT_SNIFF_WINDOW_BYTES) {
				// Never found <HealthData within the sniff window -- stop reading
				// early rather than scanning a large unsupported file to its end.
				stream.destroy();
				break;
			}
		}
	}
	scan();

	const {
		earliestStartDate,
		latestStartDate,
		looksLikeHealthExport,
		recordCount,
		workoutCount,
	} = state;
	return {
		earliestStartDate,
		latestStartDate,
		looksLikeHealthExport,
		recordCount,
		workoutCount,
	};
}
