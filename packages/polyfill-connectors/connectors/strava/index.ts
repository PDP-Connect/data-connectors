#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PDPP Strava Connector (v1.0.0) — file-based.
 *
 * Auth: none. This reads the archive Strava produces when the owner asks for a
 * copy of their account (Settings → My Account → Download or Delete Your
 * Account → Request Your Archive). Strava emails a link within hours, or
 * several days for a long history.
 *
 * WHY AN IMPORT AND NOT AN API. Not a workaround — a different regime. Strava's
 * API Policy defines "Strava Data" by its SOURCE: data accessed or collected
 * from the Strava API. An archive Strava hands its own user was never accessed
 * from the API, so the Policy's restrictions do not attach to it, and the export
 * right is stated separately and left unconditioned. This is why the export is
 * not a loophole in the API terms: it is outside them.
 *
 * Those restrictions would, by contrast, defeat a Personal Server outright. The
 * Policy holds Strava Data to a short cache; forbids providing it to any third
 * party other than the Strava user of the application that fetched it, expressly
 * including where that user consents; forbids combining it with other data;
 * forbids accumulating a corpus through repeated authorized calls; and requires
 * deletion from all systems under the developer's control on request. A server
 * whose purpose is that other applications read it satisfies none of these, at
 * any tier, and the deletion warranty is one this architecture could not
 * discharge even in principle.
 *
 * DO NOT "IMPROVE" THIS BY AUTOMATING THE DOWNLOAD. `manual_or_upload` is
 * load-bearing, not a convenience. Strava's Terms of Service prohibit accessing
 * the site by any means other than an interface Strava provides, "regardless of
 * whether you are logged into a Strava account at the time". Driving the export
 * UI, scripting the login, or fetching the archive on the owner's behalf all
 * cross that line; the owner downloading their own archive and handing us the
 * file does not. The owner's manual step IS the compliance boundary.
 *
 * The export is also the better read for this product's fields: `activities.csv`
 * carries calories, which over the API needs a per-activity detail call. (Gear
 * does not — `SummaryActivity` carries `gear_id`, so that is one call per piece
 * of kit, not per activity. Stated precisely because an overstated engineering
 * argument discredits the sound legal one beside it.)
 *
 * Streams:
 *   - activities            one record per workout
 *   - coverage_diagnostics  one record per stream per import, saying what was
 *                           covered and why it stops there
 *
 * Freshness is `snapshot`, stated in the payload and not only in the manifest,
 * because a reader holds records rather than the manifest.
 */

import {
	closeSync,
	existsSync,
	openSync,
	readdirSync,
	readSync,
	realpathSync,
	statSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	hasZipLocalFileSignature,
	readZipEntriesFromFile,
	ZipPolicyViolationError,
	zipBasename,
} from "../../src/bounded-zip-archive.ts";
import type { CollectContext } from "../../src/connector-runtime.ts";
import { runConnector } from "../../src/connector-runtime.ts";
import {
	type ActivityRecord,
	buildActivityRecord,
	type ColumnIndex,
	parseCsvRows,
	resolveColumns,
} from "./parsers.ts";
import { type COVERAGE_REASONS, validateRecord } from "./schemas.ts";

const ACTIVITIES_STREAM = "activities";
const DIAGNOSTICS_STREAM = "coverage_diagnostics";
const UPLOADED_ARTIFACT_RE = /\.(csv|zip)$/i;
const ACTIVITIES_CSV = "activities.csv";

/**
 * A Strava archive holds one file per activity beside the index, so entry
 * counts are high and legitimate. The budget bounds inflation rather than
 * ambition: only `activities.csv` is ever inflated, and nothing else in the
 * archive is read at all.
 */
const ZIP_POLICY = {
	maxEntries: 200_000,
	maxEntryUncompressedBytes: 256 * 1024 * 1024,
	maxTotalUncompressedBytes: 256 * 1024 * 1024,
} as const;

