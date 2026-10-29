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
	runCanvasesStream,
	runChannelMembershipsStream,
	runChannelsStream,
	runFilesStream,
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

// Schema constraints from the pinned slackdump v4.4.2 migration supplied by the owner.
// Keep both FILE fixtures faithful to its identity and provenance constraints.
const FILE_SCHEMA = "CREATE TABLE FILE (ID TEXT NOT NULL, FILENAME TEXT, URL TEXT, MODE TEXT NOT NULL, CHANNEL_ID TEXT NOT NULL, MESSAGE_ID INTEGER, DATA BLOB NOT NULL, CHUNK_ID INTEGER NOT NULL, PRIMARY KEY (ID, CHUNK_ID))";

// A canvas is a quip FILE row. Its channel is the file row's, or else the
// channel whose newest record says it owns the canvas.
function makeCanvasDb(): DatabaseSync {
	const db = makeDb();
	db.exec(FILE_SCHEMA);
	const insert = db.prepare(
		"INSERT INTO FILE (ID, FILENAME, URL, MODE, CHANNEL_ID, MESSAGE_ID, DATA, CHUNK_ID) VALUES (?, ?, ?, 'quip', ?, NULL, '{}', 1)",
	);
	const canvases: ReadonlyArray<readonly [string, string]> = [
		["F0PUBLIC1", "C0PUBLIC1"],
		["F0PRIVATE", "G0PRIVATE1"],
		["F0DIRECT1", "D0DIRECT01"],
		// Both the file and owning-channel metadata identify the private channel.
		["F0OWNED01", "G0PRIVATE1"],
	];
	for (const [id, channel] of canvases) {
		insert.run(id, `${id}.canvas`, `https://files.slack.com/${id}`, channel);
	}
	db.prepare(
		"INSERT INTO CHANNEL (ID, NAME, DATA, CHUNK_ID) VALUES (?, ?, ?, 2)",
	).run(
		"G0PRIVATE1",
		"board",
		JSON.stringify({
			id: "G0PRIVATE1",
			name: "board",
			is_group: true,
			is_private: true,
			properties: { canvas: { file_id: "F0OWNED01", is_empty: false } },
		}),
	);
	return db;
}

async function runCanvases(channelScope?: ReadonlySet<string>) {
	const { deps, recording } = setup(channelScope);
	await runCanvasesStream({ ...deps, db: makeCanvasDb() });
	return recording;
}

test("canvases: without a scope every canvas is read and counted", async () => {
	const recording = await runCanvases();

	assert.deepEqual(idsOf(recording, "canvases", "id"), [
		"F0DIRECT1",
		"F0OWNED01",
		"F0PRIVATE",
		"F0PUBLIC1",
	]);
	assert.equal(coverage(recording, "canvases").considered, 4);
});

test("canvases: a scoped run retains only canvases with allowed provenance", async () => {
	const recording = await runCanvases(new Set(["C0PUBLIC1"]));

	assert.deepEqual(
		idsOf(recording, "canvases", "id"),
		["F0PUBLIC1"],
		"the private and DM canvases are withheld",
	);
	const report = coverage(recording, "canvases");
	assert.equal(report.considered, 1, "the archive held four; one is in scope");
	assert.equal(report.covered, 1);
});

function fileScopeSetup(channelScope?: ReadonlySet<string>) {
	const { deps, recording } = setup(channelScope);
	deps.db.exec(FILE_SCHEMA);
	deps.requested = new Map([["files", { name: "files" }]]);
	deps.fingerprintCursors.set(
		"files",
		openFingerprintCursor(
			{ fingerprints: {} },
			{ excludeFromFingerprint: FINGERPRINT_EXCLUDE.files },
		),
	);
	const add = (id: string, channel: string | null, chunk = 1) => {
		deps.db
			.prepare(
				"INSERT INTO FILE (ID, FILENAME, URL, MODE, CHANNEL_ID, DATA, CHUNK_ID) VALUES (?, ?, ?, 'hosted', ?, '{}', ?)",
			)
			.run(id, id + ".txt", "https://files.slack.com/" + id, channel, chunk);
	};
	return { deps, recording, add };
}

