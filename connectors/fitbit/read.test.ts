// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import {
	closeSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
	canonicalMembers,
	canonicalRows,
	csv,
	EXPORTED_AT,
	fitbitJson,
	type JsonValue,
	jsonMember,
	minute,
	PROFILE_HEADER,
	PROFILE_ROW,
	profileCsv,
	profileMember,
	SCORE_HEADER,
	SCORE_ROWS,
	scoreCsv,
	sleepScoreMember,
	truncatedCsv,
	truncatedJson,
} from "./__fixtures__/synthetic-export.ts";
import { writeZip, type ZipMember } from "./__fixtures__/zip.ts";
import {
	type ExportInspection,
	inspectExport,
	MEMBER_MAX_BYTES,
	MINUTE_MEMBER_MAX_BYTES,
	PROFILE_MAX_BYTES,
	SLEEP_SCORE_MAX_BYTES,
} from "./archive.ts";
import type { SourceObject } from "./parsers.ts";
import {
	type ArchiveIo,
	type CsvLimits,
	emptyWalk,
	type MemberEnd,
	PROFILE_CSV_LIMITS,
	readCsvRows,
	readMemberValues,
	SLEEP_SCORE_CSV_LIMITS,
	type WalkResult,
	walkCsvMember,
	walkJsonFamily,
} from "./read.ts";

const TEMP = mkdtempSync(join(tmpdir(), "pdpp-fitbit-read-test-"));
const MIB = 1024 * 1024;
const CHUNK = 65_536;
const CLEAN: WalkResult = emptyWalk();

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

function memberFile(contents: Buffer | string): string {
	const path = join(freshDir(), "member-0");
	writeFileSync(path, contents);
	return path;
}

function collect<T>(into: T[]): (value: T) => Promise<void> {
	return (value) => {
		into.push(value);
		return Promise.resolve();
	};
}

/** A row handler that keeps every row and asks for more. */
function keep(into: string[][]): (cells: readonly string[]) => Promise<"more"> {
	return (cells) => {
		into.push([...cells]);
		return Promise.resolve("more");
	};
}

/** A UTC instant as the legacy files write it, `MM/DD/YY HH:MM:SS`. */
function legacyInstant(ms: number): string {
	const date = new Date(ms);
	const two = (n: number): string => String(n).padStart(2, "0");
	return `${two(date.getUTCMonth() + 1)}/${two(date.getUTCDate())}/${two(date.getUTCFullYear() % 100)} ${two(date.getUTCHours())}:${two(date.getUTCMinutes())}:00`;
}

/** Enough minutes that a member spans many 64 KiB reads. */
function manyMinutes(count: number): JsonValue[] {
	return Array.from({ length: count }, (_, index) =>
		minute(legacyInstant(Date.UTC(2026, 3, 4) + index * 60_000), String(index)),
	);
}

function valuesOf(values: readonly unknown[]): unknown[] {
	return values.map((value) =>
		typeof value === "object" && value !== null && "value" in value
			? value.value
			: value,
	);
}

type Inspected = Extract<ExportInspection, { ok: true }>;

/** Writes `parts` as one export, opens it, and hands `use` the open upload. */
async function withExport<T>(
	parts: readonly (readonly ZipMember[])[],
	use: (io: ArchiveIo, inspection: Inspected) => Promise<T>,
	scratchDir: string = freshDir(),
): Promise<T> {
	const dir = freshDir();
	const open = parts.map((members, index) => {
		const path = join(
			dir,
			`takeout-20260920T081500Z-1-00${String(index + 1)}.zip`,
		);
		writeZip(path, members);
		return { fd: openSync(path, "r"), size: statSync(path).size, group: "1" };
	});
	try {
		const inspection = inspectExport(open);
		if (!inspection.ok) {
			throw new Error(`fixture refused: ${inspection.failure}`);
		}
		return await use(
			{ parts: open, scratchDir, exportedAt: EXPORTED_AT, nextScratchIndex: 0 },
			inspection,
		);
	} finally {
		for (const { fd } of open) {
			closeSync(fd);
		}
	}
}

