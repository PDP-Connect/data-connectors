// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { EmittedMessage } from "@pdpp/connector-protocol";
import {
	CHECKPOINT_WITHHELD_REASON,
	createStreamIntegrity,
} from "./stream-integrity.ts";
import { runConnectorProtocolSubprocess } from "./test-harness.ts";

const STATE = (stream: string): EmittedMessage => ({
	type: "STATE",
	stream,
	cursor: { complete: true },
});

/** Run the fixture connector through the real runtime and return the wire, minus PROGRESS. */
async function wire(
	steps: unknown[],
	streams: string[] = ["items"],
): Promise<EmittedMessage[]> {
	const result = await runConnectorProtocolSubprocess({
		allowFailedDone: true,
		cwd: fileURLToPath(new URL("../../..", import.meta.url)),
		entrypoint: fileURLToPath(
			new URL("./__fixtures__/stream-integrity-connector.ts", import.meta.url),
		),
		env: { PDPP_TEST_STEPS: JSON.stringify(steps) },
		start: {
			type: "START",
			scope: { streams: streams.map((name) => ({ name })) },
		},
	});
	return result.messages.filter((m) => m.type !== "PROGRESS");
}

function summary(messages: readonly EmittedMessage[]): string[] {
	return messages.map((m) => {
		if (m.type === "SKIP_RESULT") return `SKIP_RESULT:${m.stream}:${m.reason}`;
		if (m.type === "RECORD")
			return `RECORD:${m.stream}:${m.key}${m.op ? `:${m.op}` : ""}`;
		if (m.type === "STATE") return `STATE:${m.stream}`;
		if (m.type === "DONE") return `DONE:${m.status}`;
		return m.type;
	});
}

const good = (id: string) => ({
	op: "record",
	stream: "items",
	data: { id, title: id },
});

// ─── Through the real runtime (runConnector) ────────────────────────────

test("runtime: a shape-rejected row withholds the stream's later STATE and keeps the rows already read", async () => {
	const messages = await wire([
		good("a"),
		{ op: "record", stream: "items", data: { id: "b", bad: true } },
		good("c"),
		{ op: "emit", msg: STATE("items") },
	]);
	assert.deepEqual(summary(messages), [
		"RECORD:items:a",
		"SKIP_RESULT:items:shape_check_failed",
		"RECORD:items:c",
		`SKIP_RESULT:items:${CHECKPOINT_WITHHELD_REASON}`,
		"DONE:succeeded",
	]);
	const notice = messages.find(
		(m) => m.type === "SKIP_RESULT" && m.reason === CHECKPOINT_WITHHELD_REASON,
	);
	assert.deepEqual(
		notice?.type === "SKIP_RESULT" ? notice.recovery_hint : null,
		{ action: "retry_by_runtime", retryable: true },
	);
});

test("runtime: an uncovered row (field omission) withholds the stream's later STATE", async () => {
	const messages = await wire([
		good("a"),
		{
			op: "record",
			stream: "items",
			data: { id: "b", title: null },
			omissions: [
				{ field: "title", reason: "title: expected string, got number" },
			],
		},
		{ op: "emit", msg: STATE("items") },
	]);
	assert.deepEqual(summary(messages), [
		"RECORD:items:a",
		"SKIP_RESULT:items:record_fields_unavailable",
		`SKIP_RESULT:items:${CHECKPOINT_WITHHELD_REASON}`,
		"DONE:succeeded",
	]);
	const skip = messages[1];
	assert.deepEqual(skip?.type === "SKIP_RESULT" ? skip.diagnostics : null, {
		key: "b",
		key_enumerated: true,
		row_withheld: true,
		omissions: [
			{ field: "title", reason: "title: expected string, got number" },
		],
	});
});

