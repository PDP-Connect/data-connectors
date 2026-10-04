// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import {
	chmodSync,
	closeSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { ZipPolicyViolationError } from "../../packages/polyfill-connectors/src/bounded-zip-archive.ts";
import {
	canonicalMembers,
	canonicalParts,
	canonicalRows,
	canonicalZip,
	EXPORTED_AT,
	jsonMember,
	legacyMember,
	neverReadMembers,
	partName,
	profileCsv,
	profileMember,
	ROOT,
	scoreCsv,
	sleepScoreMember,
	writeParts,
} from "./__fixtures__/synthetic-export.ts";
import {
	PAST_ZIP64_SWITCH_GAP_BYTES,
	writeGzipLookalike,
	writeSparseOversize,
	writeZip,
	writeZip64LocatorZip,
	writeZip64SentinelZip,
	type ZipMember,
	zipBytes,
} from "./__fixtures__/zip.ts";
import {
	type ExportInspection,
	errorCode,
	extractMember,
	FAMILY_KEYS,
	type FamilyKey,
	findUploadSet,
	inspectExport,
	inspectPart,
	isDeviceError,
	MAX_PARTS,
	MEMBER_MAX_BYTES,
	type MemberKind,
	type MemberRef,
	MINUTE_MEMBER_MAX_BYTES,
	mtimeIso,
	needsZip64,
	type OpenPart,
	type PartInspection,
	ZIP_ADDRESS_LIMIT,
} from "./archive.ts";

const TEMP = mkdtempSync(join(tmpdir(), "pdpp-fitbit-archive-test-"));
const LARGE_FIXTURE_BASE_DIR =
	process.env.PDPP_TEST_LARGE_FIXTURE_DIR ?? join(homedir(), ".tmp");
const MIB = 1024 * 1024;
const CENTRAL_HEADER_SIGNATURE = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
const LOCAL_HEADER_SIGNATURE = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const IS_ROOT = process.getuid?.() === 0;
const OLDER_STAMP = "20260801T101500Z";
const DATE_NAMED = /^[a-z_]+-(\d{4}-\d{2}-\d{2})\.json$/;

after(() => {
	rmSync(TEMP, { force: true, recursive: true });
});

let fixtureCount = 0;

function freshDir(): string {
	fixtureCount += 1;
	const dir = join(TEMP, String(fixtureCount));
	mkdirSync(dir);
	return dir;
}

function freshPath(name = "export.zip"): string {
	return join(freshDir(), name);
}

function zipFile(members: readonly ZipMember[]): string {
	const path = freshPath();
	writeZip(path, members);
	return path;
}

function fileOf(bytes: Buffer): string {
	const path = freshPath();
	writeFileSync(path, bytes);
	return path;
}

function withFd<T>(path: string, use: (fd: number, size: number) => T): T {
	const fd = openSync(path, "r");
	try {
		return use(fd, statSync(path).size);
	} finally {
		closeSync(fd);
	}
}

function inspectOne(path: string): PartInspection {
	return withFd(path, inspectPart);
}

/** Opens each part, inspects the upload, and closes them again. */
function inspectFiles(
	parts: readonly { readonly path: string; readonly group?: string }[],
): ExportInspection {
	const open: OpenPart[] = [];
	try {
		for (const { path, group = "1" } of parts) {
			open.push({ fd: openSync(path, "r"), size: statSync(path).size, group });
		}
		return inspectExport(open);
	} finally {
		for (const { fd } of open) {
			closeSync(fd);
		}
	}
}

function inspectZip(members: readonly ZipMember[]): ExportInspection {
	return inspectFiles([{ path: zipFile(members) }]);
}

type Inspected = Extract<ExportInspection, { ok: true }>;

function inspected(inspection: ExportInspection): Inspected {
	if (!inspection.ok) {
		assert.fail(`the upload was refused: ${inspection.failure}`);
	}
	return inspection;
}

function refusal(inspection: ExportInspection | PartInspection): {
	failure: string;
	code: string | null;
} {
	if (inspection.ok) {
		assert.fail("the upload should be refused");
	}
	return { failure: inspection.failure, code: inspection.code };
}

function familyNames(
	inspection: ExportInspection,
): Readonly<Record<string, readonly string[]>> {
	const { families } = inspected(inspection);
	return Object.fromEntries(
		FAMILY_KEYS.map((family) => [
			family,
			(families.get(family) ?? []).map((member) => member.name),
		]),
	);
}

function noFamilies(): Record<FamilyKey, string[]> {
	return {
		exercise: [],
		sleep: [],
		steps: [],
		distance: [],
		lightly_active_minutes: [],
		moderately_active_minutes: [],
		very_active_minutes: [],
		resting_heart_rate: [],
	};
}

function duplicatesOf(
	inspection: ExportInspection,
): Readonly<Record<string, readonly (string | null)[]>> {
	const { duplicates } = inspected(inspection);
	const kinds: readonly MemberKind[] = [
		...FAMILY_KEYS,
		"sleep_score",
		"profile",
	];
	return Object.fromEntries(
		kinds.map((kind) => [kind, duplicates.get(kind) ?? []]),
	);
}

function assertNoName(value: unknown, names: readonly string[]): void {
	const text = JSON.stringify(value);
	for (const name of [...names, "Global Export Data", "takeout-"]) {
		assert.ok(!text.includes(name), `leaked ${name}: ${text}`);
	}
}

/** A copy of a classic zip's bytes with the end record's field at `offset` overwritten. */
function withEndRecordField(
	bytes: Buffer,
	offset: number,
	width: 2 | 4,
	value = width === 2 ? 0xff_ff : 0xff_ff_ff_ff,
): Buffer {
	const copy = Buffer.from(bytes);
	const end = copy.length - 22;
	assert.equal(copy.readUInt32LE(end), 0x06_05_4b_50);
	if (width === 2) {
		copy.writeUInt16LE(value, end + offset);
	} else {
		copy.writeUInt32LE(value, end + offset);
	}
	return copy;
}

function setMtime(path: string, iso: string): void {
	const when = new Date(iso);
	utimesSync(path, when, when);
}

/** Empty files standing in for ZIPs: choosing the upload never opens one. */
function touch(dir: string, ...names: string[]): void {
	for (const name of names) {
		writeFileSync(join(dir, name), "");
	}
}