/** A CSV member alone, beside the one legacy member that places the export's root. */
function csvOnly(member: ZipMember): ZipMember[] {
	return [jsonMember("badge.json", []), member];
}

/** Records every value's member index and every member's end. */
function recorder(): {
	readonly values: [number, SourceObject][];
	readonly ends: [number, MemberEnd][];
	readonly handler: {
		readonly value: (obj: SourceObject, index: number) => Promise<void>;
		readonly memberDone: (index: number, end: MemberEnd) => void;
	};
} {
	const values: [number, SourceObject][] = [];
	const ends: [number, MemberEnd][] = [];
	return {
		values,
		ends,
		handler: {
			value: (obj, index) => {
				values.push([index, obj]);
				return Promise.resolve();
			},
			memberDone: (index, end) => {
				ends.push([index, end]);
			},
		},
	};
}

// readMemberValues

test("readMemberValues delivers every value in file order across many reads, E-notation included", async () => {
	const values = manyMinutes(6000);
	const path = memberFile(fitbitJson(values));
	assert.ok(statSync(path).size > 4 * CHUNK);
	const got: unknown[] = [];
	assert.equal(await readMemberValues(path, collect(got)), "complete");
	assert.deepEqual(
		valuesOf(got),
		values.map((_, index) => String(index)),
	);

	// Fitbit writes a large double in E-notation.
	const enotation: unknown[] = [];
	assert.equal(
		await readMemberValues(
			memberFile('[{\n  "logId" : 21000000001,\n  "distance" : 1.2345E7\n}]'),
			collect(enotation),
		),
		"complete",
	);
	assert.deepEqual(enotation, [
		{ logId: 21_000_000_001, distance: 12_345_000 },
	]);
});

test("readMemberValues hands on each property value of a root object, as it does each element of a root array", async () => {
	const got: unknown[] = [];
	assert.equal(
		await readMemberValues(
			memberFile('{"a":{"logId":1},"b":[1,2],"c":3}'),
			collect(got),
		),
		"complete",
	);
	assert.deepEqual(got, [{ logId: 1 }, [1, 2], 3]);
});

test("a pretty-printed member reads exactly as the same member minified", async () => {
	const rows = canonicalRows();
	for (const values of [rows.exercise, rows.sleep, rows.restingHeartRate]) {
		const pretty: unknown[] = [];
		const minified: unknown[] = [];
		const prettyText = fitbitJson(values);
		assert.ok(prettyText.toString().split("\n").length > values.length * 3);
		assert.equal(
			await readMemberValues(memberFile(prettyText), collect(pretty)),
			"complete",
		);
		assert.equal(
			await readMemberValues(
				memberFile(JSON.stringify(values)),
				collect(minified),
			),
			"complete",
		);
		assert.deepEqual(pretty, minified);
		assert.equal(pretty.length, values.length);
	}
});

test("readMemberValues rejects with the error onValue throws, rather than reporting the member as cut short", async () => {
	const path = memberFile(fitbitJson(manyMinutes(4000)));
	const bug = new Error("builder bug");
	const throwOn = (nth: number): ((value: unknown) => Promise<void>) => {
		let seen = 0;
		return () => {
			seen += 1;
			return seen === nth ? Promise.reject(bug) : Promise.resolve();
		};
	};
	await assert.rejects(readMemberValues(path, throwOn(2)), bug);
	// In a later read, too.
	await assert.rejects(readMemberValues(path, throwOn(3500)), bug);
	// A synchronous throw from the handler propagates the same way.
	await assert.rejects(
		readMemberValues(path, () => {
			throw bug;
		}),
		bug,
	);
});

test("readMemberValues delivers the whole values before a break, then reports the member interrupted", async () => {
	const rows = canonicalRows().stepsFirst;
	const truncated: unknown[] = [];
	assert.equal(
		await readMemberValues(
			memberFile(truncatedJson(rows, 3)),
			collect(truncated),
		),
		"interrupted",
	);
	assert.deepEqual(truncated, rows.slice(0, 3));

	const corrupt: unknown[] = [];
	assert.equal(
		await readMemberValues(
			memberFile('[{"a":1},{"b":2},{"c" x},{"d":4}]'),
			collect(corrupt),
		),
		"interrupted",
	);
	assert.deepEqual(corrupt, [{ a: 1 }, { b: 2 }]);

	// Broken many reads in: everything before the break still arrives.
	const values = manyMinutes(4000);
	const late: unknown[] = [];
	assert.equal(
		await readMemberValues(
			memberFile(truncatedJson(values, 3500)),
			collect(late),
		),
		"interrupted",
	);
	assert.equal(late.length, 3500);
});

