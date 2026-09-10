// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	type IngestBatchRequest,
	LocalDeviceQueue,
} from "@pdpp/collector-runtime";
import { LOCAL_COLLECTOR_DEFINITIONS } from "./collector-registry.ts";
import {
	AMAZON_CONNECTOR_ID,
	buildCodexStartMessage,
	buildLocalDeviceStartMessage,
	CLAUDE_CODE_CONNECTOR_ID,
	CODEX_CONNECTOR_ID,
	DEFAULT_AMAZON_STREAMS,
	DEFAULT_IMESSAGE_STREAMS,
	drainLocalDeviceQueue,
	IMESSAGE_CONNECTOR_ID,
	LOCAL_DEVICE_CONNECTOR_PROFILES,
	resolveLocalDeviceConnectorProfile,
	runLocalDeviceExporter,
	transformRecordsToLocalDeviceEnvelopes,
} from "./local-device-runtime.ts";

test("transformRecordsToLocalDeviceEnvelopes converts only RECORD messages", () => {
	const envelopes = transformRecordsToLocalDeviceEnvelopes({
		batchId: "batch-1",
		batchSeq: 1,
		deviceId: "device-1",
		messages: [
			{ message: "working", type: "PROGRESS" },
			{
				data: { id: "message-1", text: "hello" },
				emitted_at: "2026-04-30T12:00:00.000Z",
				key: "message-1",
				stream: "messages",
				type: "RECORD",
			},
			{ records_emitted: 1, status: "succeeded", type: "DONE" },
		],
		sourceInstanceId: "source-1",
	});

	assert.equal(envelopes.length, 1);
	assert.equal(envelopes[0]?.connector_id, CODEX_CONNECTOR_ID);
	assert.equal(envelopes[0]?.device_id, "device-1");
	assert.equal(envelopes[0]?.source_instance_id, "source-1");
	assert.equal(envelopes[0]?.stream, "messages");
});

test("drainLocalDeviceQueue marks sent batches and preserves retryable failures", async () => {
	const queue = new LocalDeviceQueue({
		path: await tempQueuePath(),
		retryBackoffMs: () => 60_000,
	});
	const record = transformRecordsToLocalDeviceEnvelopes({
		batchId: "batch-1",
		batchSeq: 1,
		deviceId: "device-1",
		messages: [
			{
				data: { id: "message-1" },
				emitted_at: "2026-04-30T12:00:00.000Z",
				key: "message-1",
				stream: "messages",
				type: "RECORD",
			},
		],
		sourceInstanceId: "source-1",
	});
	await queue.enqueue({
		batchId: "batch-1",
		batchSeq: 1,
		records: record,
		sourceInstanceId: "source-1",
	});
	await queue.enqueue({
		batchId: "batch-2",
		batchSeq: 2,
		records: record,
		sourceInstanceId: "source-1",
	});

	const sent: IngestBatchRequest[] = [];
	const client = {
		async ingestBatch(request: IngestBatchRequest): Promise<{ ok: true }> {
			await Promise.resolve();
			sent.push(request);
			if (request.batch_id === "batch-2") {
				throw new Error("temporary 503");
			}
			return { ok: true };
		},
	};

	assert.equal(await drainLocalDeviceQueue({ client, queue }), 1);
	assert.deepEqual(
		sent.map((request) => request.batch_id),
		["batch-1", "batch-2"],
	);
	assert.equal(typeof sent[0]?.body_hash, "string");
	assert.deepEqual(sent[0]?.records, [
		{
			data: { id: "message-1" },
			emitted_at: "2026-04-30T12:00:00.000Z",
			record_key: "message-1",
			stream: "messages",
		},
	]);
	const items = await queue.list();
	assert.equal(
		items.find((item) => item.batch_id === "batch-1")?.status,
		"sent",
	);
	assert.equal(
		items.find((item) => item.batch_id === "batch-2")?.status,
		"pending",
	);
	assert.equal(
		items.find((item) => item.batch_id === "batch-2")?.retry_count,
		1,
	);
});