// needsZip64 and inspectPart

test("needsZip64: a classic zip is readable; a ZIP64 sentinel end record or a size past 4 GiB is not", () => {
	const classic = zipFile(canonicalMembers());
	assert.equal(withFd(classic, needsZip64), false);

	const sentinel = freshPath();
	writeZip64SentinelZip(sentinel);
	assert.equal(withFd(sentinel, needsZip64), true);

	// Decided on the size alone, before any byte is read.
	assert.equal(
		withFd(classic, (fd) => needsZip64(fd, 2 ** 32)),
		true,
	);
	assert.equal(
		withFd(classic, (fd) => needsZip64(fd, ZIP_ADDRESS_LIMIT + 1)),
		true,
	);
});

test("needsZip64 flags a sentinel in each classic end-record field, behind an archive comment too", () => {
	const classic = zipBytes([
		{ name: legacyMember("steps-2026-04-04.json"), data: Buffer.from("[]") },
	]);
	const entryCount = withEndRecordField(classic, 10, 2);
	const directorySize = withEndRecordField(classic, 12, 4);
	const directoryOffset = withEndRecordField(classic, 16, 4);
	for (const [label, bytes] of [
		["entry count", entryCount],
		["central-directory size", directorySize],
		["central-directory offset", directoryOffset],
	] as const) {
		assert.equal(withFd(fileOf(bytes), needsZip64), true, label);
	}

	const comment = Buffer.from("exported by a zip tool\n".repeat(20));
	const commented = Buffer.concat([directoryOffset, comment]);
	commented.writeUInt16LE(comment.length, directoryOffset.length - 2);
	assert.equal(withFd(fileOf(commented), needsZip64), true);

	const plainCommented = Buffer.concat([classic, comment]);
	plainCommented.writeUInt16LE(comment.length, classic.length - 2);
	assert.equal(withFd(fileOf(plainCommented), needsZip64), false);
});

test("inspectPart tells a gzip stream from other files that are not zips, by their bytes", () => {
	const renamed = freshPath(partName(1));
	writeGzipLookalike(renamed);
	assert.deepEqual(refusal(inspectOne(renamed)), {
		failure: "gzip",
		code: null,
	});
	for (const bytes of [
		Buffer.from("Activity ID,Activity Date\n1,2026-03-14\n".repeat(4)),
		Buffer.from("PK\u0003\u0004", "latin1"),
		Buffer.from([0x1f]),
		Buffer.alloc(0),
	]) {
		assert.deepEqual(refusal(inspectOne(fileOf(bytes))), {
			failure: "not_zip",
			code: null,
		});
	}
});

test("inspectPart reports a zip with no readable listing as unreadable", () => {
	const whole = zipBytes([
		{ name: legacyMember("exercise-0.json"), data: Buffer.from("[{}]") },
	]);
	// Cut before the end record: the local header survives, the listing does not.
	const cut = whole.subarray(0, whole.length - 30);
	assert.deepEqual(refusal(inspectOne(fileOf(cut))), {
		failure: "unreadable_listing",
		code: null,
	});
});

test("inspectPart reports a listing broken part-way as unreadable, never as members absent", () => {
	const broken = zipBytes(canonicalMembers());
	let record = -1;
	for (let n = 0; n < 3; n += 1) {
		record = broken.indexOf(CENTRAL_HEADER_SIGNATURE, record + 1);
	}
	assert.ok(record > 0);
	// The third record's signature: the shared reader stops there and returns
	// the two records before it.
	broken[record + 3] = 0x00;
	assert.deepEqual(refusal(inspectOne(fileOf(broken))), {
		failure: "unreadable_listing",
		code: null,
	});
});

test("inspectPart refuses an unsafe or duplicated member name, naming neither", () => {
	const traversal = inspectOne(
		zipFile([
			{
				name: `${ROOT}Global Export Data/../steps-2026-04-04.json`,
				data: Buffer.from("[]"),
			},
		]),
	);
	assert.deepEqual(refusal(traversal), {
		failure: "unsafe_name",
		code: "unsafe_entry_name",
	});
	assertNoName(traversal, ["steps-2026-04-04"]);

	const name = legacyMember("steps-2026-04-04.json");
	const duplicated = inspectOne(
		zipFile([
			{ name, data: Buffer.from("[]") },
			{ name, data: Buffer.from("[]") },
		]),
	);
	assert.deepEqual(refusal(duplicated), {
		failure: "unsafe_name",
		code: "unsafe_entry_name",
	});
	assertNoName(duplicated, ["steps-2026-04-04"]);
});

test("inspectPart refuses a ZIP64 part as too large before listing it", () => {
	const sentinel = freshPath();
	writeZip64SentinelZip(sentinel, canonicalMembers());
	assert.deepEqual(refusal(inspectOne(sentinel)), {
		failure: "zip64",
		code: null,
	});

	// 65,535 entries fill the classic count field with its ZIP64 sentinel.
	const crowded = zipFile(
		Array.from({ length: 0xff_ff }, (_, index) => ({
			name: `${ROOT}Physical Activity_GoogleData/f${String(index)}.csv`,
			data: Buffer.alloc(0),
			method: "store" as const,
		})),
	);
	assert.deepEqual(refusal(inspectOne(crowded)), {
		failure: "zip64",
		code: null,
	});
});

test("inspectPart refuses a sparse part past 4 GiB as too large without reading it", () => {
	mkdirSync(LARGE_FIXTURE_BASE_DIR, { recursive: true });
	const dir = mkdtempSync(join(LARGE_FIXTURE_BASE_DIR, "pdpp-fitbit-sparse-"));
	try {
		const path = join(dir, partName(1));
		writeSparseOversize(path);
		assert.ok(statSync(path).size > ZIP_ADDRESS_LIMIT);
		assert.deepEqual(refusal(inspectOne(path)), {
			failure: "zip64",
			code: null,
		});
	} finally {
		rmSync(dir, { force: true, recursive: true });
	}
});

