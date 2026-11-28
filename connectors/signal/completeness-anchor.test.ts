// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Completeness-anchor tests for the Signal connector.
 *
 * Two concerns, deliberately tested apart:
 *
 *  1. `validateSourceTotal` — the fail-closed guard on the source-measured
 *     row total. A missing or malformed count must THROW, never silently
 *     become zero (which would read as "proven empty").
 *
 *  2. `parseEmittedIds` / `mergeEmittedIds` — the durable emitted-id cursor
 *     that makes the below-watermark backfill check a SET comparison. The
 *     set is the whole point: a scalar count of the same facts is a
 *     tautology (`sourceTotal - belowWatermark` IS the in-window row count
 *     when both are read from one database in one instant), and it also
 *     cannot tell an upstream deletion from a real gap. PDPP retains
 *     records the source deletes, so held-but-gone-upstream must never
 *     alarm.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { DatabaseSync } from "node:sqlite";
import type {
	CollectContext,
	EmittedMessage,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { test } from "node:test";
import {
	DEFAULT_MAX_ATTACHMENT_BYTES,
	mergeEmittedIds,
	parseCursorMs,
	parseEmittedIds,
	resolveMaxAttachmentBytes,
	validateSourceTotal,
} from "./index.ts";
import { buildMessageRecord } from "./parsers.ts";

// ─── validateSourceTotal: fail closed ────────────────────────────────────

test("validateSourceTotal accepts a normal non-negative integer", () => {
	assert.equal(validateSourceTotal(4739, "messages"), 4739);
});

test("validateSourceTotal accepts a proven-empty zero", () => {
	assert.equal(validateSourceTotal(0, "messages"), 0);
});

test("validateSourceTotal throws on undefined rather than defaulting to zero", () => {
	assert.throws(
		() => validateSourceTotal(undefined, "messages"),
		/signal_source_total_not_number/,
	);
});

test("validateSourceTotal throws on null rather than defaulting to zero", () => {
	assert.throws(
		() => validateSourceTotal(null, "messages"),
		/signal_source_total_not_number/,
	);
});

test("validateSourceTotal throws on a string count", () => {
	assert.throws(
		() => validateSourceTotal("4739", "messages"),
		/signal_source_total_not_number/,
	);
});

test("validateSourceTotal throws on NaN", () => {
	assert.throws(
		() => validateSourceTotal(Number.NaN, "messages"),
		/signal_source_total_not_finite/,
	);
});

test("validateSourceTotal throws on Infinity", () => {
	assert.throws(
		() => validateSourceTotal(Number.POSITIVE_INFINITY, "messages"),
		/signal_source_total_not_finite/,
	);
});

test("validateSourceTotal throws on a fractional count", () => {
	assert.throws(
		() => validateSourceTotal(12.5, "messages"),
		/signal_source_total_not_integer/,
	);
});

test("validateSourceTotal throws on a negative count", () => {
	assert.throws(
		() => validateSourceTotal(-1, "messages"),
		/signal_source_total_negative/,
	);
});

test("validateSourceTotal names the failing measurement in the error", () => {
	assert.throws(
		() => validateSourceTotal(undefined, "messages_below_watermark"),
		/messages_below_watermark/,
	);
});

// ─── parseEmittedIds: tolerant read, safe default ────────────────────────

test("parseEmittedIds reads a normal id array", () => {
	const parsed = parseEmittedIds(["a", "b", "c"]);
	assert.deepEqual([...parsed].sort(), ["a", "b", "c"]);
});

test("parseEmittedIds returns an empty set for a legacy cursor with no id list", () => {
	assert.equal(parseEmittedIds(undefined).size, 0);
});

test("parseEmittedIds returns an empty set for a malformed (non-array) value", () => {
	assert.equal(parseEmittedIds({ nope: true }).size, 0);
	assert.equal(parseEmittedIds("a,b,c").size, 0);
});

test("parseEmittedIds drops non-string and empty entries rather than trusting them", () => {
	const parsed = parseEmittedIds(["a", 7, null, "", "b"]);
	assert.deepEqual([...parsed].sort(), ["a", "b"]);
});

test("parseEmittedIds dedupes repeated ids", () => {
	assert.equal(parseEmittedIds(["a", "a", "a"]).size, 1);
});

// ─── mergeEmittedIds: carry forward, bounded ─────────────────────────────

test("mergeEmittedIds carries prior ids forward alongside this run's", () => {
	const merged = mergeEmittedIds(new Set(["old1", "old2"]), ["new1"]);
	assert.deepEqual([...merged].sort(), ["new1", "old1", "old2"]);
});

test("mergeEmittedIds keeps an empty prior set intact on a cold start", () => {
	assert.deepEqual(mergeEmittedIds(new Set(), ["a", "b"]), ["a", "b"]);
});

test("mergeEmittedIds truncates to the newest ids when the cursor cap binds", () => {
	// 200_000 is the cap; build one over it and assert the OLDEST are dropped,
	// never the newest — the watermark advances, so the newest ids are the
	// ones a backfill check still needs.
	const prior = new Set<string>();
	for (let i = 0; i < 200_000; i += 1) {
		prior.add(`old${String(i)}`);
	}
	const merged = mergeEmittedIds(prior, ["newest1", "newest2"]);
	assert.equal(merged.length, 200_000);
	assert.equal(merged.at(-1), "newest2");
	assert.equal(merged.at(-2), "newest1");
	assert.equal(
		merged.includes("old0"),
		false,
		"oldest id must be the one dropped",
	);
	assert.equal(
		merged.includes("old1"),
		false,
		"second-oldest id must be dropped",
	);
});

test("mergeEmittedIds counts a re-offered id once, so a full refresh does not saturate the cursor", () => {
	const ids = Array.from({ length: 150 }, (_, i) => `id${i}`);
	const merged = mergeEmittedIds(new Set(ids), ids);
	assert.equal(merged.length, 150);
	assert.deepEqual(new Set(merged), new Set(ids));
});

test("mergeEmittedIds does not truncate below the cap", () => {
	const merged = mergeEmittedIds(new Set(["a"]), ["b", "c"]);
	assert.equal(merged.length, 3);
});

// ─── The set-vs-count property this design exists for ────────────────────

test("a set difference reports a below-watermark backfill that a count cannot see", () => {
	// Source ids at or below the watermark after a re-link backfill added
	// three OLD messages. A count of the same instant is blind to this: the
	// backfill raises both the source total and the below-watermark count by
	// three, so `total - below` is unchanged.
	const sourceBelowWatermark = [
		"m1",
		"m2",
		"m3",
		"backfilled1",
		"backfilled2",
		"backfilled3",
	];
	const priorEmitted = new Set(["m1", "m2", "m3"]);

	const unreachable = sourceBelowWatermark.filter(
		(id) => !priorEmitted.has(id),
	);
	assert.deepEqual(unreachable, ["backfilled1", "backfilled2", "backfilled3"]);

	// The count view of the very same facts, showing it cannot fire.
	const totalBefore = 3 + 10; // 3 below-watermark + 10 in-window
	const belowBefore = 3;
	const totalAfter = 6 + 10;
	const belowAfter = 6;
	assert.equal(
		totalBefore - belowBefore,
		totalAfter - belowAfter,
		"the count check is blind to the backfill",
	);
});

test("an id present in holdings but deleted upstream produces no finding", () => {
	// Preservation: PDPP keeps records the source later deletes. The check is
	// one-directional by construction — it only asks which SOURCE ids were
	// never emitted, so a vanished id simply is not in the source list.
	const sourceBelowWatermark = ["m1", "m3"]; // m2 deleted from Signal Desktop
	const priorEmitted = new Set(["m1", "m2", "m3"]);

	const unreachable = sourceBelowWatermark.filter(
		(id) => !priorEmitted.has(id),
	);
	assert.deepEqual(
		unreachable,
		[],
		"an upstream deletion must never be reported as a gap",
	);
});

test("signal preserves send time and only falls back to receive time when needed", () => {
	const sentAt = Date.parse("2024-06-05T13:00:00.000Z");
	const receivedAtMs = sentAt + 60_000;
	const row = {
		body: "synthetic",
		conversationId: "fixture-conversation",
		id: "fixture-message",
		json: "{invalid",
		receivedAtMs,
		sentAt,
		sourceServiceId: null,
		type: "incoming",
	};

	const sent = buildMessageRecord(row);
	assert.equal(sent.record.sent_at, "2024-06-05T13:00:00.000Z");
	assert.equal(sent.sentAtMs, sentAt);
	assert.equal(sent.record.body, "synthetic");
	assert.equal(sent.record.has_attachments, false);
	assert.equal(sent.record.is_edited, false);

	const received = buildMessageRecord({ ...row, sentAt: null });
	assert.equal(received.record.sent_at, "2024-06-05T13:01:00.000Z");
	assert.equal(received.sentAtMs, receivedAtMs);
});

test("signal normalizes serialized and unusable incremental cursors", () => {
	assert.equal(parseCursorMs("1717592400000"), 1717592400000);
	assert.equal(parseCursorMs(1717592400000.75), 1717592400000);
	for (const value of [undefined, "invalid", -1, Infinity]) {
		assert.equal(parseCursorMs(value), 0);
	}
});

test("signal requires a positive whole-byte attachment limit override", () => {
	assert.equal(
		resolveMaxAttachmentBytes({ PDPP_SIGNAL_MAX_ATTACHMENT_BYTES: "4096" }),
		4096,
	);
	for (const value of ["0", "-1", "1.5", "4096bytes"]) {
		assert.equal(
			resolveMaxAttachmentBytes({ PDPP_SIGNAL_MAX_ATTACHMENT_BYTES: value }),
			DEFAULT_MAX_ATTACHMENT_BYTES,
		);
	}
});

test("a capped Signal history cursor does not claim the older row was never emitted", async () => {
	const entry = new URL("./index.ts?fixture=emitted-cap-three", import.meta.url);
	const sourceUrl = new URL("./index.ts", import.meta.url);
	const original = readFileSync(sourceUrl, "utf8");
	const cap = "const MAX_EMITTED_ID_CURSOR = 200_000;";
	const injected = original.replace(cap, "const MAX_EMITTED_ID_CURSOR = 3;");
	const open = "await withExportedDatabase(async (db) => {";
	const collect = injected.indexOf("async function collectMessagesConversationsReactions(");
	assert.ok(collect >= 0);
	assert.notEqual(injected, original);
	const tail = injected.slice(collect).replace(
		open,
		"await globalThis[Symbol.for('signal-anchor-fixture-db')](async (db) => {",
	);
	assert.notEqual(tail, injected.slice(collect));
	const source = stripTypeScriptTypes(
		injected.slice(0, collect) + tail + "\nexport { collectMessagesConversationsReactions };",
		{ mode: "transform" } as unknown as Parameters<typeof stripTypeScriptTypes>[1],
	);
	const hooks = registerHooks({
		load(url, context, nextLoad) {
			return url === entry.href
				? { format: "module", shortCircuit: true, source }
				: nextLoad(url, context);
		},
	});
	let fixture: { collectMessagesConversationsReactions(ctx: CollectContext): Promise<void> };
	try {
		fixture = await import(entry.href);
	} finally {
		hooks.deregister();
	}
	const db = new DatabaseSync(":memory:");
	const globals = globalThis as Record<symbol, unknown>;
	const key = Symbol.for("signal-anchor-fixture-db");
	const frames: EmittedMessage[] = [];
	try {
		db.exec("CREATE TABLE messages (id TEXT, conversationId TEXT, sent_at INTEGER, body TEXT, type TEXT, json TEXT)");
		db.prepare("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?)").run("older", "fixture", 1, "", "incoming", null);
		globals[key] = async (read: (value: DatabaseSync) => Promise<void>) => read(db);
		await fixture.collectMessagesConversationsReactions({
			state: { messages: { last_sent_at_ms: 10, emitted_ids: ["later-1", "later-2", "later-3"], emitted_ids_complete: true } },
			requested: new Map([["messages", {}]]),
			emit: async (frame: EmittedMessage) => { frames.push(frame); },
			emitRecord: async () => { assert.fail("no above-watermark records in this fixture"); },
			progress: async () => {},
		} as unknown as CollectContext);
	} finally {
		delete globals[key];
		db.close();
	}
	assert.deepEqual(
		frames.flatMap((frame) => frame.type === "SKIP_RESULT" ? [frame.reason] : []),
		["backfill_check_unproven_truncated_cursor"],
	);
	assert.equal(frames.some((frame) => frame.type === "DETAIL_COVERAGE"), false);
	assert.equal(frames.some((frame) =>
		frame.type === "STATE" && Reflect.get(frame.cursor as object, "emitted_ids_complete") === false), true);
});