test("runtime: a withheld row is never emitted in part, and its enumerated key cannot be deleted", async () => {
	const messages = await wire([
		{
			op: "record",
			stream: "items",
			data: { id: "b", title: "Stored title must survive", body: null },
			omissions: [
				{ field: "body", reason: "body: expected string, got object" },
			],
		},
		{
			op: "emit",
			msg: {
				type: "RECORD",
				stream: "items",
				key: "b",
				data: { id: "b" },
				emitted_at: "2026-10-15T00:00:00.000Z",
				op: "delete",
			},
		},
		{
			op: "emit",
			msg: {
				type: "DETAIL_COVERAGE",
				reference_only: true,
				stream: "items",
				state_stream: "items",
				required_keys: ["b"],
				hydrated_keys: ["b"],
			},
		},
	]);
	assert.deepEqual(summary(messages), [
		"SKIP_RESULT:items:record_fields_unavailable",
		`SKIP_RESULT:items:${CHECKPOINT_WITHHELD_REASON}`,
		"DETAIL_COVERAGE",
		"DONE:succeeded",
	]);
	assert.equal(
		JSON.stringify(messages).includes("Stored title must survive"),
		false,
		"no value of a withheld row reaches the wire",
	);
	const notice = messages[1];
	assert.deepEqual(notice?.type === "SKIP_RESULT" ? notice.diagnostics : null, {
		withheld: "delete",
		streams: [
			{
				stream: "items",
				refused_records: 1,
				refusal_causes: { fields_unavailable: 1 },
				skip_reasons: [],
				withheld_keys: ["b"],
			},
		],
	});
	const coverage = messages.find((m) => m.type === "DETAIL_COVERAGE");
	assert.ok(coverage?.type === "DETAIL_COVERAGE");
	assert.deepEqual(
		[coverage.required_keys, coverage.hydrated_keys],
		[["b"], []],
		"enumerated (required) but withheld (not hydrated): unaccounted, not absent",
	);
});

test("runtime: a record without an id is refused visibly and withholds STATE", async () => {
	const messages = await wire([
		{ op: "record", stream: "items", data: { title: "no id" } },
		{ op: "emit", msg: STATE("items") },
	]);
	assert.deepEqual(summary(messages), [
		"SKIP_RESULT:items:shape_check_failed",
		`SKIP_RESULT:items:${CHECKPOINT_WITHHELD_REASON}`,
		"DONE:succeeded",
	]);
});

test("runtime: a clean stream checkpoints normally", async () => {
	const messages = await wire([
		good("a"),
		good("b"),
		{ op: "emit", msg: STATE("items") },
	]);
	assert.deepEqual(summary(messages), [
		"RECORD:items:a",
		"RECORD:items:b",
		"STATE:items",
		"DONE:succeeded",
	]);
});

test("runtime: a loss in one stream does not block another stream's STATE", async () => {
	const messages = await wire(
		[
			{ op: "record", stream: "items", data: { id: "b", bad: true } },
			{ op: "record", stream: "others", data: { id: "x" } },
			{ op: "emit", msg: STATE("others") },
			{ op: "emit", msg: STATE("items") },
		],
		["items", "others"],
	);
	assert.deepEqual(summary(messages), [
		"SKIP_RESULT:items:shape_check_failed",
		"RECORD:others:x",
		"STATE:others",
		`SKIP_RESULT:items:${CHECKPOINT_WITHHELD_REASON}`,
		"DONE:succeeded",
	]);
});

test("runtime: declared bounds do not withhold STATE", async () => {
	const declaredBounds = [
		{
			type: "SKIP_RESULT",
			stream: "items",
			reason: "older_pages_deferred_page_budget",
			message: "deliberate page budget",
			recovery_hint: { action: "retry_on_connector_upgrade", retryable: false },
		},
		{
			type: "SKIP_RESULT",
			stream: "items",
			reason: "scope_not_supported",
			message: "resource filter not honored",
		},
		{
			type: "SKIP_RESULT",
			stream: "items",
			reason: "historical_backfill_pending",
			message: "next page owned by the runtime",
			recovery_hint: { action: "retry_by_runtime", retryable: true },
			continuation: {
				boundary: "b",
				slice_start: "s",
				slice_end: "e",
				considered: 1,
				covered: 1,
				remaining: true,
				owner: "runtime",
			},
		},
	];
	const runs = await Promise.all(
		declaredBounds.map((declared) =>
			wire([
				good("a"),
				{ op: "emit", msg: declared },
				{ op: "emit", msg: STATE("items") },
			]),
		),
	);
	for (const [index, messages] of runs.entries()) {
		const reason = declaredBounds[index]?.reason;
		assert.deepEqual(
			summary(messages),
			[
				"RECORD:items:a",
				`SKIP_RESULT:items:${String(reason)}`,
				"STATE:items",
				"DONE:succeeded",
			],
			String(reason),
		);
	}
});

