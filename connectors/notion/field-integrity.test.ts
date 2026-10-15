// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Notion is the reference connector for the shared field reader and the
 * runtime's stream integrity rule. A page whose fields cannot be read is
 * withheld, never stored with substitute values, and the stream's STATE is
 * withheld with it, so the next run reads the page again instead of moving
 * the cursor past it.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
	connectorEntrypoint,
	packageRoot as PACKAGE_ROOT,
} from "../../packages/polyfill-connectors/src/connector-paths.ts";
import type { EmittedMessage } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { runConnectorProtocolSubprocess } from "../../packages/polyfill-connectors/src/test-harness.ts";
import { databaseRow, pageRow } from "./records.ts";
import { validateRecord } from "./schemas.ts";

const ENTRYPOINT = connectorEntrypoint("notion");
const OLD_ID = "11111111-1111-4111-8111-111111111111";
const NEW_ID = "44444444-4444-4444-8444-444444444444";
const BLOCK_ID = "66666666-6666-4666-8666-666666666666";
const ACTOR_ID = "33333333-3333-4333-8333-333333333333";

function page(
	id: string,
	edited: string,
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		id,
		object: "page",
		parent: { type: "workspace", workspace: true },
		properties: { Name: { type: "title", title: [{ plain_text: "Fine" }] } },
		url: `https://www.notion.so/${id.replace(/-/g, "")}`,
		archived: false,
		created_time: "2026-08-12T00:00:00.000Z",
		last_edited_time: edited,
		created_by: { id: ACTOR_ID },
		last_edited_by: { id: ACTOR_ID },
		...overrides,
	};
}

async function runWithPages(
	pages: readonly unknown[],
): Promise<EmittedMessage[]> {
	const harnessDir = await mkdtemp(join(tmpdir(), "pdpp-notion-fields-"));
	const wrapperPath = join(harnessDir, "notion-wrapper.mjs");
	await writeFile(
		wrapperPath,
		`
globalThis.fetch = async (_input, init) => {
  const body = JSON.parse(init?.body ?? "{}");
  const isPage = body.filter?.value === "page";
  return new Response(JSON.stringify({
    has_more: false,
    next_cursor: null,
    results: isPage ? ${JSON.stringify(pages)} : []
  }), { status: 200, headers: { "content-type": "application/json" } });
};
await import(${JSON.stringify(pathToFileURL(ENTRYPOINT).href)});
`,
		"utf8",
	);
	try {
		const result = await runConnectorProtocolSubprocess({
			cwd: PACKAGE_ROOT,
			entrypoint: wrapperPath,
			env: { NOTION_API_TOKEN: "bounded-test-token" },
			start: { scope: { streams: [{ name: "pages" }] }, type: "START" },
		});
		return result.messages;
	} finally {
		await rm(harnessDir, { force: true, recursive: true });
	}
}

const pagesStates = (messages: readonly EmittedMessage[]) =>
	messages.filter((m) => m.type === "STATE" && m.stream === "pages");

test("a planted page with an unreadable title is withheld, and the pages cursor does not move past it", async () => {
	// The newer page is fine; the older one has a title part with no text.
	// Before the field reader this page was stored with title null and the
	// cursor advanced past it, so the page was never read again.
	const messages = await runWithPages([
		page(NEW_ID, "2026-08-13T00:00:00.000Z"),
		page(OLD_ID, "2026-08-12T01:00:00.000Z", {
			properties: { Name: { type: "title", title: [{}] } },
		}),
	]);

	const records = messages.filter((m) => m.type === "RECORD");
	assert.deepEqual(
		records.map((m) => (m.type === "RECORD" ? m.key : null)),
		[NEW_ID],
	);
	const withheld = messages.find(
		(m) => m.type === "SKIP_RESULT" && m.reason === "record_fields_unavailable",
	);
	assert.deepEqual(
		withheld?.type === "SKIP_RESULT" ? withheld.diagnostics : null,
		{
			key: OLD_ID,
			key_enumerated: true,
			row_withheld: true,
			omissions: [
				{
					field: "title",
					reason: "Name.title: [0]: rich text part has no plain_text",
				},
			],
		},
	);
	assert.deepEqual(pagesStates(messages), [], "no STATE moves past the page");
	const coverage = messages.find(
		(m) => m.type === "DETAIL_COVERAGE" && m.stream === "pages",
	);
	assert.ok(coverage?.type === "DETAIL_COVERAGE");
	assert.deepEqual([coverage.considered, coverage.covered], [2, 1]);
});