test("inspectPart reports a declared-size breach as too large, by its code", () => {
	const name = legacyMember("steps-2026-04-04.json");
	const hugeEntry = inspectOne(
		zipFile([{ name, data: Buffer.from("[]"), declaredSize: 0xff_ff_ff_ff }]),
	);
	assert.deepEqual(refusal(hugeEntry), {
		failure: "policy",
		code: "entry_too_large",
	});
	assertNoName(hugeEntry, ["steps-2026-04-04"]);

	// Seventeen entries of just under 4 GiB each declare more than 64 GiB in all.
	const hugeTotal = inspectOne(
		zipFile(
			Array.from({ length: 17 }, (_, index) => ({
				name: `${ROOT}Physical Activity_GoogleData/f${String(index)}.csv`,
				data: Buffer.alloc(0),
				method: "store" as const,
				declaredSize: 0xff_ff_ff_fe,
			})),
		),
	);
	assert.deepEqual(refusal(hugeTotal), {
		failure: "policy",
		code: "total_too_large",
	});
});

test("inspectPart reports a central directory its entry count cannot hold as damage, not size", () => {
	const classic = zipBytes([
		{ name: legacyMember("steps-2026-04-04.json"), data: Buffer.from("[]") },
	]);
	// One entry declares at most 4,142 bytes of directory.
	const oversizedDirectory = withEndRecordField(classic, 12, 4, 5000);
	assert.deepEqual(refusal(inspectOne(fileOf(oversizedDirectory))), {
		failure: "unreadable_listing",
		code: "too_many_entries",
	});
	// An end record zeroed to no entries over a real directory.
	const zeroed = withEndRecordField(
		withEndRecordField(classic, 8, 2, 0),
		10,
		2,
		0,
	);
	assert.deepEqual(refusal(inspectOne(fileOf(zeroed))), {
		failure: "unreadable_listing",
		code: "too_many_entries",
	});
});

// findUploadSet

test("findUploadSet reports nothing uploaded for a missing, empty or hidden-only folder", () => {
	assert.deepEqual(findUploadSet(join(TEMP, "no-such-folder")), {
		kind: "none",
	});
	assert.deepEqual(findUploadSet(freshDir()), { kind: "none" });

	const hidden = freshDir();
	writeFileSync(join(hidden, ".DS_Store"), "");
	writeZip(join(hidden, `.${partName(1)}`), canonicalMembers());
	assert.deepEqual(findUploadSet(hidden), { kind: "none" });
});

test("findUploadSet names what it cannot read: the ZIP itself, a .tgz export, or no ZIP at all", () => {
	const zip = canonicalZip(freshDir());
	assert.deepEqual(findUploadSet(zip), {
		kind: "unsupported",
		failure: "file",
	});

	for (const name of ["export.tgz", "takeout-20260920T081500Z-1-001.tar.gz"]) {
		const tgz = freshDir();
		writeGzipLookalike(join(tgz, name));
		assert.deepEqual(findUploadSet(tgz), {
			kind: "unsupported",
			failure: "gzip",
		});
	}

	const csv = freshDir();
	writeFileSync(join(csv, "export.csv"), "a,b\n1,2\n");
	assert.deepEqual(findUploadSet(csv), {
		kind: "unsupported",
		failure: "no_zip",
	});

	const unzipped = freshDir();
	mkdirSync(join(unzipped, "Takeout", "Fitbit", "Global Export Data"), {
		recursive: true,
	});
	assert.deepEqual(findUploadSet(unzipped), {
		kind: "unsupported",
		failure: "no_zip",
	});

	const folderNamedZip = freshDir();
	mkdirSync(join(folderNamedZip, partName(1)));
	assert.deepEqual(findUploadSet(folderNamedZip), {
		kind: "unsupported",
		failure: "no_zip",
	});
});

test("findUploadSet reports a folder it cannot list as the device's, with the code alone", {
	skip: IS_ROOT ? "root reads a folder whatever its mode" : false,
}, () => {
	const dir = freshDir();
	canonicalZip(dir);
	chmodSync(dir, 0o000);
	try {
		assert.deepEqual(findUploadSet(dir), { kind: "device", code: "EACCES" });
	} finally {
		chmodSync(dir, 0o700);
	}
});

test("findUploadSet reads every part of the newest Takeout stamp, never the newest file", () => {
	const dir = freshDir();
	const older = [1, 2].map((part) => partName(part, 1, OLDER_STAMP));
	const newer = [1, 2, 3].map((part) => partName(part));
	touch(dir, ...older, ...newer);
	// Staged later, as a host that copies files one by one may leave them.
	for (const name of newer) {
		setMtime(join(dir, name), "2026-09-21T00:00:00Z");
	}
	for (const name of older) {
		setMtime(join(dir, name), "2026-09-22T00:00:00Z");
	}
	assert.deepEqual(findUploadSet(dir), {
		kind: "found",
		parts: newer.map((name) => ({ path: join(dir, name), group: "1" })),
		exportedAt: EXPORTED_AT,
	});
});

test("findUploadSet ignores an unrelated ZIP beside a Takeout export, however new", () => {
	const dir = freshDir();
	touch(dir, partName(1), "export.zip");
	setMtime(join(dir, partName(1)), "2026-01-01T00:00:00Z");
	setMtime(join(dir, "export.zip"), "2026-09-26T00:00:00Z");
	assert.deepEqual(findUploadSet(dir), {
		kind: "found",
		parts: [{ path: join(dir, partName(1)), group: "1" }],
		exportedAt: EXPORTED_AT,
	});
});

test("findUploadSet takes the newest ZIP by modification time when none has a Takeout name", () => {
	const dir = freshDir();
	touch(dir, "a.zip", "b.ZIP", "notes.txt");
	setMtime(join(dir, "b.ZIP"), "2026-01-01T00:00:00Z");
	setMtime(join(dir, "a.zip"), "2026-06-01T00:00:00Z");
	assert.deepEqual(findUploadSet(dir), {
		kind: "found",
		parts: [{ path: join(dir, "a.zip"), group: "" }],
		exportedAt: "2026-06-01T00:00:00.000Z",
	});

	// An older upload whose name sorts later loses too.
	setMtime(join(dir, "b.ZIP"), "2026-09-01T00:00:00Z");
	assert.deepEqual(findUploadSet(dir), {
		kind: "found",
		parts: [{ path: join(dir, "b.ZIP"), group: "" }],
		exportedAt: "2026-09-01T00:00:00.000Z",
	});

	// A tie goes to the name that sorts first.
	const tie = freshDir();
	touch(tie, "c.zip", "a.zip", "b.zip");
	for (const name of ["c.zip", "a.zip", "b.zip"]) {
		setMtime(join(tie, name), "2026-03-15T12:00:00Z");
	}
	assert.deepEqual(findUploadSet(tie), {
		kind: "found",
		parts: [{ path: join(tie, "a.zip"), group: "" }],
		exportedAt: "2026-03-15T12:00:00.000Z",
	});

	// A Takeout-like name whose stamp is no real instant is not a Takeout part.
	const unreal = freshDir();
	touch(unreal, "takeout-20261320T081500Z-1-001.zip");
	setMtime(
		join(unreal, "takeout-20261320T081500Z-1-001.zip"),
		"2026-02-02T00:00:00Z",
	);
	assert.deepEqual(findUploadSet(unreal), {
		kind: "found",
		parts: [
			{ path: join(unreal, "takeout-20261320T081500Z-1-001.zip"), group: "" },
		],
		exportedAt: "2026-02-02T00:00:00.000Z",
	});
});

