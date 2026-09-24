// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
	chmodSync,
	closeSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { packageRoot as PACKAGE_ROOT } from "../../packages/polyfill-connectors/src/connector-paths.ts";
import {
	buildZip,
	centralDirectoryRecord,
	endOfCentralDirectory,
	localFileHeader,
	type ZipFixtureEntry,
} from "./__fixtures__/zip.ts";
import { scanExportXmlSummary } from "./parsers.ts";
import {
	extractExportEntry,
	findUploads,
	inspectZipUpload,
	resolveUploadedExport,
	UPLOAD_LIMITS,
	type UploadedExport,
} from "./uploads.ts";

const REAL_EXPORT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
<ExportDate value="2026-09-01 12:00:00 -0500"/>
<Me HKCharacteristicTypeIdentifierDateOfBirth="1990-01-01" HKCharacteristicTypeIdentifierBiologicalSex="HKBiologicalSexNotSet" HKCharacteristicTypeIdentifierBloodType="HKBloodTypeNotSet" HKCharacteristicTypeIdentifierFitzpatrickSkinType="HKFitzpatrickSkinTypeNotSet"/>
<Record type="HKQuantityTypeIdentifierStepCount" sourceName="iPhone" unit="count" creationDate="2018-01-30 08:59:38 -0800" startDate="2018-01-30 08:59:38 -0800" endDate="2018-01-30 09:00:38 -0800" value="120"/>
<Record type="HKQuantityTypeIdentifierHeartRate" sourceName="Apple Watch" unit="count/min" creationDate="2018-02-01 08:59:38 -0800" startDate="2018-02-01 08:59:38 -0800" endDate="2018-02-01 08:59:38 -0800" value="61"/>
<Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="30" durationUnit="min" sourceName="iPhone" creationDate="2018-01-15 07:00:00 -0800" startDate="2018-01-15 07:00:00 -0800" endDate="2018-01-15 07:30:00 -0800"/>
</HealthData>
`;

const CDA_XML =
	'<?xml version="1.0" encoding="UTF-8"?>\n<ClinicalDocument xmlns="urn:hl7-org:v3"><title>Health</title></ClinicalDocument>\n';

/** A one-record export taken on `day` holding `steps`, so a run shows which file it read. */
function exportTakenOn(day: string, steps = 5): string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
 <ExportDate value="${day} 12:00:00 -0500"/>
 <Record type="HKQuantityTypeIdentifierStepCount" unit="count" startDate="${day} 08:00:00 -0500" endDate="${day} 08:05:00 -0500" value="${steps}"/>
</HealthData>
`;
}

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "pdpp-apple-health-manual-upload-"));
}

async function withDir(fn: (dir: string) => Promise<void> | void) {
	const dir = tempDir();
	try {
		await fn(dir);
	} finally {
		rmSync(dir, { force: true, recursive: true });
	}
}

/** Write `body` at `path`, creating its directory, dated `ageMs` ago. */
function writeAged(path: string, body: string | Buffer, ageMs = 0): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, body);
	const when = new Date(Date.now() - ageMs);
	utimesSync(path, when, when);
}

function exportZip(xml: string, extra: ZipFixtureEntry[] = []): Buffer {
	return buildZip([
		{ name: "apple_health_export/export.xml", data: xml },
		...extra,
	]);
}

/** The export a resolution read, as text; fails the test if none was read. */
function readOf(outcome: UploadedExport): string {
	assert.equal(outcome.kind, "export", JSON.stringify(outcome));
	return outcome.kind === "export" ? readFileSync(outcome.path, "utf8") : "";
}

/** The files a zip's extraction left beside it: `.<zip name>.*`. */
function extractionsBeside(zipPath: string): string[] {
	const prefix = `.${zipPath.split("/").at(-1)}.`;
	return readdirSync(dirname(zipPath)).filter((n) => n.startsWith(prefix));
}

// ─── findUploads ────────────────────────────────────────────────────────

test("findUploads: finds a flat .xml and a .zip one level under an artifact directory", async () => {
	await withDir((dir) => {
		writeAged(join(dir, "my-export.xml"), REAL_EXPORT_XML);
		writeAged(
			join(dir, "mua_abc123", "export.zip"),
			exportZip(REAL_EXPORT_XML),
		);
		assert.deepEqual(
			findUploads(dir)
				.map((u) => u.path)
				.sort(),
			[join(dir, "mua_abc123", "export.zip"), join(dir, "my-export.xml")],
		);
	});
});

test("findUploads: ignores other extensions, dotfiles, AppleDouble files and __MACOSX", async () => {
	await withDir((dir) => {
		writeAged(join(dir, "readme.txt"), "not an export");
		writeAged(join(dir, "._export.xml"), "AppleDouble");
		writeAged(join(dir, ".hidden.zip"), "hidden");
		writeAged(join(dir, "__MACOSX", "export.xml"), REAL_EXPORT_XML);
		assert.deepEqual(findUploads(dir), []);
	});
});

test("findUploads: returns nothing for a missing directory instead of throwing", () => {
	assert.deepEqual(findUploads("/nonexistent/pdpp-apple-health-test-dir"), []);
});

test("findUploads: thousands of clinical records sorted before the export do not hide it", async () => {
	// Apple writes one file per clinical record beside the export. A walk
	// bounded by every entry it passes, in name order, would spend its budget
	// in clinical-records/ and never reach export.xml.
	await withDir((dir) => {
		const folder = join(dir, "artifact-1", "apple_health_export");
		const records = join(folder, "clinical-records");
		mkdirSync(records, { recursive: true });
		for (let i = 0; i < 10_050; i += 1) {
			writeFileSync(join(records, `Observation-${i}.json`), "{}");
		}
		writeAged(join(folder, "export.xml"), REAL_EXPORT_XML);
		writeAged(join(folder, "export_cda.xml"), CDA_XML);
		assert.deepEqual(
			findUploads(dir)
				.map((u) => u.path)
				.sort(),
			[join(folder, "export.xml"), join(folder, "export_cda.xml")],
		);
	});
});

