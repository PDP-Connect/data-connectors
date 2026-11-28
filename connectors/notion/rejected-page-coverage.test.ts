// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A page the schema rejects is considered-but-NOT-covered.
 *
 * `runStream` previously declared coverage with `buildFullScanCoverageMessage`,
 * which forces `covered === considered`. That shape cannot express a dropped
 * page: the enumeration boundary absorbed the rejected row and the stream read
 * `complete` while a real page was silently missing. Notion's schema is strict
 * (title ≤ 4000 chars, url ≤ 4096, safe text), so rejection is genuinely
 * reachable, not theoretical.
 *
 * `covered` is now tallied per record from the same `validateRecord` verdict
 * the runtime's emitRecord applies, so a rejected page reads a real `partial`.
 *
 * The companion property — an ARCHIVED (deleted) page must still count as
 * covered — is asserted here too. Notion reports deletions in-band as
 * `archived: true`, and PDPP deliberately retains records the provider has
 * removed, so treating a deletion as a gap would make correct preservation look
 * like loss on every subsequent run.
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
import { pagesSchema } from "./schemas.ts";

const pageMetadata = {
	id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
	object: "page",
	parent_type: null,
	parent_id: null,
	title: null,
	url: null,
	archived: false,
	created_time: null,
	last_edited_time: null,
	created_by_id: null,
	last_edited_by_id: null,
};

test("page metadata accepts explicit null title but requires the title key", () => {
	assert.equal(pagesSchema.safeParse(pageMetadata).success, true);
	assert.equal(
		pagesSchema.safeParse({ ...pageMetadata, title: undefined }).success,
		false,
	);
});

test("page metadata accepts a title exactly at the declared limit", () => {
	assert.equal(
		pagesSchema.safeParse({ ...pageMetadata, title: "x".repeat(4000) }).success,
		true,
	);
	assert.equal(
		pagesSchema.safeParse({ ...pageMetadata, title: "x".repeat(4001) }).success,
		false,
	);
});

const ENTRYPOINT = connectorEntrypoint("notion");
const GOOD_PAGE_ID = "11111111-1111-4111-8111-111111111111";
const BAD_PAGE_ID = "44444444-4444-4444-8444-444444444444";
const ARCHIVED_PAGE_ID = "55555555-5555-4555-8555-555555555555";
const ACTOR_ID = "33333333-3333-4333-8333-333333333333";

/** Runs the real connector against a bounded in-process Notion stub. */
async function runWithPages(
	pagesJson: string,
	state: Record<string, unknown> = {},
): Promise<EmittedMessage[]> {
	const harnessDir = await mkdtemp(join(tmpdir(), "pdpp-notion-rejected-"));
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
    results: isPage ? ${pagesJson} : []
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
			start: { scope: { streams: [{ name: "pages" }] }, state, type: "START" },
		});
		return result.messages;
	} finally {
		await rm(harnessDir, { force: true, recursive: true });
	}
}

function pagesCoverage(messages: readonly EmittedMessage[]): {
	considered?: number;
	covered?: number;
} {
	const coverage = messages.find(
		(m) => m.type === "DETAIL_COVERAGE" && m.stream === "pages",
	);
	assert.ok(coverage, "expected a pages DETAIL_COVERAGE");
	return coverage as { considered?: number; covered?: number };
}

/** A well-formed page. `titleText` is the only variable of interest. */
function page(
	id: string,
	titleText: string,
	archived = false,
	edited = "2026-08-12T01:00:00.000Z",
): string {
	return JSON.stringify({
		id,
		object: "page",
		parent: { type: "workspace", workspace: true },
		properties: { Name: { type: "title", title: [{ plain_text: titleText }] } },
		url: `https://www.notion.so/${id.replace(/-/g, "")}`,
		archived,
		created_time: "2026-08-12T00:00:00.000Z",
		last_edited_time: edited,
		created_by: { id: ACTOR_ID },
		last_edited_by: { id: ACTOR_ID },
	});
}

test("a page rejected by the schema is considered but not covered", async () => {
	// The second page's title exceeds the schema's 4000-char bound, so
	// `validateRecord` rejects it and it can never be committed.
	const messages = await runWithPages(
		`[${page(GOOD_PAGE_ID, "Fine")}, ${page(BAD_PAGE_ID, "x".repeat(4001))}]`,
	);

	const coverage = pagesCoverage(messages);
	assert.equal(
		coverage.considered,
		2,
		"both enumerated pages are in the denominator",
	);
	// The load-bearing assertion. Under `buildFullScanCoverageMessage` this was 2.
	assert.equal(
		coverage.covered,
		1,
		"a page the schema rejected must not be claimed as covered",
	);
});

test("an archived page still counts as covered, so deletion is not read as loss", async () => {
	// Notion reports a deleted page in-band as `archived: true`. It is a valid
	// record and the runtime tombstones it; it must NOT depress coverage, or
	// every upstream deletion would make a correct run look incomplete forever.
	const messages = await runWithPages(
		`[${page(GOOD_PAGE_ID, "Fine")}, ${page(ARCHIVED_PAGE_ID, "Gone", true)}]`,
	);

	const coverage = pagesCoverage(messages);
	assert.equal(coverage.considered, 2);
	assert.equal(
		coverage.covered,
		2,
		"an archived (deleted) page is a covered fact, not a coverage gap",
	);
});

