// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Proves artifact capture at the PRODUCTION collection entrypoint.
 *
 * `artifact-capture.test.ts` calls `emitToolResultFile` directly with a
 * hand-built context, which proves the helper works. It cannot prove the
 * ordinary collection path supplies one — and before this file existed, it
 * did not: `scanLegacyNonJsonl()` called `scanProjectDirs` without
 * `captureContext`, the field defaulted to null all the way down, and
 * `captureFileArtifact` returned `unavailable` on every real run.
 *
 * These tests drive `runCollectorConnector` — the same driver `bin/collector-
 * runner.ts run` uses — over a real tool-results tree, and assert on what the
 * records and the outbox actually contain.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
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
import { after, test } from "node:test";
import {
	type CollectorRunResult,
	LocalDeviceBlobSpool,
	runCollectorConnector,
} from "@pdpp/collector-runtime";
import { buildConnectorSpec } from "../../bin/collector-runner.ts";
import { resolveExecutionRoot } from "../../src/execution-root.ts";

const SESSION_ID = "22222222-2222-4222-8222-222222222222";

const cleanups: Array<() => Promise<void>> = [];

after(async () => {
	// Independent temp dirs and servers; nothing orders these teardowns.
	await Promise.all(cleanups.map((cleanup) => cleanup()));
});

interface Source {
	body: Buffer;
	claudeHome: string;
	project: string;
	projects: string;
	queuePath: string;
	spoolRoot: string;
	toolResult: string;
}

/**
 * A Claude Code home with one project, one transcript and one tool-result
 * file whose body is far larger than the preview window.
 */
async function makeSource(): Promise<Source> {
	const claudeHome = await mkdtemp(join(tmpdir(), "pdpp-claude-production-"));
	cleanups.push(() => rm(claudeHome, { force: true, recursive: true }));
	const projects = join(claudeHome, "projects");
	const project = join(projects, "-tmp-production");
	await mkdir(join(project, SESSION_ID, "tool-results"), { recursive: true });
	await writeFile(
		join(project, `${SESSION_ID}.jsonl`),
		`${JSON.stringify({
			isSidechain: false,
			message: { content: "hello" },
			sessionId: SESSION_ID,
			timestamp: "2026-09-01T00:00:00.000Z",
			type: "user",
			uuid: "00000000-0000-4000-8000-000000000001",
		})}\n`,
	);
	// 200 KB — three orders of magnitude past the 500-character preview that
	// used to be the only stored representation.
	const body = Buffer.from("z".repeat(200 * 1024), "utf8");
	const toolResult = join(project, SESSION_ID, "tool-results", "big.txt");
	await writeFile(toolResult, body);
	return {
		body,
		claudeHome,
		project,
		projects,
		queuePath: join(claudeHome, "queue.sqlite"),
		spoolRoot: join(claudeHome, "blob-spool"),
		toolResult,
	};
}

interface RunOptions {
	/**
	 * False models a run the operator has NOT wired artifact stores for: the
	 * child gets no capture env, so every body is honestly `unavailable`. This is
	 * what every run looked like before capture was configurable, which is why
	 * enabling it later has to backfill.
	 */
	capture?: boolean;
}

interface Harness {
	ingested: Array<Record<string, unknown>>;
	/** The progress lines the connector emitted, as an operator would read them. */
	progress: string[];
	run: (options?: RunOptions) => Promise<CollectorRunResult>;
	/** The cursor the reference server has persisted, as the next run will read it. */
	state: () => Record<string, unknown>;
	server: Server;
}

/** A reference-server stub plus a `runCollectorConnector` invocation. */
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
				connector: "claude_code",
				queuePath: source.queuePath,
				streams: ["sessions", "messages", "attachments"],
			},
			(options?.capture ?? true)
				? {
						outboxPath: source.queuePath,
						sourceInstanceId: "claude-production",
					}
				: undefined,
		);
		return await runCollectorConnector({
			baseUrl,
			connector: {
				...spec,
				env: {
					...spec.env,
					CLAUDE_CODE_HOME: source.claudeHome,
					CLAUDE_CODE_PROJECTS_DIR: source.projects,
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
			sourceInstanceId: "claude-production",
		});
	};
	return { ingested, progress, run, server, state: () => persistedState };
}

function attachmentRecords(
	ingested: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
	return ingested
		.filter((record) => record.stream === "attachments")
		.map((record) => (record.data ?? record) as Record<string, unknown>);
}

