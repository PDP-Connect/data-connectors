// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Finding the owner's Fitbit export from Google Takeout, checking every ZIP
 * part of it, and taking the members this connector reads out of it one at a
 * time.
 *
 * WHICH UPLOAD. Takeout names each part `takeout-<stamp>-<n>-<part>.zip`, the
 * stamp being when the export was made, in UTC and fixed width, so it sorts as
 * text. Every part under the newest stamp belongs to one export, and all of
 * them are read. Never the newest file by modification time: an upload host
 * can stage every file with the same time, and a folder can hold unrelated
 * ZIPs. Within each middle number the part numbers must run 1, 2, …, k, so a
 * missing first or middle part is refused; a missing last part cannot be
 * seen. Only when no file carries a Takeout name is the newest `.zip` by
 * modification time taken, the name breaking ties.
 *
 * WHAT IS OPENED. Only members that sit directly in one `Global Export Data/`
 * folder and whose basename matches a family below, and the
 * `Sleep Score/sleep_score.csv` and `Your Profile/Profile.csv` beside that
 * folder. The folder is found by its own name wherever it sits, because the
 * folder above it has been `Takeout/Fitbit/` and `Takeout/Google Health/`, and
 * an owner who zips an export again may drop `Takeout/`. The Google-era
 * `*_GoogleData` folders are never read and their member names are never
 * kept; whether they exist is noted only to tell a changed layout from an
 * upload that is not a Fitbit export.
 *
 * ONE EXPORT, SEVERAL PARTS. A family's members can sit in any part, so the
 * parts' listings are merged into one namespace, and one refused part refuses
 * the whole upload. A file this import reads that appears in two parts of one
 * middle number is read from neither: the two copies cannot both be right. In
 * two middle numbers, the upload is refused: two groups that share a file are
 * more likely two copies of one export than two halves of it.
 *
 * MEMBER NAMES STAY HERE. Member and upload names are handed to `fs` and the
 * shared zip reader and nowhere else, and a member is extracted under a
 * numbered scratch name. Errors are reported by `error.code` alone: `fs`
 * messages carry paths, and some of the zip reader's messages quote entry
 * names.
 *
 * NO ZIP64. The shared reader reads classic zip fields only. A part past the
 * 4 GiB address limit, or one whose end record carries ZIP64 sentinels (as a
 * part of 65,535 entries or more must), would list as empty or short, which
 * would tell the owner their export holds nothing. Both are refused as too
 * large before listing; Takeout's 2 GB parts are classic zips. A writer that
 * switches to ZIP64 part-way leaves a part that lists, but whose members
 * stored past the switch cannot be found. No known writer switches before
 * 2 GiB, so a member not found in a part over 2 GiB with ZIP64 records is
 * taken as too large, and one not found anywhere else as damaged. A damaged
 * member in such a part is taken as too large too: the two look the same.
 */

import {
	type Dirent,
	readdirSync,
	readSync,
	realpathSync,
	rmSync,
	statSync,
} from "node:fs";
import { join } from "node:path";
import {
	hasZipLocalFileSignature,
	readZipEntriesFromFile,
	streamZipEntryToFile,
	ZipPolicyViolationError,
	type ZipReadPolicy,
	zipBasename,
} from "../../packages/polyfill-connectors/src/bounded-zip-archive.ts";
import { compareText, takeoutStamp } from "./parsers.ts";
import { DATA_STREAMS, type DataStream, ISO_DT_RE } from "./schemas.ts";

/** Classic-zip address limit: the shared reader has no ZIP64 support. */
export const ZIP_ADDRESS_LIMIT = 0xff_ff_ff_ff;

/**
 * One policy per part. Its declared-size checks cover every entry in the part, including
 * the many Takeout files this import never opens, so the per-entry and total limits are
 * sized for a whole part; the per-member caps below are the limits on what is extracted.
 */
const FITBIT_ZIP_POLICY: ZipReadPolicy = {
	// The classic format's ceiling. A dense 12-year Fitbit export has about 33,000
	// files in all, fewer in any one part.
	maxEntries: 65_535,
	// Every classic entry passes; the ZIP64 size sentinel 0xFFFFFFFF fails as entry_too_large.
	maxEntryUncompressedBytes: 0xff_ff_ff_fe,
	// Declared, not inflated: text compresses well, so a 4 GiB part can declare far more.
	maxTotalUncompressedBytes: 64 * 1024 ** 3,
};