test("runtime: a stream failure withholds STATE", async () => {
	const failed = await wire([
		good("a"),
		{ op: "fail", stream: "items" },
		{ op: "emit", msg: STATE("items") },
	]);
	assert.deepEqual(summary(failed), [
		"RECORD:items:a",
		"SKIP_RESULT:items:stream_collection_failed",
		`SKIP_RESULT:items:${CHECKPOINT_WITHHELD_REASON}`,
		"DONE:failed",
	]);
});

test("runtime: after a connector-reported retryable skip, the connector's resume STATE passes but deletes and full coverage do not", async () => {
	const messages = await wire([
		good("a"),
		{
			op: "emit",
			msg: {
				type: "SKIP_RESULT",
				stream: "items",
				reason: "source_unreadable",
				message: "page did not load",
				recovery_hint: { action: "retry_by_runtime", retryable: true },
			},
		},
		{ op: "emit", msg: STATE("items") },
		{
			op: "emit",
			msg: {
				type: "RECORD",
				stream: "items",
				key: "unseen",
				data: { id: "unseen" },
				emitted_at: "2026-10-15T00:00:00.000Z",
				op: "delete",
			},
		},
		{
			op: "emit",
			msg: {
				type: "DETAIL_COVERAGE",
				reference_only: true,
				stream: "items",
				state_stream: "items",
				required_keys: [],
				hydrated_keys: [],
				considered: 2,
				covered: 2,
			},
		},
	]);
	assert.deepEqual(summary(messages), [
		"RECORD:items:a",
		"SKIP_RESULT:items:source_unreadable",
		"STATE:items",
		`SKIP_RESULT:items:${CHECKPOINT_WITHHELD_REASON}`,
		"DETAIL_COVERAGE",
		"DONE:succeeded",
	]);
	const coverage = messages.find((m) => m.type === "DETAIL_COVERAGE");
	assert.ok(coverage?.type === "DETAIL_COVERAGE");
	assert.equal("covered" in coverage, false, "full coverage reads unknown");
});

test("runtime: deletes and full-coverage claims for an incomplete stream are withheld or corrected", async () => {
	const messages = await wire([
		good("a"),
		{ op: "record", stream: "items", data: { id: "b", bad: true } },
		{
			op: "emit",
			msg: {
				type: "RECORD",
				stream: "items",
				key: "gone",
				data: { id: "gone" },
				emitted_at: "2026-10-15T00:00:00.000Z",
				op: "delete",
			},
		},
		{
			op: "emit",
			msg: {
				type: "DETAIL_COVERAGE",
				reference_only: true,
				stream: "items",
				state_stream: "items",
				required_keys: [],
				hydrated_keys: [],
				considered: 2,
				covered: 2,
			},
		},
	]);
	assert.deepEqual(summary(messages), [
		"RECORD:items:a",
		"SKIP_RESULT:items:shape_check_failed",
		`SKIP_RESULT:items:${CHECKPOINT_WITHHELD_REASON}`,
		"DETAIL_COVERAGE",
		"DONE:succeeded",
	]);
	const coverage = messages.find((m) => m.type === "DETAIL_COVERAGE");
	assert.equal(
		coverage?.type === "DETAIL_COVERAGE" ? coverage.covered : null,
		1,
		"covered drops by the refused row, so the report reads partial",
	);
});

test("runtime: a detail stream's loss withholds its checkpoint parent's STATE", async () => {
	const messages = await wire(
		[
			{ op: "record", stream: "parents", data: { id: "p1" } },
			{ op: "record", stream: "details", data: { id: "d1", bad: true } },
			{
				op: "emit",
				msg: {
					type: "DETAIL_COVERAGE",
					reference_only: true,
					stream: "details",
					state_stream: "parents",
					required_keys: ["d1"],
					hydrated_keys: ["d1"],
				},
			},
			{ op: "emit", msg: STATE("parents") },
		],
		["parents", "details"],
	);
	assert.deepEqual(summary(messages), [
		"RECORD:parents:p1",
		"SKIP_RESULT:details:shape_check_failed",
		`SKIP_RESULT:details:${CHECKPOINT_WITHHELD_REASON}`,
		"DETAIL_COVERAGE",
		`SKIP_RESULT:parents:${CHECKPOINT_WITHHELD_REASON}`,
		"DONE:succeeded",
	]);
	const coverage = messages.find((m) => m.type === "DETAIL_COVERAGE");
	assert.deepEqual(
		coverage?.type === "DETAIL_COVERAGE" ? coverage.hydrated_keys : null,
		[],
		"the refused key is unaccounted, not hydrated",
	);
});

