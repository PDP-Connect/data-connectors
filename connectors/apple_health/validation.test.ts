// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import {
	closeSync,
	mkdtempSync,
	openSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildZip } from "./__fixtures__/zip.ts";
import { resolveUploadedExport, UPLOAD_LIMITS } from "./uploads.ts";
import {
	validateAppleHealthExportArtifact,
	validateAppleHealthExportArtifactFromFile,
	validateZipArtifact,
} from "./validation.ts";

const REAL_EXPORT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
<ExportDate value="2026-09-01 12:00:00 -0500"/>
<Record type="HKQuantityTypeIdentifierStepCount" sourceName="iPhone" unit="count" startDate="2018-01-30 08:59:38 -0800" endDate="2018-01-30 09:00:38 -0800" value="120"/>
<Record type="HKQuantityTypeIdentifierHeartRate" sourceName="Apple Watch" unit="count/min" startDate="2018-02-01 08:59:38 -0800" endDate="2018-02-01 08:59:38 -0800" value="61"/>
<Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="30" sourceName="iPhone" startDate="2018-01-15 07:00:00 -0800" endDate="2018-01-15 07:30:00 -0800"/>
</HealthData>
`;

const EMPTY_EXPORT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="en_US">
<ExportDate value="2026-09-01 12:00:00 -0500"/>
</HealthData>
`;

test("validateAppleHealthExportArtifact: a real export.xml is valid with correct counts and date range", async () => {
	const result = await validateAppleHealthExportArtifact(REAL_EXPORT_XML, {
		fileName: "export.xml",
	});
	assert.equal(result.status, "valid");
	assert.equal(result.detected_format, "apple_health_export_xml");
	assert.equal(result.estimated_records, 2);
	assert.equal(result.estimated_workouts, 1);
	assert.equal(result.remediation, null);
});

test("validateAppleHealthExportArtifact: a real export.zip (apple_health_export/export.xml) is valid", async () => {
	const zip = buildZip([
		{
			data: Buffer.from(REAL_EXPORT_XML),
			name: "apple_health_export/export.xml",
		},
	]);
	const result = await validateAppleHealthExportArtifact(zip, {
		fileName: "export.zip",
	});
	assert.equal(result.status, "valid");
	assert.equal(result.detected_format, "apple_health_export_zip");
	assert.equal(result.estimated_records, 2);
});

test("validateAppleHealthExportArtifact: an empty HealthData document is reported as empty, not valid", async () => {
	const result = await validateAppleHealthExportArtifact(EMPTY_EXPORT_XML, {
		fileName: "export.xml",
	});
	assert.equal(result.status, "empty");
	assert.match(result.remediation ?? "", /does not contain any records/);
});

test("validateAppleHealthExportArtifact: a wrong file (not a health export) is unsupported with actionable remediation, never reported valid", async () => {
	const result = await validateAppleHealthExportArtifact(
		'<?xml version="1.0"?>\n<NotHealth/>\n',
		{
			fileName: "export.xml",
		},
	);
	assert.equal(result.status, "unsupported");
	assert.match(result.remediation ?? "", /Export All Health Data/);
});

test("validateAppleHealthExportArtifact: a .zip with no export.xml entry is unsupported, not silently valid", async () => {
	const zip = buildZip([
		{ data: Buffer.from("not a health export"), name: "readme.txt" },
	]);
	const result = await validateAppleHealthExportArtifact(zip, {
		fileName: "export.zip",
	});
	assert.equal(result.status, "unsupported");
});

test("validateAppleHealthExportArtifact: a file exceeding maxFileBytes is too_large, not silently truncated", async () => {
	const result = await validateAppleHealthExportArtifact(REAL_EXPORT_XML, {
		fileName: "export.xml",
		maxFileBytes: 10,
	});
	assert.equal(result.status, "too_large");
});

test("validateAppleHealthExportArtifact: the same file hash reported as an existing hash is duplicate, not valid", async () => {
	const first = await validateAppleHealthExportArtifact(REAL_EXPORT_XML, {
		fileName: "export.xml",
	});
	const second = await validateAppleHealthExportArtifact(REAL_EXPORT_XML, {
		existingFileHashes: [first.file_sha256],
		fileName: "export.xml",
	});
	assert.equal(second.status, "duplicate");
});

const CDA_XML =
	'<?xml version="1.0" encoding="UTF-8"?>\n<ClinicalDocument xmlns="urn:hl7-org:v3"/>\n';