test("findUploads: follows symlinks to a file and to a folder, and a symlink loop ends", async () => {
	await withDir((dir) => {
		const elsewhere = join(dir, "elsewhere");
		writeAged(join(elsewhere, "linked-export.xml"), REAL_EXPORT_XML);
		writeAged(
			join(elsewhere, "folder", "apple_health_export", "export.xml"),
			REAL_EXPORT_XML,
		);
		const imports = join(dir, "imports");
		mkdirSync(imports);
		symlinkSync(
			join(elsewhere, "linked-export.xml"),
			join(imports, "export.xml"),
		);
		symlinkSync(
			join(elsewhere, "folder", "apple_health_export"),
			join(imports, "apple_health_export"),
		);
		symlinkSync(imports, join(imports, "loop"));
		assert.deepEqual(
			findUploads(imports)
				.map((u) => u.path)
				.sort(),
			[
				join(imports, "apple_health_export", "export.xml"),
				join(imports, "export.xml"),
			],
		);
	});
});

// ─── Choosing the export ────────────────────────────────────────────────

test("resolveUploadedExport: nothing uploaded is none", async () => {
	await withDir(async (dir) => {
		writeAged(join(dir, "readme.txt"), "hello");
		assert.deepEqual(await resolveUploadedExport(dir), { kind: "none" });
	});
});

test("resolveUploadedExport: a bare .xml export is read where it is, with its ExportDate", async () => {
	await withDir(async (dir) => {
		const xmlPath = join(dir, "export.xml");
		writeAged(xmlPath, REAL_EXPORT_XML);
		assert.deepEqual(await resolveUploadedExport(dir), {
			kind: "export",
			exportedAt: "2026-09-01T17:00:00.000Z",
			path: xmlPath,
		});
	});
});

test("resolveUploadedExport: an XML that is not a Health export is never read as one", async () => {
	await withDir(async (dir) => {
		writeAged(
			join(dir, "not-a-health-export.xml"),
			'<?xml version="1.0"?>\n<!-- <HealthData> --><SomethingElse><HealthData/></SomethingElse>\n',
		);
		assert.deepEqual(await resolveUploadedExport(dir), {
			kind: "not_export",
		});
	});
});

test("resolveUploadedExport: the newest export is read even when it was moved in with an older file time", async () => {
	// mv, cp -p and Finder keep a file's time. A choice by file time would read
	// the older export, the newer file on disk.
	await withDir(async (dir) => {
		writeAged(join(dir, "old.xml"), exportTakenOn("2023-09-01", 1), 3_600_000);
		writeAged(
			join(dir, "art2", "export.zip"),
			exportZip(exportTakenOn("2024-09-01", 2)),
			86_400_000 * 3,
		);
		assert.match(
			readOf(await resolveUploadedExport(dir)),
			/value="2"/,
			"the 2024 export, though its zip is days older on disk",
		);
	});
});

test("resolveUploadedExport: two uploads of the same export go to the newer file, the same way every time", async () => {
	await withDir(async (dir) => {
		writeAged(join(dir, "a.xml"), REAL_EXPORT_XML, 60_000);
		writeAged(join(dir, "b.xml"), REAL_EXPORT_XML);
		const first = await resolveUploadedExport(dir);
		assert.equal(first.kind === "export" ? first.path : "", join(dir, "b.xml"));
		const when = new Date(Date.now() - 1000);
		utimesSync(join(dir, "a.xml"), when, when);
		utimesSync(join(dir, "b.xml"), when, when);
		const tied = await resolveUploadedExport(dir);
		assert.equal(
			tied.kind === "export" ? tied.path : "",
			join(dir, "a.xml"),
			"a full tie goes to the path",
		);
	});
});

test("resolveUploadedExport: an AppleDouble ._export.xml beside the export is never chosen", async () => {
	await withDir(async (dir) => {
		const folder = join(dir, "apple_health_export");
		writeAged(
			join(folder, "export.xml"),
			exportTakenOn("2024-09-01", 7),
			60_000,
		);
		const appleDouble = Buffer.alloc(4096);
		appleDouble.writeUInt32BE(0x00_05_16_07, 0);
		appleDouble.writeUInt32BE(0x00_02_00_00, 4);
		writeAged(join(folder, "._export.xml"), appleDouble);
		assert.match(readOf(await resolveUploadedExport(dir)), /value="7"/);
	});
});

test("resolveUploadedExport: an unzipped export's CDA document is never chosen, whatever its time", async () => {
	await withDir(async (dir) => {
		writeAged(
			join(dir, "apple_health_export", "export.xml"),
			REAL_EXPORT_XML,
			3_600_000,
		);
		writeAged(join(dir, "apple_health_export", "export_cda.xml"), CDA_XML);
		assert.equal(readOf(await resolveUploadedExport(dir)), REAL_EXPORT_XML);
	});
});

test("resolveUploadedExport: a symlinked export is read", async () => {
	await withDir(async (dir) => {
		writeAged(join(dir, "source.xml.txt"), REAL_EXPORT_XML);
		const imports = join(dir, "imports");
		mkdirSync(imports);
		symlinkSync(join(dir, "source.xml.txt"), join(imports, "export.xml"));
		assert.equal(readOf(await resolveUploadedExport(imports)), REAL_EXPORT_XML);
	});
});

