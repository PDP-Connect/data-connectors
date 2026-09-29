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
 *
 * Freshness is `snapshot`, stated in the payload and not only in the manifest,
 * because a reader holds records rather than the manifest.
 */

import {
	closeSync,
	existsSync,
	openSync,
	readdirSync,
	realpathSync,
	statSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CollectContext } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { runConnector } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import {
	ACTIVITIES_CSV,
	type ActivitiesCsvSource,
	streamActivitiesCsvFromFile,
} from "./artifact-stream.ts";
import {
	type ActivityRecord,
	buildActivityRecord,
	type ColumnIndex,
	resolveColumns,
	streamCsvRows,
} from "./parsers.ts";
import { validateRecord } from "./schemas.ts";

const ACTIVITIES_STREAM = "activities";
const UPLOADED_ARTIFACT_RE = /\.(csv|zip)$/i;
type CollectionReason = "collection_interrupted" | "records_unreadable";
const COLLECTION_SKIP_REASON: Record<CollectionReason, string> = {
	collection_interrupted: "collection_interrupted",
	records_unreadable: "records_unreadable",
};

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

type CsvSourceResult =
	| {
			readonly ok: true;
			readonly exportedAt: string | null;
			readonly source: ActivitiesCsvSource;
	  }
	| { readonly ok: false; readonly message: string };

/**
 * Open the uploaded artifact as a UTF-8 stream. Bare CSVs stream directly from
 * the caller-owned file descriptor. ZIPs use the shared bounded extractor to
 * stream only `activities.csv` to a scratch file, then parse that file row by
 * row. Neither path materializes the CSV or retains its rows in memory.
 */
async function openActivitiesCsv(filePath: string): Promise<CsvSourceResult> {
	let fd: number;
	try {
		fd = openSync(filePath, "r");
	} catch {
		return { ok: false, message: "The uploaded file could not be opened." };
	}
	let handedOff = false;
	try {
		const size = statSync(filePath).size;
		const result = await streamActivitiesCsvFromFile(fd, filePath, size);
		if (!result.ok) {
			return result;
		}
		handedOff = true;
		return {
			ok: true,
			exportedAt: resolveExportedAt(filePath),
			source: {
				close: () => {
					result.source.close();
					closeSync(fd);
				},
				stream: result.source.stream,
			},
		};
	} catch (error) {
		return {
			ok: false,
			message: `The uploaded file could not be read: ${error instanceof Error ? error.message : String(error)}`,
		};
	} finally {
		if (!handedOff) {
			closeSync(fd);
		}
	}
}

/** Match the runtime's inclusive-since/exclusive-until date filtering locally. */
function isOutsideRequestedTimeRange(
	dateValue: string,
	timeRange: { since?: string; until?: string } | undefined,
): boolean {
	if (!timeRange) {
		return false;
	}
	if (timeRange.since && dateValue < timeRange.since.slice(0, 10)) {
		return true;
	}
	return Boolean(timeRange.until && dateValue >= timeRange.until.slice(0, 10));
}

