// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Wire-level regressions for the Reddit content / current-stats split.
 *
 * Unlike stats-split.test.ts (real `collectAllStreams` + real `makeEmitRecord`
 * in-process), these drive the REAL `runConnector` protocol in a child process
 * (see stats-split-runtime-fixture.ts): START parsing, field/resource/time
 * scope, full-record validation, `reportStreamFailure`, DONE finalization and
 * process exit. They pin three review blockers:
 *
 *  1. START `fields` (Collection Profile 5.1): Reddit cannot safely emit a
 *     field subset. The host replaces the whole stored row with each RECORD, so
 *     a projected record would erase the omitted current fields. A restricted
 *     subset is therefore rejected before any listing fetch or RECORD; an
 *     absent `fields`, or one that names every output field, still gets the
 *     full record, and full-record validation and the record key stay intact.
 *  2. A page-capped inventory has no observed end, so the run must fail with
 *     `stream_collection_failed` (Collection Profile 5.5), never DONE
 *     succeeded.
 *  3. The retired page-limit reason, whose copy promised a resume the
 *     connector does not implement, is no longer registered anywhere.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { EmittedMessage } from "@pdpp/connector-protocol";
import {
	type ConnectorSubprocessResult,
	runConnectorProtocolSubprocess,
} from "../../packages/polyfill-connectors/src/test-harness.ts";
import { SCHEMAS } from "./schemas.ts";
import type { RedditChild } from "./types.ts";

const T0 = 1_700_000_000;
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const FIXTURE = fileURLToPath(
	new URL("./stats-split-runtime-fixture.ts", import.meta.url),
);

const post = (name: string, created: number): RedditChild => ({
	kind: "t3",
	data: {
		name,
		subreddit: "synthetic",
		title: `Post ${name}`,
		permalink: `/r/synthetic/comments/${name.slice(3)}/post/`,
		url: "https://example.com/a",
		selftext: "",
		is_self: false,
		over_18: false,
		score: 10,
		num_comments: 5,
		upvote_ratio: 0.9,
		gilded: 1,
		created_utc: created,
	},
});

const posts = (n: number): RedditChild[] =>
	Array.from({ length: n }, (_, i) => post(`t3_s${i + 1}`, T0 + 1000 - i));

interface WireScope {
	/** Typed as `unknown` so malformed values can be sent on the wire. */
	fields?: unknown;
	name: string;
}

/**
 * START is built as a plain value, not an object literal: the harness's START
 * type does not name `fields` yet, but the runtime passes extra scope keys
 * through (StreamScope has an index signature). That is a typing gap in the
 * harness, not a reason to fake the wire.
 */
function runWire(
	streams: WireScope[],
	listing: RedditChild[],
	pageSize = 100,
	fetchLog?: string,
): Promise<ConnectorSubprocessResult> {
	const start = { scope: { streams }, type: "START" as const };
	return runConnectorProtocolSubprocess({
		allowFailedDone: true,
		cwd: REPO_ROOT,
		entrypoint: FIXTURE,
		env: {
			PDPP_TEST_REDDIT_LISTINGS: JSON.stringify({ submitted: listing }),
			PDPP_TEST_REDDIT_PAGE_SIZE: String(pageSize),
			...(fetchLog ? { PDPP_TEST_REDDIT_FETCH_LOG: fetchLog } : {}),
		},
		start,
		timeoutMs: 60_000,
	});
}

/** Run once and also count how many listing fetches reached the fake page. */
async function runWireCountingFetches(
	streams: WireScope[],
	listing: RedditChild[],
): Promise<{ fetches: number; result: ConnectorSubprocessResult }> {
	const dir = mkdtempSync(join(tmpdir(), "reddit-wire-"));
	const log = join(dir, "fetches.log");
	try {
		const result = await runWire(streams, listing, 100, log);
		let fetches = 0;
		try {
			fetches = readFileSync(log, "utf8").split("\n").filter(Boolean).length;
		} catch {
			// No log file means the fake page was never asked for a listing.
		}
		return { fetches, result };
	} finally {
		rmSync(dir, { force: true, recursive: true });
	}
}

type RecordMessage = Extract<EmittedMessage, { type: "RECORD" }>;

const recordsOf = (r: ConnectorSubprocessResult, stream: string) =>
	r.messages.filter(
		(m): m is RecordMessage => m.type === "RECORD" && m.stream === stream,
	);
const skipsOf = (r: ConnectorSubprocessResult, reason: string) =>
	r.messages.filter((m) => m.type === "SKIP_RESULT" && m.reason === reason);
const doneOf = (r: ConnectorSubprocessResult) =>
	r.messages.findLast((m) => m.type === "DONE");

