// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import {
	readZipEntries,
	ZipPolicyViolationError,
	zipBasename,
} from "../../packages/polyfill-connectors/src/bounded-zip-archive.ts";
import {
	ACTIVITIES_CSV,
	streamActivitiesCsvFromFile,
	ZIP_POLICY,
} from "./artifact-stream.ts";
import {
	buildActivityRecord,
	type ColumnIndex,
	parseCsvRows,
	resolveColumns,
	streamCsvRows,
} from "./parsers.ts";

export type StravaAccountExportValidationStatus =
	| "valid"
	| "duplicate"
	| "empty"
	| "unsupported"
	| "too_large";

type StravaExportFormat =
	| "strava_account_export_csv"
	| "strava_account_export_zip";

export interface StravaAccountExportValidationOptions {
	readonly existingFileHashes?: readonly string[];
	readonly fileName?: string | null;
	readonly maxFileBytes?: number | null;
}

export interface StravaAccountExportFileValidationOptions {
	readonly existingFileHashes?: readonly string[];
	readonly fileName: string;
	/** Already-known SHA-256 from the staged upload write. */
	readonly fileSha256: string;
	readonly maxFileBytes?: number | null;
}

export interface StravaAccountExportValidation {
	readonly date_range: {
		readonly end: string | null;
		readonly start: string | null;
	};
	readonly detected_format: StravaExportFormat | "unsupported";
	readonly detected_headers: readonly string[] | null;
	readonly estimated_records: number;
	readonly file_sha256: string;
	readonly remediation: string | null;
	readonly repeated_headers: {
		readonly distance: readonly number[];
		readonly elapsed_time: readonly number[];
	} | null;
	readonly status: StravaAccountExportValidationStatus;
}

function remediationFor(
	status: StravaAccountExportValidationStatus,
): string | null {
	switch (status) {
		case "duplicate":
			return "This Strava account export was already imported. Request a newer archive from Strava if you need more recent activities.";
		case "empty":
			return "This looks like a Strava account export, but activities.csv contains no importable activities.";
		case "too_large":
			return "This Strava file is larger than the upload limit. Extract the archive yourself and upload only activities.csv.";
		case "unsupported":
			return "Choose the ZIP Strava emailed you containing activities.csv, or upload activities.csv from that archive. Other files are not supported.";
		case "valid":
			return null;
	}
}

function baseValidation(
	fileSha256: string,
	status: StravaAccountExportValidationStatus = "unsupported",
): StravaAccountExportValidation {
	return {
		date_range: { end: null, start: null },
		detected_format: "unsupported",
		detected_headers: null,
		estimated_records: 0,
		file_sha256: fileSha256,
		remediation: remediationFor(status),
		repeated_headers: null,
		status,
	};
}

function formatForFileName(
	fileName: string | null | undefined,
): StravaExportFormat | null {
	if (fileName?.toLowerCase().endsWith(".zip")) {
		return "strava_account_export_zip";
	}
	if (fileName?.toLowerCase().endsWith(".csv")) {
		return "strava_account_export_csv";
	}
	return null;
}

function hasExpectedRepeatedHeaders(columns: ColumnIndex): boolean {
	return (
		columns.occurrences.get("Distance")?.length === 2 &&
		columns.occurrences.get("Elapsed Time")?.length === 2
	);
}

function dateRange(values: readonly string[]): {
	end: string | null;
	start: string | null;
} {
	let start: string | null = null;
	let end: string | null = null;
	for (const value of values) {
		if (!start || value < start) {
			start = value;
		}
		if (!end || value > end) {
			end = value;
		}
	}
	return { end, start };
}

class ValidationAccumulator {
	private columns: ColumnIndex | null = null;
	private earliest: string | null = null;
	private latest: string | null = null;
	private recordCount = 0;
	private header: string[] | null = null;
	private headerError = false;

	accept(row: string[], exportedAt: string | null): void {
		if (!this.header) {
			this.header = row;
			const resolved = resolveColumns(row);
			if (!("occurrences" in resolved)) {
				this.headerError = true;
				return;
			}
			this.columns = resolved;
			return;
		}
		if (this.headerError || !this.columns) {
			return;
		}
		if (row.length === 1 && row[0]?.trim() === "") {
			return;
		}
		const record = buildActivityRecord(row, this.columns, exportedAt);
		if (!record) {
			return;
		}
		this.recordCount += 1;
		if (!this.earliest || record.start_time < this.earliest) {
			this.earliest = record.start_time;
		}
		if (!this.latest || record.start_time > this.latest) {
			this.latest = record.start_time;
		}
	}