test("resolveUploadedExport: an .xml named <stem>.export.xml beside <stem>.zip is an upload like any other, and is never removed", async () => {
	// The name tells nothing about who wrote the file: it may be the owner's
	// own newer export. Judged by content like any other upload, the newer
	// export is read; an extraction of the same zip ties with it on
	// ExportDate and holds the same data.
	await withDir(async (dir) => {
		writeAged(
			join(dir, "health.zip"),
			exportZip(exportTakenOn("2024-09-01", 3)),
			3_600_000,
		);
		writeAged(join(dir, "health.export.xml"), exportTakenOn("2026-09-01", 9));
		const visible = () => readdirSync(dir).filter((n) => !n.startsWith("."));
		const before = visible();
		assert.match(readOf(await resolveUploadedExport(dir)), /value="9"/);
		assert.deepEqual(visible(), before, "nothing of the owner's is removed");

		// The zip holds the newer export now, so it is extracted, and the
		// file beside it still stays.
		writeAged(
			join(dir, "health.zip"),
			exportZip(exportTakenOn("2027-09-01", 4)),
		);
		assert.match(readOf(await resolveUploadedExport(dir)), /value="4"/);
		assert.deepEqual(visible(), before, "nothing of the owner's is removed");
	});
});

test("resolveUploadedExport: a newer .zip that cannot be read is reported, and no older export is read in its place", async () => {
	// Reading the older export would import stale data while the owner
	// believes the new upload was read. The failure is reported exactly as it
	// would be were the unreadable .zip the only upload.
	await withDir(async (dir) => {
		writeAged(
			join(dir, "art-old", "export.xml"),
			exportTakenOn("2025-09-01", 1),
			3_600_000,
		);
		// Cut before its central directory, as an interrupted transfer leaves it.
		writeAged(
			join(dir, "art-new", "export.zip"),
			exportZip(exportTakenOn("2026-09-01", 2)).subarray(0, 200),
		);
		const beside = await resolveUploadedExport(dir);
		rmSync(join(dir, "art-old"), { recursive: true });
		const alone = await resolveUploadedExport(dir);
		assert.match(failureOf(beside), /could not be opened as an archive/);
		assert.deepEqual(beside, alone);
	});
});

test("resolveUploadedExport: a newer .zip refused only for its size does not block the XML unzipped from it", async () => {
	// The advice for an archive in the zip64 format, which this reader cannot
	// open, is to unzip it and upload the XML inside. Unzipping gives the XML
	// the older file time its entry records, so were the refusal to block
	// every older upload, following the advice would import nothing.
	await withDir(async (dir) => {
		writeAged(
			join(dir, "export.zip"),
			buildZip([
				{
					name: "apple_health_export/export.xml",
					data: exportTakenOn("2026-09-01", 2),
					zip64Sizes: true,
				},
			]),
		);
		writeAged(
			join(dir, "apple_health_export", "export.xml"),
			exportTakenOn("2026-09-01", 2),
			3_600_000,
		);
		const outcome = await resolveUploadedExport(dir);
		assert.match(readOf(outcome), /value="2"/);
		assert.match(
			outcome.kind === "export" ? String(outcome.newerTooLarge) : "",
			/zip64/,
			"the owner is still told of the .zip",
		);
	});
});

test("resolveUploadedExport: an older .zip that cannot be read does not hide a newer export", async () => {
	await withDir(async (dir) => {
		writeAged(
			join(dir, "old", "export.zip"),
			exportZip(exportTakenOn("2025-09-01", 1)).subarray(0, 200),
			3_600_000,
		);
		writeAged(join(dir, "export.xml"), exportTakenOn("2026-09-01", 2));
		assert.match(readOf(await resolveUploadedExport(dir)), /value="2"/);
	});
});

const RUNS_AS_ROOT = process.getuid?.() === 0;

test("resolveUploadedExport: a newer .xml whose head cannot be read does not stand in the way", {
	skip: RUNS_AS_ROOT && "root reads a file whatever its mode",
}, async () => {
	// An .xml is an export only if its head says so, and this one cannot be
	// read, so it may as well be a CDA document.
	await withDir(async (dir) => {
		writeAged(join(dir, "export.xml"), exportTakenOn("2025-09-01", 1), 60_000);
		writeAged(join(dir, "locked.xml"), exportTakenOn("2026-09-01", 2));
		chmodSync(join(dir, "locked.xml"), 0o000);
		assert.match(readOf(await resolveUploadedExport(dir)), /value="1"/);
	});
});

test("resolveUploadedExport: a directory that cannot be listed is skipped and named", {
	skip: RUNS_AS_ROOT && "root lists a directory whatever its mode",
}, async () => {
	await withDir(async (dir) => {
		writeAged(join(dir, "export.xml"), exportTakenOn("2025-09-01", 1), 60_000);
		writeAged(
			join(dir, "locked", "export.xml"),
			exportTakenOn("2026-09-01", 2),
		);
		chmodSync(join(dir, "locked"), 0o000);
		const skipped: string[] = [];
		try {
			const outcome = await resolveUploadedExport(dir, UPLOAD_LIMITS, (d) => {
				skipped.push(d);
			});
			assert.match(readOf(outcome), /value="1"/);
			assert.deepEqual(skipped, [join(dir, "locked")]);
		} finally {
			chmodSync(join(dir, "locked"), 0o755);
		}
	});
});