test("readMemberValues ignores text after the root closes", async () => {
	const rows = canonicalRows().distance;
	const sameRead: unknown[] = [];
	assert.equal(
		await readMemberValues(
			memberFile(Buffer.concat([fitbitJson(rows), Buffer.from("\nxyz")])),
			collect(sameRead),
		),
		"complete",
	);
	assert.deepEqual(sameRead, rows);

	const values = manyMinutes(500);
	const trailing: unknown[] = [];
	assert.equal(
		await readMemberValues(
			memberFile(
				Buffer.concat([
					fitbitJson(values),
					Buffer.from("\n}{ not json ".repeat(20_000)),
				]),
			),
			collect(trailing),
		),
		"complete",
	);
	assert.equal(trailing.length, 500);
});

test("readMemberValues reports an empty member as interrupted, and an empty array as complete", async () => {
	const read = async (contents: string): Promise<[string, number]> => {
		const got: unknown[] = [];
		const end = await readMemberValues(memberFile(contents), collect(got));
		return [end, got.length];
	};
	assert.deepEqual(await read(""), ["interrupted", 0]);
	assert.deepEqual(await read("  \n"), ["interrupted", 0]);
	assert.deepEqual(await read("[]"), ["complete", 0]);
	assert.deepEqual(await read("[ ]"), ["complete", 0]);
});

test("readMemberValues tells a failed device read from a failed file read", async () => {
	const nothing: unknown[] = [];
	assert.equal(
		await readMemberValues(join(TEMP, "no-such-member"), collect(nothing)),
		"device",
	);
	assert.equal(
		await readMemberValues(freshDir(), collect(nothing)),
		"interrupted",
	);
	assert.deepEqual(nothing, []);
});

test("readMemberValues waits for each value to be handled before handing over the next", async () => {
	let inFlight = 0;
	let most = 0;
	let handled = 0;
	const end = await readMemberValues(
		memberFile(fitbitJson(manyMinutes(3000))),
		async () => {
			inFlight += 1;
			most = Math.max(most, inFlight);
			await new Promise((resolve) => setImmediate(resolve));
			inFlight -= 1;
			handled += 1;
		},
	);
	assert.equal(end, "complete");
	assert.equal(handled, 3000);
	assert.equal(most, 1);
});

// readCsvRows

test("readCsvRows reads CRLF and LF alike, skips a BOM, and keeps what quotes hold", async () => {
	const lf: string[][] = [];
	const crlf: string[][] = [];
	assert.equal(
		await readCsvRows(memberFile(scoreCsv()), SLEEP_SCORE_CSV_LIMITS, keep(lf)),
		"complete",
	);
	assert.equal(
		await readCsvRows(
			memberFile(csv([SCORE_HEADER, ...SCORE_ROWS], "\r\n")),
			SLEEP_SCORE_CSV_LIMITS,
			keep(crlf),
		),
		"complete",
	);
	assert.deepEqual(lf, [SCORE_HEADER, ...SCORE_ROWS]);
	assert.deepEqual(crlf, lf);

	const bom: string[][] = [];
	assert.equal(
		await readCsvRows(
			memberFile(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), scoreCsv()])),
			SLEEP_SCORE_CSV_LIMITS,
			keep(bom),
		),
		"complete",
	);
	assert.deepEqual(bom, lf);

	// The profile's quoted cell holds a comma and a CRLF; a doubled quote is one quote.
	const profile: string[][] = [];
	assert.equal(
		await readCsvRows(
			memberFile(profileCsv()),
			PROFILE_CSV_LIMITS,
			keep(profile),
		),
		"complete",
	);
	assert.deepEqual(profile, [PROFILE_HEADER, PROFILE_ROW]);
	const quoted: string[][] = [];
	assert.equal(
		await readCsvRows(
			memberFile('a,"say ""hi"", then\r\nleave",c\n,,\n'),
			PROFILE_CSV_LIMITS,
			keep(quoted),
		),
		"complete",
	);
	assert.deepEqual(quoted, [
		["a", 'say "hi", then\r\nleave', "c"],
		["", "", ""],
	]);
});