test("a clean enumeration still reads fully covered", async () => {
	// Guards the opposite failure: a covered-tally that under-counts would make
	// every healthy run read a false `partial`.
	const messages = await runWithPages(
		`[${page(GOOD_PAGE_ID, "Fine")}, ${page(BAD_PAGE_ID, "Also fine")}]`,
	);

	const coverage = pagesCoverage(messages);
	assert.equal(coverage.considered, 2);
	assert.equal(coverage.covered, 2);
});

test("a steady-state run whose cursor suppresses every page still reads fully covered", async () => {
	// The incremental path: a cursor newer than every page means nothing is
	// emitted. Those pages were still enumerated and accounted for — an earlier
	// run's identical content already passed the real shape-check — so they must
	// count as covered. If suppressed-unchanged rows were dropped from `covered`,
	// every healthy steady-state re-scan would report a false `partial`.
	const messages = await runWithPages(
		`[${page(GOOD_PAGE_ID, "Fine")}, ${page(BAD_PAGE_ID, "Also fine")}]`,
		{
			pages: { last_edited_time: "2030-01-01T00:00:00.000Z" },
		},
	);

	const emitted = messages.filter(
		(m) => m.type === "RECORD" && m.stream === "pages",
	).length;
	assert.equal(emitted, 0, "the cursor should suppress every page");

	const coverage = pagesCoverage(messages);
	assert.equal(coverage.considered, 2, "suppressed pages are still enumerated");
	assert.equal(
		coverage.covered,
		2,
		"suppressed-unchanged pages are accounted for, not lost",
	);
});

function pagesCursor(messages: readonly EmittedMessage[]) {
	const state = messages.find(
		(m) => m.type === "STATE" && m.stream === "pages",
	);
	assert.ok(state && state.type === "STATE", "expected pages STATE");
	return state.cursor;
}

function emittedPageIds(messages: readonly EmittedMessage[]) {
	return messages
		.flatMap((m) =>
			m.type === "RECORD" && m.stream === "pages" ? [m.data.id] : [],
		)
		.sort();
}

const T1 = "2026-08-12T01:00:00.000Z";
const T2 = "2026-08-12T02:00:00.000Z";
const T3 = "2026-08-12T03:00:00.000Z";
const T4 = "2026-08-12T04:00:00.000Z";

test("rejected page holds the watermark across retries until repaired", async () => {
	// Descending provider order exercises a later valid timestamp before rejection.
	const pages = `[${page(ARCHIVED_PAGE_ID, "C", false, T3)},
		${page(BAD_PAGE_ID, "x".repeat(4001), false, T2)},
		${page(GOOD_PAGE_ID, "A", false, T1)}]`;
	const first = await runWithPages(pages);
	assert.deepEqual(pagesCursor(first), { last_edited_time: T1 });
	assert.deepEqual(
		emittedPageIds(first),
		[GOOD_PAGE_ID, ARCHIVED_PAGE_ID].sort(),
	);

	const second = await runWithPages(pages, { pages: pagesCursor(first) });
	assert.deepEqual(pagesCursor(second), { last_edited_time: T1 });
	assert.deepEqual(emittedPageIds(second), [ARCHIVED_PAGE_ID]);
	for (const messages of [first, second]) {
		assert.equal(pagesCoverage(messages).considered, 3);
		assert.equal(pagesCoverage(messages).covered, 2);
		const rejected = messages.filter(
			(m) =>
				m.type === "SKIP_RESULT" &&
				m.stream === "pages" &&
				m.reason === "shape_check_failed",
		);
		assert.equal(rejected.length, 1, "B is retried, not suppressed");
		assert.ok(rejected[0]?.type === "SKIP_RESULT");
		assert.match(rejected[0].message, new RegExp(BAD_PAGE_ID));
	}
	const repaired = await runWithPages(
		`[${page(BAD_PAGE_ID, "B fixed", false, T4)},
			${page(ARCHIVED_PAGE_ID, "C", false, T3)},
			${page(GOOD_PAGE_ID, "A", false, T1)}]`,
		{ pages: pagesCursor(second) },
	);
	assert.deepEqual(pagesCursor(repaired), { last_edited_time: T4 });
	assert.deepEqual(
		emittedPageIds(repaired),
		[BAD_PAGE_ID, ARCHIVED_PAGE_ID].sort(),
	);
	assert.equal(pagesCoverage(repaired).covered, 3);
});

test("all-valid enumeration advances to the maximum edit timestamp", async () => {
	const messages = await runWithPages(
		`[${page(ARCHIVED_PAGE_ID, "C", false, T3)},
			${page(GOOD_PAGE_ID, "A", false, T1)},
			${page(BAD_PAGE_ID, "B", false, T2)}]`,
	);
	assert.deepEqual(pagesCursor(messages), { last_edited_time: T3 });
	assert.equal(pagesCoverage(messages).covered, 3);
});

test("a valid timestamp equal to a rejection cannot advance the watermark", async () => {
	const pages = `[${page(ARCHIVED_PAGE_ID, "C", false, T3)},
		${page(GOOD_PAGE_ID, "A", false, T2)},
		${page(BAD_PAGE_ID, "x".repeat(4001), false, T2)}]`;
	const messages = await runWithPages(pages, {
		pages: { last_edited_time: T1 },
	});
	assert.deepEqual(pagesCursor(messages), { last_edited_time: T1 });
	const fresh = await runWithPages(pages);
	assert.deepEqual(pagesCursor(fresh), { last_edited_time: null });
});