test("buildCodexStartMessage does not require an owner token", () => {
	const start = buildCodexStartMessage(["messages"]);
	assert.deepEqual(start, {
		scope: { streams: [{ name: "messages" }] },
		type: "START",
	});
	assert.equal(JSON.stringify(start).includes("owner"), false);
	assert.equal(JSON.stringify(start).includes("token"), false);
});

async function tempQueuePath(): Promise<string> {
	return join(
		await mkdtemp(join(tmpdir(), "pdpp-local-device-runtime-")),
		"queue.json",
	);
}

// ─── Browser-collector connector profile (add-browser-collector-enrollment-
//     primitive proof harness) ──────────────────────────────────────────────
// The monorepo local-device runner resolves the connector entrypoint from
// LOCAL_DEVICE_CONNECTOR_PROFILES. Registering `amazon` is the deterministic
// wiring the owner-run live browser-collector proof needs; the live browser
// session itself stays owner-mediated. This registry is the MONOREPO runner's
// (development/owner-run) registry — distinct from the published
// `@pdpp/local-collector` BUNDLED_CONNECTORS, which stays filesystem-only so
// the publish never ships browser automation.

test("local-device runner resolves the amazon browser-collector connector profile", () => {
	const profile = resolveLocalDeviceConnectorProfile(AMAZON_CONNECTOR_ID);
	assert.equal(profile.connectorId, AMAZON_CONNECTOR_ID);
	assert.equal(profile.entrypoint, "connectors/amazon/index.ts");
	assert.deepEqual([...profile.defaultStreams], [...DEFAULT_AMAZON_STREAMS]);
	assert.deepEqual([...DEFAULT_AMAZON_STREAMS], ["orders", "order_items"]);
});

test("amazon profile START scope carries its declared streams without a token", () => {
	const profile = resolveLocalDeviceConnectorProfile(AMAZON_CONNECTOR_ID);
	const start = buildLocalDeviceStartMessage(profile.defaultStreams);
	assert.deepEqual(start, {
		scope: { streams: [{ name: "orders" }, { name: "order_items" }] },
		type: "START",
	});
	assert.equal(JSON.stringify(start).includes("token"), false);
});

test("local-device runner resolves the imessage local-collector connector profile", () => {
	const profile = resolveLocalDeviceConnectorProfile(IMESSAGE_CONNECTOR_ID);
	assert.equal(profile.connectorId, IMESSAGE_CONNECTOR_ID);
	assert.equal(profile.entrypoint, "connectors/imessage/index.ts");
	assert.deepEqual([...profile.defaultStreams], [...DEFAULT_IMESSAGE_STREAMS]);
	assert.deepEqual(
		[...DEFAULT_IMESSAGE_STREAMS],
		["messages", "participants", "attachments"],
	);
});

test("imessage profile START scope carries its declared streams without a token", () => {
	const profile = resolveLocalDeviceConnectorProfile(IMESSAGE_CONNECTOR_ID);
	const start = buildLocalDeviceStartMessage(profile.defaultStreams);
	assert.deepEqual(start, {
		scope: {
			streams: [
				{ name: "messages" },
				{ name: "participants" },
				{ name: "attachments" },
			],
		},
		type: "START",
	});
	assert.equal(JSON.stringify(start).includes("token"), false);
});

test("local-device profile registry covers exactly codex, claude-code, amazon, and imessage", () => {
	assert.deepEqual(
		Object.keys(LOCAL_DEVICE_CONNECTOR_PROFILES).sort(),
		[
			AMAZON_CONNECTOR_ID,
			CLAUDE_CODE_CONNECTOR_ID,
			CODEX_CONNECTOR_ID,
			IMESSAGE_CONNECTOR_ID,
		].sort(),
	);
});

test("resolveLocalDeviceConnectorProfile still rejects an unknown connector", () => {
	assert.throws(
		() => resolveLocalDeviceConnectorProfile("totally-unknown"),
		/unsupported local-device connector/,
	);
});

// ─── Default streams come from the collector definitions ──────────────────
// The exporter must request exactly the stream set each connector's own
// definition declares. A hand-copied second list drifts silently, and an
// exporter run missing `coverage_diagnostics` leaves the drained collector
// stuck on `coverage_unknown`.

/** Exporter profile id → the `connector_id` its definition is filed under. */
const DEFINITION_BACKED_PROFILES: ReadonlyArray<
	readonly [profileId: string, definitionConnectorId: string]