test("readCsvRows delivers a last row that has no line break", async () => {
	const rows: string[][] = [];
	assert.equal(
		await readCsvRows(
			memberFile("id,score\n31000000001,81"),
			SLEEP_SCORE_CSV_LIMITS,
			keep(rows),
		),
		"complete",
	);
	assert.deepEqual(rows, [
		["id", "score"],
		["31000000001", "81"],
	]);
	const quotedLast: string[][] = [];
	assert.equal(
		await readCsvRows(
			memberFile('id,note\r\n1,"two\r\nlines"'),
			PROFILE_CSV_LIMITS,
			keep(quotedLast),
		),
		"complete",
	);
	assert.deepEqual(quotedLast, [
		["id", "note"],
		["1", "two\r\nlines"],
	]);
	const empty: string[][] = [];
	assert.equal(
		await readCsvRows(memberFile(""), PROFILE_CSV_LIMITS, keep(empty)),
		"complete",
	);
	assert.deepEqual(empty, []);
});

test("readCsvRows reads a quote that falls at the end of a read chunk", async () => {
	// Place a doubled quote, then a closing quote, exactly across 64 KiB boundaries.
	const limits: CsvLimits = {
		maxFieldChars: 4 * CHUNK,
		maxCells: 8,
		maxRows: 8,
	};
	const head = `a,"${"x".repeat(CHUNK - 4)}`;
	const doubled = `${head}""${"y".repeat(CHUNK - 3)}",b\n`;
	// The first read ends between the two quotes of the pair.
	assert.equal(doubled.slice(CHUNK - 2, CHUNK + 2), 'x""y');
	const rows: string[][] = [];
	assert.equal(
		await readCsvRows(memberFile(doubled), limits, keep(rows)),
		"complete",
	);
	assert.deepEqual(rows, [
		["a", `${"x".repeat(CHUNK - 4)}"${"y".repeat(CHUNK - 3)}`, "b"],
	]);

	const closing = `${head}",b\nc,d\n`;
	// The first read ends on the closing quote.
	assert.equal(closing.slice(CHUNK - 2, CHUNK + 1), 'x",');
	const closed: string[][] = [];
	assert.equal(
		await readCsvRows(memberFile(closing), limits, keep(closed)),
		"complete",
	);
	assert.deepEqual(closed, [
		["a", "x".repeat(CHUNK - 4), "b"],
		["c", "d"],
	]);
});

test("readCsvRows reports a file that ends inside quotes as interrupted, after the rows before it", async () => {
	const rows: string[][] = [];
	assert.equal(
		await readCsvRows(
			memberFile(truncatedCsv(profileCsv(), "CANARY_ABOUT")),
			PROFILE_CSV_LIMITS,
			keep(rows),
		),
		"interrupted",
	);
	assert.deepEqual(rows, [PROFILE_HEADER]);
});