/** A JSON member other than steps or distance; real legacy members are a few MB at most. */
export const MEMBER_MAX_BYTES = 256 * 1024 * 1024;
/**
 * A steps or distance member: a 31-day batch of every minute is about 3 MB
 * pretty-printed. The cap also bounds the minute dedupe window: at 44 bytes a
 * minified row, at most about 381,000 minutes a member.
 */
export const MINUTE_MEMBER_MAX_BYTES = 16 * 1024 * 1024;
/** One row a night: 80,000 nights at 100 bytes. */
export const SLEEP_SCORE_MAX_BYTES = 8 * 1024 * 1024;
/** One header and one row. */
export const PROFILE_MAX_BYTES = 64 * 1024;
/** Parts of one export. At Takeout's 2 GB split, 128 GB. */
export const MAX_PARTS = 64;

/**
 * The largest a member may be and still legitimately yield no value (`[]` is
 * 2 bytes). A bigger member that yields none has a layout this connector does
 * not recognise.
 */
export const EMPTY_MEMBER_MAX_BYTES = 64;

/** The legacy families, in the order the streams read them. */
export const FAMILY_KEYS = [
	"exercise",
	"sleep",
	"steps",
	"distance",
	"lightly_active_minutes",
	"moderately_active_minutes",
	"very_active_minutes",
	"resting_heart_rate",
] as const;
export type FamilyKey = (typeof FAMILY_KEYS)[number];
/** Everything this import extracts: the families, the score file and the profile. */
export type MemberKind = FamilyKey | "sleep_score" | "profile";

/** The legacy families each stream reads, in reading order. */
export const STREAM_FAMILIES: Readonly<
	Record<DataStream, readonly FamilyKey[]>
> = {
	activities: ["exercise"],
	daily_summaries: [
		"steps",
		"distance",
		"lightly_active_minutes",
		"moderately_active_minutes",
		"very_active_minutes",
		"resting_heart_rate",
	],
	sleep: ["sleep"],
};

/**
 * Each family's member basename, matched only for a direct child of
 * `Global Export Data/`. Group 1 is the number in the name: the page number
 * for exercise, the date its batch starts for the others. Case-sensitive,
 * `.json` required and anchored at both ends, so `sedentary_minutes-`,
 * `heart_rate-`, `time_in_heart_rate_zones-`, a README and a copy named
 * `steps-….json.bak` all fail.
 */
const FAMILIES: Readonly<Record<FamilyKey, RegExp>> = {
	exercise: /^exercise-(\d{1,9})\.json$/,
	sleep: /^sleep-(\d{4}-\d{2}-\d{2})\.json$/,
	steps: /^steps-(\d{4}-\d{2}-\d{2})\.json$/,
	distance: /^distance-(\d{4}-\d{2}-\d{2})\.json$/,
	lightly_active_minutes: /^lightly_active_minutes-(\d{4}-\d{2}-\d{2})\.json$/,
	moderately_active_minutes:
		/^moderately_active_minutes-(\d{4}-\d{2}-\d{2})\.json$/,
	very_active_minutes: /^very_active_minutes-(\d{4}-\d{2}-\d{2})\.json$/,
	resting_heart_rate: /^resting_heart_rate-(\d{4}-\d{2}-\d{2})\.json$/,
};

// Group 1 of each is the root: everything before the anchored folder, "" at the top.
const LEGACY_MEMBER_RE = /^((?:.*\/)?)Global Export Data\/([^/]+)$/;
const SLEEP_SCORE_RE = /^((?:.*\/)?)Sleep Score\/sleep_score\.csv$/;
const PROFILE_RE = /^((?:.*\/)?)Your Profile\/Profile\.csv$/;
const GOOGLE_ERA_RE =
	/(?:^|\/)(?:Physical Activity_GoogleData|Health Fitness Data_GoogleData)\//;
/** Each stream's Google-era counterpart, whose presence names a layout change. */
const COUNTERPART_RES: Readonly<Record<DataStream, RegExp>> = {
	activities:
		/^((?:.*\/)?)Health Fitness Data_GoogleData\/UserExercises_[^/]*\.csv$/,
	daily_summaries:
		/^((?:.*\/)?)Physical Activity_GoogleData\/steps_\d{4}-\d{2}-\d{2}\.csv$/,
	sleep: /^((?:.*\/)?)Health Fitness Data_GoogleData\/UserSleeps_[^/]*\.csv$/,
};
const MACOSX_RE = /(?:^|\/)__MACOSX\//;
// Group 1 is the stamp, group 2 the middle number (absent in some exports), group 3 the part number.
const TAKEOUT_PART_RE =
	/^takeout-(\d{8}T\d{6}Z)-(?:(\d{1,4})-)?(\d{1,4})\.zip$/i;