> = [
	[CODEX_CONNECTOR_ID, "codex"],
	[CLAUDE_CODE_CONNECTOR_ID, "claude_code"],
	[IMESSAGE_CONNECTOR_ID, "imessage"],
];

for (const [profileId, definitionConnectorId] of DEFINITION_BACKED_PROFILES) {
	test(`${profileId} exporter profile requests exactly its collector definition's streams`, () => {
		const definition = LOCAL_COLLECTOR_DEFINITIONS.find(
			(candidate) => candidate.connector_id === definitionConnectorId,
		);
		assert.ok(
			definition,
			`no collector definition for "${definitionConnectorId}"`,
		);
		assert.deepEqual(
			[...resolveLocalDeviceConnectorProfile(profileId).defaultStreams],
			[...definition.streams],
		);
	});
}

test("codex and claude-code exporter profiles request coverage_diagnostics", () => {
	for (const profileId of [CODEX_CONNECTOR_ID, CLAUDE_CODE_CONNECTOR_ID]) {
		assert.ok(
			resolveLocalDeviceConnectorProfile(profileId).defaultStreams.includes(
				"coverage_diagnostics",
			),
			`${profileId} must request coverage_diagnostics or a drained collector stays on coverage_unknown`,
		);
	}
});

test("the amazon profile stays declared locally — it is browser-bound and has no collector definition", () => {
	assert.equal(
		LOCAL_COLLECTOR_DEFINITIONS.some(
			(candidate) => candidate.connector_id === AMAZON_CONNECTOR_ID,
		),
		false,
	);
	assert.deepEqual([...DEFAULT_AMAZON_STREAMS], ["orders", "order_items"]);
});

for (const profileId of [CODEX_CONNECTOR_ID, CLAUDE_CODE_CONNECTOR_ID]) {
	test(`runLocalDeviceExporter sends ${profileId} a START scope including coverage_diagnostics`, async () => {
		const dir = await mkdtemp(join(tmpdir(), "pdpp-local-device-runtime-"));
		const startCapturePath = join(dir, "start.json");
		const fakeConnectorPath = join(dir, "fake-connector.mjs");
		// A stand-in connector that records the START message the exporter
		// actually wrote to its stdin, then completes with no records. This is
		// the real spawn path — `config.streams ?? profile.defaultStreams`
		// through `buildLocalDeviceStartMessage` to the child.
		await writeFile(
			fakeConnectorPath,
			`
    import { writeFileSync } from "node:fs";
    let stdin = "";
    process.stdin.on("data", (chunk) => { stdin += chunk; });
    process.stdin.on("end", () => {
      writeFileSync(${JSON.stringify(startCapturePath)}, stdin);
      process.stdout.write(JSON.stringify({ type: "DONE", status: "ok", records_emitted: 0 }) + "\\n");
      process.exit(0);
    });
    `,
		);

		const originalFetch = global.fetch;
		global.fetch = (() =>
			Promise.resolve(
				new Response(JSON.stringify({ ok: true }), { status: 200 }),
			)) as typeof fetch;

		try {
			await runLocalDeviceExporter({
				baseUrl: "http://127.0.0.1:1",
				connectorArgs: [fakeConnectorPath],
				connectorCommand: process.execPath,
				connectorId: profileId,
				deviceId: "device-1",
				deviceToken: "token-1",
				queuePath: join(dir, "queue.json"),
				sourceInstanceId: "source-1",
			});
		} finally {
			global.fetch = originalFetch;
		}

		const start = JSON.parse(await readFile(startCapturePath, "utf8")) as {
			scope: { streams: { name: string }[] };
		};
		const requested = start.scope.streams.map((stream) => stream.name);
		assert.ok(
			requested.includes("coverage_diagnostics"),
			`the START the exporter spawned ${profileId} with requested ${requested.join(", ")}`,
		);
		assert.deepEqual(requested, [
			...resolveLocalDeviceConnectorProfile(profileId).defaultStreams,
		]);
	});
}