test("readCsvRows stops at a cell, a row or a file past its limits", async () => {
	const limits = PROFILE_CSV_LIMITS;
	const at = async (text: string): Promise<[string, number]> => {
		const rows: string[][] = [];
		const end = await readCsvRows(memberFile(text), limits, keep(rows));
		return [end, rows.length];
	};
	assert.deepEqual(await at(`h\n${"x".repeat(16_384)}\n`), ["complete", 2]);
	assert.deepEqual(await at(`h\n${"x".repeat(16_385)}\n`), ["too_long", 1]);
	// Inside quotes, and on a last row without a line break, too.
	assert.deepEqual(await at(`h\n"${"x".repeat(16_385)}"\n`), ["too_long", 1]);
	assert.deepEqual(await at(`h\n${"x".repeat(16_385)}`), ["too_long", 1]);
	assert.deepEqual(await at(`${Array(256).fill("c").join(",")}\n`), [
		"complete",
		1,
	]);
	assert.deepEqual(await at(`${Array(257).fill("c").join(",")}\n`), [
		"too_long",
		0,
	]);
	assert.deepEqual(await at(`h\n${Array(257).fill("c").join(",")}`), [
		"too_long",
		1,
	]);
	assert.deepEqual(await at("h\nr\n"), ["complete", 2]);
	assert.deepEqual(await at("h\nr\ns\n"), ["too_long", 2]);
	assert.deepEqual(await at("h\nr\ns"), ["too_long", 2]);

	const scores = `${[SCORE_HEADER.join(","), ...Array(200_000).fill("31000000001,,81,,,,,,")].join("\n")}\n`;
	const rows: string[][] = [];
	assert.equal(
		await readCsvRows(memberFile(scores), SLEEP_SCORE_CSV_LIMITS, keep(rows)),
		"too_long",
	);
	assert.equal(rows.length, 200_000);
});

test('readCsvRows ends "complete" when onRow says "stop"', async () => {
	const rows: string[][] = [];
	const end = await readCsvRows(
		memberFile(profileCsv([PROFILE_ROW, PROFILE_ROW, PROFILE_ROW])),
		{ ...PROFILE_CSV_LIMITS, maxRows: 4 },
		(cells) => {
			rows.push([...cells]);
			return Promise.resolve(rows.length === 2 ? "stop" : "more");
		},
	);
	assert.equal(end, "complete");
	assert.deepEqual(rows, [PROFILE_HEADER, PROFILE_ROW]);

	// Stopping at the last row the limits allow is not a breach, however much follows.
	const header: string[][] = [];
	assert.equal(
		await readCsvRows(
			memberFile(profileCsv([PROFILE_ROW, PROFILE_ROW])),
			PROFILE_CSV_LIMITS,
			(cells) => {
				header.push([...cells]);
				return Promise.resolve(header.length === 2 ? "stop" : "more");
			},
		),
		"complete",
	);
});

test("readCsvRows rejects with the error onRow throws", async () => {
	const bug = new Error("handler bug");
	await assert.rejects(
		readCsvRows(memberFile(scoreCsv()), SLEEP_SCORE_CSV_LIMITS, () =>
			Promise.reject(bug),
		),
		bug,
	);
	await assert.rejects(
		readCsvRows(memberFile("a\nb"), SLEEP_SCORE_CSV_LIMITS, (cells) =>
			cells[0] === "b" ? Promise.reject(bug) : Promise.resolve("more"),
		),
		bug,
	);
	await assert.rejects(
		readCsvRows(memberFile(scoreCsv()), SLEEP_SCORE_CSV_LIMITS, () => {
			throw bug;
		}),
		bug,
	);
});

test("readCsvRows tells a failed device read from a failed file read", async () => {
	const rows: string[][] = [];
	assert.equal(
		await readCsvRows(
			join(TEMP, "no-such-member"),
			PROFILE_CSV_LIMITS,
			keep(rows),
		),
		"device",
	);
	assert.equal(
		await readCsvRows(freshDir(), PROFILE_CSV_LIMITS, keep(rows)),
		"interrupted",
	);
	assert.deepEqual(rows, []);
});

// walkJsonFamily

test("walkJsonFamily hands over every object with its member's index, says how each member ended, and removes each scratch file", async () => {
	const rows = canonicalRows();
	const scratch = freshDir();
	const seen = recorder();
	await withExport(
		[canonicalMembers()],
		async (io, inspection) => {
			const steps = inspection.families.get("steps") ?? [];
			assert.equal(steps.length, 2);
			assert.deepEqual(
				await walkJsonFamily(io, steps, MINUTE_MEMBER_MAX_BYTES, seen.handler),
				{
					...CLEAN,
					files: 2,
				},
			);
			assert.equal(io.nextScratchIndex, 2);
		},
		scratch,
	);
	assert.deepEqual(seen.values, [
		...rows.stepsFirst.map((row): [number, SourceObject] => [0, row]),
		...rows.stepsSecond.map((row): [number, SourceObject] => [1, row]),
	]);
	assert.deepEqual(seen.ends, [
		[0, "read"],
		[1, "read"],
	]);
	assert.deepEqual(readdirSync(scratch), []);
});