const ZIP_NAME_RE = /\.zip$/i;
const GZIP_NAME_RE = /\.(?:tgz|tar\.gz)$/i;
const ERROR_CODE_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

const ZIP_EOCD_SIGNATURE = 0x06_05_4b_50;
const ZIP_EOCD_BYTES = 22;
const ZIP_EOCD_SEARCH_BYTES = ZIP_EOCD_BYTES + 0xff_ff;
const ZIP64_LOCATOR_SIGNATURE = 0x07_06_4b_50;
const ZIP64_LOCATOR_BYTES = 20;
const GZIP_MAGIC = [0x1f, 0x8b] as const;
/**
 * The earliest offset past which a known writer places members with ZIP64:
 * Python's zipfile, at 2 GiB less a byte. Java's and most others wait for
 * 4 GiB.
 */
const EARLIEST_ZIP64_SWITCH = 0x7f_ff_ff_ff;

/** The shared reader's errors for a member that is not where the classic fields place it. */
const MISPLACED_MEMBER_ERRORS: ReadonlySet<string> = new Set([
	"zip_entry_local_header_invalid",
	"zip_entry_data_out_of_bounds",
]);

/**
 * Error codes that mean the device failed, not the export: storage full or
 * read-only, permissions, open-file limits, an I/O fault, or a file or folder
 * gone from under the import. Nothing in an export's contents raises one, and
 * asking the owner for a new export would not help.
 */
const DEVICE_ERROR_CODES: ReadonlySet<string> = new Set([
	"EACCES",
	"EDQUOT",
	"EIO",
	"EMFILE",
	"ENFILE",
	"ENOENT",
	"ENOSPC",
	"ENOTDIR",
	"EPERM",
	"EROFS",
]);

/**
 * An error's `code`, when it is a plain identifier. The code is all that is
 * ever reported about an error.
 */
export function errorCode(error: unknown): string | null {
	if (typeof error !== "object" || error === null || !("code" in error)) {
		return null;
	}
	const { code } = error;
	return typeof code === "string" && ERROR_CODE_RE.test(code) ? code : null;
}

export function isDeviceError(error: unknown): boolean {
	const code = errorCode(error);
	return code !== null && DEVICE_ERROR_CODES.has(code);
}

/**
 * Removes a scratch file, or the scratch folder and all it holds. A failure
 * is left unreported, since its error would carry the path; a file left
 * behind goes with the folder at the end of the run.
 */
export function removeScratch(path: string): void {
	try {
		rmSync(path, { force: true, recursive: true });
	} catch {
		// Nothing path-free to report.
	}
}

// Choosing the upload

/** One ZIP of the chosen export. `group` is its middle number, compared numerically, or "" when it has none. */
export interface UploadPart {
	readonly path: string;
	readonly group: string;
}

export type UploadSearch =
	| { readonly kind: "none" }
	| {
			readonly kind: "unsupported";
			readonly failure: "file" | "gzip" | "no_zip" | "parts";
	  }
	| { readonly kind: "too_many_parts" }
	| { readonly kind: "device"; readonly code: string | null }
	| {
			readonly kind: "found";
			/** Ordered by middle number, then part number, the absent middle number first. */
			readonly parts: readonly UploadPart[];
			/**
			 * About when the export was made: the Takeout stamp, or for an upload
			 * without a Takeout name its modification time. Null when neither can
			 * be read.
			 */
			readonly exportedAt: string | null;
	  };

/** A file name that parses as a Takeout part with a real stamp. */
interface TakeoutName {
	readonly name: string;
	readonly stamp: string;
	readonly group: string;
	readonly part: number;
}

function takeoutName(name: string): TakeoutName | null {
	const match = TAKEOUT_PART_RE.exec(name);
	if (match === null) {
		return null;
	}
	const [, stamp = "", middle, part = ""] = match;
	if (takeoutStamp(stamp) === null) {
		return null;
	}
	return {
		name,
		stamp,
		group: middle === undefined ? "" : String(Number(middle)),
		part: Number(part),
	};
}

/** Sorts the absent middle number first, then the others numerically. */
function groupRank(group: string): number {
	return group === "" ? -1 : Number(group);
}

/**
 * The parts of the newest export among the Takeout-named files. The middle
 * number's meaning is unknown (it is not a part count), so part numbers are
 * checked within each middle number and never compared across them.
 */