test("findUploadSet refuses part numbers that do not run 1 to k within a middle number", () => {
	const refused = { kind: "unsupported", failure: "parts" };
	const cases: readonly (readonly string[])[] = [
		[partName(1), partName(3)],
		[partName(2)],
		[partName(1), `takeout-${"20260920T081500Z"}-1-1.zip`],
		[partName(1), partName(2), partName(2, 2)],
	];
	for (const names of cases) {
		const dir = freshDir();
		touch(dir, ...names);
		assert.deepEqual(findUploadSet(dir), refused, names.join(" "));
	}
});

test("findUploadSet never compares part numbers across middle numbers, and orders parts numerically", () => {
	const groups = freshDir();
	const names = [
		partName(1, 10),
		partName(2, 10),
		partName(1, 2),
		partName(1, 1),
	];
	touch(groups, ...names);
	assert.deepEqual(findUploadSet(groups), {
		kind: "found",
		parts: [
			{ path: join(groups, partName(1, 1)), group: "1" },
			{ path: join(groups, partName(1, 2)), group: "2" },
			{ path: join(groups, partName(1, 10)), group: "10" },
			{ path: join(groups, partName(2, 10)), group: "10" },
		],
		exportedAt: EXPORTED_AT,
	});

	// No middle number; `-1` and `-001` are both part 1, and 10 follows 9.
	const plain = freshDir();
	const plainNames = Array.from(
		{ length: 10 },
		(_, index) => `takeout-20260920T081500Z-${String(index + 1)}.zip`,
	);
	touch(plain, ...[...plainNames].reverse());
	assert.deepEqual(findUploadSet(plain), {
		kind: "found",
		parts: plainNames.map((name) => ({ path: join(plain, name), group: "" })),
		exportedAt: EXPORTED_AT,
	});

	const padded = freshDir();
	touch(
		padded,
		"takeout-20260920T081500Z-01-001.zip",
		"takeout-20260920T081500Z-1-002.zip",
	);
	assert.deepEqual(findUploadSet(padded), {
		kind: "found",
		parts: [
			{ path: join(padded, "takeout-20260920T081500Z-01-001.zip"), group: "1" },
			{ path: join(padded, "takeout-20260920T081500Z-1-002.zip"), group: "1" },
		],
		exportedAt: EXPORTED_AT,
	});
});

test("findUploadSet ignores a browser's renamed second download of a part", () => {
	const dir = freshDir();
	const copy = partName(1).replace(".zip", " (1).zip");
	touch(dir, partName(1), copy);
	setMtime(join(dir, copy), "2026-09-26T00:00:00Z");
	assert.deepEqual(findUploadSet(dir), {
		kind: "found",
		parts: [{ path: join(dir, partName(1)), group: "1" }],
		exportedAt: EXPORTED_AT,
	});
});

test("findUploadSet refuses an export of more than MAX_PARTS parts", () => {
	const at = freshDir();
	touch(
		at,
		...Array.from({ length: MAX_PARTS }, (_, index) => partName(index + 1)),
	);
	const found = findUploadSet(at);
	assert.equal(found.kind, "found");
	assert.equal(found.kind === "found" ? found.parts.length : 0, MAX_PARTS);

	const over = freshDir();
	touch(
		over,
		...Array.from({ length: MAX_PARTS + 1 }, (_, index) => partName(index + 1)),
	);
	assert.deepEqual(findUploadSet(over), { kind: "too_many_parts" });
});

test("mtimeIso renders a modification time as ISO text, or null when it cannot", () => {
	assert.equal(mtimeIso(Date.UTC(2026, 0, 1)), "2026-01-01T00:00:00.000Z");
	assert.equal(mtimeIso(253_402_300_799_999), "9999-12-31T23:59:59.999Z");
	// The year 10000 renders as "+010000-…", which no schema accepts.
	assert.equal(mtimeIso(253_402_300_800_000), null);
	// A failed stat.
	assert.equal(mtimeIso(null), null);
	assert.equal(mtimeIso(Number.NaN), null);
	assert.equal(mtimeIso(8.64e15 + 1), null);
});

// inspectExport

test("inspectExport finds every family, the score file and the profile in the canonical export, and none of the never-read members", () => {
	const members = canonicalMembers();
	const result = inspected(inspectZip(members));
	const sizes = new Map(
		members.map((member) => [
			member.name,
			Buffer.isBuffer(member.data) ? member.data.length : -1,
		]),
	);
	const ref = (name: string, nameDate: string | null): MemberRef => ({
		name,
		part: 0,
		declaredBytes: sizes.get(name) ?? -1,
		nameDate,
	});
	const legacy = (base: string): MemberRef =>
		ref(legacyMember(base), DATE_NAMED.exec(base)?.[1] ?? null);
	assert.deepEqual(
		result.families,
		new Map<FamilyKey, MemberRef[]>([
			["exercise", [legacy("exercise-0.json")]],
			["sleep", [legacy("sleep-2026-03-14.json")]],
			[
				"steps",
				[legacy("steps-2026-04-04.json"), legacy("steps-2026-04-05.json")],
			],
			["distance", [legacy("distance-2026-04-04.json")]],
			[
				"lightly_active_minutes",
				[legacy("lightly_active_minutes-2026-04-03.json")],
			],
			[
				"moderately_active_minutes",
				[legacy("moderately_active_minutes-2026-04-03.json")],
			],
			["very_active_minutes", [legacy("very_active_minutes-2026-04-03.json")]],
			["resting_heart_rate", [legacy("resting_heart_rate-2026-04-03.json")]],
		]),
	);
	assert.equal(result.families.get("steps")?.[0]?.nameDate, "2026-04-04");
	assert.equal(result.families.get("exercise")?.[0]?.nameDate, null);
	assert.deepEqual(result.sleepScore, ref(sleepScoreMember(), null));
	assert.deepEqual(result.profile, ref(profileMember(), null));
	assert.deepEqual(duplicatesOf(result), {
		...noFamilies(),
		sleep_score: [],
		profile: [],
	});
	// The counterparts exist, but so do the legacy families.
	assert.deepEqual(result.googleEra, {
		activities: false,
		daily_summaries: false,
		sleep: false,
	});
	const chosen = new Set(
		[...result.families.values()].flat().map((member) => member.name),
	);
	for (const never of neverReadMembers()) {
		assert.ok(!chosen.has(never.name), never.name);
	}
});