// ─── The rule itself (pure) ─────────────────────────────────────────────

test("a STATE taken before the loss passes; only later completion claims are withheld", () => {
	const integrity = createStreamIntegrity();
	assert.deepEqual(integrity.gate(STATE("items")), [STATE("items")]);
	integrity.refuseRecord("items", "b", "shape_check_failed");
	const first = integrity.gate(STATE("items"));
	assert.equal(first.length, 1);
	assert.equal(first[0]?.type, "SKIP_RESULT");
	assert.deepEqual(
		integrity.gate(STATE("items")),
		[],
		"one notice per stream; later STATEs are dropped quietly",
	);
	assert.deepEqual(integrity.withheldStreams(), ["items"]);
});

test("a DETAIL_GAP is accounted, not a loss, and names the checkpoint parent", () => {
	const integrity = createStreamIntegrity();
	const gap: EmittedMessage = {
		type: "DETAIL_GAP",
		reference_only: true,
		status: "pending",
		retryable: true,
		reason: "temporary_unavailable",
		stream: "details",
		parent_stream: "parents",
		record_key: "d1",
		detail_locator: { kind: "id", id: "d1" },
	};
	assert.deepEqual(integrity.gate(gap), [gap]);
	assert.deepEqual(integrity.gate(STATE("parents")), [STATE("parents")]);
	integrity.refuseRecord("details", "d2", "fields_unavailable");
	assert.equal(integrity.gate(STATE("parents"))[0]?.type, "SKIP_RESULT");
});

test("after a connector-reported skip, a full-scan coverage claim reads unknown", () => {
	const integrity = createStreamIntegrity();
	integrity.gate({
		type: "SKIP_RESULT",
		stream: "items",
		reason: "rate_limited",
		message: "throttled",
	});
	const out = integrity.gate({
		type: "DETAIL_COVERAGE",
		reference_only: true,
		stream: "items",
		state_stream: "items",
		required_keys: [],
		hydrated_keys: [],
		considered: 3,
		covered: 3,
	});
	const coverage = out.find((m) => m.type === "DETAIL_COVERAGE");
	assert.ok(coverage?.type === "DETAIL_COVERAGE");
	assert.equal("considered" in coverage, false);
	assert.equal("covered" in coverage, false);
});

test("coverage a connector already corrected for a refused row is left unchanged", () => {
	const integrity = createStreamIntegrity();
	integrity.refuseRecord("items", "b", "fields_unavailable");
	const out = integrity.gate({
		type: "DETAIL_COVERAGE",
		reference_only: true,
		stream: "items",
		state_stream: "items",
		required_keys: [],
		hydrated_keys: [],
		considered: 3,
		covered: 2,
	});
	const coverage = out.find((m) => m.type === "DETAIL_COVERAGE");
	assert.equal(
		coverage?.type === "DETAIL_COVERAGE" ? coverage.covered : null,
		2,
	);
});

test("after a connector-reported skip, an honest partial coverage report is left alone and needs no notice", () => {
	const integrity = createStreamIntegrity();
	integrity.gate({
		type: "SKIP_RESULT",
		stream: "items",
		reason: "page_read_failed",
		message: "x",
	});
	const partial: EmittedMessage = {
		type: "DETAIL_COVERAGE",
		reference_only: true,
		stream: "items",
		state_stream: "items",
		required_keys: [],
		hydrated_keys: [],
		considered: 1,
		covered: 0,
	};
	assert.deepEqual(integrity.gate(partial), [partial]);
	assert.deepEqual(integrity.withheldStreams(), []);
});

test("STREAM_EVIDENCE moves refused records from emitted to unaccounted", () => {
	const integrity = createStreamIntegrity();
	integrity.refuseRecord("items", "b", "shape_check_failed");
	const out = integrity.gate({
		type: "STREAM_EVIDENCE",
		reference_only: true,
		stream: "items",
		considered: 2,
		outcomes: { emitted: 2, unchanged: 0, gapped: 0, unaccounted: 0 },
	});
	const evidence = out.find((m) => m.type === "STREAM_EVIDENCE");
	assert.deepEqual(
		evidence?.type === "STREAM_EVIDENCE" ? evidence.outcomes : null,
		{ emitted: 1, unchanged: 0, gapped: 0, unaccounted: 1 },
	);
});