test("the ordinary collection path captures tool-result bodies", async () => {
	const source = await makeSource();
	const harness = await makeHarness(source);

	await harness.run();

	const records = attachmentRecords(harness.ingested);
	const toolResults = records.filter(
		(record) => record.event_type === "tool_result_file",
	);
	assert.equal(toolResults.length, 1, "one tool-result record was collected");
	const record = toolResults[0] as Record<string, unknown>;

	// The defect this guards: before capture was wired through the production
	// path this was "unavailable" on every real run, and no bytes were held.
	assert.equal(
		record.artifact_capture,
		"captured",
		"the ordinary run captured the body rather than reporting unavailable",
	);
	assert.equal(
		record.artifact_sha256,
		createHash("sha256").update(source.body).digest("hex"),
		"the recorded digest is the digest of the complete body",
	);

	// The bytes are really in the spool, at their full length — not a preview.
	const spool = new LocalDeviceBlobSpool({ root: source.spoolRoot });
	const sha = record.artifact_sha256 as string;
	assert.ok(
		spool.has(sha),
		"the complete body is present in the artifact spool",
	);
	assert.equal(
		spool.sizeOf(sha),
		source.body.length,
		"the spooled body is the whole file, not the preview prefix",
	);
	assert.ok(
		(await readFile(spool.pathFor(sha))).equals(source.body),
		"the spooled bytes are the source file's bytes",
	);
});

test("a transiently failed capture is retried on the next run, file unchanged", async () => {
	const source = await makeSource();
	const harness = await makeHarness(source);

	// Run 1 reads the preview fine but cannot write the body: the spool's
	// staging directory is not writable, so `put` fails at the temp file. That
	// is the transient shape this rule exists for — enumeration succeeds while
	// the body does not become durable. Restoring the mode repairs it without
	// touching the source file.
	const staging = join(source.spoolRoot, "tmp");
	await mkdir(staging, { recursive: true });
	await chmod(staging, 0o500);
	try {
		await harness.run();
	} finally {
		await chmod(staging, 0o700);
	}

	const firstRecords = attachmentRecords(harness.ingested).filter(
		(record) => record.event_type === "tool_result_file",
	);
	assert.equal(firstRecords.length, 1, "the record is emitted despite failure");
	assert.equal(
		firstRecords[0]?.artifact_capture,
		"failed",
		"the failed body is visible on the record, not silently absent",
	);

	// Run 2: the source file is NOT touched. Its mtime is identical.
	const mtimeBefore = statSync(source.toolResult).mtimeMs;
	harness.ingested.length = 0;
	await harness.run();
	assert.equal(
		statSync(source.toolResult).mtimeMs,
		mtimeBefore,
		"the source file really was unchanged between the two runs",
	);

	// The defect this guards: run 1 checkpointed the mtime before capture, so
	// run 2 skipped the unchanged file before ever reaching capture and the
	// transient failure became a permanent, unretried gap.
	const retried = attachmentRecords(harness.ingested).filter(
		(record) => record.event_type === "tool_result_file",
	);
	assert.equal(
		retried.length,
		1,
		"the unchanged file was re-examined rather than skipped on mtime",
	);
	assert.equal(
		retried[0]?.artifact_capture,
		"captured",
		"the retry captured the body the transient failure had missed",
	);
	const spool = new LocalDeviceBlobSpool({ root: source.spoolRoot });
	assert.equal(
		spool.sizeOf(retried[0]?.artifact_sha256 as string),
		source.body.length,
		"the retried capture holds the complete body",
	);
});

test("a captured file IS skipped on the next run while unchanged", async () => {
	const source = await makeSource();
	const harness = await makeHarness(source);

	await harness.run();
	assert.equal(
		attachmentRecords(harness.ingested).filter(
			(record) => record.event_type === "tool_result_file",
		)[0]?.artifact_capture,
		"captured",
		"the first run captured the body",
	);

	// The retry rule must not degrade into "re-emit everything forever". A
	// settled body stays settled: this is the negative control for the test
	// above, and it fails if withholding the mtime is applied unconditionally.
	harness.ingested.length = 0;
	await harness.run();
	assert.deepEqual(
		attachmentRecords(harness.ingested).filter(
			(record) => record.event_type === "tool_result_file",
		),
		[],
		"an unchanged file whose body is already held is not re-collected",
	);
});

/** The tool-result checkpoints, as the next run will read them back. */
function storedCheckpoint(harness: Harness, path: string): number | undefined {
	const state = harness.state() as {
		sessions?: { file_mtimes?: Record<string, number> };
	};
	return state.sessions?.file_mtimes?.[path];
}

function toolResultFiles(
	ingested: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
	return attachmentRecords(ingested).filter(
		(record) => record.event_type === "tool_result_file",
	);
}