test("resolveUploadedExport: a folder within the import folder that cannot be listed is named, and what else was found is the outcome", {
	skip: RUNS_AS_ROOT && "root lists a directory whatever its mode",
}, async () => {
	// Only the import folder itself, unlisted, leaves nothing to be found.
	await withDir(async (dir) => {
		writeAged(join(dir, "export_cda.xml"), CDA_XML);
		writeAged(join(dir, "locked", "export.xml"), exportTakenOn("2026-09-01"));
		chmodSync(join(dir, "locked"), 0o000);
		const skipped: string[] = [];
		try {
			const outcome = await resolveUploadedExport(dir, UPLOAD_LIMITS, (d) => {
				skipped.push(d);
			});
			assert.deepEqual(outcome, { kind: "not_export" });
			assert.deepEqual(skipped, [join(dir, "locked")]);
		} finally {
			chmodSync(join(dir, "locked"), 0o755);
		}
	});
});

// ─── Zips ───────────────────────────────────────────────────────────────

test("resolveUploadedExport: a zip's export is extracted once and reused while the zip is unchanged", async () => {
	await withDir(async (dir) => {
		const zipPath = join(dir, "export.zip");
		writeAged(zipPath, exportZip(REAL_EXPORT_XML));
		const first = await resolveUploadedExport(dir);
		assert.equal(readOf(first), REAL_EXPORT_XML);
		assert.equal(
			first.kind === "export" ? first.exportedAt : null,
			"2026-09-01T17:00:00.000Z",
		);
		const extracted = first.kind === "export" ? first.path : "";
		assert.ok(
			extracted.startsWith(join(dir, ".export.zip.")),
			"the extraction is a dotfile named for its zip",
		);
		const firstMtime = statSync(extracted).mtimeMs;

		const second = await resolveUploadedExport(dir);
		assert.equal(second.kind === "export" ? second.path : "", extracted);
		assert.equal(statSync(extracted).mtimeMs, firstMtime, "not re-extracted");
		assert.deepEqual(extractionsBeside(zipPath), [extracted.split("/").at(-1)]);
	});
});

test("resolveUploadedExport: a zip replaced at the same path, size and time is extracted again", async () => {
	// The extraction is keyed to the zip it came from. A replacement with the
	// same name, byte count and modification time is a different file, and
	// reusing its extraction would read the replaced export.
	await withDir(async (dir) => {
		const zipPath = join(dir, "export.zip");
		const older = exportZip(exportTakenOn("2024-09-01", 7));
		const newer = exportZip(exportTakenOn("2024-09-01", 8));
		assert.equal(older.length, newer.length, "same size by construction");
		const when = new Date(Date.now() - 3_600_000);
		writeFileSync(zipPath, older);
		utimesSync(zipPath, when, when);
		assert.match(readOf(await resolveUploadedExport(dir)), /value="7"/);

		writeFileSync(join(dir, "incoming"), newer);
		utimesSync(join(dir, "incoming"), when, when);
		renameSync(join(dir, "incoming"), zipPath);
		assert.match(readOf(await resolveUploadedExport(dir)), /value="8"/);
		assert.equal(
			extractionsBeside(zipPath).length,
			1,
			"the stale extraction is removed",
		);
	});
});

test("resolveUploadedExport: a .partial written within the hour is never read, and is left for the run that may be writing it", async () => {
	await withDir(async (dir) => {
		const zipPath = join(dir, "export.zip");
		writeAged(zipPath, exportZip(REAL_EXPORT_XML));
		const partial = ".export.zip.0123456789abcdef.xml.99999-0badf00d.partial";
		writeAged(join(dir, partial), "<Heal", 50 * 60_000);
		assert.equal(readOf(await resolveUploadedExport(dir)), REAL_EXPORT_XML);
		assert.ok(existsSync(join(dir, partial)));
	});
});

test("resolveUploadedExport: a .partial untouched for an hour is removed, whichever process named it, beside a reused extraction too", async () => {
	// An extraction writes to its partial continuously, so an hour without a
	// write means no run is. The process id in the name decides nothing: here
	// it is the first process's, alive in this namespace and unrelated, and a
	// folder shared across containers may name ids that cannot be seen.
	await withDir(async (dir) => {
		const zipPath = join(dir, "export.zip");
		writeAged(zipPath, exportZip(REAL_EXPORT_XML));
		const extracted = readOf(await resolveUploadedExport(dir));
		const abandoned = ".export.zip.0123456789abcdef.xml.1-0badf00d.partial";
		writeAged(join(dir, abandoned), "<Heal", 2 * 3_600_000);
		assert.equal(readOf(await resolveUploadedExport(dir)), extracted);
		assert.ok(!existsSync(join(dir, abandoned)));
	});
});

test("resolveUploadedExport: a stale extraction that cannot be removed does not cost the import", async () => {
	// Tidying up is best effort. A stale extraction is never read, so one that
	// cannot be removed is left, and the export is extracted and read.
	await withDir(async (dir) => {
		writeAged(join(dir, "export.zip"), exportZip(REAL_EXPORT_XML));
		mkdirSync(join(dir, ".export.zip.0123456789abcdef.xml"));
		assert.equal(readOf(await resolveUploadedExport(dir)), REAL_EXPORT_XML);
	});
});

const UPLOADS_PATH = join(
	dirname(fileURLToPath(import.meta.url)),
	"uploads.ts",
);

/**
 * Runs resolveUploadedExport in a child process that kills itself with
 * SIGKILL as soon as the first chunk of the extracted file reaches disk: the
 * state a crash, an out-of-memory kill or a host restart leaves behind.
 */
const KILL_AFTER_FIRST_WRITE = `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const real = fs.createWriteStream;
fs.createWriteStream = function (...args) {
	const stream = real.apply(this, args);
	for (const method of ["_write", "_writev"]) {
		const original = stream[method].bind(stream);
		stream[method] = (...callArgs) => {
			const done = callArgs.pop();
			original(...callArgs, (err) => {
				done(err);
				process.kill(process.pid, "SIGKILL");
			});
		};
	}
	return stream;
};
syncBuiltinESMExports();
const { resolveUploadedExport } = await import(process.argv[2]);
await resolveUploadedExport(process.argv[3]);
`;