test("walkJsonFamily counts values that are not objects, and a member that yields none, as shape mismatches", async () => {
	const row = minute("04/04/26 13:00:00", "20");
	const seen = recorder();
	await withExport(
		[
			[
				jsonMember("steps-2026-01-01.json", [1, "x", null, [], row]),
				jsonMember("steps-2026-02-01.json", []),
				{
					name: jsonMember("steps-2026-03-01.json", []).name,
					data: fitbitJson({ steps: [row, row, row] }),
				},
				// A root this reader selects nothing from, longer than an empty array can be.
				{
					name: jsonMember("steps-2026-03-15.json", []).name,
					data: fitbitJson("x".repeat(80)),
				},
				jsonMember("steps-2026-04-01.json", [row]),
			],
		],
		async (io, inspection) => {
			assert.deepEqual(
				await walkJsonFamily(
					io,
					inspection.families.get("steps") ?? [],
					MINUTE_MEMBER_MAX_BYTES,
					seen.handler,
				),
				{ ...CLEAN, files: 5, shapeMismatch: 6 },
			);
		},
	);
	assert.deepEqual(seen.values, [
		[0, row],
		[4, row],
	]);
	// The wrapped member's root key held one value, an array; an empty array is no mismatch.
	assert.deepEqual(seen.ends, [
		[0, "partial"],
		[1, "read"],
		[2, "partial"],
		[3, "partial"],
		[4, "read"],
	]);
});

test("walkJsonFamily skips a member over its cap unread and reads the rest; a cut member is partial, its values before the cut kept", async () => {
	const rows = canonicalRows();
	const scratch = freshDir();
	const seen = recorder();
	await withExport(
		[
			[
				{
					...jsonMember("steps-2026-01-01.json", rows.stepsFirst),
					declaredSize: 17 * MIB,
				},
				{
					name: jsonMember("steps-2026-02-01.json", []).name,
					data: truncatedJson(rows.stepsFirst, 2),
				},
				// Cut inside its first value: nothing arrives, and a member cut short
				// is not also a changed layout.
				{
					name: jsonMember("steps-2026-03-01.json", []).name,
					data: truncatedJson(rows.stepsFirst, 0),
				},
				jsonMember("steps-2026-04-01.json", rows.stepsSecond),
			],
		],
		async (io, inspection) => {
			const steps = inspection.families.get("steps") ?? [];
			assert.deepEqual(
				await walkJsonFamily(io, steps, MINUTE_MEMBER_MAX_BYTES, seen.handler),
				{
					...CLEAN,
					files: 4,
					interruptedFiles: 2,
					oversizedFiles: 1,
				},
			);
		},
		scratch,
	);
	assert.deepEqual(
		seen.values.map(([index]) => index),
		[1, 1, 3, 3, 3, 3, 3],
	);
	assert.deepEqual(seen.ends, [
		[0, "unread"],
		[1, "partial"],
		[2, "partial"],
		[3, "read"],
	]);
	assert.deepEqual(readdirSync(scratch), []);

	// The same member under the cap for other families is extracted, and its
	// lie about its size is caught.
	const other = recorder();
	await withExport(
		[
			[
				{
					...jsonMember("steps-2026-01-01.json", rows.stepsFirst),
					declaredSize: 17 * MIB,
				},
			],
		],
		async (io, inspection) => {
			assert.deepEqual(
				await walkJsonFamily(
					io,
					inspection.families.get("steps") ?? [],
					MEMBER_MAX_BYTES,
					other.handler,
				),
				{ ...CLEAN, files: 1, interruptedFiles: 1 },
			);
		},
	);
	assert.deepEqual(other.ends, [[0, "partial"]]);
});

