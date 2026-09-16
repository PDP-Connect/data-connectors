// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { createReadStream, mkdtempSync, readSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	hasZipLocalFileSignature,
	streamZipEntryToFile,
	ZipPolicyViolationError,
} from "../../src/bounded-zip-archive.ts";

export const ACTIVITIES_CSV = "activities.csv";

/**
 * A Strava archive may contain many per-activity files, but the connector only
 * reads this one member. Metadata and actual inflated bytes stay bounded by
 * the shared ZIP policy before this module hands the CSV to the row parser.
 */
export const ZIP_POLICY = {
	maxEntries: 200_000,
	maxEntryUncompressedBytes: 256 * 1024 * 1024,
	maxTotalUncompressedBytes: 256 * 1024 * 1024,
} as const;

export interface ActivitiesCsvSource {
	readonly close: () => void;
	readonly stream: AsyncIterable<string>;
}

export type ActivitiesCsvSourceResult =
	| { readonly ok: true; readonly source: ActivitiesCsvSource }
	| {
			readonly ok: false;
			readonly message: string;
			readonly status?: "too_large";
	  };

function closeStream(stream: ReturnType<typeof createReadStream>): void {
	if (stream.readableEnded || stream.destroyed) {
		return;
	}
	stream.destroy();
}

/**
 * Create a UTF-8 CSV stream from an already-open artifact descriptor. The
 * descriptor remains caller-owned and is never closed here.
 *
 * Bare CSVs are read directly from `fd`. ZIPs are checked through the bounded
 * archive reader and only `activities.csv` is extracted to a scratch file;
 * the extracted file is then streamed and removed by `source.close()`.
 */
export async function streamActivitiesCsvFromFile(
	fd: number,
	fileName: string,
	fileSize: number,
): Promise<ActivitiesCsvSourceResult> {
	if (fileSize === 0) {
		return { ok: false, message: "The uploaded file is empty." };
	}

	if (!fileName.toLowerCase().endsWith(".zip")) {
		const head = Buffer.alloc(Math.min(4, fileSize));
		try {
			const bytesRead = readSync(fd, head, 0, head.length, 0);
			if (hasZipLocalFileSignature(head.subarray(0, bytesRead))) {
				return {
					ok: false,
					message:
						"That file is a ZIP archive with a .csv name. Upload it with its original .zip name.",
				};
			}
		} catch {
			return { ok: false, message: "The uploaded file could not be read." };
		}

		const stream = createReadStream("", {
			autoClose: false,
			encoding: "utf8",
			fd,
			start: 0,
		});
		return {
			ok: true,
			source: {
				close: () => closeStream(stream),
				stream,
			},
		};
	}

	const scratchDir = mkdtempSync(join(tmpdir(), "pdpp-strava-csv-"));
	const scratchPath = join(scratchDir, ACTIVITIES_CSV);
	let extracted = false;
	try {
		const result = await streamZipEntryToFile(
			fd,
			fileSize,
			ACTIVITIES_CSV,
			scratchPath,
			ZIP_POLICY,
		);
		if (!result.found) {
			return {
				ok: false,
				message: `The archive does not contain ${ACTIVITIES_CSV}. Upload the ZIP Strava emailed you, or the ${ACTIVITIES_CSV} from inside it.`,
			};
		}
		const stream = createReadStream(scratchPath, { encoding: "utf8" });
		extracted = true;
		return {
			ok: true,
			source: {
				close: () => {
					closeStream(stream);
					rmSync(scratchDir, { force: true, recursive: true });
				},
				stream,
			},
		};
	} catch (error) {
		if (error instanceof ZipPolicyViolationError) {
			return {
				ok: false,
				message: `The archive exceeds the safe read policy: ${error.message}`,
				status: "too_large",
			};
		}
		return {
			ok: false,
			message: `The uploaded file could not be read: ${error instanceof Error ? error.message : String(error)}`,
		};
	} finally {
		if (!extracted) {
			rmSync(scratchDir, { force: true, recursive: true });
		}
	}
}