test("enabling capture backfills a body recorded before any store was wired", async () => {
	const source = await makeSource();
	const harness = await makeHarness(source);

	// A run with no artifact stores: honest, but it holds no bytes.
	await harness.run({ capture: false });
	assert.equal(
		toolResultFiles(harness.ingested)[0]?.artifact_capture,
		"unavailable",
		"the first run had nowhere to put the body",
	);

	// The operator wires the stores. The file has NOT changed, so a checkpoint
	// compared on mtime alone would skip it and the old body would stay lost.
	harness.ingested.length = 0;
	await harness.run({ capture: true });
	const backfilled = toolResultFiles(harness.ingested);
	assert.equal(backfilled.length, 1, "the unchanged file was revisited");
	assert.equal(
		backfilled[0]?.artifact_capture,
		"captured",
		"enabling capture backfilled the previously-unavailable body",
	);

	// Backfill must happen ONCE, not on every subsequent run. The checkpoint now
	// records that the body is held, which is what stops the re-read.
	assert.notEqual(
		storedCheckpoint(harness, source.toolResult),
		statSync(source.toolResult).mtimeMs,
		"the checkpoint records a held body, not the bare mtime",
	);
});

test("a captured body's checkpoint is distinguishable from a bare mtime", async () => {
	const source = await makeSource();
	const harness = await makeHarness(source);

	await harness.run({ capture: true });
	assert.equal(
		toolResultFiles(harness.ingested)[0]?.artifact_capture,
		"captured",
	);

	// This is the fact that makes backfill terminate. If the captured file were
	// checkpointed with its bare mtime, a capture-enabled run could not tell it
	// apart from a preview-only checkpoint, and would re-read it forever.
	const stored = storedCheckpoint(harness, source.toolResult);
	assert.ok(stored !== undefined, "the captured file was checkpointed");
	assert.notEqual(
		stored,
		statSync(source.toolResult).mtimeMs,
		"a held body is checkpointed distinguishably",
	);
});

test("collection continues across runs once a body has been captured", async () => {
	const source = await makeSource();
	const harness = await makeHarness(source);

	const first = await harness.run({ capture: true });
	assert.equal(
		toolResultFiles(harness.ingested)[0]?.artifact_capture,
		"captured",
		"the first run captured the body",
	);
	assert.equal(
		first.outboxSummary.deadLetter,
		0,
		"capturing a body dead-letters nothing",
	);

	// A brand-new session appears. A healthy connector must collect it.
	const NEXT_SESSION = "33333333-3333-4333-8333-333333333333";
	await mkdir(join(source.project, NEXT_SESSION, "tool-results"), {
		recursive: true,
	});
	await writeFile(
		join(source.project, `${NEXT_SESSION}.jsonl`),
		`${JSON.stringify({
			isSidechain: false,
			message: { content: "brand new" },
			sessionId: NEXT_SESSION,
			timestamp: "2026-09-02T00:00:00.000Z",
			type: "user",
			uuid: "00000000-0000-4000-8000-000000000002",
		})}\n`,
	);

	harness.ingested.length = 0;
	const second = await harness.run({ capture: true });

	// The defect this guards: capture enqueued a `blob_upload` obligation against
	// an upload transport that is not wired. Its drain failed terminally, the row
	// was dead-lettered on the first attempt, and the runtime's scan-admission
	// predicate treats any non-succeeded row outside `gap` / `terminal_run_commit`
	// as backlog. Every later run skipped the scan entirely, so ONE captured body
	// permanently stopped the connector — unchanged files, modified files and new
	// sessions alike.
	assert.equal(
		second.skippedScanForBacklog,
		false,
		"the run after a capture actually scans rather than skipping for backlog",
	);
	assert.ok(
		harness.ingested.some((record) =>
			JSON.stringify(record).includes(NEXT_SESSION),
		),
		"a session created after the first capture is still collected",
	);
});

test("a captured body's pending upload stays visible in reporting", async () => {
	const source = await makeSource();
	const harness = await makeHarness(source);

	await harness.run({ capture: true });

	// Not enqueuing the upload row must not become "pretend nothing is owed".
	// Local retention is complete; remote delivery is not, and an operator has to
	// be able to see that.
	assert.ok(
		harness.progress.some((line) =>
			line.includes("artifact_bodies_awaiting_upload=1"),
		),
		"the undelivered body is reported, not silently dropped",
	);
});

test("an unreadable tool-result is retried on a later run, capture off", async () => {
	const source = await makeSource();
	const harness = await makeHarness(source);

	// `readBoundedFilePreview` returns null here, the failure path that precedes
	// any capture attempt. With capture off the ledger is inert, so the retry
	// obligation cannot live there — it has to be the absent checkpoint.
	await chmod(source.toolResult, 0o000);
	try {
		await harness.run({ capture: false });
	} finally {
		await chmod(source.toolResult, 0o600);
	}
	assert.equal(
		storedCheckpoint(harness, source.toolResult),
		undefined,
		"an unreadable file leaves no checkpoint to skip behind",
	);

	harness.ingested.length = 0;
	await harness.run({ capture: false });
	assert.equal(
		toolResultFiles(harness.ingested).length,
		1,
		"the now-readable file was re-examined rather than skipped forever",
	);
});