test("the root is wherever Global Export Data/ sits, and the score file and profile resolve beside it", () => {
	const rows = canonicalRows();
	for (const root of [
		"Takeout/Fitbit/",
		"Takeout/Google Health/",
		"Takeout/Google\u00a0Health/",
		"export copy/Takeout/Fitbit/",
		"",
	]) {
		const result = inspected(
			inspectZip([
				jsonMember("steps-2026-04-04.json", rows.stepsFirst, root),
				{ name: sleepScoreMember(root), data: scoreCsv() },
				{ name: profileMember(root), data: profileCsv() },
				// Beside another root: never this export's.
				{ name: "Other/Sleep Score/sleep_score.csv", data: scoreCsv() },
			]),
		);
		assert.deepEqual(
			result.families.get("steps")?.map((member) => member.name),
			[legacyMember("steps-2026-04-04.json", root)],
			JSON.stringify(root),
		);
		assert.equal(result.sleepScore?.name, sleepScoreMember(root));
		assert.equal(result.profile?.name, profileMember(root));
	}
});

test("two Global Export Data/ roots are refused rather than guessed between, within a part or across parts", () => {
	const rows = canonicalRows();
	assert.deepEqual(
		refusal(
			inspectZip([
				jsonMember("steps-2026-04-04.json", rows.stepsFirst),
				jsonMember("badge.json", [{}], "Copy/Takeout/Fitbit/"),
			]),
		),
		{ failure: "ambiguous_root", code: null },
	);
	const dir = freshDir();
	const [first = "", second = ""] = writeParts(dir, [
		[jsonMember("steps-2026-04-04.json", rows.stepsFirst)],
		[
			jsonMember(
				"steps-2026-04-05.json",
				rows.stepsSecond,
				"Takeout/Google Health/",
			),
		],
	]);
	assert.deepEqual(refusal(inspectFiles([{ path: first }, { path: second }])), {
		failure: "ambiguous_root",
		code: null,
	});
});

test("an upload without Global Export Data/ is a layout change when a Google-era folder is there, else not a Fitbit export", () => {
	assert.deepEqual(
		refusal(
			inspectZip([
				{
					name: `${ROOT}Physical Activity_GoogleData/steps_2026-04-01.csv`,
					data: Buffer.from("timestamp,steps\n"),
				},
			]),
		),
		{ failure: "google_era_only", code: null },
	);
	for (const members of [
		[
			{
				name: "Takeout/YouTube and YouTube Music/history/watch-history.json",
				data: Buffer.from("[]"),
			},
		],
		[
			{
				name: `__MACOSX/${ROOT}Global Export Data/._steps-2026-04-04.json`,
				data: Buffer.from("Mac OS X"),
			},
			{ name: `${ROOT}Global Export Data/`, data: Buffer.alloc(0) },
		],
	]) {
		assert.deepEqual(refusal(inspectZip(members)), {
			failure: "not_fitbit",
			code: null,
		});
	}
});

test("a stream is a layout change only when its own legacy families are all gone and its counterpart is there", () => {
	const noSleep = inspected(inspectZip(canonicalMembers({ sleep: [] })));
	assert.deepEqual(noSleep.googleEra, {
		activities: false,
		daily_summaries: false,
		sleep: true,
	});
	// One daily family left is enough to keep the stream's legacy layout.
	const oneDaily = inspected(
		inspectZip(
			canonicalMembers({
				exercise: [],
				steps: [],
				distance: [],
				lightly_active_minutes: [],
				moderately_active_minutes: [],
				very_active_minutes: [],
			}),
		),
	);
	assert.deepEqual(oneDaily.googleEra, {
		activities: true,
		daily_summaries: false,
		sleep: false,
	});
	// Without the counterpart, an absent family is only absent.
	const bare = inspected(
		inspectZip(
			canonicalMembers({
				sleep: [],
				never_read: neverReadMembers().filter(
					(member) => !member.name.includes("UserSleeps_"),
				),
			}),
		),
	);
	assert.equal(bare.googleEra.sleep, false);
	// A family whose only member is duplicated across parts still has a member.
	const duplicated = writeParts(freshDir(), [
		canonicalMembers(),
		[jsonMember("sleep-2026-03-14.json", canonicalRows().sleep)],
	]);
	const kept = inspected(inspectFiles(duplicated.map((path) => ({ path }))));
	assert.deepEqual(kept.families.get("sleep"), []);
	assert.equal(kept.googleEra.sleep, false);
});

test("family members match by their whole basename, directly in Global Export Data/, and nothing like them does", () => {
	const data = Buffer.from("[]");
	const inspection = inspectZip(
		[
			"sedentary_minutes-2026-04-03.json",
			"heart_rate-2026-04-04.json",
			"time_in_heart_rate_zones-2026-04-04.json",
			"steps_readme.txt",
			"steps-2026-04-04.json.bak",
			"Steps-2026-04-04.json",
			"steps-2026-04-04.JSON",
			"._steps-2026-04-04.json",
			"steps-2026-4-4.json",
			"archive/steps-2026-04-04.json",
			"exercise-abc.json",
			"sleep-2026-03-14.csv",
			"resting_heart_rate_2026-04-03.json",
		]
			.map((base) => ({ name: legacyMember(base), data }))
			.concat([
				{
					name: `${ROOT}Physical Activity_GoogleData/steps_readme.txt`,
					data,
				},
				{
					name: `__MACOSX/${ROOT}Global Export Data/steps-2026-04-04.json`,
					data,
				},
				{ name: `${ROOT}Other/steps-2026-04-04.json`, data },
				{ name: `${ROOT}XGlobal Export Data/steps-2026-04-04.json`, data },
			]),
	);
	assert.deepEqual(familyNames(inspection), noFamilies());
});