const manifest = JSON.parse(
	readFileSync(new URL("./manifest.json", import.meta.url), "utf8"),
) as {
	reason_display_messages?: Record<string, string>;
	streams: Array<{
		name: string;
		schema: { properties: object };
		selection?: { fields?: boolean; resources?: boolean };
	}>;
};
const manifestFields = (stream: string): string[] =>
	Object.keys(
		manifest.streams.find((s) => s.name === stream)?.schema.properties ?? {},
	).sort();

// ─── 1. START `fields`: a restricted subset is rejected, never projected ──
//
// The host replaces the whole stored row with each RECORD (no partial merge).
// A projected record would erase every omitted current field, so Reddit
// declines a restricted subset instead of emitting one. Rejection happens
// before any listing fetch, so nothing is offered, checkpointed or fetched.

const PRIVATE_TITLE = "PRIVATE-CANARY-TITLE-4f1c";

const privatePosts = (n: number): RedditChild[] =>
	posts(n).map((c) => ({
		...c,
		data: { ...c.data, title: `${PRIVATE_TITLE} ${String(c.data.name)}` },
	}));

const ALL_OUTPUTS = Object.keys(SCHEMAS).sort();
const outputFields = (stream: string): string[] =>
	Object.keys((SCHEMAS[stream] as unknown as { shape: object }).shape).sort();

function assertFieldScopeRejected(
	r: ConnectorSubprocessResult,
	fetches: number,
	rejectedStreams: readonly string[],
): void {
	const done = doneOf(r);
	assert.equal(done?.status, "failed", "a restricted subset must not succeed");
	assert.equal(done?.error?.code, "stream_collection_failed");
	assert.equal(r.code, 1, "process exits non-zero");
	assert.equal(fetches, 0, "rejected before any Reddit listing fetch");
	assert.equal(
		r.messages.filter((m) => m.type === "RECORD").length,
		0,
		"no RECORD is offered for any output of a rejected request",
	);
	for (const type of ["STATE", "DETAIL_COVERAGE"]) {
		assert.equal(
			r.messages.some((m) => m.type === type),
			false,
			`a rejected request saves no ${type}`,
		);
	}
	assert.equal(skipsOf(r, "shape_check_failed").length, 0);
	const failed = skipsOf(r, "stream_collection_failed")
		.map((m) => ("stream" in m ? m.stream : undefined))
		.sort();
	assert.deepEqual(failed, [...rejectedStreams].sort());
	for (const m of skipsOf(r, "stream_collection_failed")) {
		assert.ok(JSON.stringify(m).length < 1_000, "failure evidence is bounded");
	}
	assert.equal(
		JSON.stringify(r.messages).includes(PRIVATE_TITLE),
		false,
		"no source value appears in the failure",
	);
}

test("wire fields: a stats-only field subset is rejected before any fetch or RECORD", async () => {
	const { fetches, result } = await runWireCountingFetches(
		[{ name: "submitted_stats", fields: ["id", "created_utc", "score"] }],
		privatePosts(3),
	);
	assertFieldScopeRejected(result, fetches, ["submitted_stats"]);
});

test("wire fields: a content-only field subset is rejected before any fetch or RECORD", async () => {
	const { fetches, result } = await runWireCountingFetches(
		[{ name: "submitted", fields: ["id", "created_utc", "title"] }],
		privatePosts(3),
	);
	assertFieldScopeRejected(result, fetches, ["submitted"]);
});

test("wire fields: a combined request with two subsets rejects both outputs and offers nothing", async () => {
	const { fetches, result } = await runWireCountingFetches(
		[
			{ name: "submitted", fields: ["id", "title"] },
			{ name: "submitted_stats", fields: ["id", "num_comments", "gilded"] },
		],
		privatePosts(3),
	);
	assertFieldScopeRejected(result, fetches, ["submitted", "submitted_stats"]);
});

test("wire fields: one restricted output rejects the whole combined request, so the unrestricted output writes nothing either", async () => {
	const { fetches, result } = await runWireCountingFetches(
		[
			{ name: "submitted" },
			{ name: "submitted_stats", fields: ["id", "score"] },
		],
		privatePosts(3),
	);
	assertFieldScopeRejected(result, fetches, ["submitted_stats"]);
});

for (const stream of ALL_OUTPUTS) {
	test(`wire fields: ${stream} rejects a restricted subset`, async () => {
		const { fetches, result } = await runWireCountingFetches(
			[{ name: stream, fields: outputFields(stream).slice(0, -1) }],
			privatePosts(2),
		);
		assertFieldScopeRejected(result, fetches, [stream]);
	});
}

test("wire fields: a subset made of schema-metadata or prototype names is still a subset", async () => {
	const { fetches, result } = await runWireCountingFetches(
		[
			{
				name: "submitted_stats",
				fields: ["id", "properties", "required", "__proto__", "toString"],
			},
		],
		privatePosts(2),
	);
	assertFieldScopeRejected(result, fetches, ["submitted_stats"]);
});