/** An export large enough that extracting it takes many writes. */
function manyRecordsExport(): string {
	const records: string[] = [];
	for (let i = 0; i < 20_000; i += 1) {
		records.push(
			`<Record type="HKQuantityTypeIdentifierStepCount" unit="count" startDate="2018-01-30 08:59:38 -0800" endDate="2018-01-30 09:00:38 -0800" value="${i}"/>`,
		);
	}
	return REAL_EXPORT_XML.replace(
		"</HealthData>",
		`${records.join("\n")}\n</HealthData>`,
	);
}

test("resolveUploadedExport: an extraction killed part way never leaves a file that looks complete", async () => {
	await withDir(async (dir) => {
		const imports = join(dir, "imports");
		const zipPath = join(imports, "export.zip");
		const full = manyRecordsExport();
		writeAged(zipPath, exportZip(full), 3_600_000);
		const script = join(dir, "kill-after-first-write.mjs");
		writeFileSync(script, KILL_AFTER_FIRST_WRITE);

		const child = spawnSync(
			process.execPath,
			["--import", "tsx", script, UPLOADS_PATH, imports],
			{ cwd: PACKAGE_ROOT, encoding: "utf8" },
		);
		assert.equal(child.signal, "SIGKILL", child.stderr);
		assert.ok(
			extractionsBeside(zipPath).every((n) => n.endsWith(".partial")),
			"a killed extraction leaves nothing the next run would trust",
		);

		const killed = extractionsBeside(zipPath);
		assert.equal(readOf(await resolveUploadedExport(imports)), full);
		assert.deepEqual(
			extractionsBeside(zipPath).filter((n) => n.endsWith(".partial")),
			killed,
			"the killed run's partial is left until it has gone an hour unwritten",
		);
	});
});

/** Resolve once `ready()` holds, checking every 20 ms; reject after `ms`. */
function pollUntil(ready: () => boolean, ms: number): Promise<void> {
	const deadline = Date.now() + ms;
	return new Promise((resolve, reject) => {
		const timer = setInterval(() => {
			if (ready()) {
				clearInterval(timer);
				resolve();
			} else if (Date.now() > deadline) {
				clearInterval(timer);
				reject(new Error(`not ready within ${ms} ms`));
			}
		}, 20);
	});
}

/**
 * Runs resolveUploadedExport in a child process that stops itself with
 * SIGSTOP once the first chunk of its extraction reaches disk, and prints
 * what it read after SIGCONT: a run caught part way while another starts.
 */
const STOP_AFTER_FIRST_WRITE = `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const real = fs.createWriteStream;
let stopped = false;
fs.createWriteStream = function (...args) {
	const stream = real.apply(this, args);
	for (const method of ["_write", "_writev"]) {
		const original = stream[method].bind(stream);
		stream[method] = (...callArgs) => {
			const done = callArgs.pop();
			original(...callArgs, (err) => {
				if (!stopped) {
					stopped = true;
					process.kill(process.pid, "SIGSTOP");
				}
				done(err);
			});
		};
	}
	return stream;
};
syncBuiltinESMExports();
const { resolveUploadedExport } = await import(process.argv[2]);
const outcome = await resolveUploadedExport(process.argv[3]);
process.stdout.write(outcome.kind === "export" ? fs.readFileSync(outcome.path, "utf8") : JSON.stringify(outcome));
`;

test("resolveUploadedExport: a run never removes the extraction another run is writing", {
	timeout: 60_000,
}, async () => {
	await withDir(async (dir) => {
		const imports = join(dir, "imports");
		const zipPath = join(imports, "export.zip");
		const full = manyRecordsExport();
		writeAged(zipPath, exportZip(full), 3_600_000);
		const script = join(dir, "stop-after-first-write.mjs");
		writeFileSync(script, STOP_AFTER_FIRST_WRITE);
		const child = spawn(
			process.execPath,
			["--import", "tsx", script, UPLOADS_PATH, imports],
			{ cwd: PACKAGE_ROOT },
		);
		let stdout = "";
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (text: string) => {
			stdout += text;
		});
		const exited = once(child, "exit");
		try {
			const writing = `.${child.pid}-`;
			await pollUntil(
				() =>
					extractionsBeside(zipPath).some(
						(n) =>
							n.includes(writing) &&
							n.endsWith(".partial") &&
							(statSync(join(imports, n), { throwIfNoEntry: false })?.size ??
								0) > 0,
					),
				30_000,
			);
			// The first run is stopped part way through its extraction.
			assert.equal(readOf(await resolveUploadedExport(imports)), full);
			child.kill("SIGCONT");
			const [code] = await exited;
			assert.equal(code, 0);
			assert.equal(stdout, full, "the first run's extraction survived");
		} finally {
			child.kill("SIGKILL");
		}
	});
});

test("resolveUploadedExport: a zip holding no Health export is not an export", async () => {
	await withDir(async (dir) => {
		writeAged(
			join(dir, "export.zip"),
			buildZip([
				{ name: "some-other-file.txt", data: "not a health export" },
				{ name: "notes.xml", data: "<notes/>" },
			]),
		);
		assert.deepEqual(await resolveUploadedExport(dir), { kind: "not_export" });
	});
});

test("resolveUploadedExport: a localised export is found by its content, not its name", async () => {
	// A Norwegian export names its files eksport.xml and eksport_cda.xml. The
	// CDA companion is listed first here.
	await withDir(async (dir) => {
		writeAged(
			join(dir, "eksport.zip"),
			buildZip([
				{ name: "apple_health_export/eksport_cda.xml", data: CDA_XML },
				{ name: "apple_health_export/eksport.xml", data: REAL_EXPORT_XML },
				{
					name: "apple_health_export/workout-routes/route_2018-01-15.gpx",
					data: "<gpx/>",
				},
			]),
		);
		assert.equal(readOf(await resolveUploadedExport(dir)), REAL_EXPORT_XML);
	});
});