test("walkJsonFamily reads members from every part of the export", async () => {
	const rows = canonicalRows();
	const seen = recorder();
	await withExport(
		[
			[jsonMember("steps-2026-04-04.json", rows.stepsFirst)],
			[jsonMember("steps-2026-04-05.json", rows.stepsSecond)],
		],
		async (io, inspection) => {
			const steps = inspection.families.get("steps") ?? [];
			assert.deepEqual(
				steps.map((member) => member.part),
				[0, 1],
			);
			await walkJsonFamily(io, steps, MINUTE_MEMBER_MAX_BYTES, seen.handler);
		},
	);
	assert.equal(seen.values.length, 10);
	assert.deepEqual(seen.ends, [
		[0, "read"],
		[1, "read"],
	]);
});

test("walkJsonFamily lets a handler error fail the walk, and still removes the scratch file", async () => {
	const scratch = freshDir();
	const bug = new Error("emit failed");
	await withExport(
		[canonicalMembers()],
		async (io, inspection) => {
			await assert.rejects(
				walkJsonFamily(
					io,
					inspection.families.get("sleep") ?? [],
					MEMBER_MAX_BYTES,
					{
						value: () => Promise.reject(bug),
					},
				),
				bug,
			);
		},
		scratch,
	);
	assert.deepEqual(readdirSync(scratch), []);
});

test("walkJsonFamily stops reading at a device error, reports its code alone, and still says how every member ended", async () => {
	const rows = canonicalRows();
	const members = [
		jsonMember("steps-2026-04-04.json", rows.stepsFirst),
		jsonMember("steps-2026-04-05.json", rows.stepsSecond),
		jsonMember("steps-2026-05-05.json", rows.stepsSecond),
	];
	// The scratch folder goes while the first member's values are handled.
	const scratch = freshDir();
	const ends: [number, MemberEnd][] = [];
	const result = await withExport(
		[members],
		async (io, inspection) => {
			const walked = await walkJsonFamily(
				io,
				inspection.families.get("steps") ?? [],
				MINUTE_MEMBER_MAX_BYTES,
				{
					value: () => {
						rmSync(scratch, { force: true, recursive: true });
						return Promise.resolve();
					},
					memberDone: (index, end) => {
						ends.push([index, end]);
					},
				},
			);
			// Only the first two members were tried.
			assert.equal(io.nextScratchIndex, 2);
			return walked;
		},
		scratch,
	);
	assert.deepEqual(result, {
		...CLEAN,
		files: 3,
		deviceError: true,
		deviceCode: "ENOENT",
	});
	assert.deepEqual(ends, [
		[0, "read"],
		[1, "unread"],
		[2, "unread"],
	]);
	assert.ok(!JSON.stringify(result).includes("steps-"));

	// A scratch folder gone from the start: nothing is tried after the first.
	const none: [number, MemberEnd][] = [];
	await withExport(
		[members],
		async (io, inspection) => {
			await walkJsonFamily(
				io,
				inspection.families.get("steps") ?? [],
				MINUTE_MEMBER_MAX_BYTES,
				{
					value: () => Promise.resolve(),
					memberDone: (index, end) => {
						none.push([index, end]);
					},
				},
			);
			assert.equal(io.nextScratchIndex, 1);
		},
		join(TEMP, "no-such-scratch"),
	);
	assert.deepEqual(none, [
		[0, "unread"],
		[1, "unread"],
		[2, "unread"],
	]);
});

test("walkJsonFamily reads nothing for a family the export lacks", async () => {
	const seen = recorder();
	await withExport([canonicalMembers()], async (io) => {
		assert.deepEqual(
			await walkJsonFamily(io, [], MEMBER_MAX_BYTES, seen.handler),
			CLEAN,
		);
		assert.equal(io.nextScratchIndex, 0);
	});
	assert.deepEqual(seen.values, []);
	assert.deepEqual(seen.ends, []);
});

// walkCsvMember

test("walkCsvMember reads a CSV member's rows and removes its scratch file", async () => {
	const scratch = freshDir();
	const rows: string[][] = [];
	await withExport(
		[canonicalMembers()],
		async (io, inspection) => {
			assert.ok(inspection.sleepScore);
			assert.deepEqual(
				await walkCsvMember(
					io,
					inspection.sleepScore,
					SLEEP_SCORE_MAX_BYTES,
					SLEEP_SCORE_CSV_LIMITS,
					keep(rows),
				),
				{ ...CLEAN, files: 1 },
			);
		},
		scratch,
	);
	assert.deepEqual(rows, [SCORE_HEADER, ...SCORE_ROWS]);
	assert.deepEqual(readdirSync(scratch), []);
});