test("exercise pages sort by their number, not their name", () => {
	const inspection = inspectZip(
		[
			"exercise-1000.json",
			"exercise-900.json",
			"exercise-0.json",
			"exercise-100.json",
		].map((base) => jsonMember(base, [])),
	);
	assert.deepEqual(familyNames(inspection).exercise, [
		legacyMember("exercise-0.json"),
		legacyMember("exercise-100.json"),
		legacyMember("exercise-900.json"),
		legacyMember("exercise-1000.json"),
	]);
});

test("members of one export merge across its parts, each keeping its part", () => {
	const dir = freshDir();
	const paths = writeParts(dir, [
		canonicalMembers({ steps: [], never_read: [] }),
		canonicalMembers({
			exercise: [],
			sleep: [],
			distance: [],
			lightly_active_minutes: [],
			moderately_active_minutes: [],
			very_active_minutes: [],
			resting_heart_rate: [],
			sleep_score: [],
			profile: [],
		}),
	]);
	const result = inspected(inspectFiles(paths.map((path) => ({ path }))));
	assert.deepEqual(
		FAMILY_KEYS.map((family) =>
			(result.families.get(family) ?? []).map((member) => member.part),
		),
		[[0], [0], [1, 1], [0], [0], [0], [0], [0]],
	);
	assert.equal(result.sleepScore?.part, 0);
});

test("a member in two parts of one middle number is read from neither, and its name date is kept", () => {
	const rows = canonicalRows();
	const shared = [
		jsonMember("steps-2026-04-04.json", rows.stepsFirst),
		{ name: sleepScoreMember(), data: scoreCsv() },
		{ name: profileMember(), data: profileCsv() },
	];
	const dir = freshDir();
	const paths = writeParts(dir, [
		canonicalMembers(),
		[...shared, jsonMember("sleep-2026-04-13.json", [])],
		// A third copy is still one duplicated member.
		shared.slice(0, 1),
	]);
	const result = inspected(inspectFiles(paths.map((path) => ({ path }))));
	assert.deepEqual(familyNames(result).steps, [
		legacyMember("steps-2026-04-05.json"),
	]);
	assert.deepEqual(familyNames(result).sleep, [
		legacyMember("sleep-2026-03-14.json"),
		legacyMember("sleep-2026-04-13.json"),
	]);
	assert.equal(result.families.get("sleep")?.[1]?.part, 1);
	assert.equal(result.sleepScore, null);
	assert.equal(result.profile, null);
	assert.deepEqual(duplicatesOf(result), {
		...noFamilies(),
		steps: ["2026-04-04"],
		sleep_score: [null],
		profile: [null],
	});
	assert.deepEqual(result.googleEra, {
		activities: false,
		daily_summaries: false,
		sleep: false,
	});
});

test("two middle numbers that share a file this import reads refuse the upload; disjoint ones merge", () => {
	const both = freshDir();
	const [a1 = "", b1 = ""] = writeParts(
		both,
		[canonicalMembers(), canonicalMembers()],
		(part) => partName(1, part),
	);
	assert.deepEqual(
		refusal(
			inspectFiles([
				{ path: a1, group: "1" },
				{ path: b1, group: "2" },
			]),
		),
		{ failure: "parts", code: null },
	);

	const profileOnly = freshDir();
	const [c1 = "", d1 = ""] = writeParts(
		profileOnly,
		[canonicalMembers(), [{ name: profileMember(), data: profileCsv() }]],
		(part) => partName(1, part),
	);
	assert.deepEqual(
		refusal(
			inspectFiles([
				{ path: c1, group: "1" },
				{ path: d1, group: "2" },
			]),
		),
		{ failure: "parts", code: null },
	);

	// A shared file this import never reads does not matter.
	const neverRead = freshDir();
	const [e1 = "", f1 = ""] = writeParts(
		neverRead,
		[
			canonicalMembers({ steps: [] }),
			canonicalMembers({
				exercise: [],
				sleep: [],
				distance: [],
				lightly_active_minutes: [],
				moderately_active_minutes: [],
				very_active_minutes: [],
				resting_heart_rate: [],
				sleep_score: [],
				profile: [],
			}),
		],
		(part) => partName(1, part),
	);
	const disjoint = inspected(
		inspectFiles([
			{ path: e1, group: "1" },
			{ path: f1, group: "2" },
		]),
	);
	assert.deepEqual(
		familyNames(disjoint),
		familyNames(inspectZip(canonicalMembers())),
	);
	assert.deepEqual(
		disjoint.families.get("steps")?.map((member) => member.part),
		[1, 1],
	);
});

/**
 * An open file whose first bytes fail to read with EIO, a device error:
 * Linux's /proc/self/mem, unmapped at address 0. Null where that file is
 * missing or cannot be opened.
 */
function deviceFailingPart(): OpenPart | null {
	let fd: number;
	try {
		fd = openSync("/proc/self/mem", "r");
	} catch {
		return null;
	}
	try {
		readSync(fd, Buffer.alloc(4), 0, 4, 0);
	} catch (error) {
		if (errorCode(error) === "EIO") {
			return { fd, size: 1_000_000, group: "1" };
		}
	}
	closeSync(fd);
	return null;
}

test("one refused part refuses the upload, the device first, then size, then damage", (t) => {
	const good = canonicalZip(freshDir());
	const text = fileOf(Buffer.from("not a zip at all, just text\n".repeat(4)));
	const gzip = freshPath();
	writeGzipLookalike(gzip);
	const sentinel = freshPath();
	writeZip64SentinelZip(sentinel);
	const opened: number[] = [];
	const open = (path: string): OpenPart => {
		const fd = openSync(path, "r");
		opened.push(fd);
		return { fd, size: statSync(path).size, group: "1" };
	};
	try {
		assert.deepEqual(
			refusal(inspectExport([open(text), open(sentinel), open(good)])),
			{ failure: "zip64", code: null },
		);
		assert.deepEqual(refusal(inspectExport([open(good), open(text)])), {
			failure: "not_zip",
			code: null,
		});
		// Among equals, the first part to fail.
		assert.deepEqual(refusal(inspectExport([open(gzip), open(text)])), {
			failure: "gzip",
			code: null,
		});
		const device = deviceFailingPart();
		if (device === null) {
			t.skip("no file here fails to read with EIO");
			return;
		}
		opened.push(device.fd);
		assert.deepEqual(
			refusal(inspectExport([open(good), open(text), open(sentinel), device])),
			{ failure: "device", code: "EIO" },
		);
	} finally {
		for (const fd of opened) {
			closeSync(fd);
		}
	}
});

