// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Proves Codex artifact capture at the PRODUCTION collection entrypoint.
 *
 * These tests drive `runCollectorConnector` — the same driver
 * `bin/collector-runner.ts run` uses — over a real rollout tree, and assert on
 * what the records, the STATE cursor and the spool actually contain. A helper
 * test that injects a capture context by hand cannot prove the ordinary
 * collection path supplies one, which is the defect this guards.
 *
 * The body under test is the session's rollout JSONL file. Every inline field
 * stays a bounded projection (message content 5,000 chars, function arguments
 * 2,000, function output 4,000); the blob is the authoritative content.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { statSync, utimesSync } from "node:fs";
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import {
	type CollectorRunResult,
	LocalDeviceBlobSpool,
	runCollectorConnector,
} from "@pdpp/collector-runtime";
import { buildConnectorSpec } from "../../bin/collector-runner.ts";
import { resolveExecutionRoot } from "../../src/execution-root.ts";

const SESSION_ID = "019d922d-c38b-7e11-ae99-9187af386148";
const DATE_DIR = join("2026", "04", "15");

const cleanups: Array<() => Promise<void>> = [];

after(async () => {
	// Independent temp dirs and servers; nothing orders these teardowns.
	await Promise.all(cleanups.map((cleanup) => cleanup()));
});

function sessionMetaLine(id: string): string {
	return JSON.stringify({
		type: "session_meta",
		timestamp: "2026-04-15T17:33:32.000Z",
		payload: {
			id,
			timestamp: "2026-04-15T17:33:32.000Z",
			cwd: "/repo",
			originator: "codex-tui",
		},
	});
}

function messageLine(text: string, ts = "2026-04-15T17:34:00.000Z"): string {
	return JSON.stringify({
		type: "response_item",
		timestamp: ts,
		payload: { type: "message", role: "user", content: [{ text }] },
	});
}

/**
 * A rollout file far past every inline bound.
 *
 * The single message body is 200 KB — three orders of magnitude past the
 * 5,000-character content projection, and well past the 64 KiB the cursor's
 * prefix-integrity guard hashes, so a capture that only covered the guard
 * window would fail the whole-file digest assertion below.
 */
function bigRollout(): { body: Buffer; text: string } {
	const text = jsonlLines([
		sessionMetaLine(SESSION_ID),
		messageLine("z".repeat(200 * 1024)),
	]);
	return { body: Buffer.from(text, "utf8"), text };
}

function jsonlLines(lines: readonly string[]): string {
	return `${lines.join("\n")}\n`;
}

interface Source {
	body: Buffer;
	codexHome: string;
	queuePath: string;
	rolloutPath: string;
	sessionsDir: string;
	spoolRoot: string;
}

async function makeSource(): Promise<Source> {
	const codexHome = await mkdtemp(join(tmpdir(), "pdpp-codex-production-"));
	cleanups.push(() => rm(codexHome, { force: true, recursive: true }));
	const sessionsDir = join(codexHome, "sessions");
	await mkdir(join(sessionsDir, DATE_DIR), { recursive: true });
	const { body } = bigRollout();
	const rolloutPath = join(
		sessionsDir,
		DATE_DIR,
		`rollout-2026-04-15T12-26-06-${SESSION_ID}.jsonl`,
	);
	await writeFile(rolloutPath, body);
	return {
		body,
		codexHome,
		queuePath: join(codexHome, "queue.sqlite"),
		rolloutPath,
		sessionsDir,
		spoolRoot: join(codexHome, "blob-spool"),
	};
}

/**
 * Write `state_5.sqlite#threads` with one row for `SESSION_ID`.
 *
 * Only the columns `THREADS_QUERY` selects are needed; `updated_at` and `title`
 * are the two this file moves, since together they are exactly a thread-metadata
 * change that leaves the rollout file alone.
 */
