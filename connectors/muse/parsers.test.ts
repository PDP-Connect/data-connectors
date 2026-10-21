// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
	activityId,
	buildActivityRecord,
	buildConnectedAppRecord,
	buildConversationRecord,
	buildFileRecord,
	buildGoalRecord,
	buildMemoryFileRecord,
	buildMessageRecord,
	buildScheduledTaskRecord,
	cleanText,
	isConnectedApp,
	memoryFileEntries,
	msToIso,
	parseActivities,
	parseConnectors,
	parseFsList,
	parseGoals,
	parseHistory,
	parseLibrary,
	parseRawText,
	parseSchedules,
	parseSessions,
	secondsToIso,
	uniqueEvents,
	zonedIsoToIso,
} from "./parsers.ts";
import { validateRecord } from "./schemas.ts";

function fixture(name: string): unknown {
	return JSON.parse(
		readFileSync(
			new URL(`./__fixtures__/${name}.json`, import.meta.url),
			"utf8",
		),
	);
}

function assertValid(stream: string, record: Record<string, unknown>): void {
	const result = validateRecord(stream, record);
	assert.equal(result.ok, true, `${stream}: ${JSON.stringify(result)}`);
}

test("times: epoch ms and seconds become RFC 3339 UTC; zoneless strings are rejected", () => {
	assert.equal(msToIso(1792607934000), "2026-10-21T18:38:54.000Z");
	assert.equal(secondsToIso(1792684800), "2026-10-22T16:00:00.000Z");
	assert.equal(
		zonedIsoToIso("2026-01-03T10:02:14Z"),
		"2026-01-03T10:02:14.000Z",
	);
	assert.equal(
		zonedIsoToIso("2026-01-03T12:02:14+02:00"),
		"2026-01-03T10:02:14.000Z",
	);
	assert.equal(zonedIsoToIso("2026-01-03T10:02:14"), null);
	assert.equal(msToIso(31), null);
	assert.equal(msToIso("1792607934000"), null);
});

test("cleanText keeps safe text unchanged and replaces control-rich text with null", () => {
	assert.deepEqual(cleanText("line\nnext"), {
		value: "line\nnext",
		reason: null,
	});
	assert.deepEqual(cleanText(""), { value: "", reason: null });
	assert.equal(cleanText("a\u0000b").value, null);
	assert.match(String(cleanText("a\u0000b").reason), /U\+0000/);
	assert.deepEqual(cleanText(42), { value: null, reason: null });
});

test("sessions fixture parses into valid conversation records", () => {
	const sessions = parseSessions(fixture("sessions"));
	assert.ok(sessions);
	assert.equal(sessions.length, 2);
	const records = sessions.map((s) => buildConversationRecord(s, false).record);
	for (const r of records) assertValid("conversations", r);
	assert.equal(records[0]?.id, "40e530d9-99e2-40b7-8755-e82048f45fa6");
	assert.equal(records[0]?.created_at, "2026-10-21T18:38:54.000Z");
	assert.equal(records[0]?.is_primary, true);
	assert.equal(records[1]?.is_thread, true);
	assert.deepEqual(parseSessions(fixture("sessions-archived")), []);
});

test("an unreadable session entry fails the whole list", () => {
	assert.equal(parseSessions({ sessions: [{ title: "no id" }] }), null);
	assert.equal(parseSessions({ items: [] }), null);
});

test("history fixture: display_text first, payload.content as fallback, empty reply ids are null", () => {
	const page = parseHistory(fixture("history"));
	assert.ok(page);
	assert.equal(page.hasMore, false);
	assert.equal(page.events.length, 3);
	const sessionId = "40e530d9-99e2-40b7-8755-e82048f45fa6";
	const records = uniqueEvents(page.events).map(
		(e) => buildMessageRecord(e, sessionId).record,
	);
	for (const r of records) assertValid("messages", r);
	const first = records[0];
	assert.ok(first);
	assert.equal(
		first.text,
		"Synthetic display_text 1 lorem lorem lorem lorem lorem lorem lorem lorem lorem lorem lorem lorem lorem",
	);
	assert.equal(first.occurred_at, "2026-10-21T18:43:05.077Z");
	assert.equal(
		first.reply_to_message_id,
		"5d760c5e-ca5c-4bf9-85bc-0816268724cf",
	);
	assert.equal(first.source, "runtime");
	const user = records.find((r) => r.role === "user");
	assert.equal(user?.reply_to_message_id, null);

	// Copy of a fixture event with an empty display_text: content is used.
	const raw = structuredClone(fixture("history")) as {
		chat_events: Array<{ display_text: string }>;
	};
	const event = raw.chat_events[0];
	assert.ok(event);
	event.display_text = "";
	const reparsed = parseHistory(raw);
	assert.ok(reparsed?.events[0]);
	assert.equal(
		buildMessageRecord(reparsed.events[0], sessionId).record.text,
		"Synthetic content 4 lorem lorem lorem lorem lorem lorem lorem lorem lorem lorem lorem lorem lorem",
	);
});

test("history without has_more or with an event missing its id is unreadable", () => {
	const raw = structuredClone(fixture("history")) as Record<string, unknown>;
	delete raw.has_more;
	assert.equal(parseHistory(raw), null);
	const noId = structuredClone(fixture("history")) as {
		chat_events: Array<Record<string, unknown>>;
	};
	delete noId.chat_events[0]?.message_id;
	assert.equal(parseHistory(noId), null);
});