test("runLocalDeviceExporter truncates queued records to sampleLimit but reports the true recordsSeen count", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pdpp-local-device-runtime-"));
	const fakeConnectorPath = join(dir, "fake-connector.mjs");
	// A minimal stand-in connector: reads START from stdin, emits 5 RECORDs,
	// then DONE — enough to exercise the sample-truncation path without a real
	// chat.db fixture or subprocess protocol harness.
	await writeFile(
		fakeConnectorPath,
		`
    process.stdin.on("data", () => {});
    process.stdin.on("end", () => {
      for (let i = 0; i < 5; i += 1) {
        process.stdout.write(JSON.stringify({ type: "RECORD", stream: "messages", data: { id: "r" + i } }) + "\\n");
      }
      process.stdout.write(JSON.stringify({ type: "DONE", status: "ok", records_emitted: 5 }) + "\\n");
      process.exit(0);
    });
    `,
	);

	const queuePath = join(dir, "queue.json");
	const originalFetch = global.fetch;
	const requests: { path: string; body: unknown }[] = [];
	global.fetch = ((url: string | URL, init?: RequestInit) => {
		const path = new URL(url).pathname;
		requests.push({
			path,
			body: init?.body ? JSON.parse(String(init.body)) : null,
		});
		return Promise.resolve(
			new Response(JSON.stringify({ ok: true }), { status: 200 }),
		);
	}) as typeof fetch;

	try {
		const result = await runLocalDeviceExporter({
			baseUrl: "http://127.0.0.1:1",
			connectorArgs: [fakeConnectorPath],
			connectorCommand: process.execPath,
			connectorId: IMESSAGE_CONNECTOR_ID,
			deviceId: "device-1",
			deviceToken: "token-1",
			queuePath,
			sampleLimit: 2,
			sourceInstanceId: "source-1",
		});

		assert.equal(
			result.recordsSeen,
			5,
			"the fake connector emitted 5 records total",
		);
		assert.equal(
			result.recordsQueued,
			2,
			"sampleLimit=2 must cap what gets queued/ingested",
		);
		assert.equal(result.truncatedBySample, true);

		const ingestRequests = requests.filter((r) =>
			r.path.includes("ingest-batches"),
		);
		assert.equal(ingestRequests.length, 1);
		const ingestBody = ingestRequests[0]?.body as
			| { records: unknown[] }
			| undefined;
		assert.equal(
			ingestBody?.records.length,
			2,
			"only the truncated 2 records should ever hit the wire",
		);
	} finally {
		global.fetch = originalFetch;
	}
});

test("runLocalDeviceExporter queues every record when sampleLimit is unset", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pdpp-local-device-runtime-"));
	const fakeConnectorPath = join(dir, "fake-connector.mjs");
	await writeFile(
		fakeConnectorPath,
		`
    process.stdin.on("data", () => {});
    process.stdin.on("end", () => {
      for (let i = 0; i < 3; i += 1) {
        process.stdout.write(JSON.stringify({ type: "RECORD", stream: "messages", data: { id: "r" + i } }) + "\\n");
      }
      process.stdout.write(JSON.stringify({ type: "DONE", status: "ok", records_emitted: 3 }) + "\\n");
      process.exit(0);
    });
    `,
	);

	const queuePath = join(dir, "queue.json");
	const originalFetch = global.fetch;
	global.fetch = (() =>
		Promise.resolve(
			new Response(JSON.stringify({ ok: true }), { status: 200 }),
		)) as typeof fetch;

	try {
		const result = await runLocalDeviceExporter({
			baseUrl: "http://127.0.0.1:1",
			connectorArgs: [fakeConnectorPath],
			connectorCommand: process.execPath,
			connectorId: IMESSAGE_CONNECTOR_ID,
			deviceId: "device-1",
			deviceToken: "token-1",
			queuePath,
			sourceInstanceId: "source-1",
		});

		assert.equal(result.recordsSeen, 3);
		assert.equal(result.recordsQueued, 3);
		assert.equal(result.truncatedBySample, false);
	} finally {
		global.fetch = originalFetch;
	}
});