type CoverageReason = (typeof COVERAGE_REASONS)[number];

interface ActivitiesState {
	last_start_time?: string;
}

interface StravaState {
	activities?: ActivitiesState;
}

interface LoadFailure {
	readonly failed: true;
	readonly reason:
		| "strava_export_not_recognised"
		| "strava_export_columns_unexpected";
	readonly message: string;
}

interface LoadedCsv {
	readonly failed: false;
	/** ISO timestamp of the artifact the rows came from. See resolveExportedAt. */
	readonly exportedAt: string | null;
	readonly columns: ColumnIndex;
	readonly rows: string[][];
	/** Rows the CSV reader could not complete — a truncated download. */
	readonly truncated: boolean;
}

function isFailure(value: LoadedCsv | LoadFailure): value is LoadFailure {
	return value.failed;
}

/**
 * The archive's own file timestamp.
 *
 * This is the honest upper bound on the data's age and the value a reader
 * needs in order to say "your Strava last synced <date>" rather than
 * presenting a month-old reading as current. It is NOT a claim about the
 * instant Strava generated the archive — the export carries no such field
 * anywhere, and inventing one would be the kind of confident wrong value this
 * connector exists to avoid. What it states is: the records are no fresher
 * than this.
 */
function resolveExportedAt(filePath: string): string | null {
	try {
		return statSync(filePath).mtime.toISOString();
	} catch {
		return null;
	}
}

/**
 * The archive to read, newest first.
 *
 * Ordered by modification time rather than by name, and the reason is a real
 * failure rather than a preference: Strava's archives are date-stamped, the
 * host does not prune a previous upload, and an owner who re-exports after six
 * months leaves two files side by side. Alphabetical order picks the OLDER of
 * the two, so the refresh silently collects nothing new and the owner is told
 * their data is up to date as of a date that has already passed.
 */
function findUploadedArtifact(importDir: string): string | null {
	try {
		return (
			readdirSync(importDir, { withFileTypes: true })
				.filter(
					(entry) => entry.isFile() && UPLOADED_ARTIFACT_RE.test(entry.name),
				)
				.map((entry) => {
					let mtimeMs = 0;
					try {
						mtimeMs = statSync(join(importDir, entry.name)).mtimeMs;
					} catch {
						mtimeMs = 0;
					}
					return { mtimeMs, name: entry.name };
				})
				// Name is the tie-break so the choice stays deterministic when two
				// files share a timestamp, which a single unzip routinely produces.
				.sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name))
				.at(0)?.name ?? null
		);
	} catch {
		return null;
	}
}

/**
 * Pull `activities.csv` out of the uploaded artifact. Accepts the archive ZIP
 * or a bare `activities.csv`, because the manifest tells owners with a large
 * archive to upload just that file.
 */
function readActivitiesCsv(
	filePath: string,
): { ok: true; text: string } | { ok: false; message: string } {
	let fd: number;
	try {
		fd = openSync(filePath, "r");
	} catch {
		return { ok: false, message: "The uploaded file could not be opened." };
	}
	try {
		const size = statSync(filePath).size;
		if (size === 0) {
			return { ok: false, message: "The uploaded file is empty." };
		}
		if (!filePath.toLowerCase().endsWith(".zip")) {
			// A bare CSV upload. hasZipLocalFileSignature guards the case where a
			// ZIP was renamed to .csv, which would otherwise parse as one very
			// strange row of binary.
			const head = Buffer.alloc(Math.min(4, size));
			readSync(fd, head, 0, head.length, 0);
			if (hasZipLocalFileSignature(head)) {
				return {
					ok: false,
					message:
						"That file is a ZIP archive with a .csv name. Upload it with its original .zip name.",
				};
			}
			const buf = Buffer.alloc(size);
			readSync(fd, buf, 0, size, 0);
			return { ok: true, text: buf.toString("utf8") };
		}

		const entries = readZipEntriesFromFile(fd, size, ZIP_POLICY);
		const match = entries.find(
			(entry) => zipBasename(entry.name).toLowerCase() === ACTIVITIES_CSV,
		);
		if (!match) {
			return {
				ok: false,
				message: `The archive does not contain ${ACTIVITIES_CSV}. Upload the ZIP Strava emailed you, or the ${ACTIVITIES_CSV} from inside it.`,
			};
		}
		return { ok: true, text: match.data().toString("utf8") };
	} catch (error) {
		if (error instanceof ZipPolicyViolationError) {
			return {
				ok: false,
				message: `The archive exceeds the safe read policy: ${error.message}`,
			};
		}
		return {
			ok: false,
			message: `The uploaded file could not be read: ${error instanceof Error ? error.message : String(error)}`,
		};
	} finally {
		closeSync(fd);
	}
}