function newestTakeoutSet(
	dir: string,
	names: readonly TakeoutName[],
): UploadSearch {
	let newest = "";
	for (const { stamp } of names) {
		if (stamp > newest) {
			newest = stamp;
		}
	}
	const chosen = names.filter((name) => name.stamp === newest);
	const partsByGroup = new Map<string, number[]>();
	for (const { group, part } of chosen) {
		const parts = partsByGroup.get(group) ?? [];
		parts.push(part);
		partsByGroup.set(group, parts);
	}
	for (const parts of partsByGroup.values()) {
		parts.sort((a, b) => a - b);
		if (!parts.every((part, index) => part === index + 1)) {
			return { kind: "unsupported", failure: "parts" };
		}
	}
	if (chosen.length > MAX_PARTS) {
		return { kind: "too_many_parts" };
	}
	const ordered = [...chosen].sort(
		(a, b) => groupRank(a.group) - groupRank(b.group) || a.part - b.part,
	);
	return {
		kind: "found",
		parts: ordered.map(({ name, group }) => ({ path: join(dir, name), group })),
		exportedAt: takeoutStamp(newest),
	};
}

function mtimeOf(path: string): number | null {
	try {
		return statSync(path).mtimeMs;
	} catch {
		return null;
	}
}

/**
 * A modification time as ISO text; null when `stat` failed, or when the time
 * does not render as `YYYY-MM-DDTHH:MM:SS…` (a year past 9999 renders as
 * `+010000-…`, which no record schema accepts).
 */
export function mtimeIso(mtimeMs: number | null): string | null {
	if (mtimeMs === null || !Number.isFinite(mtimeMs)) {
		return null;
	}
	const date = new Date(mtimeMs);
	if (Number.isNaN(date.getTime())) {
		return null;
	}
	const text = date.toISOString();
	return ISO_DT_RE.test(text) ? text : null;
}

/**
 * The upload to read.
 *
 * - `none`: the folder does not exist, is empty, or holds only hidden
 *   entries. Nothing has been uploaded yet.
 * - `unsupported`: the import path is a file (a ZIP itself, say); the newest
 *   Takeout export's part numbers do not run 1…k within a middle number; or
 *   the folder holds no ZIP, only a `.tgz` export or something else, such as
 *   an unzipped export or a CSV.
 * - `too_many_parts`: the newest Takeout export has more than MAX_PARTS parts.
 * - `device`: the folder could not be resolved or listed.
 * - `found`: every part of the newest Takeout export, or, when no file has a
 *   Takeout name, the newest ZIP by modification time, the name breaking ties
 *   so the choice is the same on every run.
 *
 * Only a regular file is an upload. A symbolic link is not followed, since it
 * can point outside the import folder, so a linked ZIP counts as something
 * else in the folder. Other files beside the chosen export are ignored: older
 * exports, unrelated ZIPs, and a browser's `takeout-…-001 (1).zip` copy, which
 * has no Takeout name.
 */
export function findUploadSet(importDir: string): UploadSearch {
	let dir: string;
	let entries: Dirent[];
	try {
		dir = realpathSync(importDir);
		entries = readdirSync(dir, { withFileTypes: true });
	} catch (error) {
		const code = errorCode(error);
		if (code === "ENOENT") {
			return { kind: "none" };
		}
		// Before isDeviceError, which also lists ENOTDIR: a file where the
		// folder should be is the owner's to fix, not the device's.
		if (code === "ENOTDIR") {
			return { kind: "unsupported", failure: "file" };
		}
		return isDeviceError(error)
			? { kind: "device", code }
			: { kind: "unsupported", failure: "no_zip" };
	}
	const visible = entries.filter((entry) => !entry.name.startsWith("."));
	if (visible.length === 0) {
		return { kind: "none" };
	}
	const files = visible
		.filter((entry) => entry.isFile())
		.map((entry) => entry.name);
	const takeout = files.flatMap((name) => takeoutName(name) ?? []);
	if (takeout.length > 0) {
		return newestTakeoutSet(dir, takeout);
	}
	const newest = files
		.filter((name) => ZIP_NAME_RE.test(name))
		.map((name) => {
			const path = join(dir, name);
			return { name, path, mtimeMs: mtimeOf(path) };
		})
		.sort(
			(a, b) =>
				(b.mtimeMs ?? Number.NEGATIVE_INFINITY) -
					(a.mtimeMs ?? Number.NEGATIVE_INFINITY) ||
				compareText(a.name, b.name),
		)
		.at(0);
	if (newest !== undefined) {
		return {
			kind: "found",
			parts: [{ path: newest.path, group: "" }],
			exportedAt: mtimeIso(newest.mtimeMs),
		};
	}
	return files.some((name) => GZIP_NAME_RE.test(name))
		? { kind: "unsupported", failure: "gzip" }
		: { kind: "unsupported", failure: "no_zip" };
}