test("the upload preview and the import accept exactly the same archives", async () => {
	// One function selects the export in both. If they diverged, the preview
	// would accept an archive the import then cannot read, or turn away one it
	// could.
	const archives: ReadonlyArray<{
		accepted: boolean;
		entries: ReadonlyArray<{ name: string; data: string }>;
		label: string;
	}> = [
		{
			label: "standard export with its CDA companion",
			accepted: true,
			entries: [
				{ name: "apple_health_export/export.xml", data: REAL_EXPORT_XML },
				{ name: "apple_health_export/export_cda.xml", data: CDA_XML },
			],
		},
		{
			label: "localised export, CDA listed first",
			accepted: true,
			entries: [
				{ name: "apple_health_export/eksport_cda.xml", data: CDA_XML },
				{ name: "apple_health_export/eksport.xml", data: REAL_EXPORT_XML },
			],
		},
		{
			label: "export at the archive root",
			accepted: true,
			entries: [{ name: "export.xml", data: REAL_EXPORT_XML }],
		},
		{
			label: "CDA document only",
			accepted: false,
			entries: [{ name: "apple_health_export/export_cda.xml", data: CDA_XML }],
		},
		{
			label: "an XML that is not a Health export",
			accepted: false,
			entries: [
				{
					name: "apple_health_export/export.xml",
					data: '<?xml version="1.0"?>\n<NotHealth/>\n',
				},
			],
		},
		{
			label: "no XML at all",
			accepted: false,
			entries: [{ name: "readme.txt", data: "not a health export" }],
		},
		{
			label: "the export beside others sharing its base name",
			accepted: true,
			entries: [
				{ name: "export.xml", data: REAL_EXPORT_XML },
				{ name: "old/export.xml", data: REAL_EXPORT_XML },
				{ name: "notes/export.xml", data: "<notes/>" },
			],
		},
		{
			label: "an AppleDouble companion under __MACOSX",
			accepted: true,
			entries: [
				{
					name: "__MACOSX/apple_health_export/._export.xml",
					data: "\u0000\u0005\u0016\u0007",
				},
				{ name: "apple_health_export/export.xml", data: REAL_EXPORT_XML },
			],
		},
		{
			label: "HealthData named only inside another root and a comment",
			accepted: false,
			entries: [
				{
					name: "export.xml",
					data: '<?xml version="1.0"?>\n<!-- <HealthData> -->\n<Notes><HealthData/></Notes>\n',
				},
			],
		},
	];
	for (const archive of archives) {
		const zip = buildZip(archive.entries);
		const preview = await validateAppleHealthExportArtifact(zip, {
			fileName: "export.zip",
		});
		const dir = mkdtempSync(join(tmpdir(), "pdpp-apple-health-parity-"));
		try {
			const zipPath = join(dir, "export.zip");
			writeFileSync(zipPath, zip);
			const imported = await resolveUploadedExport(dir);
			assert.equal(
				preview.status === "valid",
				archive.accepted,
				`${archive.label}: preview status ${preview.status}`,
			);
			assert.equal(
				imported.kind === "export",
				archive.accepted,
				`${archive.label}: import outcome ${imported.kind}`,
			);
		} finally {
			rmSync(dir, { force: true, recursive: true });
		}
	}
});

test("the upload preview and the import say the same of a .zip cut short", async () => {
	// Cut before its central directory, as an interrupted transfer leaves it.
	const zip = buildZip([
		{ name: "apple_health_export/export.xml", data: REAL_EXPORT_XML },
	]).subarray(0, 200);
	const preview = await validateAppleHealthExportArtifact(zip, {
		fileName: "export.zip",
	});
	const dir = mkdtempSync(join(tmpdir(), "pdpp-apple-health-cut-"));
	try {
		writeFileSync(join(dir, "export.zip"), zip);
		const imported = await resolveUploadedExport(dir);
		assert.equal(preview.status, "unsupported");
		assert.equal(imported.kind, "failed");
		assert.equal(
			preview.remediation,
			imported.kind === "failed" ? imported.message : "",
		);
	} finally {
		rmSync(dir, { force: true, recursive: true });
	}
});

test("validateAppleHealthExportArtifact: thousands of route files beside the export still validate", async () => {
	const entries = [
		{ name: "apple_health_export/export.xml", data: REAL_EXPORT_XML },
	];
	for (let i = 0; i < 6000; i += 1) {
		entries.push({
			name: `apple_health_export/workout-routes/route_${i}.gpx`,
			data: "<gpx/>",
		});
	}
	const result = await validateAppleHealthExportArtifact(buildZip(entries), {
		fileName: "export.zip",
	});
	assert.equal(result.status, "valid");
	assert.equal(result.estimated_records, 2);
});

test("validateAppleHealthExportArtifact: an export too large for the classic zip format is too_large, with the unzip advice", async () => {
	const zip = buildZip([
		{
			name: "apple_health_export/export.xml",
			data: REAL_EXPORT_XML,
			zip64Sizes: true,
		},
	]);
	const result = await validateAppleHealthExportArtifact(zip, {
		fileName: "export.zip",
	});
	assert.equal(result.status, "too_large");
	assert.match(
		result.remediation ?? "",
		/is under 8 GB, unzip it on your computer and upload that XML instead/,
	);
});