test("files: scope excludes private provenance before records, coverage and fingerprints", async () => {
	const { deps, recording, add } = fileScopeSetup(new Set(["C0PUBLIC1"]));
	try {
		add("F0PUBLIC", "C0PUBLIC1");
		add("F0PRIVATE", "G0PRIVATE1");
		await runFilesStream(deps);
		assert.deepEqual(idsOf(recording, "files", "id"), ["F0PUBLIC"]);
		assert.equal(coverage(recording, "files").considered, 1);
		assert.equal(coverage(recording, "files").covered, 1);
		assert.deepEqual(
			Object.keys(deps.fingerprintCursors.get("files")?.toState() ?? {}).sort(),
			["F0PUBLIC"],
		);
		// A new run seeds its fingerprint cursor from the previous checkpoint.
		deps.fingerprintCursors.set(
			"files",
			openFingerprintCursor(
				{ fingerprints: deps.fingerprintCursors.get("files")?.toState() ?? {} },
				{ excludeFromFingerprint: FINGERPRINT_EXCLUDE.files },
			),
		);
		await runFilesStream(deps);
		assert.equal(recording.emitted.length, 1);
	} finally {
		deps.db.close();
	}
});

test("files: latest allowed snapshot is retained once; latest outside snapshot is withheld", async () => {
	const { deps, recording, add } = fileScopeSetup(new Set(["C0PUBLIC1"]));
	try {
		add("F0SHARED", "G0PRIVATE1", 1);
		add("F0SHARED", "C0PUBLIC1", 2);
		add("F0SHARED", "C0PUBLIC1", 3);
		add("F0OUTSIDE", "G0PRIVATE1", 1);
		add("F0OUTSIDE", "D0DIRECT01", 2);
		add("F0STALE", "C0PUBLIC1", 1);
		add("F0STALE", "G0PRIVATE1", 2);
		await runFilesStream(deps);
		assert.deepEqual(idsOf(recording, "files", "id"), ["F0SHARED"]);
		assert.equal(coverage(recording, "files").considered, 1);
		assert.equal(coverage(recording, "files").covered, 1);
		assert.deepEqual(
			Object.keys(deps.fingerprintCursors.get("files")?.toState() ?? {}),
			["F0SHARED"],
		);
	} finally {
		deps.db.close();
	}
});

test("files: empty channel scope withholds every current file", async () => {
	const { deps, recording, add } = fileScopeSetup(new Set());
	try {
		add("F0PUBLIC", "C0PUBLIC1");
		await runFilesStream(deps);
		assert.deepEqual(idsOf(recording, "files", "id"), []);
		assert.equal(coverage(recording, "files").considered, 0);
	} finally {
		deps.db.close();
	}
});

test("files: default scope preserves all channel associations", async () => {
	const { deps, recording, add } = fileScopeSetup();
	try {
		add("F0PUBLIC", "C0PUBLIC1");
		add("F0PRIVATE", "G0PRIVATE1");
		await runFilesStream(deps);
		assert.deepEqual(idsOf(recording, "files", "id"), [
			"F0PRIVATE",
			"F0PUBLIC",
		]);
		assert.equal(coverage(recording, "files").considered, 2);
	} finally {
		deps.db.close();
	}
});

for (const kind of ["files", "canvases"]) {
	test(`${kind}: FILE fixture enforces primary key and non-null channel`, () => {
		const db = kind === "files" ? fileScopeSetup().deps.db : makeCanvasDb();
		try {
			const insert = db.prepare(
				"INSERT INTO FILE (ID, CHUNK_ID, CHANNEL_ID, MODE, DATA) VALUES (?, ?, ?, 'hosted', '{}')",
			);
			insert.run("FCONSTRAINT", 99, "C0PUBLIC1");
			assert.throws(() => insert.run("FCONSTRAINT", 99, "G0PRIVATE1"), /UNIQUE|PRIMARY KEY/);
			assert.throws(() => insert.run("FNULL", 99, null), /NOT NULL/);
		} finally {
			db.close();
		}
	});
}