	result(
		format: StravaExportFormat,
		fileSha256: string,
		existingFileHashes: readonly string[] | undefined,
		parseError?: string,
	): StravaAccountExportValidation {
		const base = baseValidation(fileSha256);
		if (!this.header || this.headerError || !this.columns || parseError) {
			return {
				...base,
				detected_headers: this.header,
			};
		}
		if (!hasExpectedRepeatedHeaders(this.columns)) {
			return {
				...base,
				detected_headers: this.header,
			};
		}
		const status: StravaAccountExportValidationStatus = new Set(
			existingFileHashes ?? [],
		).has(fileSha256)
			? "duplicate"
			: this.recordCount === 0
				? "empty"
				: "valid";
		return {
			date_range: dateRange(
				[this.earliest, this.latest].filter(
					(value): value is string => value !== null,
				),
			),
			detected_format: format,
			detected_headers: this.header,
			estimated_records: this.recordCount,
			file_sha256: fileSha256,
			remediation: remediationFor(status),
			repeated_headers: {
				distance: this.columns.occurrences.get("Distance") ?? [],
				elapsed_time: this.columns.occurrences.get("Elapsed Time") ?? [],
			},
			status,
		};
	}
}

function validateRows(
	rows: readonly string[][],
	format: StravaExportFormat,
	fileSha256: string,
	options: StravaAccountExportValidationOptions,
	parseError?: string,
): StravaAccountExportValidation {
	const accumulator = new ValidationAccumulator();
	for (const row of rows) {
		accumulator.accept(row, null);
	}
	return accumulator.result(
		format,
		fileSha256,
		options.existingFileHashes,
		parseError,
	);
}

function validateBufferContents(
	bytes: Buffer,
	format: StravaExportFormat,
	fileSha256: string,
	options: StravaAccountExportValidationOptions,
): StravaAccountExportValidation {
	if (format === "strava_account_export_csv") {
		const parsed = parseCsvRows(bytes.toString("utf8"));
		return validateRows(parsed.rows, format, fileSha256, options, parsed.error);
	}
	try {
		const entries = readZipEntries(bytes, ZIP_POLICY);
		const match = entries.find(
			(entry) => zipBasename(entry.name).toLowerCase() === ACTIVITIES_CSV,
		);
		if (!match) {
			return baseValidation(fileSha256);
		}
		const parsed = parseCsvRows(match.data().toString("utf8"));
		return validateRows(parsed.rows, format, fileSha256, options, parsed.error);
	} catch (error) {
		return baseValidation(
			fileSha256,
			error instanceof ZipPolicyViolationError ? "too_large" : "unsupported",
		);
	}
}

export function validateStravaAccountExportArtifact(
	input: Buffer | Uint8Array | string,
	options: StravaAccountExportValidationOptions = {},
): StravaAccountExportValidation {
	const bytes =
		typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input);
	const fileSha256 = createHash("sha256").update(bytes).digest("hex");
	const fileName = options.fileName ?? ACTIVITIES_CSV;
	const format = formatForFileName(fileName);
	if (
		options.maxFileBytes !== null &&
		options.maxFileBytes !== undefined &&
		bytes.byteLength > options.maxFileBytes
	) {
		return baseValidation(fileSha256, "too_large");
	}
	if (!format) {
		return baseValidation(fileSha256);
	}
	return validateBufferContents(bytes, format, fileSha256, options);
}

export async function validateStravaAccountExportArtifactFromFile(
	fd: number,
	_filePath: string,
	fileSize: number,
	options: StravaAccountExportFileValidationOptions,
): Promise<StravaAccountExportValidation> {
	if (
		options.maxFileBytes !== null &&
		options.maxFileBytes !== undefined &&
		fileSize > options.maxFileBytes
	) {
		return baseValidation(options.fileSha256, "too_large");
	}
	const format = formatForFileName(options.fileName);
	if (!format) {
		return baseValidation(options.fileSha256);
	}

	const opened = await streamActivitiesCsvFromFile(
		fd,
		options.fileName,
		fileSize,
	);
	if (!opened.ok) {
		return baseValidation(options.fileSha256, opened.status ?? "unsupported");
	}

	const accumulator = new ValidationAccumulator();
	try {
		const parsed = await streamCsvRows(opened.source.stream, async (row) => {
			accumulator.accept(row, null);
		});
		return accumulator.result(
			format,
			options.fileSha256,
			options.existingFileHashes,
			parsed.error,
		);
	} catch {
		return baseValidation(options.fileSha256);
	} finally {
		opened.source.close();
	}
}