// extractMember

/** Opens every part of `paths`, runs `use`, and closes them. */
async function withParts<T>(
	paths: readonly string[],
	use: (parts: OpenPart[], inspection: Inspected) => Promise<T>,
): Promise<T> {
	const parts = paths.map((path) => ({
		fd: openSync(path, "r"),
		size: statSync(path).size,
		group: "1",
	}));
	try {
		return await use(parts, inspected(inspectExport(parts)));
	} finally {
		for (const { fd } of parts) {
			closeSync(fd);
		}
	}
}

test("extractMember writes one member from its own part, byte for byte, under a numbered scratch name", async () => {
	const members = canonicalMembers();
	const paths = canonicalParts(freshDir(), 2, members);
	const scratch = freshDir();
	await withParts(paths, async (parts, inspection) => {
		const sleep = inspection.families.get("sleep")?.[0];
		const profile = inspection.profile;
		assert.ok(sleep && profile);
		assert.notEqual(sleep.part, profile.part);
		const first = await extractMember(
			parts,
			sleep,
			scratch,
			7,
			MEMBER_MAX_BYTES,
		);
		const second = await extractMember(
			parts,
			profile,
			scratch,
			8,
			MEMBER_MAX_BYTES,
		);
		assert.deepEqual(first, { ok: true, path: join(scratch, "member-7") });
		assert.deepEqual(second, { ok: true, path: join(scratch, "member-8") });
		const byName = new Map(members.map((member) => [member.name, member.data]));
		assert.deepEqual(
			readFileSync(join(scratch, "member-7")),
			byName.get(sleep.name),
		);
		assert.deepEqual(
			readFileSync(join(scratch, "member-8")),
			byName.get(profile.name),
		);
	});
	assert.deepEqual(readdirSync(scratch).sort(), ["member-7", "member-8"]);
});

test("extractMember refuses a member declaring more than its cap without extracting it", async () => {
	const rows = canonicalRows();
	const path = zipFile([
		{
			...jsonMember("sleep-2026-03-14.json", rows.sleep),
			declaredSize: 300 * MIB,
		},
		{
			...jsonMember("steps-2026-04-04.json", rows.stepsFirst),
			declaredSize: 17 * MIB,
		},
		jsonMember("steps-2026-04-05.json", rows.stepsSecond),
	]);
	const scratch = freshDir();
	await withParts([path], async (parts, inspection) => {
		const [lying] = inspection.families.get("sleep") ?? [];
		const [overMinuteCap, small] = inspection.families.get("steps") ?? [];
		assert.ok(lying && overMinuteCap && small);
		assert.deepEqual(lying.declaredBytes, 300 * MIB);
		const tooLarge = { ok: false, failure: "too_large", code: null };
		assert.deepEqual(
			await extractMember(parts, lying, scratch, 1, MEMBER_MAX_BYTES),
			tooLarge,
		);
		assert.deepEqual(
			await extractMember(
				parts,
				overMinuteCap,
				scratch,
				2,
				MINUTE_MEMBER_MAX_BYTES,
			),
			tooLarge,
		);
		assert.deepEqual(
			await extractMember(parts, small, scratch, 3, small.declaredBytes - 1),
			tooLarge,
		);
		assert.deepEqual(readdirSync(scratch), []);
		// At its cap, a member is still read.
		assert.deepEqual(
			await extractMember(parts, small, scratch, 4, small.declaredBytes),
			{
				ok: true,
				path: join(scratch, "member-4"),
			},
		);
	});
});

test("extractMember reports a member that inflates to any size but the one it declares as interrupted, leaving no file", async () => {
	const rows = canonicalRows();
	const data = jsonMember("steps-2026-04-04.json", rows.stepsFirst);
	const scratch = freshDir();
	for (const [n, declaredSize] of [
		[1, (data.data as Buffer).length + 1],
		[2, (data.data as Buffer).length - 1],
	] as const) {
		for (const method of ["deflate", "store"] as const) {
			await withParts(
				[zipFile([{ ...data, declaredSize, method }])],
				async (parts, inspection) => {
					const [member] = inspection.families.get("steps") ?? [];
					assert.ok(member);
					assert.equal(member.declaredBytes, declaredSize);
					assert.deepEqual(
						await extractMember(parts, member, scratch, n, MEMBER_MAX_BYTES),
						{
							ok: false,
							failure: "interrupted",
							code: null,
						},
					);
				},
			);
		}
	}
	assert.deepEqual(readdirSync(scratch), []);
});

test("extractMember reports a missing, damaged or unsupported member as interrupted and leaves no partial file", async () => {
	const name = legacyMember("exercise-0.json");
	const data = Buffer.from(JSON.stringify([{ logId: 21_000_000_001 }]));
	const good = zipBytes([{ name, data }]);

	// Deflate data whose first block has the reserved type.
	const damaged = Buffer.from(good);
	const dataStart = 30 + Buffer.byteLength(name);
	damaged.fill(0xff, dataStart, dataStart + 8);

	// Compression method 9 (Deflate64), which the shared reader does not support.
	const unsupported = Buffer.from(good);
	unsupported.writeUInt16LE(
		9,
		unsupported.indexOf(CENTRAL_HEADER_SIGNATURE) + 10,
	);

	const scratch = freshDir();
	const extract = (
		bytes: Buffer,
		member: MemberRef,
		n: number,
	): Promise<unknown> =>
		withParts([fileOf(bytes)], (parts) =>
			extractMember(parts, member, scratch, n, MEMBER_MAX_BYTES),
		);
	const ref: MemberRef = {
		name,
		part: 0,
		declaredBytes: data.length,
		nameDate: null,
	};
	const missing = await extract(good, { ...ref, name: `${name}.missing` }, 1);
	const broken = await extract(damaged, ref, 2);
	const method = await extract(unsupported, ref, 3);
	assert.deepEqual(missing, { ok: false, failure: "interrupted", code: null });
	assert.deepEqual(broken, {
		ok: false,
		failure: "interrupted",
		code: "Z_DATA_ERROR",
	});
	assert.deepEqual(method, { ok: false, failure: "interrupted", code: null });
	assert.deepEqual(readdirSync(scratch), []);
	for (const result of [missing, broken, method]) {
		assertNoName(result, ["exercise-0"]);
	}
});