test("resolveUploadedExport: the export is extracted by its exact path, never by a shared base name", async () => {
	// Entries named export.xml in other folders, one a Health export of its
	// own and one not, listed after the export. Matching by base name would
	// take whichever came last.
	await withDir(async (dir) => {
		writeAged(
			join(dir, "upload.zip"),
			buildZip([
				{ name: "export.xml", data: exportTakenOn("2024-09-01", 222) },
				{ name: "old/export.xml", data: exportTakenOn("2019-09-01", 999) },
				{ name: "notes/export.xml", data: "<notes/>" },
			]),
		);
		assert.match(readOf(await resolveUploadedExport(dir)), /value="222"/);
	});
});

async function inspectZipAt(path: string) {
	const fd = openSync(path, "r");
	try {
		return await inspectZipUpload(fd, statSync(path).size);
	} finally {
		closeSync(fd);
	}
}

test("inspectZipUpload: 16,000 small XML entries cost a bounded number of sniffs, and the export's folder is sniffed first", {
	timeout: 60_000,
}, async () => {
	// Extracting each entry in full to judge it, with the archive's directory
	// read again for every one, would be quadratic: minutes on a small zip. At
	// most maxSniffedEntries are opened, each only for its head.
	await withDir(async (dir) => {
		const decoys: ZipFixtureEntry[] = [];
		for (let i = 0; i < 16_000; i += 1) {
			decoys.push({ name: `a/${i}.xml`, data: "<x/>" });
		}
		const decoysOnly = join(dir, "many.zip");
		writeFileSync(decoysOnly, buildZip(decoys));
		const withExport = join(dir, "with-export.zip");
		writeFileSync(
			withExport,
			buildZip([
				...decoys,
				{ name: "apple_health_export/export.xml", data: REAL_EXPORT_XML },
			]),
		);
		const started = Date.now();
		const refused = await inspectZipAt(decoysOnly);
		assert.equal(refused.kind, "too_large");
		assert.match(
			refused.kind === "too_large" ? refused.detail : "",
			/more XML files than this reader will search/,
		);
		assert.equal((await inspectZipAt(withExport)).kind, "export");
		assert.ok(Date.now() - started < 10_000, `took ${Date.now() - started} ms`);
	});
});

/**
 * An archive of `entries` .xml entries whose records all point at one stream
 * of `megabytes` MiB of empty DEFLATE blocks: valid, and inflating to nothing.
 */
function emptyBlocksZip(entries: number, megabytes: number): Buffer {
	const blocks = Math.floor((megabytes * 1024 * 1024) / 5);
	const data = Buffer.alloc((blocks + 1) * 5);
	for (let i = 0; i <= blocks; i += 1) {
		data[i * 5] = i === blocks ? 0x01 : 0x00;
		data.writeUInt16LE(0xff_ff, i * 5 + 3);
	}
	const sizes = { compressedSize: data.length, uncompressedSize: 0 };
	const local = localFileHeader({ ...sizes, name: Buffer.from("a.xml") });
	const directory = Buffer.concat(
		Array.from({ length: entries }, (_, i) =>
			centralDirectoryRecord({
				...sizes,
				name: Buffer.from(`d${String(i).padStart(4, "0")}.xml`),
			}),
		),
	);
	return Buffer.concat([
		local,
		data,
		directory,
		endOfCentralDirectory(
			entries,
			directory.length,
			local.length + data.length,
		),
	]);
}

test("inspectZipUpload: entries of empty DEFLATE blocks are judged in bounded time", {
	timeout: 60_000,
}, async () => {
	// Empty blocks inflate to nothing, so no cap on inflated bytes stops a
	// sniff reading such an entry to its end; every sniff would read all
	// 16 MiB. Compressed input per sniff is capped instead.
	await withDir(async (dir) => {
		const zipPath = join(dir, "empty-blocks.zip");
		writeFileSync(zipPath, emptyBlocksZip(300, 16));
		const started = Date.now();
		const inspected = await inspectZipAt(zipPath);
		const elapsed = Date.now() - started;
		assert.notEqual(inspected.kind, "export");
		assert.ok(elapsed < 5000, `took ${elapsed} ms`);
	});
});

test("inspectZipUpload: more XML files than the sniff count ahead of the export gets the unzip advice, never 'no export'", async () => {
	await withDir(async (dir) => {
		const entries: ZipFixtureEntry[] = [];
		for (let i = 0; i < UPLOAD_LIMITS.maxSniffedEntries + 10; i += 1) {
			entries.push({
				name: `apple_health_export/a${i}.xml`,
				data: `${" ".repeat(60_000)}<x/>`,
			});
		}
		entries.push({
			name: "apple_health_export/export.xml",
			data: REAL_EXPORT_XML,
		});
		const zipPath = join(dir, "padded.zip");
		writeFileSync(zipPath, buildZip(entries));
		const inspected = await inspectZipAt(zipPath);
		assert.equal(inspected.kind, "too_large");
		assert.match(
			inspected.kind === "too_large" ? inspected.detail : "",
			/more XML files than this reader will search/,
		);
	});
});

test("resolveUploadedExport: thousands of route files beside the export do not reject the archive", async () => {
	await withDir(async (dir) => {
		const routes: ZipFixtureEntry[] = [];
		for (let i = 0; i < 6000; i += 1) {
			routes.push({
				name: `apple_health_export/workout-routes/route_${i}.gpx`,
				data: "<gpx/>",
			});
		}
		writeAged(join(dir, "export.zip"), exportZip(REAL_EXPORT_XML, routes));
		assert.equal(readOf(await resolveUploadedExport(dir)), REAL_EXPORT_XML);
	});
});

