// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { EmittedMessage } from "@pdpp/connector-protocol";
import { buildRow, readField, v } from "./field-reader.ts";
import {
	CHECKPOINT_WITHHELD_REASON,
	createStreamIntegrity,
	declaredBoundSkip,
	resumeSafeSkip,
} from "./stream-integrity.ts";
import { runConnectorProtocolSubprocess } from "./test-harness.ts";

const STATE = (stream: string): EmittedMessage => ({
	type: "STATE",
	stream,
	cursor: { complete: true },
});

/** Run the fixture connector through the real runtime and return the wire, minus PROGRESS. */
type StreamRequest =
	| string
	| { name: string; time_range?: { since?: string; until?: string } };

async function wire(
	steps: unknown[],
	streams: StreamRequest[] = ["items"],
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
			scope: {
				streams: streams.map((stream) =>
					typeof stream === "string" ? { name: stream } : stream,
				),
			},
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
				undeclared_skip_reasons: [],
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

const PAGE_BUDGET = {
	type: "SKIP_RESULT",
	stream: "items",
	reason: "older_pages_deferred_page_budget",
	message: "deliberate page budget",
	recovery_hint: { action: "retry_on_connector_upgrade", retryable: false },
} as const;

const RUNTIME_CONTINUATION = {
	type: "SKIP_RESULT",
	stream: "items",
	reason: "historical_backfill_pending",
	message: "next page owned by the runtime",
	recovery_hint: { action: "retry_by_runtime", retryable: true },
	continuation: {
		boundary: "b",
		slice_start: 0,
		slice_end: 1,
		considered: 1,
		covered: 1,
		remaining: true,
		owner: "runtime",
	},
} as const;

test("runtime: only typed declarations let STATE pass after a skip", async () => {
	const passing = [
		{
			type: "SKIP_RESULT",
			stream: "items",
			reason: "scope_not_supported",
			message: "resource filter not honored",
		},
		declaredBoundSkip(PAGE_BUDGET, "configured_limit"),
		resumeSafeSkip(RUNTIME_CONTINUATION, "cursor_at_or_before_loss"),
	];
	const runs = await Promise.all(
		passing.map((declared) =>
			wire([
				good("a"),
				{ op: "emit", msg: declared },
				{ op: "emit", msg: STATE("items") },
			]),
		),
	);
	for (const [index, messages] of runs.entries()) {
		const reason = passing[index]?.reason;
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

test("runtime: retryable:false alone, a bare continuation, or an unknown bound is no declaration", async () => {
	const undeclared = [
		PAGE_BUDGET,
		RUNTIME_CONTINUATION,
		{ ...PAGE_BUDGET, diagnostics: { declared_bound: "because" } },
	];
	const runs = await Promise.all(
		undeclared.map((skip) =>
			wire([
				good("a"),
				{ op: "emit", msg: skip },
				{ op: "emit", msg: STATE("items") },
			]),
		),
	);
	for (const [index, messages] of runs.entries()) {
		const reason = undeclared[index]?.reason;
		assert.deepEqual(
			summary(messages),
			[
				"RECORD:items:a",
				`SKIP_RESULT:items:${String(reason)}`,
				`SKIP_RESULT:items:${CHECKPOINT_WITHHELD_REASON}`,
				"DONE:succeeded",
			],
			String(index),
		);
	}
});

test("a declared bound still blocks deletes and full-coverage claims", () => {
	const integrity = createStreamIntegrity();
	integrity.gate(declaredBoundSkip(PAGE_BUDGET, "configured_limit"));
	assert.deepEqual(integrity.gate(STATE("items")), [STATE("items")]);
	const out = integrity.gate({
		type: "RECORD",
		stream: "items",
		key: "unseen",
		data: { id: "unseen" },
		emitted_at: "2026-10-15T00:00:00.000Z",
		op: "delete",
	});
	assert.deepEqual(
		out.map((m) => (m.type === "SKIP_RESULT" ? m.reason : m.type)),
		[CHECKPOINT_WITHHELD_REASON],
	);
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

const SOURCE_UNREADABLE = {
	type: "SKIP_RESULT",
	stream: "items",
	reason: "source_unreadable",
	message: "page did not load",
	recovery_hint: { action: "retry_by_runtime", retryable: true },
} as const;

test("runtime: a reported retryable skip without a resume-safe declaration withholds STATE", async () => {
	const messages = await wire([
		good("a"),
		{ op: "emit", msg: SOURCE_UNREADABLE },
		{ op: "emit", msg: STATE("items") },
	]);
	assert.deepEqual(summary(messages), [
		"RECORD:items:a",
		"SKIP_RESULT:items:source_unreadable",
		`SKIP_RESULT:items:${CHECKPOINT_WITHHELD_REASON}`,
		"DONE:succeeded",
	]);
});

test("runtime: a declared resume-safe skip lets the connector's STATE pass, but not deletes or full coverage", async () => {
	const messages = await wire([
		good("a"),
		{
			op: "emit",
			msg: resumeSafeSkip(SOURCE_UNREADABLE, "cursor_at_or_before_loss"),
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
		`SKIP_RESULT:items:${CHECKPOINT_WITHHELD_REASON}`,
		"DETAIL_COVERAGE",
		"DONE:succeeded",
	]);
	const skip = messages[1];
	assert.deepEqual(
		skip?.type === "SKIP_RESULT" ? skip.diagnostics : null,
		{ resume_safe: "cursor_at_or_before_loss" },
		"the declaration is visible on the wire",
	);
	const coverage = messages.find((m) => m.type === "DETAIL_COVERAGE");
	assert.ok(coverage?.type === "DETAIL_COVERAGE");
	assert.equal("covered" in coverage, false, "full coverage reads unknown");
});

test("runtime: an unknown resume-safe basis is no declaration", async () => {
	const messages = await wire([
		{
			op: "emit",
			msg: {
				...SOURCE_UNREADABLE,
				diagnostics: { resume_safe: "trust_me" },
			},
		},
		{ op: "emit", msg: STATE("items") },
	]);
	assert.deepEqual(summary(messages), [
		"SKIP_RESULT:items:source_unreadable",
		`SKIP_RESULT:items:${CHECKPOINT_WITHHELD_REASON}`,
		"DONE:succeeded",
	]);
});

test("runtime: a refused recovery cannot retire its durable gap", async () => {
	const recovered = (key: string) => ({
		op: "emit",
		msg: {
			type: "DETAIL_GAP_RECOVERED",
			reference_only: true,
			stream: "items",
			gap_id: `gap-${key}`,
			record_key: key,
		},
	});
	const messages = await wire([
		// Recovery of K fetched a row the schema rejects; of L, a row it accepts.
		{ op: "record", stream: "items", data: { id: "K", bad: true } },
		recovered("K"),
		good("L"),
		recovered("L"),
		{
			op: "record",
			stream: "items",
			data: { id: "M", title: null },
			omissions: [
				{ field: "title", reason: "title: expected string, got number" },
			],
		},
		recovered("M"),
	]);
	assert.deepEqual(summary(messages), [
		"SKIP_RESULT:items:shape_check_failed",
		`SKIP_RESULT:items:${CHECKPOINT_WITHHELD_REASON}`,
		"RECORD:items:L",
		"DETAIL_GAP_RECOVERED",
		"SKIP_RESULT:items:record_fields_unavailable",
		"DONE:succeeded",
	]);
	const receipts = messages.filter((m) => m.type === "DETAIL_GAP_RECOVERED");
	assert.deepEqual(
		receipts.map((m) =>
			m.type === "DETAIL_GAP_RECOVERED" ? m.record_key : null,
		),
		["L"],
		"K and M stay pending; only the stored recovery is receipted",
	);
});

test("runtime: a withheld row's diagnostics carry no source value, enum members included", async () => {
	const SENTINEL = "PRIVATE-SENTINEL-7f3a";
	const source = {
		id: "row-1",
		kind: SENTINEL,
		link: `ftp://${SENTINEL}.example/x`,
		tags: ["ok", SENTINEL],
		title: SENTINEL,
	};
	const row = buildRow({
		id: readField(source, "id", v.string({ nonEmpty: true })),
		kind: readField(source, "kind", v.enumOf(["album", "playlist"])),
		link: readField(source, "link", v.url()),
		tags: readField(source, "tags", v.arrayOf(v.enumOf(["ok"]))),
		title: readField(source, "title", v.string()),
	});
	assert.equal(row.covered, false);
	const messages = await wire([
		{
			op: "record",
			stream: "items",
			data: { id: "row-1" },
			omissions: row.covered ? [] : row.omissions,
		},
	]);
	assert.deepEqual(summary(messages), [
		"SKIP_RESULT:items:record_fields_unavailable",
		"DONE:succeeded",
	]);
	assert.equal(
		JSON.stringify(messages).includes(SENTINEL),
		false,
		"the wire names fields and expected shapes only",
	);
	const skip = messages[0];
	assert.deepEqual(skip?.type === "SKIP_RESULT" ? skip.diagnostics : null, {
		key: "row-1",
		key_enumerated: true,
		row_withheld: true,
		omissions: [
			{ field: "kind", reason: "kind: not one of the expected values" },
			{ field: "link", reason: "link: URL protocol not allowed" },
			{ field: "tags", reason: "tags: [1]: not one of the expected values" },
		],
	});
});

test("runtime: a malformed row provably outside the time range does not starve the in-range checkpoint", async () => {
	const since = { since: "2026-10-01T00:00:00Z" };
	const oldBadRow = {
		op: "record",
		stream: "items",
		data: { id: "old", updated_at: "2026-09-01T00:00:00Z", title: null },
		omissions: [
			{ field: "title", reason: "title: expected string, got number" },
		],
	};
	const inRange = {
		op: "record",
		stream: "items",
		data: { id: "new", updated_at: "2026-10-10T00:00:00Z", title: "t" },
	};
	const allowed = await wire(
		[oldBadRow, inRange, { op: "emit", msg: STATE("items") }],
		[{ name: "items", time_range: since }],
	);
	assert.deepEqual(summary(allowed), [
		"RECORD:items:new",
		"STATE:items",
		"DONE:succeeded",
	]);

	// Fail closed when the time itself is unreadable, or the row is in range.
	const unreadableTime = await wire(
		[
			{
				...oldBadRow,
				data: { id: "old", updated_at: null, title: null },
				omissions: [
					{ field: "updated_at", reason: "updated_at: not an ISO 8601 date" },
				],
			},
			inRange,
			{ op: "emit", msg: STATE("items") },
		],
		[{ name: "items", time_range: since }],
	);
	assert.deepEqual(summary(unreadableTime), [
		"SKIP_RESULT:items:record_fields_unavailable",
		"RECORD:items:new",
		`SKIP_RESULT:items:${CHECKPOINT_WITHHELD_REASON}`,
		"DONE:succeeded",
	]);
	const inRangeBad = await wire(
		[
			{
				...oldBadRow,
				data: { id: "mid", updated_at: "2026-10-05T00:00:00Z", title: null },
			},
			{ op: "emit", msg: STATE("items") },
		],
		[{ name: "items", time_range: since }],
	);
	assert.deepEqual(summary(inRangeBad), [
		"SKIP_RESULT:items:record_fields_unavailable",
		`SKIP_RESULT:items:${CHECKPOINT_WITHHELD_REASON}`,
		"DONE:succeeded",
	]);
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

test("STREAM_EVIDENCE: a refusal the connector could not see moves out of emitted even when other rows are already unaccounted", () => {
	// A was never retrieved (connector reports it unaccounted); B was handed to
	// emitRecord and refused by the schema (connector counted it emitted).
	const integrity = createStreamIntegrity();
	integrity.refuseRecord("items", "B", "shape_check_failed");
	const out = integrity.gate({
		type: "STREAM_EVIDENCE",
		reference_only: true,
		stream: "items",
		considered: 2,
		outcomes: { emitted: 1, unchanged: 0, gapped: 0, unaccounted: 1 },
	});
	const evidence = out.find((m) => m.type === "STREAM_EVIDENCE");
	assert.deepEqual(
		evidence?.type === "STREAM_EVIDENCE" ? evidence.outcomes : null,
		{ emitted: 0, unchanged: 0, gapped: 0, unaccounted: 2 },
	);
});

test("STREAM_EVIDENCE and coverage: a row the connector withheld itself is not subtracted twice", () => {
	const integrity = createStreamIntegrity();
	integrity.refuseRecord("items", "B", "fields_unavailable");
	const evidence: EmittedMessage = {
		type: "STREAM_EVIDENCE",
		reference_only: true,
		stream: "items",
		considered: 2,
		outcomes: { emitted: 1, unchanged: 0, gapped: 0, unaccounted: 1 },
	};
	assert.deepEqual(integrity.gate(evidence), [evidence]);
	const coverage: EmittedMessage = {
		type: "DETAIL_COVERAGE",
		reference_only: true,
		stream: "items",
		state_stream: "items",
		required_keys: [],
		hydrated_keys: [],
		considered: 2,
		covered: 1,
	};
	assert.deepEqual(integrity.gate(coverage), [coverage]);
});

test("coverage: after a refusal the report can never read complete, and a connector that already excluded the row is exact", () => {
	const integrity = createStreamIntegrity();
	integrity.refuseRecord("items", "B", "shape_check_failed");
	const claimFull = integrity.gate({
		type: "DETAIL_COVERAGE",
		reference_only: true,
		stream: "items",
		state_stream: "items",
		required_keys: [],
		hydrated_keys: [],
		considered: 2,
		covered: 2,
	});
	const full = claimFull.find((m) => m.type === "DETAIL_COVERAGE");
	assert.equal(full?.type === "DETAIL_COVERAGE" ? full.covered : null, 1);
	const preValidated: EmittedMessage = {
		type: "DETAIL_COVERAGE",
		reference_only: true,
		stream: "items",
		state_stream: "items",
		required_keys: [],
		hydrated_keys: [],
		considered: 2,
		covered: 1,
	};
	assert.deepEqual(integrity.gate(preValidated), [preValidated]);
});