function loadCsv(importDir: string, fileName: string): LoadedCsv | LoadFailure {
	const filePath = join(importDir, fileName);
	const read = readActivitiesCsv(filePath);
	if (!read.ok) {
		return {
			failed: true,
			reason: "strava_export_not_recognised",
			message: read.message,
		};
	}
	const parsed = parseCsvRows(read.text);
	const header = parsed.rows.at(0);
	if (!header) {
		return {
			failed: true,
			reason: "strava_export_not_recognised",
			message: `${ACTIVITIES_CSV} has no header row.`,
		};
	}
	const columns = resolveColumns(header);
	if ("message" in columns && !("occurrences" in columns)) {
		return {
			failed: true,
			reason: "strava_export_columns_unexpected",
			message: columns.message,
		};
	}
	return {
		failed: false,
		columns: columns as ColumnIndex,
		rows: parsed.rows.slice(1),
		exportedAt: resolveExportedAt(filePath),
		truncated: Boolean(parsed.error),
	};
}

interface Coverage {
	readonly reason: CoverageReason;
	readonly status: "complete" | "partial" | "empty";
	readonly recordCount: number;
	readonly from: string | null;
	readonly to: string | null;
	readonly requestedFrom: string | null;
	/**
	 * Optional columns this archive did not carry. Calories and gear are the two
	 * fields the export path exists to deliver, and neither is a required
	 * column — an archive without them would otherwise degrade to all-null with
	 * nothing anywhere saying why.
	 */
	readonly fieldsUnavailable: readonly string[];
}

async function emitDiagnostics(
	ctx: CollectContext,
	coverage: Coverage,
	exportedAt: string | null,
): Promise<void> {
	if (!ctx.requested.has(DIAGNOSTICS_STREAM)) {
		return;
	}
	await ctx.emitRecord(DIAGNOSTICS_STREAM, {
		id: `${ACTIVITIES_STREAM}:${exportedAt ?? "unknown"}`,
		stream: ACTIVITIES_STREAM,
		status: coverage.status,
		reason: coverage.reason,
		record_count: coverage.recordCount,
		fields_unavailable: [...coverage.fieldsUnavailable],
		window_requested_from: coverage.requestedFrom,
		window_requested_to: null,
		window_covered_from: coverage.from,
		window_covered_to: coverage.to,
		freshness: "snapshot",
		exported_at: exportedAt,
	});
}

/** A receipt for a run that collected nothing, so no failure is ever silent. */
function emptyCoverage(
	reason: CoverageReason,
	requestedFrom: string | null,
): Coverage {
	return {
		reason,
		status: "empty",
		recordCount: 0,
		from: null,
		to: null,
		requestedFrom,
		fieldsUnavailable: [],
	};
}

