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
	return { ingested, progress, run, server, state: () => persistedState };
}

function sessionRecords(
	ingested: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
	return ingested
		.filter((record) => record.stream === "sessions")
		.map((record) => (record.data ?? record) as Record<string, unknown>);
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