for (const [label, fields] of [
	["null", null],
	["an empty list", []],
	["a bare string", "id"],
	["an object", { id: true }],
	["a list with a non-string entry", ["id", 1]],
	["a list with a null entry", ["id", null]],
] as const) {
	test(`wire fields: malformed fields (${label}) is rejected, never read as the full record`, async () => {
		const { fetches, result } = await runWireCountingFetches(
			[{ name: "submitted_stats", fields }],
			privatePosts(2),
		);
		assertFieldScopeRejected(result, fetches, ["submitted_stats"]);
	});
}

test("wire fields: a list with a non-string entry is rejected even when it also names every field", async () => {
	const { fetches, result } = await runWireCountingFetches(
		[
			{
				name: "submitted_stats",
				fields: [...outputFields("submitted_stats"), 7],
			},
		],
		privatePosts(2),
	);
	assertFieldScopeRejected(result, fetches, ["submitted_stats"]);
});

test("wire fields: no `fields` (the useful full default) still emits every manifest property of both streams", async () => {
	const r = await runWire(
		[{ name: "submitted" }, { name: "submitted_stats" }],
		posts(2),
	);
	assert.equal(doneOf(r)?.status, "succeeded");
	for (const stream of ["submitted", "submitted_stats"]) {
		const out = recordsOf(r, stream);
		assert.equal(out.length, 2, `${stream}: records`);
		for (const m of out) {
			assert.deepEqual(Object.keys(m.data).sort(), manifestFields(stream));
		}
	}
});

test("wire fields: naming every manifest property is the same as the full default", async () => {
	const r = await runWire(
		[
			{ name: "submitted", fields: manifestFields("submitted") },
			{ name: "submitted_stats", fields: manifestFields("submitted_stats") },
		],
		posts(2),
	);
	assert.equal(doneOf(r)?.status, "succeeded");
	for (const stream of ["submitted", "submitted_stats"]) {
		const out = recordsOf(r, stream);
		assert.equal(out.length, 2, `${stream}: records`);
		for (const m of out) {
			assert.deepEqual(Object.keys(m.data).sort(), manifestFields(stream));
		}
	}
});

test("wire fields: naming every property plus unknown and metadata-like names is still the full record", async () => {
	const r = await runWire(
		[
			{
				name: "submitted_stats",
				fields: [
					...manifestFields("submitted_stats"),
					"properties",
					"required",
					"not_a_field",
				],
			},
		],
		posts(2),
	);
	assert.equal(doneOf(r)?.status, "succeeded");
	const out = recordsOf(r, "submitted_stats");
	assert.equal(out.length, 2);
	for (const m of out) {
		assert.deepEqual(
			Object.keys(m.data).sort(),
			manifestFields("submitted_stats"),
		);
	}
});

test("wire fields: the output field list used by the guard equals the manifest properties", () => {
	for (const stream of ALL_OUTPUTS) {
		assert.deepEqual(outputFields(stream), manifestFields(stream), stream);
	}
});

test("wire fields: a full request still validates the FULL record (a schema-invalid listed row is skipped)", async () => {
	const listing = [post("t3_s1", T0 + 10), post("t3_bad_id", T0 + 5)];
	const r = await runWire([{ name: "submitted_stats" }], listing);
	assert.equal(doneOf(r)?.status, "succeeded");
	assert.deepEqual(
		recordsOf(r, "submitted_stats").map((m) => m.data.id),
		["t3_s1"],
	);
	assert.ok(skipsOf(r, "shape_check_failed").length >= 1);
});

// ─── 2. Page-capped inventory is a stream failure ───────────────────────

const CAP_LISTING = (): RedditChild[] =>
	Array.from({ length: 105 }, (_, i) => post(`t3_s${i + 1}`, T0 + 5000 - i));

function assertCappedFailure(
	r: ConnectorSubprocessResult,
	streams: readonly string[],
): void {
	const done = doneOf(r);
	assert.equal(done?.status, "failed", "capped inventory must not succeed");
	assert.equal(done?.error?.code, "stream_collection_failed");
	assert.equal(r.code, 1, "process exits non-zero");
	const failedStreams = skipsOf(r, "stream_collection_failed")
		.map((m) => ("stream" in m ? m.stream : undefined))
		.sort();
	assert.deepEqual(failedStreams, [...streams].sort());
	for (const m of skipsOf(r, "stream_collection_failed")) {
		// Bounded: a message and a recovery hint, never records or page bodies.
		assert.ok(JSON.stringify(m).length < 1_000, "failure evidence is bounded");
	}
	assert.equal(
		r.messages.some((m) => m.type === "STATE"),
		false,
		"a capped walk saves no checkpoint",
	);
	assert.equal(
		r.messages.some((m) => m.type === "DETAIL_COVERAGE"),
		false,
		"a capped walk makes no coverage claim",
	);
}

