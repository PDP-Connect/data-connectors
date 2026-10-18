// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// A run that leaves a channel type out reads only the rows of the channels it
// archives. The record guard is the last line; these tests pin that the
// channel-bearing runners skip an out-of-scope row before the fingerprint
// cursor or a coverage count sees it, so an archive that holds more than it
// was asked for neither inflates `covered` nor remembers a channel the run
// never emitted.

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type {
	DetailCoverageMessage,
	StreamScope,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { openFingerprintCursor } from "../../packages/polyfill-connectors/src/fingerprint-cursor.ts";
import { makeRecordingEmit } from "../../packages/polyfill-connectors/src/test-harness.ts";
import {
	emitMessagesPass,
	FINGERPRINT_EXCLUDE,
	runChannelMembershipsStream,
	runChannelsStream,
	type StreamDeps,
} from "./index.ts";
import { validateRecord } from "./schemas.ts";
import type { MessageRow } from "./types.ts";

const CHANNELS = [
	{ id: "C0PUBLIC1", name: "general", is_channel: true },
	{ id: "G0PRIVATE1", name: "board", is_group: true, is_private: true },
	{ id: "D0DIRECT01", name: "dm", is_im: true, is_private: true },
];

function makeDb(): DatabaseSync {
	const db = new DatabaseSync(":memory:");
	db.exec(`
    CREATE TABLE CHANNEL (ID TEXT NOT NULL, NAME TEXT, DATA TEXT, CHUNK_ID INTEGER NOT NULL);
    CREATE TABLE CHANNEL_USER (CHANNEL_ID TEXT, USER_ID TEXT);
  `);
	for (const channel of CHANNELS) {
		db.prepare(
			"INSERT INTO CHANNEL (ID, NAME, DATA, CHUNK_ID) VALUES (?, ?, ?, ?)",
		).run(channel.id, channel.name, JSON.stringify(channel), 1);
		db.prepare(
			"INSERT INTO CHANNEL_USER (CHANNEL_ID, USER_ID) VALUES (?, ?)",
		).run(channel.id, "U1");
	}
	return db;
}

function setup(channelScope?: ReadonlySet<string>) {
	const recording = makeRecordingEmit(validateRecord);
	const deps: StreamDeps = {
		...(channelScope ? { channelScope } : {}),
		db: makeDb(),
		emit: recording.emit,
		emitRecord: recording.emitRecord,
		emittedAt: "2026-08-11T00:00:00.000Z",
		failedStreams: new Set(),
		fingerprintCursors: new Map([
			[
				"channels",
				openFingerprintCursor(
					{ fingerprints: {} },
					{ excludeFromFingerprint: FINGERPRINT_EXCLUDE.channels },
				),
			],
			[
				"channel_memberships",
				openFingerprintCursor(
					{ fingerprints: {} },
					{ excludeFromFingerprint: FINGERPRINT_EXCLUDE.channel_memberships },
				),
			],
		]),
		progress: () => Promise.resolve(),
		requested: new Map<string, StreamScope>([
			["channel_memberships", { name: "channel_memberships" }],
			["channel_stats", { name: "channel_stats" }],
			["channels", { name: "channels" }],
		]),
	};
	return { deps, recording };
}

function coverage(
	recording: ReturnType<typeof makeRecordingEmit>,
	stream: string,
): DetailCoverageMessage {
	const message = recording.protocolMessages.find(
		(candidate): candidate is DetailCoverageMessage =>
			candidate.type === "DETAIL_COVERAGE" && candidate.stream === stream,
	);
	assert.ok(message, `expected a ${stream} coverage report`);
	return message;
}

const idsOf = (
	recording: ReturnType<typeof makeRecordingEmit>,
	stream: string,
	key: string,
): string[] =>
	recording.emitted
		.filter((record) => record.stream === stream)
		.map((record) => String((record.data as Record<string, unknown>)[key]))
		.sort();

test("channels: without a scope every archived channel is read, counted and remembered", async () => {
	const { deps, recording } = setup();
	await runChannelsStream(deps);

	assert.deepEqual(idsOf(recording, "channels", "id"), [
		"C0PUBLIC1",
		"D0DIRECT01",
		"G0PRIVATE1",
	]);
	assert.equal(coverage(recording, "channels").considered, 3);
	assert.equal(coverage(recording, "channels").covered, 3);
	assert.deepEqual(
		Object.keys(
			deps.fingerprintCursors.get("channels")?.toState() ?? {},
		).sort(),
		["C0PUBLIC1", "D0DIRECT01", "G0PRIVATE1"],
	);
});

test("channels: a scoped run counts, emits and remembers only the channels in scope", async () => {
	const { deps, recording } = setup(new Set(["C0PUBLIC1"]));
	await runChannelsStream(deps);

	assert.deepEqual(idsOf(recording, "channels", "id"), ["C0PUBLIC1"]);
	assert.deepEqual(idsOf(recording, "channel_stats", "channel_id"), [
		"C0PUBLIC1",
	]);
	const report = coverage(recording, "channels");
	assert.equal(report.considered, 1, "the archive held three; one is in scope");
	assert.equal(report.covered, 1);
	assert.deepEqual(
		Object.keys(deps.fingerprintCursors.get("channels")?.toState() ?? {}),
		["C0PUBLIC1"],
		"a channel left out is not remembered as emitted, so widening the scope later still emits it",
	);
});

test("channel memberships: a scoped run counts, emits and remembers only memberships in scope", async () => {
	const { deps, recording } = setup(new Set(["C0PUBLIC1"]));
	await runChannelMembershipsStream(deps);

	assert.deepEqual(idsOf(recording, "channel_memberships", "channel_id"), [
		"C0PUBLIC1",
	]);
	const report = coverage(recording, "channel_memberships");
	assert.equal(report.considered, 1);
	assert.equal(report.covered, 1);
	const remembered = Object.keys(
		deps.fingerprintCursors.get("channel_memberships")?.toState() ?? {},
	);
	assert.equal(remembered.length, 1);
	assert.ok(
		remembered.every((key) => key.includes("C0PUBLIC1")),
		`remembered keys name only the channel in scope: ${remembered.join(", ")}`,
	);
});

test("an empty scope reads nothing instead of everything", async () => {
	const { deps, recording } = setup(new Set());
	await runChannelsStream(deps);
	await runChannelMembershipsStream(deps);

	assert.deepEqual(idsOf(recording, "channels", "id"), []);
	assert.deepEqual(idsOf(recording, "channel_memberships", "channel_id"), []);
	assert.equal(coverage(recording, "channels").considered, 0);
	assert.equal(coverage(recording, "channel_memberships").considered, 0);
});

function messageRow(channel: string, ts: string): MessageRow {
	return {
		CHANNEL_ID: channel,
		DATA: new TextEncoder().encode(JSON.stringify({ text: "hi", user: "U1" })),
		IS_PARENT: null,
		NUM_FILES: null,
		THREAD_TS: null,
		TS: ts,
		TXT: "hi",
	};
}

test("messages: a scoped pass counts, emits and advances cursors only for channels in scope", async () => {
	const { deps, recording } = setup(new Set(["C0PUBLIC1"]));
	const result = await emitMessagesPass(
		{ ...deps, requested: new Map([["messages", { name: "messages" }]]) },
		[
			messageRow("C0PUBLIC1", "1714032840.123456"),
			messageRow("D0DIRECT01", "1714032841.123456"),
			messageRow("G0PRIVATE1", "1714032842.123456"),
		],
		null,
	);

	assert.equal(
		result.considered,
		1,
		"the archive held three rows; one is in scope",
	);
	assert.equal(result.covered, 1);
	assert.deepEqual(Object.keys(result.channelMaxTs), ["C0PUBLIC1"]);
	assert.deepEqual(
		Object.keys(result.iteratedChannelMaxTs),
		["C0PUBLIC1"],
		"even the observational cursor does not learn the channels left out",
	);
	assert.equal(result.maxMessageTs, "1714032840.123456");
	assert.deepEqual(idsOf(recording, "messages", "channel_id"), ["C0PUBLIC1"]);
});
