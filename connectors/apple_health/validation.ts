// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import {
	closeSync,
	mkdtempSync,
	openSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanExportXmlSummary } from "./parsers.ts";
import {
	exportTooLargeMessage,
	extractExportEntry,
	inspectXmlUpload,
	inspectZipUpload,
	UNREADABLE_ARCHIVE_MESSAGE,
	UPLOAD_LIMITS,
	type UploadLimits,
	ZIP_MAX_CLASSIC_SIZE,
	zipTooLargeMessage,
} from "./uploads.ts";

export type AppleHealthExportValidationStatus =
	| "valid"
	| "duplicate"
	| "empty"
	| "unsupported"
	| "too_large";

export interface AppleHealthExportValidationOptions {
	readonly existingFileHashes?: readonly string[];
	readonly fileName?: string | null;
	readonly maxFileBytes?: number | null;
}

export interface AppleHealthExportValidation {
	readonly date_range: {
		readonly end: string | null;
		readonly start: string | null;
	};
	readonly detected_format:
		| "apple_health_export_xml"
		| "apple_health_export_zip"
		| "unsupported";
	readonly estimated_records: number;
	readonly estimated_workouts: number;
	readonly file_sha256: string;
	readonly remediation: string | null;
	readonly status: AppleHealthExportValidationStatus;
}

const ZIP_EXT_RE = /\.zip$/i;
const XML_EXT_RE = /\.xml$/i;

function remediationFor(
	status: AppleHealthExportValidationStatus,
): string | null {
	switch (status) {
		case "duplicate":
			return "This export was already imported. Produce a newer export from iPhone Health app > profile > Export All Health Data if you need more recent data.";
		case "empty":
			return "This looks like an Apple Health export, but it does not contain any records or workouts to import.";
		case "unsupported":
			return "Choose the .zip from Health app > profile > Export All Health Data, or the export.xml file extracted from it. Other files (Health app backups, screenshots, CSV exports from third-party apps) are not supported.";
		case "valid":
			return null;
		default:
			return null;
	}
}

/**
 * For an upload over the host's upload limit. Unzipping would not help,
 * since the XML inside is larger than its compressed copy, and Export All
 * Health Data offers no smaller date range. A higher limit helps only while
 * the host's is below the most this import reads and the file is one it
 * reads: an XML within that ceiling, or a .zip under 4 GiB, since a larger
 * one needs the zip64 format this reader refuses. The operator is named only
 * then.
 */
function overUploadLimit(
	fileSize: number,
	maxFileBytes: number,
	zip: boolean,
): string {
	const ceiling = UPLOAD_LIMITS.maxExportBytes;
	const readable = zip ? fileSize < ZIP_MAX_CLASSIC_SIZE : fileSize <= ceiling;
	const advice =
		maxFileBytes < ceiling && readable
			? " Ask your PDPP operator to raise the upload limit."
			: "";
	return `This export is larger than PDPP can safely process from a browser upload.${advice}`;
}

function baseValidation(
	fileSha256: string,
): Omit<AppleHealthExportValidation, "remediation" | "status"> {
	return {
		date_range: { end: null, start: null },
		detected_format: "unsupported",
		estimated_records: 0,
		estimated_workouts: 0,
		file_sha256: fileSha256,
	};
}

function buildValidationFromSummary(
	summary: {
		earliestStartDate: string | null;
		latestStartDate: string | null;
		looksLikeHealthExport: boolean;
		recordCount: number;
		workoutCount: number;
	},
	detectedFormat: "apple_health_export_xml" | "apple_health_export_zip",
	fileSha256: string,
	existingFileHashes: readonly string[] | undefined,
): AppleHealthExportValidation {
	if (!summary.looksLikeHealthExport) {
		return {
			...baseValidation(fileSha256),
			remediation: remediationFor("unsupported"),
			status: "unsupported",
		};
	}

	let status: AppleHealthExportValidationStatus = "valid";
	if (new Set(existingFileHashes ?? []).has(fileSha256)) {
		status = "duplicate";
	} else if (summary.recordCount === 0 && summary.workoutCount === 0) {
		status = "empty";
	}

	return {
		date_range: {
			end: summary.latestStartDate,
			start: summary.earliestStartDate,
		},
		detected_format: detectedFormat,
		estimated_records: summary.recordCount,
		estimated_workouts: summary.workoutCount,
		file_sha256: fileSha256,
		remediation: remediationFor(status),
		status,
	};
}

/**
 * Validate an already-staged Apple Health export artifact from disk (a bare
 * export.xml, or the .zip Health app produces) — the primary entrypoint,
 * used by the manual-upload route's file-backed dispatch. `fd`/`filePath`
 * are caller-owned; this function neither opens nor closes `fd`. A .zip is
 * read through `fd`, and its export is written to a scratch file removed
 * before returning. Matches {@link scanExportXmlSummary}'s O(1)-memory
 * streaming guarantee.
 */