async function collectActivities(
	ctx: CollectContext,
	importDir: string,
	state: ActivitiesState | undefined,
): Promise<void> {
	const { emit, emitRecord } = ctx;
	const fullRefresh = ctx.collectionMode === "full_refresh";
	const since = fullRefresh ? undefined : state?.last_start_time;
	const timeRange = ctx.requested.get(ACTIVITIES_STREAM)?.time_range;

	let canonicalDir: string;
	try {
		canonicalDir = realpathSync(importDir);
	} catch (error) {
		await emit({
			type: "SKIP_RESULT",
			stream: ACTIVITIES_STREAM,
			reason: "strava_export_not_recognised",
			recovery_hint: { action: "manual_action_required", retryable: false },
			message: `Failed to resolve import directory: ${error instanceof Error ? error.message : String(error)}`,
		});
		return;
	}

	const fileName = findUploadedArtifact(canonicalDir);
	if (!fileName) {
		await emit({
			type: "SKIP_RESULT",
			stream: ACTIVITIES_STREAM,
			reason: "strava_export_not_recognised",
			recovery_hint: { action: "manual_action_required", retryable: false },
			message: `No Strava export found in ${canonicalDir}. Upload the ZIP Strava emailed you, or the ${ACTIVITIES_CSV} from inside it.`,
		});
		// An owner who has not uploaded anything yet has not suffered a failure.
		// Reporting "some of your activities didn't arrive — import it again" for
		// a file that does not exist is the exact dishonesty this enum exists to
		// prevent: every value has to end in the right sentence.
		return;
	}

	const opened = await openActivitiesCsv(join(canonicalDir, fileName));
	if (!opened.ok) {
		await emit({
			type: "SKIP_RESULT",
			stream: ACTIVITIES_STREAM,
			reason: "strava_export_not_recognised",
			recovery_hint: { action: "manual_action_required", retryable: false },
			message: opened.message,
		});
		return;
	}

	const { source, exportedAt } = opened;
	// Strava activities are mutable at source: owners rename them, correct the
	// sport, and delete them. An incremental run keyed on start_time can never
	// see any of that, because an edit does not move the activity in time. A
	// full refresh is the owner asking for exactly that, so it must ignore the
	// cursor and re-emit the archive whole — the stream is declared
	// mutable_state and the primary key is stable, so the reader supersedes
	// rather than duplicates.
	await emit({
		type: "PROGRESS",
		stream: ACTIVITIES_STREAM,
		message: `Strava phase=emit stream=activities source=${fileName} mode=streaming`,
	});

	let emitted = 0;
	let unreadable = 0;
	let earliest: string | null = null;
	let coveredLatest: string | null = null;
	let cursorLatest: string | null = since ?? null;
	const parseState: {
		columns: ColumnIndex | null;
		headerSeen: boolean;
		loadFailure: LoadFailure | null;
	} = { columns: null, headerSeen: false, loadFailure: null };
	let truncated = false;

	try {
		const parsed = await streamCsvRows(source.stream, async (row) => {
			if (!parseState.headerSeen) {
				parseState.headerSeen = true;
				const resolved = resolveColumns(row);
				if (!("occurrences" in resolved)) {
					parseState.loadFailure = {
						failed: true,
						reason: "strava_export_columns_unexpected",
						message: resolved.message,
					};
					return;
				}
				parseState.columns = resolved;
				return;
			}
			const resolvedColumns = parseState.columns;
			if (!resolvedColumns || parseState.loadFailure) {
				return;
			}
			if (row.length === 1 && row[0]?.trim() === "") {
				return; // trailing newline
			}
			const record: ActivityRecord | null = buildActivityRecord(
				row,
				resolvedColumns,
				exportedAt,
			);
			if (!record) {
				unreadable += 1;
				return;
			}
			// The cursor makes a re-import of an overlapping archive cheap: Strava's
			// activity ids are stable across exports, so the second archive collapses
			// onto the first rather than double-counting.
			if (
				(since && record.start_time <= since) ||
				isOutsideRequestedTimeRange(record.start_time, timeRange)
			) {
				return;
			}
			// Apply the requested time range before emitRecord. The runtime repeats
			// this guard so emitted activities obey the requested period.
			await emitRecord(ACTIVITIES_STREAM, { ...record });
			emitted += 1;
			if (!earliest || record.start_time < earliest) {
				earliest = record.start_time;
			}
			if (!coveredLatest || record.start_time > coveredLatest) {
				coveredLatest = record.start_time;
			}
			if (!cursorLatest || record.start_time > cursorLatest) {
				cursorLatest = record.start_time;
			}
			if (emitted % 250 === 0) {
				await emit({
					type: "PROGRESS",
					stream: ACTIVITIES_STREAM,
					message: `Strava phase=emit stream=activities emitted=${emitted} unreadable=${unreadable}`,
					count: emitted,
				});
			}
		});
		truncated = Boolean(parsed.error);
	} catch (error) {
		await emit({
			type: "SKIP_RESULT",
			stream: ACTIVITIES_STREAM,
			reason: "strava_export_not_recognised",
			recovery_hint: { action: "manual_action_required", retryable: false },
			message: `The uploaded file could not be read: ${error instanceof Error ? error.message : String(error)}`,
		});
		return;
	} finally {
		source.close();
	}

	const resolvedColumns = parseState.columns;
	if (parseState.loadFailure || !resolvedColumns || !parseState.headerSeen) {
		const failure = parseState.loadFailure;
		if (failure?.reason === "strava_export_columns_unexpected") {
			await emit({
				type: "SKIP_RESULT",
				stream: ACTIVITIES_STREAM,
				reason: "strava_export_columns_unexpected",
				recovery_hint: {
					action: "retry_on_connector_upgrade",
					retryable: false,
				},
				message: failure.message,
			});
		} else {
			await emit({
				type: "SKIP_RESULT",
				stream: ACTIVITIES_STREAM,
				reason: "strava_export_not_recognised",
				recovery_hint: { action: "manual_action_required", retryable: false },
				message: failure?.message ?? `${ACTIVITIES_CSV} has no header row.`,
			});
		}
		return;
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
	let reason: CollectionReason | null = null;
	if (truncated) {
		reason = "collection_interrupted";
	} else if (unreadable > 0) {
		reason = "records_unreadable";
	}

	if (reason) {
		await emit({
			type: "SKIP_RESULT",
			stream: ACTIVITIES_STREAM,
			reason: COLLECTION_SKIP_REASON[reason],
			// A file that ended mid-row can be imported again in full. Rows with no
			// usable id or date stay unreadable in every later import of this file.
			recovery_hint: truncated
				? { action: "manual_action_required", retryable: false }
				: { action: "not_retriable", retryable: false },
			message: truncated
				? `${ACTIVITIES_CSV} ended mid-row, so an unknown number of activities were not read.`
				: `${String(unreadable)} row(s) in ${ACTIVITIES_CSV} had no usable activity id or date and were not read.`,
			diagnostics: { unreadable_rows: unreadable, truncated },
		});
	}


	// Hold the cursor ONLY when the file was truncated, because only then does
	// unread history exist beyond it. Holding it for unreadable rows would stall
	// the cursor permanently: those rows fail identically on every future
	// import, so the connector would re-read the whole archive for ever and
	// "the second run resumes" would never be true on a real file.
	await emit({
		type: "STATE",
		stream: ACTIVITIES_STREAM,
		cursor: {
			last_start_time: truncated ? (since ?? null) : cursorLatest,
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
			// PROGRESS and return — the requested activity stream would look healthy
			// despite collecting nothing.
			if (ctx.requested.has(ACTIVITIES_STREAM)) {
				await ctx.emit({
					type: "SKIP_RESULT",
					stream: ACTIVITIES_STREAM,
					reason: "strava_export_not_recognised",
					recovery_hint: { action: "manual_action_required", retryable: false },
					message: `No Strava import directory at ${importDir}. Set STRAVA_EXPORT_DIR, or put the archive in ~/.pdpp/imports/strava/`,
				});
			}
			return;
		}

		if (!ctx.requested.has(ACTIVITIES_STREAM)) {
			return;
		}
		await collectActivities(ctx, importDir, state?.activities);
	},
});
