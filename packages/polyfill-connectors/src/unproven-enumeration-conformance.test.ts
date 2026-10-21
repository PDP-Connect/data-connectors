// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Collection Profile §5.5 and §5.8: a stream whose enumeration the connector
 * could not prove complete is reported as exactly one thing on the wire, a
 * SKIP_RESULT with `reason: "stream_collection_failed"`, and the run ends
 * with failed DONE whose `error.code` is `stream_collection_failed`. A runtime
 * certifies a stream-scoped failure (and so preserves the unaffected streams)
 * only from those two facts.
 *
 * Connectors describe the unproven enumeration with their own cause
 * (`inventory_not_proven_complete`, `linkedin_enumeration_unproven`). These
 * tests drive the real runtime as a subprocess and read only what reaches
 * stdout.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { EmittedMessage } from "@pdpp/connector-protocol";
import { runConnectorProtocolSubprocess } from "./test-harness.ts";

const FIXTURE = fileURLToPath(
	new URL("./__fixtures__/unproven-enumeration-connector.ts", import.meta.url),
);

type Skip = Extract<EmittedMessage, { type: "SKIP_RESULT" }>;
type Done = Extract<EmittedMessage, { type: "DONE" }>;

async function wire(
	streams: readonly string[],
	messages: readonly unknown[],
): Promise<{ code: number | null; messages: EmittedMessage[] }> {
	const result = await runConnectorProtocolSubprocess({
		allowFailedDone: true,
		cwd: fileURLToPath(new URL("../../..", import.meta.url)),
		entrypoint: FIXTURE,
		env: { PDPP_TEST_MESSAGES: JSON.stringify(messages) },
		start: {
			scope: { streams: streams.map((name) => ({ name })) },
			type: "START",
		},
	});
	return { code: result.code, messages: result.messages };
}

const skips = (messages: readonly EmittedMessage[]): Skip[] =>
	messages.filter((m): m is Skip => m.type === "SKIP_RESULT");

const doneOf = (messages: readonly EmittedMessage[]): Done => {
	const done = messages.find((m): m is Done => m.type === "DONE");
	assert.ok(done, "run ended without DONE");
	return done;
};

for (const cause of [
	"inventory_not_proven_complete",
	"linkedin_enumeration_unproven",
]) {
	test(`${cause}: an unproven enumeration reaches the wire as exactly the portable reason and code`, async () => {
		const { code, messages } = await wire(
			["orders", "profile"],
			[
				{ type: "STATE", stream: "profile", cursor: { done: true } },
				{
					type: "SKIP_RESULT",
					stream: "orders",
					reason: cause,
					message: "The source stopped before the end of the list.",
					recovery_hint: { action: "retry_by_runtime", retryable: true },
					diagnostics: { source_reason: "icloud_omitted_rows", rows_seen: 3 },
				},
			],
		);

		const orders = skips(messages).filter((m) => m.stream === "orders");
		assert.equal(orders.length, 1, "one SKIP_RESULT for the failed stream");
		assert.equal(orders[0]?.reason, "stream_collection_failed");
		assert.equal(
			orders[0]?.message,
			"The source stopped before the end of the list.",
		);
		assert.deepEqual(orders[0]?.recovery_hint, {
			action: "retry_by_runtime",
			retryable: true,
		});
		assert.deepEqual(orders[0]?.diagnostics, {
			source_reason: "icloud_omitted_rows",
			rows_seen: 3,
			original_reason: cause,
		});
		assert.equal(
			messages.some((m) => m.type === "SKIP_RESULT" && m.reason === cause),
			false,
			"the connector-specific reason must not reach the wire",
		);

		const done = doneOf(messages);
		assert.equal(done.status, "failed");
		assert.equal(done.error?.code, "stream_collection_failed");
		assert.equal(done.error?.retryable, true);
		assert.equal(code, 1, "failed DONE exits non-zero");

		assert.deepEqual(
			messages.filter((m) => m.type === "STATE"),
			[{ type: "STATE", stream: "profile", cursor: { done: true } }],
			"the unaffected stream's checkpoint is still emitted",
		);
	});
}