test("runLocalDeviceExporter drops a coverage_diagnostics proof claim when sampleLimit truncates the data it vouches for", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pdpp-local-device-runtime-"));
	const fakeConnectorPath = join(dir, "fake-connector.mjs");
	// Mirrors the real connectors (codex, claude-code, apple-photos,
	// google-takeout): coverage_diagnostics is emitted BEFORE the data records
	// it vouches for. A sample limit must not be able to keep the early proof
	// claim while dropping the late data it describes.
	await writeFile(
		fakeConnectorPath,
		`
    process.stdin.on("data", () => {});
    process.stdin.on("end", () => {
      process.stdout.write(JSON.stringify({ type: "RECORD", stream: "coverage_diagnostics", key: "coverage:messages", data: { store: "messages", status: "collected" } }) + "\\n");
      for (let i = 0; i < 50; i += 1) {
        process.stdout.write(JSON.stringify({ type: "RECORD", stream: "messages", data: { id: "r" + i } }) + "\\n");
      }
      process.stdout.write(JSON.stringify({ type: "DONE", status: "ok", records_emitted: 50 }) + "\\n");
      process.exit(0);
    });
    `,
	);

	const queuePath = join(dir, "queue.json");
	const originalFetch = global.fetch;
	const requests: { path: string; body: IngestBatchRequest | null }[] = [];
	global.fetch = ((url: string | URL, init?: RequestInit) => {
		const path = new URL(url).pathname;
		requests.push({
			path,
			body: init?.body ? JSON.parse(String(init.body)) : null,
		});
		return Promise.resolve(
			new Response(JSON.stringify({ ok: true }), { status: 200 }),
		);
	}) as typeof fetch;

	try {
		const result = await runLocalDeviceExporter({
			baseUrl: "http://127.0.0.1:1",
			connectorArgs: [fakeConnectorPath],
			connectorCommand: process.execPath,
			connectorId: CODEX_CONNECTOR_ID,
			deviceId: "device-1",
			deviceToken: "token-1",
			queuePath,
			sampleLimit: 1,
			sourceInstanceId: "source-1",
		});

		assert.equal(result.truncatedBySample, true);
		const ingestRequests = requests.filter((r) =>
			r.path.includes("ingest-batches"),
		);
		const queuedStreams = ingestRequests.flatMap(
			(r) => r.body?.records.map((record) => record.stream) ?? [],
		);
		assert.ok(
			!queuedStreams.includes("coverage_diagnostics"),
			`a truncated run must never queue a coverage_diagnostics proof claim, got streams: ${JSON.stringify(queuedStreams)}`,
		);
		assert.equal(
			result.recordsQueued,
			1,
			"only the sampled data record should be queued, not the diagnostic",
		);
	} finally {
		global.fetch = originalFetch;
	}
});

test("runLocalDeviceExporter still queues coverage_diagnostics when the run completes without truncation", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pdpp-local-device-runtime-"));
	const fakeConnectorPath = join(dir, "fake-connector.mjs");
	await writeFile(
		fakeConnectorPath,
		`
    process.stdin.on("data", () => {});
    process.stdin.on("end", () => {
      process.stdout.write(JSON.stringify({ type: "RECORD", stream: "coverage_diagnostics", key: "coverage:messages", data: { store: "messages", status: "collected" } }) + "\\n");
      for (let i = 0; i < 3; i += 1) {
        process.stdout.write(JSON.stringify({ type: "RECORD", stream: "messages", data: { id: "r" + i } }) + "\\n");
      }
      process.stdout.write(JSON.stringify({ type: "DONE", status: "ok", records_emitted: 3 }) + "\\n");
      process.exit(0);
    });
    `,
	);

	const queuePath = join(dir, "queue.json");
	const originalFetch = global.fetch;
	const requests: { path: string; body: IngestBatchRequest | null }[] = [];
	global.fetch = ((url: string | URL, init?: RequestInit) => {
		const path = new URL(url).pathname;
		requests.push({
			path,
			body: init?.body ? JSON.parse(String(init.body)) : null,
		});
		return Promise.resolve(
			new Response(JSON.stringify({ ok: true }), { status: 200 }),
		);
	}) as typeof fetch;

	try {
		const result = await runLocalDeviceExporter({
			baseUrl: "http://127.0.0.1:1",
			connectorArgs: [fakeConnectorPath],
			connectorCommand: process.execPath,
			connectorId: CODEX_CONNECTOR_ID,
			deviceId: "device-1",
			deviceToken: "token-1",
			queuePath,
			sampleLimit: 10,
			sourceInstanceId: "source-1",
		});

		assert.equal(result.truncatedBySample, false);
		const ingestRequests = requests.filter((r) =>
			r.path.includes("ingest-batches"),
		);
		const queuedStreams = ingestRequests.flatMap(
			(r) => r.body?.records.map((record) => record.stream) ?? [],
		);
		assert.ok(
			queuedStreams.includes("coverage_diagnostics"),
			"an untruncated run under the sample limit must still carry its proof claim",
		);
		assert.equal(
			result.recordsQueued,
			4,
			"3 data records plus the coverage_diagnostics record",
		);
	} finally {
		global.fetch = originalFetch;
	}
});