// Checking one part

/**
 * The archive's last bytes, as far back as an end record can start, and
 * where in them the end record sits; null when there is none.
 */
function findEndRecord(
	fd: number,
	size: number,
): { readonly tail: Buffer; readonly at: number } | null {
	const tailLength = Math.min(size, ZIP_EOCD_SEARCH_BYTES);
	const tail = Buffer.alloc(tailLength);
	readSync(fd, tail, 0, tailLength, size - tailLength);
	for (let i = tailLength - ZIP_EOCD_BYTES; i >= 0; i -= 1) {
		if (tail.readUInt32LE(i) === ZIP_EOCD_SIGNATURE) {
			return { tail, at: i };
		}
	}
	return null;
}

/**
 * Whether the archive needs ZIP64 to be listed: it is past the classic
 * address limit, or its end record carries a ZIP64 sentinel in the entry
 * count, the central-directory size or its offset.
 */
export function needsZip64(fd: number, size: number): boolean {
	if (size > ZIP_ADDRESS_LIMIT) {
		return true;
	}
	const end = findEndRecord(fd, size);
	if (end === null) {
		// The listing comes back empty and reports the file as damaged.
		return false;
	}
	const { tail, at } = end;
	return (
		tail.readUInt16LE(at + 10) === 0xff_ff ||
		tail.readUInt32LE(at + 12) === 0xff_ff_ff_ff ||
		tail.readUInt32LE(at + 16) === 0xff_ff_ff_ff
	);
}

/**
 * Whether a ZIP64 locator sits just before the classic end record. A writer
 * that switches to ZIP64 part-way, as Python's zipfile does at 2 GiB, keeps
 * real values in the classic end record, so the archive lists, but writes
 * ZIP64's sentinel as the offset of every member stored past the switch.
 */
function hasZip64Locator(fd: number, size: number): boolean {
	const end = findEndRecord(fd, size);
	return (
		end !== null &&
		end.at >= ZIP64_LOCATOR_BYTES &&
		end.tail.readUInt32LE(end.at - ZIP64_LOCATOR_BYTES) ===
			ZIP64_LOCATOR_SIGNATURE
	);
}

/**
 * Whether a member failed because only ZIP64 can place it: the reader did
 * not find it where the classic fields say, in an archive past the earliest
 * switch to ZIP64 that carries ZIP64 records. Elsewhere the same failure is
 * a damaged member.
 */
function isBeyondClassicReach(
	fd: number,
	size: number,
	error: unknown,
): boolean {
	if (
		size <= EARLIEST_ZIP64_SWITCH ||
		!(error instanceof Error) ||
		!MISPLACED_MEMBER_ERRORS.has(error.message)
	) {
		return false;
	}
	try {
		return hasZip64Locator(fd, size);
	} catch {
		// The end record cannot be read again, so the member stays damaged.
		return false;
	}
}

/** The number of entries the end record declares; zero when there is none. */
function declaredEntryCount(fd: number, size: number): number {
	const end = findEndRecord(fd, size);
	return end === null ? 0 : end.tail.readUInt16LE(end.at + 10);
}

/** Up to the first four bytes of the file. */
function headOf(fd: number): Buffer {
	const head = Buffer.alloc(4);
	const bytesRead = readSync(fd, head, 0, head.length, 0);
	return head.subarray(0, bytesRead);
}

/** Whether a name could belong to an export at all: not a folder, not macOS metadata. */
function isCandidate(name: string): boolean {
	return (
		!name.endsWith("/") &&
		!MACOSX_RE.test(name) &&
		!zipBasename(name).startsWith("._")
	);
}

/** A name this import may extract, and what it is. */
interface KeptName {
	readonly name: string;
	/** Everything before the anchored folder; "" when the folder is at the top. */
	readonly root: string;
	readonly kind: MemberKind;
	readonly declaredBytes: number;
	/** The date in a date-named family member's basename, as written; else null. */
	readonly nameDate: string | null;
	/** An exercise page's number; else null. */
	readonly page: number | null;
}

