#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PDPP iCal Connector (v0.1.0)
 *
 * Auth: none. User exports a calendar (.ics file) from Apple Calendar,
 * Google Calendar, Outlook, etc., and drops the file(s) into
 * ICAL_IMPORT_DIR (defaults ~/.pdpp/imports/ical/). Supports subscription
 * URLs via ICAL_SUBSCRIPTION_URL env var (comma-separated).
 *
 * Parses RFC 5545 (simplified) — VEVENT blocks with DTSTART, DTEND, SUMMARY,
 * LOCATION, DESCRIPTION, UID, ORGANIZER, ATTENDEE, RRULE, STATUS.
 */

import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	type CollectContext,
	type EmittedMessage,
	runConnector,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { isMainModule } from "@pdpp/connector-protocol";
import {
	advanceCursor,
	buildEventRecord,
	hashId,
	ICS_EXT_RE,
	isBeforeCursor,
	parseIcs,
	RETRYABLE_FETCH_RE,
} from "./parsers.ts";
import { validateRecord } from "./schemas.ts";
import type { IcsSource } from "./types.ts";
type CheckpointSource = IcsSource & { checkpointKey: string };

async function fetchIcs(url: string, fetchImpl: typeof fetch): Promise<string> {
	const res = await fetchImpl(url);
	if (!res.ok) {
		throw new Error(`ics_fetch_${res.status}`);
	}
	return res.text();
}

/**
 * Read every .ics file inside `dir` (if it exists) into an IcsSource.
 * Silently swallows read errors — matches the prior inline try/catch
 * behavior in collect() before decomposition.
 */
async function loadLocalSources(dir: string): Promise<CheckpointSource[]> {
	const sources: CheckpointSource[] = [];
	if (!existsSync(dir)) {
		return sources;
	}
	try {
		const files = (await readdir(dir)).filter((f) =>
			f.toLowerCase().endsWith(".ics"),
		);
		for (const f of files) {
			const file = join(dir, f);
			try {
				sources.push({
					checkpointKey: hashId("file:" + file),
					name: f.replace(ICS_EXT_RE, ""),
					text: await readFile(file, "utf8"),
				});
			} catch {
				// Keep this file's checkpoint and continue with independent files.
			}
		}
	} catch {
		/* ignore — fall through with whatever we collected */
	}
	return sources;
}

/**
 * Fetch every subscription URL. Failed URLs report a SKIP_RESULT via the
 * runtime's emit() and are left out of the returned array.
 */
async function loadSubscriptionSources(
	urls: readonly string[],
	emit: (msg: EmittedMessage) => Promise<void>,
	fetchImpl: typeof fetch,
): Promise<CheckpointSource[]> {
	const sources: CheckpointSource[] = [];
	for (const url of urls) {
		try {
			const sourceUrl = new URL(url);
			const text = await fetchIcs(url, fetchImpl);
			sources.push({ checkpointKey: hashId("url:" + sourceUrl.href), name: sourceUrl.hostname, text });
		} catch {
			await emit({
				type: "SKIP_RESULT",
				stream: "events",
				reason: "ics_fetch_failed",
				message: "An iCal subscription could not be fetched.",
			});
		}
	}
	return sources;
}

function readSubscriptionUrls(): string[] {
	return (process.env.ICAL_SUBSCRIPTION_URL || "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

/** Cursor state mutated while iterating sources. */
interface EventCursor {
	latest: string | undefined;
	since: string | undefined;
}

async function emitEventsFromSource(
	src: IcsSource,
	cursor: EventCursor,
	emitRecord: (stream: string, rec: Record<string, unknown>) => Promise<void>,
	progress: (message: string, opts?: { stream?: string }) => Promise<void>,
): Promise<void> {
	await progress(`Parsing ${src.name}`, { stream: "events" });
	const events = parseIcs(src.text, src.name);
	for (const e of events) {
		const rec = buildEventRecord(e, src.name);
		if (!rec) {
			continue;
		}
		if (isBeforeCursor(rec.start, cursor.since)) {
			continue;
		}
		cursor.latest = advanceCursor(cursor.latest, rec.start);
		await emitRecord("events", { ...rec });
	}
}

export async function collectIcal(
	{ state, emit, emitRecord, progress }: Pick<CollectContext, "state" | "emit" | "emitRecord" | "progress">,
	{ dir = process.env.ICAL_IMPORT_DIR || join(homedir(), ".pdpp/imports/ical"),
		subscriptionUrls = readSubscriptionUrls(), fetchImpl = fetch } = {},
): Promise<void> {
	const localSources = await loadLocalSources(dir);
	const remoteSources = await loadSubscriptionSources(subscriptionUrls, emit, fetchImpl);
	const sources = [...localSources, ...remoteSources];

	if (!sources.length) {
		await emit({
			type: "SKIP_RESULT",
			stream: "events",
			reason: "no_calendar_sources",
			message: "No readable .ics exports or subscription feeds were available.",
		});
		return;
	}

	const eventState = state.events;
	const prior = eventState && typeof eventState === "object" ? Reflect.get(eventState, "per_source") : undefined;
	const perSource: Record<string, string> = {};
	if (prior && typeof prior === "object" && !Array.isArray(prior)) {
		for (const [id, value] of Object.entries(prior)) {
			if (/^[a-f0-9]{24}$/.test(id) && typeof value === "string" && Number.isFinite(Date.parse(value))) {
				perSource[id] = value;
			}
		}
	}

	// A legacy global cursor cannot prove which feed was read. Re-read each
	// feed once when it first succeeds, then use only its own watermark.
	for (const src of sources) {
		const since = perSource[src.checkpointKey];
		const cursor: EventCursor = { since, latest: since };
		await emitEventsFromSource(src, cursor, emitRecord, progress);
		if (cursor.latest !== undefined) perSource[src.checkpointKey] = cursor.latest;
	}
	await emit({ type: "STATE", stream: "events", cursor: { per_source: perSource } });
}

if (isMainModule(import.meta.url)) {
	runConnector({ name: "ical", retryablePattern: RETRYABLE_FETCH_RE, validateRecord,
		collect: (ctx) => collectIcal(ctx) });
}