test("runLocalDeviceExporter sampleLimit=0 truncates all substantive records and withholds coverage_diagnostics", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pdpp-local-device-runtime-"));
	const fakeConnectorPath = join(dir, "fake-connector.mjs");
	await writeFile(
		fakeConnectorPath,
		`
    process.stdin.on("data", () => {});
    process.stdin.on("end", () => {
      process.stdout.write(JSON.stringify({ type: "RECORD", stream: "coverage_diagnostics", key: "coverage:messages", data: { store: "messages", status: "collected" } }) + "\\n");
      for (let i = 0; i < 3; i += 1) {
        process.stdout.write(JSON.stringify({ type: "RECORD", stream: "messages", data: { id: "r" + i } }) + "\\n");
      }
      process.stdout.write(JSON.stringify({ type: "DONE", status: "ok", records_emitted: 3 }) + "\\n");
      process.exit(0);
    });
    `,
	);

	const queuePath = join(dir, "queue.json");
	const originalFetch = global.fetch;
	const requests: { path: string; body: IngestBatchRequest | null }[] = [];
	global.fetch = ((url: string | URL, init?: RequestInit) => {
		const path = new URL(url).pathname;
		requests.push({
			path,
			body: init?.body ? JSON.parse(String(init.body)) : null,
		});
		return Promise.resolve(
			new Response(JSON.stringify({ ok: true }), { status: 200 }),
		);
	}) as typeof fetch;

	try {
		const result = await runLocalDeviceExporter({
			baseUrl: "http://127.0.0.1:1",
			connectorArgs: [fakeConnectorPath],
			connectorCommand: process.execPath,
			connectorId: CODEX_CONNECTOR_ID,
			deviceId: "device-1",
			deviceToken: "token-1",
			queuePath,
			sampleLimit: 0,
			sourceInstanceId: "source-1",
		});

		assert.equal(
			result.truncatedBySample,
			true,
			"sampleLimit=0 must truncate whenever substantive records exist",
		);
		assert.equal(
			result.recordsQueued,
			0,
			"no substantive records and no diagnostic should be queued",
		);
		const ingestRequests = requests.filter((r) =>
			r.path.includes("ingest-batches"),
		);
		assert.equal(
			ingestRequests.length,
			0,
			"an empty sample must not even issue an ingest batch",
		);
	} finally {
		global.fetch = originalFetch;
	}
});