function keptName(name: string, declaredBytes: number): KeptName | null {
	const legacy = LEGACY_MEMBER_RE.exec(name);
	if (legacy !== null) {
		const [, root = "", base = ""] = legacy;
		for (const kind of FAMILY_KEYS) {
			const number = FAMILIES[kind].exec(base)?.[1];
			if (number !== undefined) {
				const exercise = kind === "exercise";
				return {
					name,
					root,
					kind,
					declaredBytes,
					nameDate: exercise ? null : number,
					page: exercise ? Number(number) : null,
				};
			}
		}
		return null;
	}
	for (const [kind, pattern] of [
		["sleep_score", SLEEP_SCORE_RE],
		["profile", PROFILE_RE],
	] as const) {
		const root = pattern.exec(name)?.[1];
		if (root !== undefined) {
			return { name, root, kind, declaredBytes, nameDate: null, page: null };
		}
	}
	return null;
}

/** What one part holds that matters here. Every other name is dropped once seen. */
interface PartListing {
	/** The roots of every `Global Export Data/` folder with a member in it. */
	readonly legacyRoots: ReadonlySet<string>;
	/** Family members, score files and profiles, under any root. */
	readonly kept: readonly KeptName[];
	/** For each stream, the roots under which its Google-era counterpart has a member. */
	readonly counterpartRoots: Readonly<Record<DataStream, ReadonlySet<string>>>;
	/** Whether any member sits in a Google-era folder. */
	readonly googleEra: boolean;
}

type PartFailure =
	| "gzip"
	| "not_zip"
	| "zip64"
	| "policy"
	| "unreadable_listing"
	| "unsafe_name"
	| "device";

export type PartInspection =
	| { readonly ok: true; readonly listing: PartListing }
	| {
			readonly ok: false;
			readonly failure: PartFailure;
			readonly code: string | null;
	  };

function partFailureOf(error: unknown): PartFailure {
	if (error instanceof ZipPolicyViolationError) {
		switch (error.code) {
			case "unsafe_entry_name":
				return "unsafe_name";
			// With maxEntries at the classic ceiling, only the reader's
			// plausibility check raises this: a central directory larger than its
			// entry count allows, which is damage, not size. A part with 65,535
			// entries or more needs ZIP64 and is refused before listing.
			case "too_many_entries":
				return "unreadable_listing";
			default:
				return "policy";
		}
	}
	return isDeviceError(error) ? "device" : "unreadable_listing";
}

function listingOf(
	entries: readonly {
		readonly name: string;
		readonly uncompressedSize: number;
	}[],
): PartListing {
	const legacyRoots = new Set<string>();
	const kept: KeptName[] = [];
	const counterpartRoots: Record<DataStream, Set<string>> = {
		activities: new Set(),
		daily_summaries: new Set(),
		sleep: new Set(),
	};
	let googleEra = false;
	for (const { name, uncompressedSize } of entries) {
		if (!isCandidate(name)) {
			continue;
		}
		const legacyRoot = LEGACY_MEMBER_RE.exec(name)?.[1];
		if (legacyRoot !== undefined) {
			legacyRoots.add(legacyRoot);
		}
		const member = keptName(name, uncompressedSize);
		if (member !== null) {
			kept.push(member);
		}
		if (GOOGLE_ERA_RE.test(name)) {
			googleEra = true;
			for (const stream of DATA_STREAMS) {
				const root = COUNTERPART_RES[stream].exec(name)?.[1];
				if (root !== undefined) {
					counterpartRoots[stream].add(root);
				}
			}
		}
	}
	return { legacyRoots, kept, counterpartRoots, googleEra };
}

/**
 * Checks that one part is a classic zip this connector can list, and keeps
 * what it holds that matters here. Reads only the first bytes, the end record
 * and the central directory. `fd` is caller-owned.
 *
 * A listing shorter than the end record declares is damaged. The shared
 * reader stops at the first central-directory record it cannot read and
 * returns the entries before it, so every member listed after the damage
 * would otherwise look absent from the export.
 */
export function inspectPart(fd: number, size: number): PartInspection {
	try {
		const head = headOf(fd);
		if (size < ZIP_EOCD_BYTES || !hasZipLocalFileSignature(head)) {
			const gzip = head[0] === GZIP_MAGIC[0] && head[1] === GZIP_MAGIC[1];
			return { ok: false, failure: gzip ? "gzip" : "not_zip", code: null };
		}
		if (needsZip64(fd, size)) {
			return { ok: false, failure: "zip64", code: null };
		}
		const entries = readZipEntriesFromFile(fd, size, FITBIT_ZIP_POLICY);
		if (entries.length === 0 || entries.length < declaredEntryCount(fd, size)) {
			return { ok: false, failure: "unreadable_listing", code: null };
		}
		return { ok: true, listing: listingOf(entries) };
	} catch (error) {
		return { ok: false, failure: partFailureOf(error), code: errorCode(error) };
	}
}