async function collectActivities(
	ctx: CollectContext,
	importDir: string,
	state: ActivitiesState | undefined,
): Promise<void> {
	const { emit, emitRecord } = ctx;

	let canonicalDir: string;
	try {
		canonicalDir = realpathSync(importDir);
	} catch (error) {
		await emit({
			type: "SKIP_RESULT",
			stream: ACTIVITIES_STREAM,
			reason: "strava_export_not_recognised",
			message: `Failed to resolve import directory: ${error instanceof Error ? error.message : String(error)}`,
		});
		await emitDiagnostics(
			ctx,
			emptyCoverage("source_unreadable", state?.last_start_time ?? null),
			null,
		);
		return;
	}

	const fileName = findUploadedArtifact(canonicalDir);
	if (!fileName) {
		await emit({
			type: "SKIP_RESULT",
			stream: ACTIVITIES_STREAM,
			reason: "strava_export_not_recognised",
			message: `No Strava export found in ${canonicalDir}. Upload the ZIP Strava emailed you, or the ${ACTIVITIES_CSV} from inside it.`,
		});
		// An owner who has not uploaded anything yet has not suffered a failure.
		// Reporting "some of your activities didn't arrive — import it again" for
		// a file that does not exist is the exact dishonesty this enum exists to
		// prevent: every value has to end in the right sentence.
		await emitDiagnostics(
			ctx,
			emptyCoverage("awaiting_upload", state?.last_start_time ?? null),
			null,
		);
		return;
	}

	const loaded = loadCsv(canonicalDir, fileName);
	if (isFailure(loaded)) {
		await emit({
			type: "SKIP_RESULT",
			stream: ACTIVITIES_STREAM,
			reason: loaded.reason,
			message: loaded.message,
		});
		await emitDiagnostics(
			ctx,
			emptyCoverage("source_unreadable", state?.last_start_time ?? null),
			null,
		);
		return;
	}

	const { columns, rows, exportedAt, truncated } = loaded;
	// Strava activities are mutable at source: owners rename them, correct the
	// sport, and delete them. An incremental run keyed on start_time can never
	// see any of that, because an edit does not move the activity in time. A
	// full refresh is the owner asking for exactly that, so it must ignore the
	// cursor and re-emit the archive whole — the stream is declared
	// mutable_state and the primary key is stable, so the reader supersedes
	// rather than duplicates.
	const fullRefresh = ctx.collectionMode === "full_refresh";
	const since = fullRefresh ? undefined : state?.last_start_time;

	await emit({
		type: "PROGRESS",
		stream: ACTIVITIES_STREAM,
		message: `Strava phase=emit stream=activities source=${fileName} total_rows=${rows.length}`,
		total: rows.length,
	});

	let emitted = 0;
	let unreadable = 0;
	let earliest: string | null = null;
	let latest: string | undefined = since;

	for (const row of rows) {
		if (row.length === 1 && row[0]?.trim() === "") {
			continue; // trailing newline
		}
		const record: ActivityRecord | null = buildActivityRecord(
			row,
			columns,
			exportedAt,
		);
		if (!record) {
			unreadable += 1;
			continue;
		}
		// The cursor makes a re-import of an overlapping archive cheap: Strava's
		// activity ids are stable across exports, so the second archive collapses
		// onto the first rather than double-counting.
		if (since && record.start_time <= since) {
			continue;
		}
		await emitRecord(ACTIVITIES_STREAM, { ...record });
		emitted += 1;
		if (!earliest || record.start_time < earliest) {
			earliest = record.start_time;
		}
		if (!latest || record.start_time > latest) {
			latest = record.start_time;
		}
		if (emitted % 250 === 0) {
			await emit({
				type: "PROGRESS",
				stream: ACTIVITIES_STREAM,
				message: `Strava phase=emit stream=activities emitted=${emitted} unreadable=${unreadable}`,
				count: emitted,
				total: rows.length,
			});
		}
	}

	// Three outcomes that must not be conflated, because each ends in a different
	// sentence to the owner:
	//
	//   truncated     the file stopped mid-row, so activities exist beyond what we
	//                 read. Importing again can recover them.
	//   unreadable>0  the file was read to the end; some rows carried no usable id
	//                 or date. Importing the same file again recovers nothing —
	//                 those rows will be just as bad next time.
	//   emitted===0   nothing in range. Ordinary, and not a failure at all.
	let reason: CoverageReason;
	let status: Coverage["status"];
	if (truncated) {
		reason = "collection_interrupted";
		status = emitted > 0 ? "partial" : "empty";
	} else if (unreadable > 0) {
		reason = "records_unreadable";
		status = emitted > 0 ? "partial" : "empty";
	} else if (emitted === 0) {
		reason = "nothing_in_range";
		status = "empty";
	} else {
		reason = "covered_in_full";
		status = "complete";
	}

	if (truncated || unreadable > 0) {
		await emit({
			type: "SKIP_RESULT",
			stream: ACTIVITIES_STREAM,
			reason,
			message: truncated
				? `${ACTIVITIES_CSV} ended mid-row, so an unknown number of activities were not read.`
				: `${String(unreadable)} row(s) in ${ACTIVITIES_CSV} had no usable activity id or date and were not read.`,
			diagnostics: { unreadable_rows: unreadable, truncated },
		});
	}

	// Calories and gear are the two fields this path exists to deliver and
	// neither is a required column, so an archive without them must say so
	// rather than presenting a column of nulls.
	const fieldsUnavailable = [
		columns.calories === null ? "calories_kcal" : null,
		columns.gear === null ? "gear" : null,
		columns.movingTimeS === null ? "moving_time_s" : null,
		columns.averageHeartRate === null ? "average_heartrate" : null,
		columns.maxHeartRate === null ? "max_heartrate" : null,
		columns.elevationGainM === null ? "total_elevation_gain_m" : null,
	].filter((field): field is string => field !== null);

	await emitDiagnostics(
		ctx,
		{
			reason,
			status,
			recordCount: emitted,
			from: earliest,
			to: latest ?? null,
			requestedFrom: since ?? null,
			fieldsUnavailable,
		},
		exportedAt,
	);

	// Hold the cursor ONLY when the file was truncated, because only then does
	// unread history exist beyond it. Holding it for unreadable rows would stall
	// the cursor permanently: those rows fail identically on every future
	// import, so the connector would re-read the whole archive for ever and
	// "the second run resumes" would never be true on a real file.
	await emit({
		type: "STATE",
		stream: ACTIVITIES_STREAM,
		cursor: {
			last_start_time: truncated ? (since ?? null) : (latest ?? null),
		},
	});
}