test("runLocalDeviceExporter retains coverage_diagnostics for a verified-empty run with zero substantive records", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pdpp-local-device-runtime-"));
	const fakeConnectorPath = join(dir, "fake-connector.mjs");
	// A run that genuinely found nothing to collect still owes its coverage
	// proof: zero substantive records is not the same as a sample cutting
	// real data off, so sampleLimit=0 must not withhold this diagnostic.
	await writeFile(
		fakeConnectorPath,
		`
    process.stdin.on("data", () => {});
    process.stdin.on("end", () => {
      process.stdout.write(JSON.stringify({ type: "RECORD", stream: "coverage_diagnostics", key: "coverage:messages", data: { store: "messages", status: "verified_empty" } }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "DONE", status: "ok", records_emitted: 0 }) + "\\n");
      process.exit(0);
    });
    `,
	);

	const queuePath = join(dir, "queue.json");
	const originalFetch = global.fetch;
	const requests: { path: string; body: IngestBatchRequest | null }[] = [];
	global.fetch = ((url: string | URL, init?: RequestInit) => {
		const path = new URL(url).pathname;
		requests.push({
			path,
			body: init?.body ? JSON.parse(String(init.body)) : null,
		});
		return Promise.resolve(
			new Response(JSON.stringify({ ok: true }), { status: 200 }),
		);
	}) as typeof fetch;

	try {
		const result = await runLocalDeviceExporter({
			baseUrl: "http://127.0.0.1:1",
			connectorArgs: [fakeConnectorPath],
			connectorCommand: process.execPath,
			connectorId: CODEX_CONNECTOR_ID,
			deviceId: "device-1",
			deviceToken: "token-1",
			queuePath,
			sampleLimit: 0,
			sourceInstanceId: "source-1",
		});

		assert.equal(
			result.truncatedBySample,
			false,
			"zero substantive records under sampleLimit=0 is not a truncation — there was nothing to cut off",
		);
		const ingestRequests = requests.filter((r) =>
			r.path.includes("ingest-batches"),
		);
		const queuedStreams = ingestRequests.flatMap(
			(r) => r.body?.records.map((record) => record.stream) ?? [],
		);
		assert.ok(
			queuedStreams.includes("coverage_diagnostics"),
			"a verified-empty run's coverage proof must still reach the server",
		);
		assert.equal(
			result.recordsQueued,
			1,
			"only the coverage_diagnostics record, no substantive records exist",
		);
	} finally {
		global.fetch = originalFetch;
	}
});

test("runLocalDeviceExporter drops a coverage_diagnostics proof claim emitted AFTER the data it vouches for, when truncated", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pdpp-local-device-runtime-"));
	const fakeConnectorPath = join(dir, "fake-connector.mjs");
	// The fix partitions allRecords by stream, not position — this proves that
	// ordering independence directly: diagnostics emitted LAST (the reverse of
	// codex's own emission order) still get withheld from a truncated run.
	await writeFile(
		fakeConnectorPath,
		`
    process.stdin.on("data", () => {});
    process.stdin.on("end", () => {
      for (let i = 0; i < 50; i += 1) {
        process.stdout.write(JSON.stringify({ type: "RECORD", stream: "messages", data: { id: "r" + i } }) + "\\n");
      }
      process.stdout.write(JSON.stringify({ type: "RECORD", stream: "coverage_diagnostics", key: "coverage:messages", data: { store: "messages", status: "collected" } }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "DONE", status: "ok", records_emitted: 50 }) + "\\n");
      process.exit(0);
    });
    `,
	);

	const queuePath = join(dir, "queue.json");
	const originalFetch = global.fetch;
	const requests: { path: string; body: IngestBatchRequest | null }[] = [];
	global.fetch = ((url: string | URL, init?: RequestInit) => {
		const path = new URL(url).pathname;
		requests.push({
			path,
			body: init?.body ? JSON.parse(String(init.body)) : null,
		});
		return Promise.resolve(
			new Response(JSON.stringify({ ok: true }), { status: 200 }),
		);
	}) as typeof fetch;

	try {
		const result = await runLocalDeviceExporter({
			baseUrl: "http://127.0.0.1:1",
			connectorArgs: [fakeConnectorPath],
			connectorCommand: process.execPath,
			connectorId: CODEX_CONNECTOR_ID,
			deviceId: "device-1",
			deviceToken: "token-1",
			queuePath,
			sampleLimit: 1,
			sourceInstanceId: "source-1",
		});

		assert.equal(result.truncatedBySample, true);
		const ingestRequests = requests.filter((r) =>
			r.path.includes("ingest-batches"),
		);
		const queuedStreams = ingestRequests.flatMap(
			(r) => r.body?.records.map((record) => record.stream) ?? [],
		);
		assert.ok(
			!queuedStreams.includes("coverage_diagnostics"),
			`ordering must not matter: a trailing coverage_diagnostics record must still be withheld from a truncated run, got: ${JSON.stringify(queuedStreams)}`,
		);
		assert.equal(
			result.recordsQueued,
			1,
			"only the sampled data record should be queued, not the trailing diagnostic",
		);
	} finally {
		global.fetch = originalFetch;
	}
});