// Checking the whole upload

/** An open part: the caller opens and closes the descriptor. */
export interface PartHandle {
	readonly fd: number;
	readonly size: number;
}

/** An open part of the chosen upload, with its middle number from UploadPart. */
export interface OpenPart extends PartHandle {
	readonly group: string;
}

/**
 * A member to extract: its full name, which goes to the zip reader and
 * nowhere else; the index of its part; and the uncompressed size its
 * central-directory record declares. `nameDate` is the YYYY-MM-DD text in a
 * date-named family member's basename, as written (not checked as a real
 * day); null for exercise pages, the score file and Profile.csv.
 */
export interface MemberRef {
	readonly name: string;
	readonly part: number;
	readonly declaredBytes: number;
	readonly nameDate: string | null;
}

export type InspectFailure =
	| PartFailure
	| "parts"
	| "not_fitbit"
	| "ambiguous_root"
	| "google_era_only";

export type ExportInspection =
	| {
			readonly ok: true;
			/** An entry per family, in reading order; an absent family is empty. */
			readonly families: ReadonlyMap<FamilyKey, readonly MemberRef[]>;
			readonly sleepScore: MemberRef | null;
			readonly profile: MemberRef | null;
			/**
			 * An entry per kind: one nameDate per member present in more than one
			 * part of a middle number, which is then read from none. The count is
			 * the length; the dates place each one's days.
			 */
			readonly duplicates: ReadonlyMap<MemberKind, readonly (string | null)[]>;
			/**
			 * Per stream, whether its layout has changed: none of its legacy
			 * families has a member (duplicated ones count as members), while its
			 * Google-era counterpart has one under the export's root.
			 */
			readonly googleEra: Readonly<Record<DataStream, boolean>>;
	  }
	| {
			readonly ok: false;
			readonly failure: InspectFailure;
			readonly code: string | null;
	  };

/** Lower is more urgent: the device first, then size, then damage. */
const PART_FAILURE_RANK: Readonly<Record<PartFailure, number>> = {
	device: 0,
	zip64: 1,
	policy: 1,
	gzip: 2,
	not_zip: 2,
	unreadable_listing: 2,
	unsafe_name: 2,
};

function refused(
	failure: InspectFailure,
	code: string | null = null,
): ExportInspection {
	return { ok: false, failure, code };
}

function memberOrder(a: KeptName, b: KeptName): number {
	if (a.page !== null && b.page !== null && a.page !== b.page) {
		return a.page - b.page;
	}
	return compareText(a.name, b.name);
}

/**
 * Checks every part and merges their listings into one export. Any refused
 * part refuses the upload, with the most urgent failure (the device, then too
 * large, then unreadable; the first part to fail among equals), since a
 * family could live in any part.
 */