runConnector({
	name: "strava",
	validateRecord,
	// Without this the runtime falls back to a field named "date", which these
	// records do not have, and any connection carrying an owner-declared time
	// scope fails the whole run instead of filtering.
	timeRangeField: "start_time",
	async collect(ctx) {
		const importDir =
			process.env.STRAVA_EXPORT_DIR ||
			join(homedir(), ".pdpp", "imports", "strava");

		const state = ctx.state as StravaState | undefined;

		if (!existsSync(importDir)) {
			// This is the commonest first-run state, and it used to emit a bare
			// PROGRESS and return — no skip, no receipt. A run that collected
			// nothing looked exactly like a healthy one.
			if (ctx.requested.has(ACTIVITIES_STREAM)) {
				await ctx.emit({
					type: "SKIP_RESULT",
					stream: ACTIVITIES_STREAM,
					reason: "strava_export_not_recognised",
					message: `No Strava import directory at ${importDir}. Set STRAVA_EXPORT_DIR, or put the archive in ~/.pdpp/imports/strava/`,
				});
				await emitDiagnostics(
					ctx,
					emptyCoverage(
						"awaiting_upload",
						state?.activities?.last_start_time ?? null,
					),
					null,
				);
			}
			return;
		}

		if (!ctx.requested.has(ACTIVITIES_STREAM)) {
			return;
		}
		await collectActivities(ctx, importDir, state?.activities);
	},
});