// ─── What the owner is told ─────────────────────────────────────────────

function failureOf(outcome: UploadedExport): string {
	assert.equal(outcome.kind, "failed", JSON.stringify(outcome));
	return outcome.kind === "failed" ? outcome.message : "";
}

test("resolveUploadedExport: an export too large for the classic zip format gets the unzip-it-yourself advice", async () => {
	await withDir(async (dir) => {
		writeAged(
			join(dir, "export.zip"),
			buildZip([
				{
					name: "apple_health_export/export.xml",
					data: REAL_EXPORT_XML,
					zip64Sizes: true,
				},
			]),
		);
		const message = failureOf(await resolveUploadedExport(dir));
		assert.match(message, /4 GB or larger/);
		assert.match(
			message,
			/is under 8 GB, unzip it on your computer and upload that XML instead/,
		);
		assert.doesNotMatch(message, /does not contain/);
	});
});

test("resolveUploadedExport: an archive of 65,535 files gets the unzip advice without the 4 GB claim", async () => {
	await withDir(async (dir) => {
		const entries: ZipFixtureEntry[] = [
			{ name: "apple_health_export/export.xml", data: REAL_EXPORT_XML },
		];
		for (let i = 1; i < 65_535; i += 1) {
			entries.push({ name: `r/${i}.gpx`, data: "" });
		}
		writeAged(join(dir, "export.zip"), buildZip(entries));
		const message = failureOf(await resolveUploadedExport(dir));
		assert.match(message, /65,535 or more files/);
		assert.match(
			message,
			/is under 8 GB, unzip it on your computer and upload that XML instead/,
		);
		assert.doesNotMatch(message, /4 GB/);
	});
});

test("resolveUploadedExport: an export over the size ceiling is not given advice that cannot work", async () => {
	// Unzipping it would produce an XML over the same ceiling. The zip
	// under-declares the size, as a writer does whose sizes wrap past 32 bits,
	// so only the bytes actually inflated reveal it.
	await withDir(async (dir) => {
		const big = REAL_EXPORT_XML.replace(
			"</HealthData>",
			`${"<!-- padding -->\n".repeat(20_000)}</HealthData>`,
		);
		writeAged(
			join(dir, "export.zip"),
			buildZip([
				{
					name: "apple_health_export/export.xml",
					data: big,
					declaredSize: 1000,
				},
			]),
		);
		const limits = { ...UPLOAD_LIMITS, maxExportBytes: 200 * 1024 };
		assert.ok(big.length > limits.maxExportBytes);
		const message = failureOf(await resolveUploadedExport(dir, limits));
		assert.match(
			message,
			/larger than 204800 bytes, the most this import reads/,
		);
		assert.doesNotMatch(message, /[Uu]nzip|operator|date range/);
		assert.deepEqual(extractionsBeside(join(dir, "export.zip")), []);
	});
});

test("resolveUploadedExport: an archive that cannot be opened is not given advice that cannot work", async () => {
	await withDir(async (dir) => {
		// Cut before the central directory, as an interrupted transfer leaves it.
		writeAged(
			join(dir, "export.zip"),
			exportZip(REAL_EXPORT_XML).subarray(0, 200),
		);
		const message = failureOf(await resolveUploadedExport(dir));
		assert.match(message, /could not be opened as an archive/);
		assert.match(message, /Take a fresh export/);
		assert.doesNotMatch(message, /[Uu]nzip/);
	});
});

test("extractExportEntry: writes the entry atomically and leaves no partial file", async () => {
	await withDir(async (dir) => {
		const zipPath = join(dir, "export.zip");
		writeFileSync(zipPath, exportZip(REAL_EXPORT_XML));
		const fd = openSync(zipPath, "r");
		try {
			const inspected = await inspectZipUpload(fd, statSync(zipPath).size);
			assert.equal(inspected.kind, "export");
			if (inspected.kind === "export") {
				const dest = join(dir, "out.xml");
				assert.deepEqual(await extractExportEntry(inspected.entry, dest), {
					kind: "extracted",
				});
				assert.equal(readFileSync(dest, "utf8"), REAL_EXPORT_XML);
			}
		} finally {
			closeSync(fd);
		}
		assert.deepEqual(
			readdirSync(dir).filter((n) => n.endsWith(".partial")),
			[],
		);
	});
});

// ─── scanExportXmlSummary ───────────────────────────────────────────────

test("scanExportXmlSummary: counts Records and Workouts exactly once, computes the date range", async () => {
	await withDir(async (dir) => {
		const xmlPath = join(dir, "export.xml");
		writeFileSync(xmlPath, REAL_EXPORT_XML);
		const summary = await scanExportXmlSummary(xmlPath);
		assert.equal(summary.looksLikeHealthExport, true);
		assert.equal(summary.recordCount, 2);
		assert.equal(summary.workoutCount, 1);
		assert.equal(summary.earliestStartDate, "2018-01-15T15:00:00.000Z");
		assert.equal(summary.latestStartDate, "2018-02-01T16:59:38.000Z");
	});
});