export function inspectExport(parts: readonly OpenPart[]): ExportInspection {
	const listings: PartListing[] = [];
	let failed: Extract<PartInspection, { ok: false }> | null = null;
	for (const { fd, size } of parts) {
		const inspection = inspectPart(fd, size);
		if (inspection.ok) {
			listings.push(inspection.listing);
		} else if (
			failed === null ||
			PART_FAILURE_RANK[inspection.failure] < PART_FAILURE_RANK[failed.failure]
		) {
			failed = inspection;
		}
	}
	if (failed !== null) {
		return refused(failed.failure, failed.code);
	}
	const roots = new Set(
		listings.flatMap(({ legacyRoots }) => [...legacyRoots]),
	);
	if (roots.size === 0) {
		const googleEra = listings.some((listing) => listing.googleEra);
		return refused(googleEra ? "google_era_only" : "not_fitbit");
	}
	const [root] = roots;
	if (roots.size > 1 || root === undefined) {
		return refused("ambiguous_root");
	}

	// The namespace: names under the root, first seen in part order.
	const seen = new Map<string, { kept: KeptName; part: number }>();
	const duplicated = new Map<string, KeptName>();
	for (const [part, listing] of listings.entries()) {
		for (const kept of listing.kept) {
			if (kept.root !== root) {
				continue;
			}
			const earlier = seen.get(kept.name);
			if (earlier === undefined) {
				seen.set(kept.name, { kept, part });
			} else if (parts[earlier.part]?.group !== parts[part]?.group) {
				return refused("parts");
			} else {
				duplicated.set(kept.name, kept);
			}
		}
	}

	const byKind = new Map<MemberKind, { kept: KeptName; part: number }[]>();
	for (const entry of seen.values()) {
		if (!duplicated.has(entry.kept.name)) {
			const list = byKind.get(entry.kept.kind) ?? [];
			list.push(entry);
			byKind.set(entry.kept.kind, list);
		}
	}
	const refsOf = (kind: MemberKind): MemberRef[] =>
		(byKind.get(kind) ?? [])
			.sort((a, b) => memberOrder(a.kept, b.kept))
			.map(({ kept, part }) => ({
				name: kept.name,
				part,
				declaredBytes: kept.declaredBytes,
				nameDate: kept.nameDate,
			}));
	const duplicatesOf = (kind: MemberKind): (string | null)[] =>
		[...duplicated.values()]
			.filter((kept) => kept.kind === kind)
			.sort(memberOrder)
			.map((kept) => kept.nameDate);
	const kinds: readonly MemberKind[] = [
		...FAMILY_KEYS,
		"sleep_score",
		"profile",
	];
	const families = new Map(FAMILY_KEYS.map((kind) => [kind, refsOf(kind)]));
	const duplicates = new Map(kinds.map((kind) => [kind, duplicatesOf(kind)]));
	const layoutChanged = (stream: DataStream): boolean =>
		STREAM_FAMILIES[stream].every(
			(kind) =>
				(families.get(kind)?.length ?? 0) === 0 &&
				(duplicates.get(kind)?.length ?? 0) === 0,
		) && listings.some((listing) => listing.counterpartRoots[stream].has(root));
	return {
		ok: true,
		families,
		sleepScore: refsOf("sleep_score")[0] ?? null,
		profile: refsOf("profile")[0] ?? null,
		duplicates,
		googleEra: {
			activities: layoutChanged("activities"),
			daily_summaries: layoutChanged("daily_summaries"),
			sleep: layoutChanged("sleep"),
		},
	};
}

// Extracting a member

type Extraction =
	| { readonly ok: true; readonly path: string }
	| {
			readonly ok: false;
			readonly failure: "too_large" | "interrupted" | "device";
			readonly code: string | null;
	  };

/**
 * Extracts one member to `scratchDir` as `member-<n>`, never under its own
 * name. A member declaring more than `maxBytes` is not extracted. One that
 * inflates to any size but the one it declares is removed and reported as
 * interrupted: the shared reader checks neither the CRC nor the declared
 * size, and a CSV has no end marker to betray a cut. So a member that is read
 * is exactly its declared size, and `maxBytes` bounds everything read from it.
 *
 * Known limit: a member that declares a small size but inflates large is
 * stopped only by the policy's per-entry cap, so it can fill up to 4 GiB of
 * scratch disk before the size check sees it; if the disk runs out, the
 * stream reports the device. A per-call cap belongs in the shared zip reader,
 * and changing that file changes the published artifact of every connector
 * that bundles it. Each extraction also walks its part's whole central
 * directory again, so the cost grows with members times entries.
 */
export async function extractMember(
	parts: readonly PartHandle[],
	member: MemberRef,
	scratchDir: string,
	n: number,
	maxBytes: number,
): Promise<Extraction> {
	if (member.declaredBytes > maxBytes) {
		return { ok: false, failure: "too_large", code: null };
	}
	const part = parts[member.part];
	if (part === undefined) {
		throw new RangeError("extractMember: the member's part is not open");
	}
	const dest = join(scratchDir, `member-${String(n)}`);
	try {
		// The full name: the reader also matches a bare basename and silently
		// takes the last match, while a full name can match only itself, since a
		// duplicate full name already refused the part.
		const { found, bytesWritten } = await streamZipEntryToFile(
			part.fd,
			part.size,
			member.name,
			dest,
			FITBIT_ZIP_POLICY,
		);
		if (found && bytesWritten === member.declaredBytes) {
			return { ok: true, path: dest };
		}
		removeScratch(dest);
		return { ok: false, failure: "interrupted", code: null };
	} catch (error) {
		removeScratch(dest);
		const code = errorCode(error);
		if (
			error instanceof ZipPolicyViolationError ||
			isBeyondClassicReach(part.fd, part.size, error)
		) {
			return { ok: false, failure: "too_large", code };
		}
		// Anything else is the member's own fault: bad deflate data, a damaged
		// local header, or a compression method the reader does not support.
		return isDeviceError(error)
			? { ok: false, failure: "device", code }
			: { ok: false, failure: "interrupted", code };
	}
}