function writeThreadsDb(
	source: Source,
	row: { title: string; updatedAt: number },
): void {
	const db = new DatabaseSync(join(source.codexHome, "state_5.sqlite"));
	try {
		db.exec(`CREATE TABLE IF NOT EXISTS threads (
			id TEXT PRIMARY KEY, rollout_path TEXT, created_at INTEGER,
			updated_at INTEGER, source TEXT, model_provider TEXT, cwd TEXT,
			title TEXT, sandbox_policy TEXT, approval_mode TEXT, tokens_used INTEGER,
			has_user_event INTEGER, archived INTEGER, archived_at INTEGER,
			git_sha TEXT, git_branch TEXT, git_origin_url TEXT, cli_version TEXT,
			first_user_message TEXT, agent_nickname TEXT, agent_role TEXT,
			memory_mode TEXT, model TEXT, reasoning_effort TEXT
		)`);
		db.prepare(
			`INSERT INTO threads (id, rollout_path, created_at, updated_at, cwd, title, archived)
			 VALUES (?, ?, ?, ?, ?, ?, 0)
			 ON CONFLICT(id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at`,
		).run(
			SESSION_ID,
			source.rolloutPath,
			1_776_000_000,
			row.updatedAt,
			"/repo",
			row.title,
		);
	} finally {
		db.close();
	}
}

interface RunOptions {
	/**
	 * False models a run the operator has NOT wired artifact stores for: the
	 * child gets no capture env, so every body is honestly `unavailable`. This
	 * is what every run looked like before capture was configurable, which is
	 * why enabling it later has to backfill.
	 */
	capture?: boolean;
}

interface Harness {
	ingested: Array<Record<string, unknown>>;
	progress: string[];
	run: (options?: RunOptions) => Promise<CollectorRunResult>;
	/** Plant a STATE the connector will read on its next run, as the server holds it. */
	seedState: (state: Record<string, unknown>) => void;
	state: () => Record<string, unknown>;
	server: Server;
}