/** Two members; the second as a writer stores it past a part-way switch to ZIP64. */
function switchedMembers(): ZipMember[] {
	const rows = canonicalRows();
	return [
		jsonMember("sleep-2026-03-14.json", rows.sleep),
		{ ...jsonMember("exercise-0.json", rows.exercise), offsetSentinel: true },
	];
}

test("extractMember reports a member past a part-way switch to ZIP64 as too large, not damaged", async () => {
	// Python's zipfile switches at 2 GiB: its classic end record keeps real
	// values, so the part lists, but a member stored past the switch has
	// ZIP64's sentinel for its offset, and asking for a fresh export would
	// only fail the same way. The hole before the central directory is sparse.
	mkdirSync(LARGE_FIXTURE_BASE_DIR, { recursive: true });
	const dir = mkdtempSync(join(LARGE_FIXTURE_BASE_DIR, "pdpp-fitbit-switch-"));
	const scratch = freshDir();
	try {
		const located = join(dir, partName(1));
		writeZip64LocatorZip(
			located,
			switchedMembers(),
			PAST_ZIP64_SWITCH_GAP_BYTES,
		);
		assert.ok(statSync(located).size > PAST_ZIP64_SWITCH_GAP_BYTES);
		assert.equal(withFd(located, needsZip64), false);
		await withParts([located], async (parts, inspection) => {
			const sleep = inspection.families.get("sleep")?.[0];
			const exercise = inspection.families.get("exercise")?.[0];
			assert.ok(sleep && exercise);
			assert.deepEqual(
				await extractMember(parts, sleep, scratch, 1, MEMBER_MAX_BYTES),
				{
					ok: true,
					path: join(scratch, "member-1"),
				},
			);
			assert.deepEqual(
				await extractMember(parts, exercise, scratch, 2, MEMBER_MAX_BYTES),
				{
					ok: false,
					failure: "too_large",
					code: null,
				},
			);
		});
	} finally {
		rmSync(dir, { force: true, recursive: true });
	}
	assert.deepEqual(readdirSync(scratch), ["member-1"]);
});

test("extractMember reports a member it cannot find as damaged under 2 GiB, ZIP64 records or not", async () => {
	const members = switchedMembers();
	const scratch = freshDir();
	const damaged = { ok: false, failure: "interrupted", code: null } as const;
	const exerciseOf = async (path: string, n: number): Promise<unknown> =>
		withParts([path], (parts, inspection) => {
			const exercise = inspection.families.get("exercise")?.[0];
			assert.ok(exercise);
			return extractMember(parts, exercise, scratch, n, MEMBER_MAX_BYTES);
		});

	// Without ZIP64 records, a member at ZIP64's offset sentinel is damaged.
	assert.deepEqual(await exerciseOf(zipFile(members), 1), damaged);

	// With them, but too small for any known writer to have switched yet.
	const small = freshPath();
	writeZip64LocatorZip(small, members);
	assert.deepEqual(await exerciseOf(small, 2), damaged);

	// A local header damaged before any switch, in a small part with ZIP64 records.
	const intact = freshPath();
	writeZip64LocatorZip(
		intact,
		members.map((member) => ({ ...member, offsetSentinel: false })),
	);
	const bytes = readFileSync(intact);
	const second = bytes.indexOf(LOCAL_HEADER_SIGNATURE, 4);
	assert.ok(second > 0);
	bytes[second + 3] = 0x00;
	assert.deepEqual(await exerciseOf(fileOf(bytes), 3), damaged);
	assert.deepEqual(readdirSync(scratch), []);
});

test("extractMember reports a scratch folder that is gone as the device's", async () => {
	const path = canonicalZip(freshDir());
	await withParts([path], async (parts, inspection) => {
		const member = inspection.families.get("resting_heart_rate")?.[0];
		assert.ok(member);
		assert.deepEqual(
			await extractMember(
				parts,
				member,
				join(TEMP, "no-such-scratch"),
				1,
				MEMBER_MAX_BYTES,
			),
			{ ok: false, failure: "device", code: "ENOENT" },
		);
	});
});

// Errors

test("isDeviceError accepts the device codes and rejects every other error", () => {
	const withCode = (code: unknown): Error =>
		Object.assign(new Error("message naming a path"), { code });
	for (const code of [
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
	]) {
		assert.equal(isDeviceError(withCode(code)), true, code);
	}
	for (const error of [
		withCode("EBADF"),
		withCode("EISDIR"),
		withCode("EEXIST"),
		withCode("Z_DATA_ERROR"),
		withCode(5),
		new ZipPolicyViolationError("entry_too_large", "too large"),
		new Error("EIO"),
		"EIO",
		{ code: "eio" },
		null,
		undefined,
	]) {
		assert.equal(isDeviceError(error), false, String(error));
	}

	let thrown: unknown;
	try {
		readdirSync(join(TEMP, "no-such-folder"));
	} catch (error) {
		thrown = error;
	}
	assert.equal(isDeviceError(thrown), true);
	assert.equal(errorCode(thrown), "ENOENT");
});

test("errorCode passes on only a plain identifier, never text that could carry a name", () => {
	assert.equal(
		errorCode({ code: "ERR_STREAM_PREMATURE_CLOSE" }),
		"ERR_STREAM_PREMATURE_CLOSE",
	);
	assert.equal(
		errorCode({ code: `${ROOT}Global Export Data/steps-2026-04-04.json` }),
		null,
	);
	assert.equal(errorCode({ code: "two words" }), null);
	assert.equal(errorCode({ code: "E".repeat(65) }), null);
	assert.equal(errorCode({ code: 13 }), null);
	assert.equal(errorCode(new Error("EIO")), null);
});
