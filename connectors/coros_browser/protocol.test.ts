// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The real connector runtime in a subprocess, fed the synthetic fixtures by
 * protocol-runtime-fixture.ts, and every record it ships checked against Zod and the manifest.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import {
	consentTimeFieldResolver,
	type EmittedMessage,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import {
	type ConnectorSubprocessResult,
	runConnectorProtocolSubprocess,
} from "../../packages/polyfill-connectors/src/test-harness.ts";
import { TIME_RANGE_FIELD } from "./index.ts";
import { STREAMS, type Stream, validateRecord } from "./schemas.ts";

type RecordMessage = Extract<EmittedMessage, { type: "RECORD" }>;
type Scope = { name: string; time_range?: { since?: string; until?: string } };

const text = (name: string): string =>
	readFileSync(new URL(`./${name}`, import.meta.url), "utf8");

/** protocol-runtime-fixture.ts's clock; its source is checked against this below. */
const NOW = "2026-11-10T18:00:00.000Z";
const IDS: Record<Stream, string[]> = {
	profile: ["472000000000000101"],
	// Oldest window first; inside a window, COROS's newest-first order.
	activities: [
		"476000000000000201",
		"476000000000000203",
		"476000000000000202",
	],
	daily_metrics: ["2026-11-07", "2026-11-08", "2026-11-09"],
	planned_workouts: ["2026-11-08::3", "2026-11-12::4"],
};
const RECORDS = Object.values(IDS).flat().length;

const PACKAGE_DIR = new URL(
	"../../packages/polyfill-connectors/",
	import.meta.url,
).pathname;
const ENTRYPOINT = new URL("./protocol-runtime-fixture.ts", import.meta.url)
	.pathname;
const SUBPROCESS = { timeout: 30_000 };

function start(
	streams: Scope[],
	extra: { state?: Record<string, unknown> } = {},
): Promise<ConnectorSubprocessResult> {
	return runConnectorProtocolSubprocess({
		cwd: PACKAGE_DIR,
		entrypoint: ENTRYPOINT,
		start: { type: "START", scope: { streams }, ...extra },
		timeoutMs: 30_000,
	});
}

let firstRun: Promise<ConnectorSubprocessResult> | undefined;
const full = (): Promise<ConnectorSubprocessResult> => {
	firstRun ??= start(STREAMS.map((name) => ({ name })));
	return firstRun;
};

const recordsOf = (run: ConnectorSubprocessResult): RecordMessage[] =>
	run.messages.filter((m): m is RecordMessage => m.type === "RECORD");
const idsIn = (run: ConnectorSubprocessResult, stream: Stream): string[] =>
	recordsOf(run)
		.filter((m) => m.stream === stream)
		.map((m) => String(m.data.id));

function assertSucceeded(run: ConnectorSubprocessResult): void {
	assert.equal(run.code, 0, run.stderr);
	const done = run.messages.at(-1);
	assert.equal(done?.type, "DONE");
	if (done?.type === "DONE") {
		assert.equal(done.status, "succeeded");
		assert.equal(done.records_emitted, recordsOf(run).length);
	}
}

test("coros_browser: the runtime fixture's clock is the one these tests assume", () => {
	assert.match(
		text("protocol-runtime-fixture.ts"),
		new RegExp(`new Date\\("${NOW.replaceAll(".", "\\.")}"\\)`, "u"),
	);
});

test(
	"coros_browser: every stream ships its fixture records, keyed by id, and DONE counts them",
	SUBPROCESS,
	async () => {
		const run = await full();
		assertSucceeded(run);
		assert.equal(recordsOf(run).length, RECORDS);
		for (const stream of STREAMS)
			assert.deepEqual(idsIn(run, stream), IDS[stream], stream);
		for (const m of recordsOf(run)) assert.equal(m.key, m.data.id);
		assert.deepEqual(
			run.messages.filter(
				(m) => m.type === "SKIP_RESULT" || m.type === "PROGRESS",
			),
			[],
		);
	},
);

test(
	"coros_browser: a START time_range holds each stream to its own grant",
	SUBPROCESS,
	async () => {
		// Activities by instant: the ride (01:10Z on the 9th) is in, the morning run (15:30Z on the
		// 8th) is not. Daily metrics by day: the 8th and 9th. The calendar: only the 12th.
		const run = await start([
			{ name: "activities", time_range: { since: "2026-11-09T00:00:00.000Z" } },
			{ name: "daily_metrics", time_range: { since: "2026-11-08" } },
			{ name: "planned_workouts", time_range: { since: "2026-11-10" } },
		]);
		assertSucceeded(run);
		assert.deepEqual(idsIn(run, "activities"), ["476000000000000203"]);
		assert.deepEqual(idsIn(run, "daily_metrics"), ["2026-11-08", "2026-11-09"]);
		assert.deepEqual(idsIn(run, "planned_workouts"), ["2026-11-12::4"]);
		assert.deepEqual(idsIn(run, "profile"), []);
	},
);

// ── Manifest agreement ─────────────────────────────────────────────────────
interface ManifestStream {
	name: string;
	primary_key: string[];
	cursor_field?: string;
	consent_time_field?: string;
	schema: { properties: Record<string, unknown>; required: string[] };
}
const manifest = JSON.parse(text("manifest.json")) as {
	protocol_version: string;
	connector_key: string;
	streams: ManifestStream[];
	reason_display_messages: Record<string, string>;
};
const spec = (stream: string): ManifestStream => {
	const found = manifest.streams.find(({ name }) => name === stream);
	assert.ok(found, `${stream} in the manifest`);
	return found;
};
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats.default(ajv);

test(
	"coros_browser: every shipped record passes Zod cleanly and the manifest's JSON Schema, with exactly its keys",
	SUBPROCESS,
	async () => {
		const run = await full();
		for (const { stream, data } of recordsOf(run)) {
			const zod = validateRecord(stream, data);
			assert.equal(zod.ok, true, `${stream} ${String(data.id)}: Zod`);
			const check = ajv.compile(spec(stream).schema);
			assert.equal(
				check(data),
				true,
				`${stream} ${String(data.id)}: ${ajv.errorsText(check.errors)}`,
			);
			assert.deepEqual(
				Object.keys(data).toSorted(),
				Object.keys(spec(stream).schema.properties).toSorted(),
			);
			assert.deepEqual(
				spec(stream).schema.required.toSorted(),
				Object.keys(spec(stream).schema.properties).toSorted(),
			);
		}
	},
);

test("coros_browser: the manifest names the streams, keys and consent fields the code uses", () => {
	assert.equal(manifest.protocol_version, "0.1.0");
	assert.equal(manifest.connector_key, "coros-browser");
	assert.deepEqual(
		manifest.streams.map(({ name }) => name),
		[...STREAMS],
	);
	const consent = consentTimeFieldResolver("coros_browser");
	assert.equal(consent("profile"), null);
	for (const [stream, field] of Object.entries(TIME_RANGE_FIELD)) {
		const { primary_key, cursor_field, consent_time_field } = spec(stream);
		assert.deepEqual(primary_key, ["id"]);
		assert.equal(cursor_field, field, stream);
		assert.equal(consent_time_field, field, stream);
		assert.deepEqual(consent(stream), {
			field,
			format: field === "date" ? "date" : "date-time",
		});
	}
	assert.doesNotMatch(text("index.ts"), /timeRangeField/u);
});

test("coros_browser: every reason the connector can emit has its own copy, and no other reason does", () => {
	const source = text("index.ts");
	const table = /const SKIP_REASON\b[^=]*=\s*\{([^}]*)\}/u.exec(source)?.[1];
	assert.ok(table);
	const reasons = [...table.matchAll(/^\s*(\w+):\s*"([^"]+)",?\s*$/gmu)].map(
		([, key, value]) => {
			assert.equal(value, key);
			return value as string;
		},
	);
	assert.deepEqual(
		reasons.toSorted(),
		Object.keys(manifest.reason_display_messages).toSorted(),
	);
	assert.equal(source.match(/type: "SKIP_RESULT"/gu)?.length, 1);
	for (const [, literal] of source.matchAll(/\breason: "([^"]+)"/gu)) {
		assert.ok(reasons.includes(literal ?? ""), String(literal));
	}
});