test("a page the schema rejects withholds STATE too; the runtime corrects coverage", async () => {
	// The reader accepts this id; the output schema (Notion UUID) does not.
	const messages = await runWithPages([
		page(NEW_ID, "2026-08-13T00:00:00.000Z"),
		page("not-a-notion-id", "2026-08-12T01:00:00.000Z"),
	]);
	assert.deepEqual(pagesStates(messages), []);
	const coverage = messages.find(
		(m) => m.type === "DETAIL_COVERAGE" && m.stream === "pages",
	);
	assert.ok(coverage?.type === "DETAIL_COVERAGE");
	assert.deepEqual(
		[coverage.considered, coverage.covered],
		[2, 1],
		"the connector handed over 2; the runtime refused 1",
	);
});

test("a clean run still saves the pages cursor", async () => {
	const messages = await runWithPages([
		page(NEW_ID, "2026-08-13T00:00:00.000Z"),
		page(OLD_ID, "2026-08-12T01:00:00.000Z"),
	]);
	assert.deepEqual(
		pagesStates(messages).map((m) => (m.type === "STATE" ? m.cursor : null)),
		[{ last_edited_time: "2026-08-13T00:00:00.000Z" }],
	);
});

// ─── Row builders ───────────────────────────────────────────────────────

test("pageRow: maps every field; a block parent's id is read, not dropped", () => {
	const row = pageRow(
		page(NEW_ID, "2026-08-13T00:00:00.000Z", {
			parent: { type: "block_id", block_id: BLOCK_ID },
		}),
	);
	assert.ok(row.covered, row.covered ? "" : JSON.stringify(row.omissions));
	assert.deepEqual(row.data, {
		id: NEW_ID,
		parent_type: "block_id",
		parent_id: BLOCK_ID,
		url: `https://www.notion.so/${NEW_ID.replace(/-/g, "")}`,
		archived: false,
		created_time: "2026-08-12T00:00:00.000Z",
		last_edited_time: "2026-08-13T00:00:00.000Z",
		object: "page",
		title: "Fine",
		created_by_id: ACTOR_ID,
		last_edited_by_id: ACTOR_ID,
	});
	assert.equal(validateRecord("pages", row.data).ok, true);
});

test("pageRow: an untitled page is a stated empty title, not a loss", () => {
	const row = pageRow(
		page(NEW_ID, "2026-08-13T00:00:00.000Z", {
			properties: { Name: { type: "title", title: [] } },
		}),
	);
	assert.ok(row.covered);
	assert.equal(row.data.title, null);
});

test("pageRow: malformed or missing fields make the row uncovered, never defaulted", () => {
	const cases: ReadonlyArray<[Record<string, unknown>, string[]]> = [
		[{ archived: "false" }, ["archived"]],
		[{ created_by: "user-1" }, ["created_by_id"]],
		[{ last_edited_time: "yesterday" }, ["last_edited_time"]],
		[{ url: "/relative" }, ["url"]],
		[{ parent: { type: "page_id" } }, ["parent_id"]],
		[{ properties: { Name: { type: "rich_text" } } }, ["title"]],
	];
	for (const [overrides, fields] of cases) {
		const row = pageRow(page(NEW_ID, "2026-08-13T00:00:00.000Z", overrides));
		assert.deepEqual(
			row.covered ? [] : row.omissions.map((o) => o.field),
			fields,
			JSON.stringify(overrides),
		);
	}
	const { created_time: _dropped, ...withoutCreated } = page(
		NEW_ID,
		"2026-08-13T00:00:00.000Z",
	);
	const absent = pageRow(withoutCreated);
	assert.deepEqual(
		absent.covered ? [] : absent.omissions.map((o) => o.field),
		["created_time"],
		"Notion always sends created_time; its absence is not emptiness",
	);
});

test("databaseRow: maps title and property names; a malformed properties map is a loss", () => {
	const database = {
		id: NEW_ID,
		object: "database",
		parent: { type: "workspace", workspace: true },
		title: [{ plain_text: "Tasks" }],
		properties: { Name: { type: "title" }, Due: { type: "date" } },
		url: `https://www.notion.so/${NEW_ID.replace(/-/g, "")}`,
		archived: false,
		created_time: "2026-08-10T00:00:00.000Z",
		last_edited_time: "2026-08-10T01:00:00.000Z",
	};
	const row = databaseRow(database);
	assert.ok(row.covered);
	assert.equal(row.data.title, "Tasks");
	assert.deepEqual(row.data.property_names, ["Name", "Due"]);
	assert.equal(validateRecord("databases", row.data).ok, true);
	const bad = databaseRow({ ...database, properties: [] });
	assert.deepEqual(bad.covered ? [] : bad.omissions.map((o) => o.field), [
		"property_names",
	]);
});