test("every unproven stream gets its own portable SKIP_RESULT, and retryability follows the hint", async () => {
	const { messages } = await wire(
		["a", "b"],
		[
			{
				type: "SKIP_RESULT",
				stream: "a",
				reason: "inventory_not_proven_complete",
				message: "a unproven",
				recovery_hint: {
					action: "retry_on_connector_upgrade",
					retryable: false,
				},
			},
			{
				type: "SKIP_RESULT",
				stream: "b",
				reason: "inventory_not_proven_complete",
				message: "b unproven",
				recovery_hint: { action: "retry_by_runtime", retryable: true },
			},
		],
	);
	assert.deepEqual(
		skips(messages).map((m) => `${m.stream}:${m.reason}`),
		["a:stream_collection_failed", "b:stream_collection_failed"],
	);
	const done = doneOf(messages);
	assert.equal(done.status, "failed");
	assert.equal(done.error?.code, "stream_collection_failed");
	assert.equal(
		done.error?.retryable,
		false,
		"the first reported failure decides, as with reportStreamFailure",
	);
});

test("a skip that is not an unproven enumeration passes through and the run still succeeds", async () => {
	const { code, messages } = await wire(
		["orders"],
		[
			{
				type: "SKIP_RESULT",
				stream: "orders",
				reason: "rows_unreadable",
				message: "Some rows could not be read.",
			},
		],
	);
	assert.deepEqual(
		skips(messages).map((m) => m.reason),
		["rows_unreadable"],
	);
	assert.equal(doneOf(messages).status, "succeeded");
	assert.equal(code, 0);
});

// The runtime's browser cleanup must agree with the terminal result: a run that
// ends failed because of a reported stream failure keeps its failure evidence.
async function browserRun(
	messages: readonly unknown[],
): Promise<{ done: Done; captureRuns: string[] }> {
	const root = mkdtempSync(join(tmpdir(), "unproven-enumeration-capture-"));
	try {
		const result = await runConnectorProtocolSubprocess({
			allowFailedDone: true,
			cwd: fileURLToPath(new URL("../../..", import.meta.url)),
			entrypoint: fileURLToPath(
				new URL(
					"./__fixtures__/unproven-enumeration-browser-connector.ts",
					import.meta.url,
				),
			),
			env: {
				PDPP_BROWSER_HEADLESS: "1",
				PDPP_BROWSER_SURFACE_REMOTE_CDP_URL: undefined,
				PDPP_BROWSER_SURFACE_REQUIRED: undefined,
				PDPP_CAPTURE_FIXTURES: undefined,
				PDPP_CAPTURE_ON_FAILURE: "1",
				PDPP_CAPTURE_ROOT_DIR: root,
				PDPP_TEST_MESSAGES: JSON.stringify(messages),
			},
			start: { scope: { streams: [{ name: "s" }] }, type: "START" },
			timeoutMs: 90_000,
		});
		const connectorRoot = join(
			root,
			"unproven-enumeration-browser-fixture",
			"raw",
		);
		return {
			captureRuns: existsSync(connectorRoot) ? readdirSync(connectorRoot) : [],
			done: doneOf(result.messages),
		};
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
}

test("a browser run that reports an unproven enumeration keeps its failure capture", async () => {
	const unproven = await browserRun([
		{
			type: "SKIP_RESULT",
			stream: "s",
			reason: "inventory_not_proven_complete",
			message: "The source stopped before the end of the list.",
			recovery_hint: { action: "retry_by_runtime", retryable: true },
		},
	]);
	assert.equal(unproven.done.status, "failed");
	assert.equal(unproven.done.error?.code, "stream_collection_failed");
	assert.equal(
		unproven.captureRuns.length,
		1,
		"the failed run's raw capture is retained",
	);

	const clean = await browserRun([]);
	assert.equal(clean.done.status, "succeeded");
	assert.deepEqual(
		clean.captureRuns,
		[],
		"a clean run's raw capture is deleted, so the difference above is the failure policy",
	);
});