async function makeHarness(source: Source): Promise<Harness> {
	let persistedState: Record<string, unknown> = {};
	const ingested: Array<Record<string, unknown>> = [];
	const server = createServer(async (request, response) => {
		const chunks: Buffer[] = [];
		for await (const chunk of request) {
			chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		}
		const body =
			chunks.length === 0
				? null
				: (JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
						string,
						unknown
					>);
		if (request.url?.endsWith("/state")) {
			if (request.method === "GET") {
				response.end(JSON.stringify({ state: persistedState }));
			} else {
				persistedState = {
					...persistedState,
					...(body?.state as Record<string, unknown>),
				};
				response.end(JSON.stringify({ state: persistedState }));
			}
			return;
		}
		if (request.url?.includes("/ingest-batches")) {
			for (const record of (body?.records ?? []) as Array<
				Record<string, unknown>
			>) {
				ingested.push(record);
			}
			response.end(
				JSON.stringify({
					accepted_record_count: ((body?.records ?? []) as unknown[]).length,
					status: "accepted",
				}),
			);
			return;
		}
		response.end(JSON.stringify({ status: "accepted" }));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	cleanups.push(
		() => new Promise<void>((resolve) => server.close(() => resolve())),
	);
	const address = server.address();
	assert.ok(address && typeof address === "object");
	const baseUrl = `http://127.0.0.1:${address.port}`;

	const progress: string[] = [];

	const run = async (options?: RunOptions): Promise<CollectorRunResult> => {
		// `buildConnectorSpec` is the production spec builder from the CLI, so
		// this exercises the same env threading a real `run` uses.
		const spec = buildConnectorSpec(
			{
				baseUrl,
				command: "run",
				connector: "codex",
				queuePath: source.queuePath,
				streams: ["sessions", "messages"],
			},
			(options?.capture ?? true)
				? { outboxPath: source.queuePath, sourceInstanceId: "codex-production" }
				: undefined,
		);
		return await runCollectorConnector({
			baseUrl,
			connector: {
				...spec,
				env: {
					...spec.env,
					CODEX_HOME: source.codexHome,
					// Without this a just-written rollout is deferred as actively
					// appending, and the run would prove nothing about capture.
					PDPP_CODEX_ACTIVE_ROLLOUT_QUIET_MS: "0",
				},
			},
			deviceId: "device-production",
			deviceToken: "test-token",
			executionRoot: resolveExecutionRoot(spec),
			onMessage: (message) => {
				if (
					message.type === "PROGRESS" &&
					typeof message.message === "string"
				) {
					progress.push(message.message);
				}
			},
			queuePath: source.queuePath,
			sourceInstanceId: "codex-production",
		});
	};
	return {
		ingested,
		progress,
		run,
		seedState: (state) => {
			persistedState = { ...persistedState, ...state };
		},
		server,
		state: () => persistedState,
	};
}

function sessionRecords(
	ingested: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
	return ingested
		.filter((record) => record.stream === "sessions")
		.map((record) => (record.data ?? record) as Record<string, unknown>);
}

/**
 * The session row as the server would hold it, over every run so far.
 *
 * The reference server upserts on `(connector_instance_id, stream, record_key)`
 * with `record_json = excluded.record_json` — the payload is REPLACED, never
 * merged (`reference-implementation/server/queries/records/ingest/upsert-record.sql`).
 * Codex keys a session row by its `id` (`makeCodexEmitRecord` emits
 * `key: String(d.id)`), so every emission for one session lands on one row and
 * the last one wins outright.
 *
 * Reading the LATEST emission is therefore the only honest way to ask what the
 * owner's stored session says. Asking whether SOME emission carried the digest
 * would pass even while the row the server actually holds has lost it — which
 * is precisely the defect these tests exist to catch.
 */
function latestStoredSession(
	ingested: Array<Record<string, unknown>>,
	id: string = SESSION_ID,
): Record<string, unknown> | undefined {
	let stored: Record<string, unknown> | undefined;
	for (const record of ingested) {
		if (record.stream !== "sessions") {
			continue;
		}
		const data = (record.data ?? record) as Record<string, unknown>;
		if (data.id === id) {
			stored = data;
		}
	}
	return stored;
}

/** The rollout cursor the next run will read, as the server persisted it. */
function cursorFor(
	state: Record<string, unknown>,
): Record<string, unknown> | undefined {
	const streams = ["sessions", "messages", "function_calls"];
	for (const stream of streams) {
		const cursors = (
			state[stream] as { file_cursors?: Record<string, unknown> } | undefined
		)?.file_cursors;
		const cursor = cursors?.[SESSION_ID];
		if (cursor) {
			return cursor as Record<string, unknown>;
		}
	}
	return undefined;
}

test("the ordinary collection path captures the complete rollout body", async () => {
	const source = await makeSource();
	const harness = await makeHarness(source);

	await harness.run();

	const sessions = sessionRecords(harness.ingested);
	assert.equal(sessions.length, 1, "one session record was collected");
	const record = sessions[0] as Record<string, unknown>;

	// The defect this guards: without capture wired through the production path
	// this is `unavailable` on every real run and no bytes are held.
	assert.equal(
		record.artifact_capture,
		"captured",
		"the ordinary run captured the body rather than reporting unavailable",
	);
	const expected = createHash("sha256").update(source.body).digest("hex");
	assert.equal(
		record.artifact_sha256,
		expected,
		"the recorded digest is the digest of the complete rollout file",
	);

	// The bytes are really in the spool, at full length — not a 64 KiB prefix.
	const spool = new LocalDeviceBlobSpool({ root: source.spoolRoot });
	assert.ok(spool.has(expected), "the complete body is present in the spool");
	assert.equal(
		spool.sizeOf(expected),
		source.body.length,
		"the spooled body is the whole file, not a bounded prefix",
	);
	assert.ok(
		(await readFile(spool.pathFor(expected))).equals(source.body),
		"the spooled bytes are the source file's bytes",
	);
	assert.ok(
		source.body.length > 64 * 1024,
		"the fixture is larger than the 64 KiB guard window, so a prefix-only capture would fail above",
	);

	// The obligation is disclosed, not implied: the bytes are held locally and
	// no transport exists to deliver them.
	assert.ok(
		harness.progress.some((line) =>
			line.includes("artifact_bodies_awaiting_upload=1"),
		),
		"the undelivered body is reported in terminal output",
	);
});

test("collection continues across runs while a captured body is pending upload", async () => {
	const source = await makeSource();
	const harness = await makeHarness(source);

	await harness.run();
	assert.equal(sessionRecords(harness.ingested).length, 1, "run 1 collected");

	// A brand-new session appears after the first capture. The halt this guards
	// (data-connectors#100) made every later run skip scanning entirely, so this
	// session would never be seen.
	const second = "029d922d-c38b-7e11-ae99-9187af386149";
	await writeFile(
		join(
			source.sessionsDir,
			DATE_DIR,
			`rollout-2026-04-15T12-26-06-${second}.jsonl`,
		),
		jsonlLines([sessionMetaLine(second), messageLine("second session")]),
	);

	harness.ingested.length = 0;
	const result = await harness.run();

	assert.equal(result.done?.status, "succeeded", "run 2 completed");
	// The halt's signature (data-connectors#100) was a run that scanned nothing
	// because a dead-lettered blob_upload row read as blocking backlog.
	assert.notEqual(
		result.skippedScanForBacklog,
		true,
		"scanning was admitted, not skipped as backlog, with a captured body pending",
	);
	const ids = sessionRecords(harness.ingested).map((record) => record.id);
	assert.ok(
		ids.includes(second),
		"the new session was scanned and ingested after a captured body was pending",
	);
});

test("a transiently failed capture is retried on the next run, file unchanged", async () => {
	const source = await makeSource();
	const harness = await makeHarness(source);

	// Run 1 parses fine but cannot write the body: the spool's staging directory
	// is not writable, so `put` fails at the temp file. Enumeration succeeds
	// while the body does not become durable — the transient shape this rule
	// exists for.
	const staging = join(source.spoolRoot, "tmp");
	await mkdir(staging, { recursive: true });
	await chmod(staging, 0o500);
	try {
		await harness.run();
	} finally {
		await chmod(staging, 0o700);
	}

	const first = sessionRecords(harness.ingested);
	assert.equal(
		first.length,
		1,
		"the record is emitted despite capture failure",
	);
	assert.equal(
		first[0]?.artifact_capture,
		"failed",
		"the failed body is visible on the record, not silently absent",
	);
	assert.equal(
		cursorFor(harness.state())?.captured_sha256,
		undefined,
		"no captured marker is persisted for a body that is not held",
	);
	assert.ok(
		harness.progress.some((line) =>
			line.includes("artifact_bodies_outstanding=1"),
		),
		"the outstanding body is reported in terminal output",
	);

	// Run 2: the source file is NOT touched — same bytes, same size, so the
	// ordinary cursor would skip it. Only the withheld marker forces the retry.
	harness.ingested.length = 0;
	harness.progress.length = 0;
	await harness.run();

	const expected = createHash("sha256").update(source.body).digest("hex");
	const spool = new LocalDeviceBlobSpool({ root: source.spoolRoot });
	assert.ok(
		spool.has(expected),
		"the retry captured the body on the next run, with the file unchanged",
	);
	assert.equal(
		cursorFor(harness.state())?.captured_sha256,
		expected,
		"the captured marker is persisted once the bytes are held",
	);
});

test("a genuine dead-lettered backlog row still blocks scanning", async () => {
	const source = await makeSource();
	const harness = await makeHarness(source);

	// A healthy capturing run first, so the queue exists and the connector is in
	// its ordinary state.
	await harness.run();

	// Now the must-fail side of the halt repair. Not enqueuing a `blob_upload`
	// row is what keeps a captured body from halting collection — but that must
	// not have weakened the backlog gate itself. A REAL undelivered record batch
	// is exactly the backlog scan admission is supposed to refuse to run past.
	const db = new DatabaseSync(source.queuePath);
	try {
		const now = new Date().toISOString();
		db.prepare(
			`INSERT INTO local_device_outbox (
				id, source_instance_id, kind, status, payload_json, body_hash,
				attempt_count, next_attempt_at, lease_epoch, created_at, updated_at
			) VALUES (?, ?, 'record_batch', 'dead_letter', '{}', 'x', 1, ?, 0, ?, ?)`,
		).run("halt-control-row", "codex-production", now, now, now);
	} finally {
		db.close();
	}

	// A brand-new session the run would otherwise collect.
	const third = "039d922d-c38b-7e11-ae99-9187af386150";
	await writeFile(
		join(
			source.sessionsDir,
			DATE_DIR,
			`rollout-2026-04-15T12-26-06-${third}.jsonl`,
		),
		jsonlLines([sessionMetaLine(third), messageLine("third session")]),
	);

	harness.ingested.length = 0;
	const result = await harness.run();

	assert.equal(
		result.skippedScanForBacklog,
		true,
		"genuine dead-lettered backlog still stops the scan",
	);
	assert.equal(
		sessionRecords(harness.ingested).length,
		0,
		"and nothing was collected past it",
	);
});

test("a capture-less run over an APPENDED file does not strand the new bytes", async () => {
	const source = await makeSource();
	const harness = await makeHarness(source);

	// Run 1 captures the body as it stands, so a real `captured_sha256` is on the
	// cursor. This digest describes 205 KB of file and nothing more.
	await harness.run();
	const firstDigest = createHash("sha256").update(source.body).digest("hex");
	assert.equal(
		cursorFor(harness.state())?.captured_sha256,
		firstDigest,
		"run 1 marked the body it actually captured",
	);

	// Codex appends to the same rollout: the session kept going. The file is now
	// strictly larger, and the run-1 digest no longer describes it.
	const appended = `${messageLine("y".repeat(100 * 1024), "2026-04-15T17:35:00.000Z")}\n`;
	await writeFile(source.rolloutPath, appended, { flag: "a" });
	const grown = await readFile(source.rolloutPath);
	assert.ok(
		grown.length > source.body.length,
		"the fixture really grew, so this run takes the parse path, not the skip path",
	);
	const grownDigest = createHash("sha256").update(grown).digest("hex");

	// Run 2 has no artifact stores — the operator has not wired capture for this
	// run. It still PARSES the appended lines and commits a new, larger
	// `size_bytes`. The defect: `capturedMarker` returns the prior digest
	// unchanged when the ledger is disabled, stamping run 1's digest onto a
	// cursor that now vouches for the grown file. `captured_sha256` is defined as
	// the digest "as of `size_bytes`", so that marker is a false claim.
	harness.ingested.length = 0;
	await harness.run({ capture: false });

	const afterCaptureless = cursorFor(harness.state());
	assert.notEqual(
		afterCaptureless?.captured_sha256,
		firstDigest,
		"a capture-less run must not carry the old digest onto the grown file's cursor",
	);

	// Run 3 re-enables capture with the file untouched. Because run 2 left no
	// marker, `isSettled` is false and the appended bytes are captured. With the
	// stale marker present this run captured NOTHING and the bytes were lost once
	// Codex aged the session out.
	harness.ingested.length = 0;
	await harness.run();

	const spool = new LocalDeviceBlobSpool({ root: source.spoolRoot });
	assert.ok(
		spool.has(grownDigest),
		"the appended bytes were captured once capture was re-enabled",
	);
	assert.equal(
		spool.sizeOf(grownDigest),
		grown.length,
		"the captured body is the whole grown file",
	);
	assert.equal(
		cursorFor(harness.state())?.captured_sha256,
		grownDigest,
		"the cursor now vouches for the bytes actually held",
	);
});

test("a capture-less run over a SAME-SIZE rewritten file does not strand the new bytes", async () => {
	const source = await makeSource();
	const harness = await makeHarness(source);

	// Run 1 captures the body as it stands and marks the cursor with its digest.
	await harness.run();
	const firstDigest = createHash("sha256").update(source.body).digest("hex");
	assert.equal(
		cursorFor(harness.state())?.captured_sha256,
		firstDigest,
		"run 1 marked the body it actually captured",
	);

	// The file is rewritten in place at exactly its old length — every `z` in the
	// message body becomes a `w` — and the mtime moves. Size equality alone
	// cannot tell this apart from an untouched file, which is why the carry
	// forward has to test the mtime too.
	const rewritten = Buffer.from(
		source.body.toString("utf8").replaceAll("z", "w"),
		"utf8",
	);
	assert.equal(
		rewritten.length,
		source.body.length,
		"the rewrite really is the same length, so size equality still holds",
	);
	assert.ok(!rewritten.equals(source.body), "and the bytes really did change");
	await writeFile(source.rolloutPath, rewritten);
	const bumped = statSync(source.rolloutPath).mtimeMs + 5_000;
	utimesSync(source.rolloutPath, bumped / 1000, bumped / 1000);
	const rewrittenDigest = createHash("sha256").update(rewritten).digest("hex");

	// Run 2 has no artifact stores. It reparses (same size + moved mtime with no
	// growth resolves to `unsafe_full`) and commits a cursor describing the NEW
	// bytes. Carrying run 1's digest here would be a false claim about content
	// the file no longer holds.
	harness.ingested.length = 0;
	await harness.run({ capture: false });

	assert.notEqual(
		cursorFor(harness.state())?.captured_sha256,
		firstDigest,
		"a capture-less run must not carry the old digest onto the rewritten file's cursor",
	);

	// Run 3 re-enables capture with the file untouched since run 2. Only the
	// absent marker can make it revisit the file: size and mtime now both match
	// run 2's cursor, so a surviving marker would send it down the skip path and
	// the rewritten bytes would never reach the spool.
	harness.ingested.length = 0;
	await harness.run();

	const spool = new LocalDeviceBlobSpool({ root: source.spoolRoot });
	assert.ok(
		spool.has(rewrittenDigest),
		"the rewritten bytes were captured once capture was re-enabled",
	);
	assert.equal(
		spool.sizeOf(rewrittenDigest),
		rewritten.length,
		"the captured body is the whole rewritten file",
	);
	assert.equal(
		cursorFor(harness.state())?.captured_sha256,
		rewrittenDigest,
		"the cursor now vouches for the bytes actually held",
	);
});

test("a thread-only metadata change does not erase the stored body reference", async () => {
	const source = await makeSource();
	writeThreadsDb(source, { title: "original title", updatedAt: 1_776_000_100 });
	const harness = await makeHarness(source);

	// Run 1 parses and captures, so the stored row carries the reference.
	await harness.run();
	const digest = createHash("sha256").update(source.body).digest("hex");
	assert.equal(
		latestStoredSession(harness.ingested)?.artifact_capture,
		"captured",
		"run 1 stored the capture outcome",
	);
	assert.equal(
		latestStoredSession(harness.ingested)?.artifact_sha256,
		digest,
		"run 1 stored the digest",
	);

	// Codex renames the thread. Only state_5 moves — the rollout file is not
	// touched, so run 2 builds NO aggregate for this session and re-emits the row
	// from thread metadata alone.
	writeThreadsDb(source, { title: "renamed thread", updatedAt: 1_776_000_900 });

	harness.ingested.length = 0;
	await harness.run();

	const stored = latestStoredSession(harness.ingested);
	assert.ok(stored, "run 2 re-emitted the session on the metadata change");
	assert.equal(
		stored?.title,
		"renamed thread",
		"the re-emit really is the metadata change, not a stale copy",
	);
	// The defect: `artifactCaptureFields(undefined)` returned `{}`, so the rebuilt
	// record omitted both fields. The server replaces `record_json` wholesale, so
	// omission is deletion — the owner's stored session silently stopped pointing
	// at a body that is still held in the spool.
	assert.equal(
		stored?.artifact_capture,
		"captured",
		"the stored row still says the body is captured after a metadata-only update",
	);
	assert.equal(
		stored?.artifact_sha256,
		digest,
		"the stored row still carries the digest after a metadata-only update",
	);

	// The reference is not a fiction: the bytes it names are really held.
	const spool = new LocalDeviceBlobSpool({ root: source.spoolRoot });
	assert.ok(spool.has(digest), "the digest the row carries is a held body");
});

test("a backfill gives the stored session its body reference, not just the cursor", async () => {
	const source = await makeSource();
	writeThreadsDb(source, { title: "stable title", updatedAt: 1_776_000_100 });
	const harness = await makeHarness(source);

	// Run 1 has no artifact stores: the row is stored with no capture fields.
	await harness.run({ capture: false });
	assert.equal(
		latestStoredSession(harness.ingested)?.artifact_capture,
		undefined,
		"a storeless run asserts nothing about the body",
	);

	// Run 2 enables capture. The rollout file is untouched and state_5 is
	// untouched, so this run parses nothing and its only work is the skip-path
	// backfill.
	harness.ingested.length = 0;
	await harness.run();

	const digest = createHash("sha256").update(source.body).digest("hex");
	const spool = new LocalDeviceBlobSpool({ root: source.spoolRoot });
	assert.ok(spool.has(digest), "the backfill captured the body");
	assert.equal(
		cursorFor(harness.state())?.captured_sha256,
		digest,
		"and marked the cursor",
	);

	// The defect: the backfill builds no aggregate and moves no count, so the
	// ordinary emit gate stayed shut and the digest reached ONLY the cursor. The
	// owner's stored session kept saying nothing about a body now held.
	const stored = latestStoredSession(harness.ingested);
	assert.ok(stored, "the backfill issued a targeted session update");
	assert.equal(
		stored?.artifact_capture,
		"captured",
		"the stored row gained the capture outcome from the backfill",
	);
	assert.equal(
		stored?.artifact_sha256,
		digest,
		"the stored row gained the digest from the backfill",
	);
});

test("a prior digest is not rescued from stale state when this run's capture fails", async () => {
	const source = await makeSource();
	writeThreadsDb(source, {
		title: "precedence title",
		updatedAt: 1_776_000_100,
	});
	const harness = await makeHarness(source);

	// Run 1 captures, so the PRIOR state run 2 reads carries a real digest.
	await harness.run();
	const firstDigest = createHash("sha256").update(source.body).digest("hex");
	assert.equal(
		cursorFor(harness.state())?.captured_sha256,
		firstDigest,
		"run 1 left a digest in durable state",
	);

	// The session keeps going: Codex appends. The run-1 digest describes only the
	// smaller file, so it must not speak for the grown one.
	await writeFile(
		source.rolloutPath,
		`${messageLine("y".repeat(100 * 1024), "2026-04-15T17:35:00.000Z")}\n`,
		{ flag: "a" },
	);

	// Run 2 parses the appended lines but CANNOT capture them. Reconciliation
	// reads the cursor this run is about to persist, which the scan deliberately
	// left unmarked; the digest still sitting in the PRIOR map describes bytes
	// that are no longer the whole file. Reporting `captured` here would be a
	// false claim of retention — worse than the gap it hides — so a scanned file
	// that ends the run unmarked must not be rescued from stale state.
	const staging = join(source.spoolRoot, "tmp");
	await mkdir(staging, { recursive: true });
	await chmod(staging, 0o500);
	harness.ingested.length = 0;
	try {
		await harness.run();
	} finally {
		await chmod(staging, 0o700);
	}

	const stored = latestStoredSession(harness.ingested);
	assert.ok(stored, "run 2 re-emitted the session");
	assert.equal(
		stored?.artifact_capture,
		"failed",
		"the failure is reported as itself",
	);
	assert.notEqual(
		stored?.artifact_sha256,
		firstDigest,
		"and the prior digest is not carried onto the grown file's record",
	);
	assert.equal(
		cursorFor(harness.state())?.captured_sha256,
		undefined,
		"the persisted cursor is unmarked, so the next run retries the body",
	);
});

test("a rewritten body and a failed capture never leave a stale digest on the stored session", async () => {
	const source = await makeSource();
	writeThreadsDb(source, { title: "control title", updatedAt: 1_776_000_100 });
	const harness = await makeHarness(source);

	// Run 1 captures, so a real digest exists to be wrongly carried.
	await harness.run();
	const firstDigest = createHash("sha256").update(source.body).digest("hex");
	assert.equal(
		latestStoredSession(harness.ingested)?.artifact_sha256,
		firstDigest,
		"run 1 stored the digest it captured",
	);

	// Same-length in-place rewrite plus a moved mtime: the bytes changed, so the
	// run-1 digest describes content the file no longer holds.
	const rewritten = Buffer.from(
		source.body.toString("utf8").replaceAll("z", "w"),
		"utf8",
	);
	assert.equal(
		rewritten.length,
		source.body.length,
		"the rewrite is the same length, so size equality alone still holds",
	);
	assert.ok(!rewritten.equals(source.body), "and the bytes really did change");
	await writeFile(source.rolloutPath, rewritten);
	const bumped = statSync(source.rolloutPath).mtimeMs + 5_000;
	utimesSync(source.rolloutPath, bumped / 1000, bumped / 1000);

	// Run 2 reparses the rewritten file, and its capture FAILS: the spool's
	// staging directory is unwritable. Both invalidations are live at once — the
	// bytes moved, and this run cannot vouch for the new ones either.
	const staging = join(source.spoolRoot, "tmp");
	await mkdir(staging, { recursive: true });
	await chmod(staging, 0o500);
	harness.ingested.length = 0;
	try {
		await harness.run();
	} finally {
		await chmod(staging, 0o700);
	}

	const stored = latestStoredSession(harness.ingested);
	assert.ok(stored, "run 2 re-emitted the session");
	assert.notEqual(
		stored?.artifact_sha256,
		firstDigest,
		"the stored row must not carry a digest of bytes the file no longer holds",
	);
	assert.equal(
		stored?.artifact_capture,
		"failed",
		"the failure is reported as itself, not papered over with a durable digest",
	);
	assert.equal(
		cursorFor(harness.state())?.captured_sha256,
		undefined,
		"and no captured marker is persisted for a body that is not held",
	);
});

test("a legacy mtime-only history enters capture instead of skipping forever", async () => {
	const source = await makeSource();
	const harness = await makeHarness(source);

	// The legacy shape: a history that has only ever recorded the whole-file
	// mtime, with no rich cursor — what enrollment and a connector-version
	// upgrade both leave behind. Seeded directly so the STATE is genuinely
	// legacy, not a rich cursor with a field removed.
	harness.seedState({
		messages: {
			file_mtimes: {
				[source.rolloutPath]: statSync(source.rolloutPath).mtimeMs,
			},
		},
	});

	// Run 1 with capture on, file unchanged. The defect: the legacy fast path
	// returns before any capture logic whenever the numeric mtime matches and no
	// rich cursor exists — zero captures, no rich cursor written, no obligation
	// recorded, repeating on every run forever.
	await harness.run();

	const digest = createHash("sha256").update(source.body).digest("hex");
	const spool = new LocalDeviceBlobSpool({ root: source.spoolRoot });
	assert.ok(
		spool.has(digest),
		"the legacy entry was captured rather than skipped past",
	);
	assert.equal(
		harness.progress.filter((line) => line.includes("awaiting_upload=1"))
			.length,
		1,
		"exactly one capture, not a re-capture storm",
	);
	assert.equal(
		cursorFor(harness.state())?.captured_sha256,
		digest,
		"the rich cursor was persisted, so the legacy entry is now upgraded",
	);

	// Run 2 changes nothing. The skip must be regained now that retention is
	// established — the one-time reparse must not become a per-run cost.
	harness.ingested.length = 0;
	harness.progress.length = 0;
	await harness.run();

	assert.ok(
		!harness.progress.some((line) => line.includes("awaiting_upload")),
		"the second unchanged run captures nothing",
	);
	assert.ok(
		!harness.progress.some((line) => line.includes("outstanding")),
		"and owes nothing",
	);
});

test("a legacy mtime-only history keeps the fast path when capture is not configured", async () => {
	const source = await makeSource();
	const harness = await makeHarness(source);

	harness.seedState({
		messages: {
			file_mtimes: {
				[source.rolloutPath]: statSync(source.rolloutPath).mtimeMs,
			},
		},
	});

	// The control for the repair's gate: with no artifact stores there is nothing
	// to gain by reparsing a legacy entry, so the old behaviour must stand. A
	// repair that dropped the fast path unconditionally would reparse every
	// legacy file on every capture-less run.
	await harness.run({ capture: false });

	assert.equal(
		sessionRecords(harness.ingested).length,
		0,
		"the unchanged legacy entry was skipped, emitting nothing",
	);
	assert.equal(
		cursorFor(harness.state())?.captured_sha256,
		undefined,
		"and no captured marker was invented",
	);
});

test("enabling capture backfills a previously-unavailable body exactly once", async () => {
	const source = await makeSource();
	const harness = await makeHarness(source);

	// Run 1 has no artifact stores at all — what every run looked like before
	// capture was configurable.
	await harness.run({ capture: false });
	assert.equal(
		sessionRecords(harness.ingested)[0]?.artifact_capture,
		undefined,
		"a run with no stores asserts nothing about the body",
	);
	assert.equal(
		cursorFor(harness.state())?.captured_sha256,
		undefined,
		"and persists no captured marker",
	);

	// Run 2 enables capture. The file is unchanged, so only the absent marker
	// can make this run revisit it.
	harness.ingested.length = 0;
	await harness.run();

	const expected = createHash("sha256").update(source.body).digest("hex");
	const spool = new LocalDeviceBlobSpool({ root: source.spoolRoot });
	assert.ok(spool.has(expected), "enabling capture backfilled the body");
	assert.equal(
		cursorFor(harness.state())?.captured_sha256,
		expected,
		"the backfilled body is marked captured",
	);

	// Run 3 changes nothing. The backfill must be once, not every run.
	harness.ingested.length = 0;
	harness.progress.length = 0;
	await harness.run();
	assert.ok(
		!harness.progress.some((line) => line.includes("awaiting_upload")),
		"a settled body is not re-captured on a later unchanged run",
	);
});