export async function validateAppleHealthExportArtifactFromFile(
	fd: number,
	filePath: string,
	fileSize: number,
	options: {
		readonly existingFileHashes?: readonly string[];
		readonly fileName: string;
		readonly fileSha256: string;
		readonly maxFileBytes?: number | null;
	},
): Promise<AppleHealthExportValidation> {
	const base = baseValidation(options.fileSha256);
	if (
		options.maxFileBytes !== null &&
		options.maxFileBytes !== undefined &&
		fileSize > options.maxFileBytes
	) {
		return {
			...base,
			remediation: overUploadLimit(
				fileSize,
				options.maxFileBytes,
				ZIP_EXT_RE.test(options.fileName),
			),
			status: "too_large",
		};
	}

	if (XML_EXT_RE.test(options.fileName)) {
		if (inspectXmlUpload(filePath).kind !== "export") {
			return {
				...base,
				remediation: remediationFor("unsupported"),
				status: "unsupported",
			};
		}
		const summary = await scanExportXmlSummary(filePath);
		return buildValidationFromSummary(
			summary,
			"apple_health_export_xml",
			options.fileSha256,
			options.existingFileHashes,
		);
	}

	if (!ZIP_EXT_RE.test(options.fileName)) {
		return {
			...base,
			remediation: remediationFor("unsupported"),
			status: "unsupported",
		};
	}

	return await validateZipArtifact(fd, fileSize, options);
}

/**
 * The preview of an uploaded .zip. The export is found and extracted by the
 * same functions the import uses, to a scratch file that is scanned for the
 * preview's counts and then thrown away; the import extracts its own copy.
 * `limits` exists so a test can reach the export-size ceiling without an
 * 8 GB fixture.
 */
export async function validateZipArtifact(
	fd: number,
	fileSize: number,
	options: {
		readonly existingFileHashes?: readonly string[];
		readonly fileSha256: string;
	},
	limits: UploadLimits = UPLOAD_LIMITS,
): Promise<AppleHealthExportValidation> {
	const base = baseValidation(options.fileSha256);
	const unsupported: AppleHealthExportValidation = {
		...base,
		remediation: remediationFor("unsupported"),
		status: "unsupported",
	};
	const scratchDir = mkdtempSync(join(tmpdir(), "pdpp-apple-health-validate-"));
	const scratchPath = join(scratchDir, "export.xml");
	try {
		const zip = await inspectZipUpload(fd, fileSize, limits);
		if (zip.kind === "too_large") {
			// The same advice the import gives: unzip it, if what is inside is
			// within the size this import reads.
			return {
				...base,
				remediation: zipTooLargeMessage(zip.detail, limits),
				status: "too_large",
			};
		}
		if (zip.kind === "unreadable_archive") {
			// Most often an upload cut short; the import says the same of it.
			return { ...unsupported, remediation: UNREADABLE_ARCHIVE_MESSAGE };
		}
		if (zip.kind !== "export") {
			return unsupported;
		}
		const extraction = await extractExportEntry(zip.entry, scratchPath);
		if (extraction.kind === "export_too_large") {
			// Unzipping would not help, and no operator setting raises this
			// ceiling: the XML itself is over it.
			return {
				...base,
				remediation: exportTooLargeMessage(limits),
				status: "too_large",
			};
		}
		const summary = await scanExportXmlSummary(scratchPath);
		return buildValidationFromSummary(
			summary,
			"apple_health_export_zip",
			options.fileSha256,
			options.existingFileHashes,
		);
	} catch {
		// An archive that throws is corrupt or unsafe: not one this connector
		// can read, whatever it holds.
		return unsupported;
	} finally {
		rmSync(scratchDir, { force: true, recursive: true });
	}
}

/**
 * Buffer-backed entrypoint required by the connector-owned validation
 * registry's uniform dispatch shape (see manual-upload-validation.ts) even
 * though Apple Health exports are never appropriately validated from an
 * in-memory buffer at real-world size — this writes the buffer to a scratch
 * temp file and delegates to the file-backed path above, so the SAME
 * streaming logic runs either way and a small buffer (e.g. a synthetic
 * fixture in a test) is not a second, divergent code path.
 */
export async function validateAppleHealthExportArtifact(
	input: Buffer | Uint8Array | string,
	options: AppleHealthExportValidationOptions = {},
): Promise<AppleHealthExportValidation> {
	const bytes =
		typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input);
	const fileSha256 = createHash("sha256").update(bytes).digest("hex");
	const fileName = options.fileName ?? "export.xml";

	const scratchDir = mkdtempSync(
		join(tmpdir(), "pdpp-apple-health-validate-buf-"),
	);
	const scratchPath = join(
		scratchDir,
		fileName.replace(/[^\w.-]/g, "_") || "export.xml",
	);
	try {
		writeFileSync(scratchPath, bytes);
		const fd = openSync(scratchPath, "r");
		try {
			return await validateAppleHealthExportArtifactFromFile(
				fd,
				scratchPath,
				bytes.length,
				{
					...(options.existingFileHashes === undefined
						? {}
						: { existingFileHashes: options.existingFileHashes }),
					fileName,
					fileSha256,
					maxFileBytes: options.maxFileBytes ?? null,
				},
			);
		} finally {
			closeSync(fd);
		}
	} finally {
		rmSync(scratchDir, { force: true, recursive: true });
	}
}