test("a message id seen twice keeps the later event", () => {
	const page = parseHistory(fixture("history"));
	assert.ok(page?.events[0]);
	const later = { ...page.events[0], seq: 99, display_text: "edited" };
	const unique = uniqueEvents([page.events[0], later]);
	assert.equal(unique.length, 1);
	assert.equal(unique[0]?.display_text, "edited");
});

test("unsafe message text is replaced with null and counted", () => {
	const page = parseHistory(fixture("history"));
	assert.ok(page?.events[0]);
	const event = { ...page.events[0], display_text: "bad\u0000text" };
	const built = buildMessageRecord(event, "s");
	assert.equal(built.record.text, null);
	assert.match(String(built.record.text_binary_reason), /U\+0000/);
	assert.equal(built.replaced, 1);
	assertValid("messages", built.record);
});

test("activity fixture: ids stay unique when one message logs several activities", () => {
	const items = parseActivities(fixture("activity"));
	assert.ok(items);
	assert.equal(items.length, 3);
	const ids = items.map(activityId);
	assert.equal(new Set(ids).size, 3);
	const records = items.map((a) => buildActivityRecord(a).record);
	for (const r of records) assertValid("activities", r);
	assert.equal(records[0]?.timestamp, "2026-01-03T10:02:14.000Z");
	assert.equal(records[1]?.type, "web_search");
});

test("goals fixtures: empty user goals and one tracked goal", () => {
	const empty = parseGoals(fixture("goals"));
	assert.deepEqual(empty, { goals: [], hasNextPage: false });
	const tracked = parseGoals(fixture("goals-tracking"));
	assert.ok(tracked?.goals[0]);
	const r = buildGoalRecord(tracked.goals[0], "assistant_tracking").record;
	assertValid("goals", r);
	assert.equal(r.id, "goal_516bb0ad139a");
	assert.equal(r.created_at, "2026-01-06T10:05:35.000Z");
	// No pagination block: no end signal, unreadable.
	assert.equal(parseGoals({ goals: [], warnings: [] }), null);
});

test("tasks fixture: epoch-second times and every cadence kind", () => {
	const schedules = parseSchedules(fixture("tasks"));
	assert.ok(schedules);
	const records = schedules.map((s) => buildScheduledTaskRecord(s).record);
	for (const r of records) assertValid("scheduled_tasks", r);
	assert.deepEqual(
		records.map((r) => r.cadence_kind),
		["daily", "interval", "runonce"],
	);
	assert.equal(records[1]?.cadence_interval_seconds, 1800);
	assert.equal(records[2]?.cadence_run_at, "2026-10-22T16:00:00.000Z");
	assert.equal(records[1]?.next_run_at, "2026-10-21T20:23:12.000Z");
});

test("memory files: only the five known names at the root are picked, directories never", () => {
	const root = structuredClone(fixture("files-root")) as {
		entries: Array<Record<string, unknown>>;
	};
	const base = root.entries[0];
	assert.ok(base);
	root.entries.push(
		{ ...base, name: "MEMORY.md", type: "file", size: 120 },
		{ ...base, name: "SOUL.md", type: "file", size: 80 },
		{ ...base, name: "runtime.lock", type: "file", size: 3 },
		{ ...base, name: "USER.md", type: "directory" },
	);
	const entries = parseFsList(root);
	assert.ok(entries);
	const picked = memoryFileEntries(entries);
	assert.deepEqual(
		picked.map((e) => e.name),
		["MEMORY.md", "SOUL.md"],
	);
	const first = picked[0];
	assert.ok(first);
	const r = buildMemoryFileRecord(first, "# Memory\n- likes tea").record;
	assertValid("memory_files", r);
	assert.equal(r.id, "MEMORY.md");
	assert.equal(r.modified_at, "2026-01-03T10:02:14.123Z");
	assert.equal(parseRawText({ __blob_text: "x" }), "x");
	assert.equal(parseRawText("y"), "y");
	assert.equal(parseRawText({}), null);
});

test("library fixture: metadata-only file records", () => {
	const page = parseLibrary(fixture("library-recents"));
	assert.ok(page);
	assert.equal(page.hasMore, false);
	assert.equal(page.total, 6);
	const built = page.entries.map(buildFileRecord);
	for (const b of built) {
		assert.ok(b);
		assertValid("files", b.record);
		assert.equal("text" in b.record, false);
	}
	assert.equal(built[0]?.record.modified_at, "2026-10-21T19:50:28.050Z");
});

test("connectors fixture: only connected or needs-reauth services are kept", () => {
	const connectors = parseConnectors(fixture("connectors"));
	assert.ok(connectors);
	const kept = connectors.filter(isConnectedApp);
	assert.deepEqual(
		kept.map((c) => c.id),
		["browser"],
	);
	const browser = kept[0];
	assert.ok(browser);
	const r = buildConnectedAppRecord(browser).record;
	assertValid("connected_apps", r);
	assert.equal(r.state, "connected");
	const asana = connectors[0];
	assert.ok(asana);
	assert.equal(isConnectedApp(asana), false);
	assert.equal(isConnectedApp({ ...asana, needs_reauth: true }), true);
});