test("walkCsvMember counts a member over its cap as oversized without extracting it", async () => {
	const rows: string[][] = [];
	await withExport(
		[
			csvOnly({
				name: sleepScoreMember(),
				data: scoreCsv(),
				declaredSize: 9 * MIB,
			}),
		],
		async (io, inspection) => {
			assert.ok(inspection.sleepScore);
			assert.deepEqual(
				await walkCsvMember(
					io,
					inspection.sleepScore,
					SLEEP_SCORE_MAX_BYTES,
					SLEEP_SCORE_CSV_LIMITS,
					keep(rows),
				),
				{ ...CLEAN, files: 1, oversizedFiles: 1 },
			);
			assert.deepEqual(readdirSync(io.scratchDir), []);
		},
	);
	assert.deepEqual(rows, []);
});

test("walkCsvMember counts a file past its limits as oversized, a cut one as interrupted, and a device failure by its code", async () => {
	const pastRows: string[][] = [];
	const past = await withExport(
		[
			csvOnly({
				name: profileMember(),
				data: profileCsv([PROFILE_ROW, PROFILE_ROW]),
			}),
		],
		(io, inspection) => {
			assert.ok(inspection.profile);
			return walkCsvMember(
				io,
				inspection.profile,
				PROFILE_MAX_BYTES,
				PROFILE_CSV_LIMITS,
				keep(pastRows),
			);
		},
	);
	assert.deepEqual(past, { ...CLEAN, files: 1, oversizedFiles: 1 });
	assert.deepEqual(pastRows, [PROFILE_HEADER, PROFILE_ROW]);

	const cutRows: string[][] = [];
	const cut = await withExport(
		[
			csvOnly({
				name: profileMember(),
				data: truncatedCsv(profileCsv(), "CANARY_ABOUT"),
			}),
		],
		(io, inspection) => {
			assert.ok(inspection.profile);
			return walkCsvMember(
				io,
				inspection.profile,
				PROFILE_MAX_BYTES,
				PROFILE_CSV_LIMITS,
				keep(cutRows),
			);
		},
	);
	assert.deepEqual(cut, { ...CLEAN, files: 1, interruptedFiles: 1 });
	assert.deepEqual(cutRows, [PROFILE_HEADER]);

	// Declared longer than it inflates: cut in the download.
	const short = await withExport(
		[
			csvOnly({
				name: profileMember(),
				data: profileCsv(),
				declaredSize: profileCsv().length + 10,
			}),
		],
		(io, inspection) => {
			assert.ok(inspection.profile);
			return walkCsvMember(
				io,
				inspection.profile,
				PROFILE_MAX_BYTES,
				PROFILE_CSV_LIMITS,
				keep([]),
			);
		},
	);
	assert.deepEqual(short, { ...CLEAN, files: 1, interruptedFiles: 1 });

	const device = await withExport(
		[canonicalMembers()],
		(io, inspection) => {
			assert.ok(inspection.profile);
			return walkCsvMember(
				io,
				inspection.profile,
				PROFILE_MAX_BYTES,
				PROFILE_CSV_LIMITS,
				keep([]),
			);
		},
		join(TEMP, "no-such-scratch"),
	);
	assert.deepEqual(device, {
		...CLEAN,
		files: 1,
		deviceError: true,
		deviceCode: "ENOENT",
	});

	// A profile read stops after the header and its row, reading nothing more.
	const stopped: string[][] = [];
	const read = await withExport([canonicalMembers()], (io, inspection) => {
		assert.ok(inspection.profile);
		return walkCsvMember(
			io,
			inspection.profile,
			PROFILE_MAX_BYTES,
			PROFILE_CSV_LIMITS,
			(cells) => {
				stopped.push([...cells]);
				return Promise.resolve(stopped.length === 2 ? "stop" : "more");
			},
		);
	});
	assert.deepEqual(read, { ...CLEAN, files: 1 });
	assert.deepEqual(stopped, [PROFILE_HEADER, PROFILE_ROW]);
});