test("validateAppleHealthExportArtifact: a .zip over the upload limit gets the size advice, not the unzip advice", async () => {
	// The XML inside an archive is larger than its compressed copy, so
	// unzipping an archive over the upload limit gives a file over it too.
	const zip = buildZip([
		{ name: "apple_health_export/export.xml", data: REAL_EXPORT_XML },
	]);
	const result = await validateAppleHealthExportArtifact(zip, {
		fileName: "export.zip",
		maxFileBytes: 10,
	});
	assert.equal(result.status, "too_large");
	assert.match(result.remediation ?? "", /raise the upload limit/);
	assert.doesNotMatch(result.remediation ?? "", /[Uu]nzip/);
	// Export All Health Data offers no date range to narrow.
	assert.doesNotMatch(result.remediation ?? "", /date range/);
});

test("validateAppleHealthExportArtifactFromFile: an upload over the limit names the operator only where a higher limit could admit it", async () => {
	// Nothing is read past the size check, so no file of these sizes is needed.
	const gb = 1024 ** 3;
	const cases = [
		{ label: "within what this import reads", size: 2 * gb, limit: gb },
		{ label: "over what this import reads", size: 9 * gb, limit: gb },
		{
			label: "the host limit already at that ceiling",
			size: 9 * gb,
			limit: 8.5 * gb,
		},
		// A .zip of 4 GiB or more needs the zip64 format, refused whatever the
		// limit; an XML of that size is read.
		{ label: "a .zip of 5 GiB", size: 5 * gb, limit: gb },
		{ label: "an XML of 5 GiB", size: 5 * gb, limit: gb, name: "export.xml" },
	];
	const results = await Promise.all(
		cases.map((c) =>
			validateAppleHealthExportArtifactFromFile(-1, "/nonexistent", c.size, {
				fileName: c.name ?? "export.zip",
				fileSha256: "0".repeat(64),
				maxFileBytes: c.limit,
			}),
		),
	);
	assert.deepEqual(
		results.map((r) => [r.status, /operator/.test(r.remediation ?? "")]),
		[
			["too_large", true],
			["too_large", false],
			["too_large", false],
			["too_large", false],
			["too_large", true],
		],
		cases.map((c) => c.label).join("; "),
	);
});

test("validateZipArtifact: an export over the size ceiling is told so, without advice that cannot work", async () => {
	// The zip under-declares the export's size, as a writer does whose sizes
	// wrap past 32 bits, so only the bytes actually inflated reveal it.
	const big = REAL_EXPORT_XML.replace(
		"</HealthData>",
		`${"<!-- padding -->\n".repeat(20_000)}</HealthData>`,
	);
	const limits = { ...UPLOAD_LIMITS, maxExportBytes: 200 * 1024 };
	assert.ok(big.length > limits.maxExportBytes);
	const dir = mkdtempSync(join(tmpdir(), "pdpp-apple-health-ceiling-"));
	try {
		const zipPath = join(dir, "export.zip");
		writeFileSync(
			zipPath,
			buildZip([
				{
					name: "apple_health_export/export.xml",
					data: big,
					declaredSize: 1000,
				},
			]),
		);
		const fd = openSync(zipPath, "r");
		try {
			const result = await validateZipArtifact(
				fd,
				statSync(zipPath).size,
				{ fileSha256: "0".repeat(64) },
				limits,
			);
			assert.equal(result.status, "too_large");
			assert.match(
				result.remediation ?? "",
				/larger than 204800 bytes, the most this import reads/,
			);
			// Neither unzipping nor a larger upload limit changes this ceiling.
			assert.doesNotMatch(
				result.remediation ?? "",
				/[Uu]nzip|operator|date range/,
			);
		} finally {
			closeSync(fd);
		}
	} finally {
		rmSync(dir, { force: true, recursive: true });
	}
});

test("the upload preview and the import accept exactly the same bare XML files", async () => {
	const documents: ReadonlyArray<{
		accepted: boolean;
		label: string;
		xml: string;
	}> = [
		{ label: "a Health export", accepted: true, xml: REAL_EXPORT_XML },
		{
			label: "an empty, self-closed HealthData root",
			accepted: true,
			xml: '<?xml version="1.0"?>\n<HealthData locale="en_US"/>\n',
		},
		{
			label: "HealthData named only inside a comment and another root",
			accepted: false,
			xml: '<?xml version="1.0"?>\n<!-- <HealthData> -->\n<Notes><HealthData/></Notes>\n',
		},
		{ label: "a CDA document", accepted: false, xml: CDA_XML },
	];
	for (const doc of documents) {
		const preview = await validateAppleHealthExportArtifact(doc.xml, {
			fileName: "export.xml",
		});
		const dir = mkdtempSync(join(tmpdir(), "pdpp-apple-health-xml-parity-"));
		try {
			writeFileSync(join(dir, "export.xml"), doc.xml);
			const imported = await resolveUploadedExport(dir);
			assert.equal(
				preview.status === "valid" || preview.status === "empty",
				doc.accepted,
				`${doc.label}: preview status ${preview.status}`,
			);
			assert.equal(
				imported.kind === "export",
				doc.accepted,
				`${doc.label}: import outcome ${imported.kind}`,
			);
		} finally {
			rmSync(dir, { force: true, recursive: true });
		}
	}
});
