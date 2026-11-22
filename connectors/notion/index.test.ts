// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import type { EmittedMessage } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { buildFullScanCoverageMessage } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { runConnectorProtocolSubprocess } from "../../packages/polyfill-connectors/src/test-harness.ts";
import { databasesSchema } from "./schemas.ts";

const toyDatabaseMetadata = {
	id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
	title: "Invented table",
	parent_type: null,
	parent_id: null,
	url: null,
	archived: null,
	created_time: null,
	last_edited_time: null,
	property_names: [],
};

test("Notion database metadata preserves dashed and compact ID spellings", () => {
	for (const id of [
		toyDatabaseMetadata.id,
		toyDatabaseMetadata.id.replaceAll("-", ""),
	]) {
		assert.equal(databasesSchema.parse({ ...toyDatabaseMetadata, id }).id, id);
	}
});

test("Notion database metadata preserves property label order and Unicode", () => {
	const labels = ["Zebra", "Café", "alpha"];
	const row = databasesSchema.parse({
		...toyDatabaseMetadata,
		property_names: labels,
	});
	assert.deepEqual(row.property_names, labels);
});

test("Notion full-scan coverage records the enumerated boundary, including empty", () => {
	assert.deepEqual(buildFullScanCoverageMessage("pages", 0), {
		type: "DETAIL_COVERAGE",
		reference_only: true,
		stream: "pages",
		state_stream: "pages",
		required_keys: [],
		hydrated_keys: [],
		considered: 0,
		covered: 0,
	});
	assert.deepEqual(buildFullScanCoverageMessage("databases", 162), {
		type: "DETAIL_COVERAGE",
		reference_only: true,
		stream: "databases",
		state_stream: "databases",
		required_keys: [],
		hydrated_keys: [],
		considered: 162,
		covered: 162,
	});
});

import {
	connectorEntrypoint,
	packageRoot as PACKAGE_ROOT,
} from "../../packages/polyfill-connectors/src/connector-paths.ts";

const ENTRYPOINT = connectorEntrypoint("notion");
const PAGE_ID = "11111111-1111-4111-8111-111111111111";
const DATABASE_ID = "22222222-2222-4222-8222-222222222222";
const ACTOR_ID = "33333333-3333-4333-8333-333333333333";

function protocolMessagesFor(
	messages: readonly EmittedMessage[],
	type: EmittedMessage["type"],
): EmittedMessage[] {
	return messages.filter((message) => message.type === type);
}

function lastDone(
	messages: readonly EmittedMessage[],
): Extract<EmittedMessage, { type: "DONE" }> {
	const done = messages.findLast(
		(message): message is Extract<EmittedMessage, { type: "DONE" }> =>
			message.type === "DONE",
	);
	assert.ok(done, "connector emits DONE");
	return done;
}

async function runRealNotionConnector(
	mode: "complete" | "provider_failure" | "contradictory_pagination",
) {
	const harnessDir = await mkdtemp(join(tmpdir(), "pdpp-notion-protocol-"));
	const wrapperPath = join(harnessDir, "notion-wrapper.mjs");
	const entrypointUrl = pathToFileURL(ENTRYPOINT).href;
	await writeFile(
		wrapperPath,
		`
const mode = ${JSON.stringify(mode)};
globalThis.fetch = async (_input, init) => {
  if (mode === "provider_failure") {
    return new Response(JSON.stringify({ message: "bounded mock provider failure" }), { status: 503 });
  }
  const body = JSON.parse(init?.body ?? "{}");
  const object = body.filter?.value;
  const isPage = object === "page";
  if (mode === "contradictory_pagination" && isPage) {
    return new Response(JSON.stringify({
      has_more: true,
      next_cursor: null,
      results: []
    }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return new Response(JSON.stringify({
    has_more: false,
    next_cursor: null,
    results: isPage
      ? [
          {
            id: ${JSON.stringify(PAGE_ID)},
            object: "page",
            parent: { type: "workspace", workspace: true },
            properties: { Name: { type: "title", title: [{ plain_text: "Bounded page" }] } },
            url: "https://www.notion.so/${PAGE_ID}",
            archived: false,
            created_time: "2026-08-12T00:00:00.000Z",
            last_edited_time: "2026-08-12T01:00:00.000Z",
            created_by: { id: ${JSON.stringify(ACTOR_ID)} },
            last_edited_by: { id: ${JSON.stringify(ACTOR_ID)} }
          },
          {
            id: "44444444-4444-4444-8444-444444444444",
            object: "page",
            parent: { type: "workspace", workspace: true },
            properties: { Name: { type: "title", title: [{ plain_text: "Second bounded page" }] } },
            url: "https://www.notion.so/44444444444444444444444444444444",
            archived: false,
            created_time: "2026-08-11T00:00:00.000Z",
            last_edited_time: "2026-08-11T01:00:00.000Z",
            created_by: { id: ${JSON.stringify(ACTOR_ID)} },
            last_edited_by: { id: ${JSON.stringify(ACTOR_ID)} }
          }
        ]
      : [
          {
            id: ${JSON.stringify(DATABASE_ID)},
            object: "database",
            parent: { type: "workspace", workspace: true },
            title: [{ plain_text: "Bounded database" }],
            properties: { Name: { type: "title" } },
            url: "https://www.notion.so/${DATABASE_ID}",
            archived: false,
            created_time: "2026-08-10T00:00:00.000Z",
            last_edited_time: "2026-08-10T01:00:00.000Z"
          }
        ]
  }), { status: 200, headers: { "content-type": "application/json" } });
};
await import(${JSON.stringify(entrypointUrl)});
`,
		"utf8",
	);

	try {
		return await runConnectorProtocolSubprocess({
			allowFailedDone: mode !== "complete",
			cwd: PACKAGE_ROOT,
			entrypoint: wrapperPath,
			env: { NOTION_API_TOKEN: "bounded-test-token" },
			start: {
				scope: { streams: [{ name: "pages" }, { name: "databases" }] },
				state: {},
				type: "START",
			},
		});
	} finally {
		await rm(harnessDir, { force: true, recursive: true });
	}
}