test("wire cap: a capped stats-only run finishes DONE failed / stream_collection_failed", async () => {
	const r = await runWire([{ name: "submitted_stats" }], CAP_LISTING(), 1);
	assertCappedFailure(r, ["submitted_stats"]);
});

test("wire cap: a capped content-only run finishes DONE failed / stream_collection_failed", async () => {
	const r = await runWire([{ name: "submitted" }], CAP_LISTING(), 1);
	assertCappedFailure(r, ["submitted"]);
});

test("wire cap: a capped combined run reports a failure for EACH requested output", async () => {
	const r = await runWire(
		[{ name: "submitted" }, { name: "submitted_stats" }],
		CAP_LISTING(),
		1,
	);
	assertCappedFailure(r, ["submitted", "submitted_stats"]);
});

test("wire cap: an output that was not requested gets no failure report", async () => {
	const r = await runWire([{ name: "submitted_stats" }], CAP_LISTING(), 1);
	assert.equal(
		skipsOf(r, "stream_collection_failed").some(
			(m) => "stream" in m && m.stream === "submitted",
		),
		false,
	);
});

test("wire cap baseline: an uncapped listing (100 pages exactly) still finishes DONE succeeded", async () => {
	const r = await runWire(
		[{ name: "submitted" }, { name: "submitted_stats" }],
		posts(100),
		1,
	);
	assert.equal(doneOf(r)?.status, "succeeded");
	assert.equal(skipsOf(r, "stream_collection_failed").length, 0);
});

// ─── 3. No stale page-limit reason is registered ────────────────────────
//
// Reddit no longer emits `older_pages_deferred_page_budget`: a page-capped
// inventory is a stream failure (section 2). The old owner-facing copy promised
// "Nothing was lost — the next run picks up where this one stopped", but every
// run restarts from the newest item and no continuation is saved. Keeping an
// unreachable, false registration in any generated copy would be misleading.

function registeredRedditReasons(): Array<{
	source: string;
	reasons: string[];
}> {
	const read = (rel: string): unknown =>
		JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8"));
	const index = read("../../connector-implementation-index.json") as {
		connectors: Array<{
			manifest: {
				connector_key?: string;
				reason_display_messages?: Record<string, string>;
			};
		}>;
	};
	const library = read(
		"../../packages/polyfill-connectors/src/manifest-library-metadata.json",
	) as Array<{
		file: string;
		manifest: { reason_display_messages?: Record<string, string> };
	}>;
	return [
		{
			source: "connectors/reddit/manifest.json",
			reasons: Object.keys(manifest.reason_display_messages ?? {}),
		},
		{
			source: "connector-implementation-index.json",
			reasons: Object.keys(
				index.connectors.find((c) => c.manifest.connector_key === "reddit")
					?.manifest.reason_display_messages ?? {},
			),
		},
		{
			source: "manifest-library-metadata.json",
			reasons: Object.keys(
				library.find((e) => e.file === "reddit.json")?.manifest
					.reason_display_messages ?? {},
			),
		},
	];
}

test("the unreachable page-limit reason is not registered in the manifest or either generated copy", () => {
	for (const { source, reasons } of registeredRedditReasons()) {
		assert.deepEqual(reasons, [], `${source}: no Reddit reason registrations`);
	}
});

// ─── 4. The public manifest declares what the connector supports ────────
//
// `selection.fields: false` tells a consent UI and a caller that no Reddit
// output honors a field subset; `resources` selection is unchanged. The
// generated implementation index must carry the same declaration (the library
// metadata copy holds reason messages only).

test("every Reddit output declares field selection unsupported and keeps resource selection", () => {
	assert.equal(manifest.streams.length, ALL_OUTPUTS.length);
	for (const s of manifest.streams) {
		assert.deepEqual(s.selection, { fields: false, resources: true }, s.name);
	}
});

test("the generated implementation index carries the same Reddit selection declaration", () => {
	const index = JSON.parse(
		readFileSync(
			new URL("../../connector-implementation-index.json", import.meta.url),
			"utf8",
		),
	) as {
		connectors: Array<{
			manifest: {
				connector_key?: string;
				streams: Array<{ name: string; selection?: unknown }>;
			};
		}>;
	};
	const streams = index.connectors.find(
		(c) => c.manifest.connector_key === "reddit",
	)?.manifest.streams;
	assert.deepEqual(
		streams?.map((s) => [s.name, s.selection]),
		manifest.streams.map((s) => [s.name, s.selection]),
	);
});