test("scanExportXmlSummary: does not double-count a Workout with nested MetadataEntry/WorkoutEvent children", async () => {
	await withDir(async (dir) => {
		const xmlPath = join(dir, "export.xml");
		writeFileSync(
			xmlPath,
			`<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
<Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="30" sourceName="iPhone" startDate="2018-01-15 07:00:00 -0800" endDate="2018-01-15 07:30:00 -0800">
<MetadataEntry key="HKIndoorWorkout" value="0"/>
<WorkoutEvent type="HKWorkoutEventTypePause" date="2018-01-15 07:10:00 -0800"/>
</Workout>
</HealthData>
`,
		);
		const summary = await scanExportXmlSummary(xmlPath);
		assert.equal(
			summary.workoutCount,
			1,
			"nested children must not be miscounted as additional Workout/Record elements",
		);
		assert.equal(summary.recordCount, 0);
	});
});

test("scanExportXmlSummary: a long run the tag pattern never matches is held and scanned only in part", {
	timeout: 120_000,
}, async () => {
	// A GPS route's locations match nothing the scan counts. Held whole and
	// rescanned with every chunk, 64 MiB of them cost time quadratic in their
	// length and memory in proportion to it.
	await withDir(async (dir) => {
		const xmlPath = join(dir, "export.xml");
		const fd = openSync(xmlPath, "w");
		try {
			writeSync(
				fd,
				'<?xml version="1.0"?>\n<HealthData locale="en_US">\n<ExportDate value="2026-09-01 12:00:00 -0500"/>\n',
			);
			const route = '<Location latitude="51.5" longitude="-0.1"/>\n'.repeat(
				24_000,
			);
			for (let i = 0; i < 64; i += 1) {
				writeSync(fd, route);
			}
			writeSync(
				fd,
				'\n<Record type="HKQuantityTypeIdentifierStepCount" unit="count" startDate="2026-06-05 08:00:00 -0500" value="1"/>\n</HealthData>\n',
			);
		} finally {
			closeSync(fd);
		}
		const started = Date.now();
		const summary = await scanExportXmlSummary(xmlPath);
		const elapsed = Date.now() - started;
		assert.equal(summary.recordCount, 1);
		assert.ok(elapsed < 5000, `took ${elapsed} ms`);
	});
});

/** Write an export at `path` from the body pieces `write` produces. */
function writeExportPieces(
	path: string,
	write: (w: (s: string) => void) => void,
): void {
	const fd = openSync(path, "w");
	try {
		writeSync(
			fd,
			'<?xml version="1.0"?>\n<HealthData locale="en_US">\n<ExportDate value="2026-09-01 12:00:00 -0500"/>\n',
		);
		write((s) => {
			writeSync(fd, s);
		});
		writeSync(fd, "</HealthData>\n");
	} finally {
		closeSync(fd);
	}
}

/** A step-count record's open tag on a day of June 2026, without its end. */
function stepCountTag(day: string): string {
	return `<Record type="HKQuantityTypeIdentifierStepCount" unit="count" startDate="2026-06-${day} 08:00:00 -0500" value="1"`;
}

test("scanExportXmlSummary: an element with millions of attributes is counted, not thrown on", async () => {
	// Matched as one repeated group, 2.5 million attributes exhaust the regex
	// engine's stack, and the preview would fail instead of describing the file.
	await withDir(async (dir) => {
		const xmlPath = join(dir, "export.xml");
		writeExportPieces(xmlPath, (w) => {
			w(`${stepCountTag("05")}/>\n${stepCountTag("06")}`);
			const attributes = ' a="1"'.repeat(100_000);
			for (let i = 0; i < 25; i += 1) {
				w(attributes);
			}
			w(`/>\n${stepCountTag("07")}/>\n`);
		});
		const summary = await scanExportXmlSummary(xmlPath);
		assert.equal(summary.recordCount, 3);
		assert.equal(summary.latestStartDate, "2026-06-07T13:00:00.000Z");
	});
});

test("scanExportXmlSummary: elements that never close cost time in proportion to their length", {
	timeout: 120_000,
}, async () => {
	// Scanned whole again with every chunk that arrives, six 18 MB tags that
	// never close within the pending ceiling take most of a minute.
	await withDir(async (dir) => {
		const xmlPath = join(dir, "export.xml");
		writeExportPieces(xmlPath, (w) => {
			const attributes = ' k="0123456789abc"'.repeat(100_000);
			for (let e = 1; e <= 6; e += 1) {
				w(stepCountTag(`0${e}`));
				for (let i = 0; i < 10; i += 1) {
					w(attributes);
				}
				w("/>\n");
			}
			w(`${stepCountTag("09")}/>\n`);
		});
		const started = Date.now();
		const summary = await scanExportXmlSummary(xmlPath);
		const elapsed = Date.now() - started;
		assert.equal(summary.recordCount, 1);
		assert.ok(elapsed < 5000, `took ${elapsed} ms`);
	});
});

test("scanExportXmlSummary: a file without the <HealthData root reports looksLikeHealthExport=false, zero counts", async () => {
	await withDir(async (dir) => {
		const xmlPath = join(dir, "not-health.xml");
		writeFileSync(
			xmlPath,
			'<?xml version="1.0"?>\n<Something><Record type="x" startDate="2018-01-01"/></Something>\n',
		);
		const summary = await scanExportXmlSummary(xmlPath);
		assert.equal(summary.looksLikeHealthExport, false);
	});
});

test("scanExportXmlSummary: an empty HealthData document (no records/workouts) is still recognized as a health export with zero counts", async () => {
	await withDir(async (dir) => {
		const xmlPath = join(dir, "empty.xml");
		writeFileSync(
			xmlPath,
			'<?xml version="1.0"?>\n<HealthData locale="en_US">\n<ExportDate value="2026-09-01 12:00:00 -0500"/>\n</HealthData>\n',
		);
		const summary = await scanExportXmlSummary(xmlPath);
		assert.equal(summary.looksLikeHealthExport, true);
		assert.equal(summary.recordCount, 0);
		assert.equal(summary.workoutCount, 0);
	});
});