test("real Notion connector fails closed when has_more is true without a cursor", async () => {
	const result = await runRealNotionConnector("contradictory_pagination");
	assert.equal(
		result.code,
		1,
		"a contradictory pagination response fails the run",
	);
	assert.equal(
		protocolMessagesFor(result.messages, "DETAIL_COVERAGE").length,
		0,
	);
	assert.equal(protocolMessagesFor(result.messages, "STATE").length, 0);
	assert.equal(lastDone(result.messages).status, "failed");
});

test("real Notion connector protocol emits coverage and STATE after complete pages/databases enumeration", async () => {
	const result = await runRealNotionConnector("complete");
	assert.equal(result.code, 0);

	const coverages = protocolMessagesFor(result.messages, "DETAIL_COVERAGE");
	const states = protocolMessagesFor(result.messages, "STATE");
	for (const [stream, considered] of [
		["pages", 2],
		["databases", 1],
	] as const) {
		const coverage = coverages.find(
			(message) =>
				message.type === "DETAIL_COVERAGE" && message.stream === stream,
		);
		assert.ok(
			coverage && coverage.type === "DETAIL_COVERAGE",
			`${stream} DETAIL_COVERAGE is on the wire`,
		);
		assert.equal(coverage.state_stream, stream);
		assert.equal(coverage.considered, considered);
		assert.equal(coverage.covered, considered);
		assert.deepEqual(coverage.required_keys, []);
		assert.deepEqual(coverage.hydrated_keys, []);

		const state = states.find(
			(message) => message.type === "STATE" && message.stream === stream,
		);
		assert.ok(
			state && state.type === "STATE",
			`${stream} STATE is on the wire`,
		);
		assert.ok(state.cursor && typeof state.cursor === "object");
	}
	assert.equal(
		lastDone(result.messages).status,
		"succeeded",
		"complete enumeration succeeds",
	);
});

test("real Notion connector protocol emits no coverage proof or STATE when provider enumeration fails", async () => {
	const result = await runRealNotionConnector("provider_failure");
	assert.equal(
		result.code,
		1,
		"failed connector exits with its normal failed-run status",
	);
	assert.equal(
		protocolMessagesFor(result.messages, "DETAIL_COVERAGE").length,
		0,
	);
	assert.equal(protocolMessagesFor(result.messages, "STATE").length, 0);
	assert.equal(lastDone(result.messages).status, "failed");
});

const fictionalSummary = {
	id: "00000000-0000-4000-8000-000000000001",
	parent_type: null,
	parent_id: null,
	title: "Fixture notebook",
	url: null,
	archived: null,
	created_time: null,
	last_edited_time: "2026-10-01T12:00:00.000Z",
};

test("Notion page validation identifies a malformed edit timestamp", async () => {
	const { validateRecord } = await import("./schemas.ts");
	const page = {
		...fictionalSummary,
		object: "page",
		created_by_id: null,
		last_edited_by_id: null,
	};
	assert.ok(validateRecord("pages", page).ok);

	const result = validateRecord("pages", {
		...page,
		last_edited_time: "not-a-timestamp",
	});
	if (result.ok) assert.fail("expected malformed timestamp to be rejected");
	assert.deepEqual(
		result.issues.map((issue) => issue.path),
		["last_edited_time"],
	);
});

test("Notion database validation identifies a scalar property-name list", async () => {
	const { validateRecord } = await import("./schemas.ts");
	const database = { ...fictionalSummary, property_names: ["Fixture column"] };
	assert.ok(validateRecord("databases", database).ok);

	const result = validateRecord("databases", {
		...database,
		property_names: "Fixture column",
	});
	if (result.ok) assert.fail("expected scalar property names to be rejected");
	assert.deepEqual(
		result.issues.map((issue) => issue.path),
		["property_names"],
	);
});
