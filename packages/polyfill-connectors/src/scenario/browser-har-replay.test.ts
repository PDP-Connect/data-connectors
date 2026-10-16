// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for `resolveBrowserEvidence` — the recorded-browser driver's
 * pre-flight evidence gate (browser-har-replay.ts), called before any
 * browser or subprocess is spawned.
 *
 * Observable behavior under test: for a `recorded-browser` run, this
 * function must fail with ONE specific, named `BrowserReplayEvidenceError`
 * reason for each way the evidence envelope can be missing/unusable — NOT
 * degrade into the generic unmatched-request-abort cascade the module doc
 * comment describes (a HAR replayed into a cold context makes every
 * subsequent request miss the HAR for reasons that have nothing to do with
 * THIS specific missing field). The plausible defect each test guards
 * against: a future edit collapsing two of these distinct failure paths
 * into one generic message, which would turn a fast, precise diagnosis back
 * into exactly the confusing cascade this gate exists to prevent.
 *
 * Oracle: `resolveBrowserEvidence` itself, called directly (no subprocess,
 * no browser, no CLI) — this is a pure filesystem-and-shape check, so a
 * direct unit test is the smallest sufficient oracle per
 * docs/reference/testing-policy.md's "choose the smallest sufficient
 * oracle" table (pure rule/parser/projection -> deterministic direct test).
 * `writeBrowserHarReplayPreload` (the NODE_OPTIONS preload generator) is
 * NOT otherwise unit-tested here — its generated source only runs inside a
 * spawned subprocess with a real patchright browser, which is exactly the
 * kind of expensive, hard-to-isolate integration surface this package's
 * OTHER browser-driven connectors (src/browser-launch.test.ts) also do not
 * exercise with a real Chromium launch at this test tier; asserting that
 * the generated module STRING contains the expected patchright-patching/
 * routeFromHAR/setStorageState/clock-install SHAPE would be a change-
 * detector on the template literal's exact text, not a test of observable
 * behavior — see this file's module doc for why the meaningful boundary
 * (evidence resolution) is what's covered instead.
 *
 * ONE exception, below ("the generated preload's own code never calls Date
 * .now()/..."): that is not a shape check, it is a negative SAFETY
 * invariant — this preload's own setup code must never read the live clock
 * it patches, the same invariant subprocess-fetch-preloads.test.ts asserts
 * for `writeRecordPreload`/`writeReplayBridgePreload` (see that file's
 * comment for the full "why" — a past investigation into clock-trace index
 * drift chased this exact question before finding the real cause lived in
 * `node_modules/tsx`'s own loader, outside any of this package's code). A
 * plain substring scan is the right tool for a textual fact about a
 * template, and is cheap insurance against a future edit accidentally
 * reintroducing it here.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	type ApiRequestHarEntry,
	BrowserReplayEvidenceError,
	buildApiResponseFromHarEntry,
	findApiRequestHarMatch,
	resolveBrowserEvidence,
	sequentialHarRequestKey,
	sequentialHarResponseGroups,
	writeBrowserHarReplayPreload,
} from "./browser-har-replay.ts";
import type { ScenarioRun } from "./format.ts";

function withTmpDir(fn: (dir: string) => void): void {
	const dir = mkdtempSync(join(tmpdir(), "browser-har-replay-test-"));
	try {
		fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

async function withTmpDirAsync<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = mkdtempSync(join(tmpdir(), "browser-har-replay-test-"));
	try {
		return await fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function writeHar(path: string, entryCount: number): void {
	writeFileSync(
		path,
		JSON.stringify({
			log: {
				entries: Array.from({ length: entryCount }, (_unused, i) => ({
					request: { method: "GET", url: `https://toy.example/${String(i)}` },
					response: { status: 200 },
				})),
			},
		}),
	);
}

function writeStorageState(path: string): void {
	writeFileSync(path, JSON.stringify({ cookies: [], origins: [] }));
}

function browserRun(overrides: {
	har_entry_count?: unknown;
	har_path?: unknown;
	storage_state_path?: unknown;
}): ScenarioRun {
	return {
		environment: {
			network: {
				driver: "recorded-browser",
				har_path: "run-0.har",
				storage_state_path: "run-0.storage-state.json",
				har_entry_count: 2,
				...overrides,
			} as never,
		},
		start: { scope: { streams: [{ name: "widgets" }] }, state: null },
		interactions: [],
		expected: { records: {}, final_state: {} },
	};
}

function assertRejectsWithMessage(
	fn: () => void,
	expectedMessageFragment: RegExp,
): void {
	assert.throws(fn, (err: unknown) => {
		assert.ok(
			err instanceof BrowserReplayEvidenceError,
			`expected BrowserReplayEvidenceError, got ${String(err)}`,
		);
		assert.match(err.message, expectedMessageFragment);
		return true;
	});
}

test("resolveBrowserEvidence: happy path — a well-formed HAR + storage-state pair resolves cleanly", () => {
	withTmpDir((dir) => {
		writeHar(join(dir, "run-0.har"), 2);
		writeStorageState(join(dir, "run-0.storage-state.json"));
		const evidence = resolveBrowserEvidence(dir, browserRun({}));
		assert.equal(evidence.harPath, join(dir, "run-0.har"));
		assert.equal(
			evidence.storageStatePath,
			join(dir, "run-0.storage-state.json"),
		);
		assert.equal(evidence.harEntryCount, 2);
	});
});

test("resolveBrowserEvidence: rejects a run whose driver is not recorded-browser (defensive — bin/scenario-verify.ts only calls this after dispatching on the driver)", () => {
	withTmpDir((dir) => {
		const run: ScenarioRun = {
			environment: { network: { driver: "recorded-http" } },
			start: { scope: { streams: [] }, state: null },
			interactions: [],
			expected: { records: {}, final_state: {} },
		};
		assertRejectsWithMessage(
			() => resolveBrowserEvidence(dir, run),
			/driver === "recorded-browser"/,
		);
	});
});

test("resolveBrowserEvidence: rejects a missing har_path with a named reason", () => {
	withTmpDir((dir) => {
		assertRejectsWithMessage(
			() => resolveBrowserEvidence(dir, browserRun({ har_path: "" })),
			/requires run\.environment\.network\.har_path/,
		);
	});
});

// This is THE most likely first failure per the coordinator's architecture
// review: a HAR without its paired session state. Its diagnosis must be
// exact, not folded into a generic "missing field" message — asserted here
// with the specific wording, distinct from the har_path case above.
test("resolveBrowserEvidence: rejects a missing storage_state_path with the EXACT named session-state reason (not a generic missing-field message)", () => {
	withTmpDir((dir) => {
		writeHar(join(dir, "run-0.har"), 2);
		assertRejectsWithMessage(
			() => resolveBrowserEvidence(dir, browserRun({ storage_state_path: "" })),
			/browser replay requires the captured session state \(run\.environment\.network\.storage_state_path is missing or empty\)/,
		);
	});
});

test("resolveBrowserEvidence: rejects a har_path that does not resolve to an existing file", () => {
	withTmpDir((dir) => {
		writeStorageState(join(dir, "run-0.storage-state.json"));
		assertRejectsWithMessage(
			() => resolveBrowserEvidence(dir, browserRun({})),
			/HAR file not found/,
		);
	});
});

test("resolveBrowserEvidence: rejects a storage_state_path that does not resolve to an existing file, with the named session-state reason", () => {
	withTmpDir((dir) => {
		writeHar(join(dir, "run-0.har"), 2);
		assertRejectsWithMessage(
			() => resolveBrowserEvidence(dir, browserRun({})),
			/requires the captured session state — storage_state_path .+ does not exist/,
		);
	});
});

test("resolveBrowserEvidence: rejects a storage-state file that is not valid JSON", () => {
	withTmpDir((dir) => {
		writeHar(join(dir, "run-0.har"), 2);
		writeFileSync(join(dir, "run-0.storage-state.json"), "{not json");
		assertRejectsWithMessage(
			() => resolveBrowserEvidence(dir, browserRun({})),
			/requires the captured session state — storage_state_path .+ is not valid JSON/,
		);
	});
});

test("resolveBrowserEvidence: rejects a storage-state file that parses but is not an object (e.g. a JSON array)", () => {
	withTmpDir((dir) => {
		writeHar(join(dir, "run-0.har"), 2);
		writeFileSync(join(dir, "run-0.storage-state.json"), "[]");
		assertRejectsWithMessage(
			() => resolveBrowserEvidence(dir, browserRun({})),
			/does not contain a storage-state object/,
		);
	});
});

test("resolveBrowserEvidence: rejects a scenario declaring har_entry_count: 0 — vacuous, nothing to replay", () => {
	withTmpDir((dir) => {
		writeHar(join(dir, "run-0.har"), 0);
		writeStorageState(join(dir, "run-0.storage-state.json"));
		assertRejectsWithMessage(
			() => resolveBrowserEvidence(dir, browserRun({ har_entry_count: 0 })),
			/no recorded entries to replay/,
		);
	});
});

test("resolveBrowserEvidence: paths are resolved relative to the scenario's own directory, not the process cwd", () => {
	withTmpDir((dir) => {
		const nested = join(dir, "nested");
		mkdirSync(nested);
		writeHar(join(nested, "run-0.har"), 1);
		writeStorageState(join(nested, "run-0.storage-state.json"));
		const evidence = resolveBrowserEvidence(nested, browserRun({}));
		assert.equal(evidence.harPath, join(nested, "run-0.har"));
	});
});

test("resolveBrowserEvidence: carries run.clock.fixed_now through unchanged when present (the clock-pin contract browser-har-replay.ts's preload reads)", () => {
	withTmpDir((dir) => {
		writeHar(join(dir, "run-0.har"), 1);
		writeStorageState(join(dir, "run-0.storage-state.json"));
		const run = {
			...browserRun({}),
			clock: { fixed_now: "2026-01-01T00:00:00.000Z" },
		};
		const evidence = resolveBrowserEvidence(dir, run);
		assert.equal(evidence.fixedNowIso, "2026-01-01T00:00:00.000Z");
	});
});

test("resolveBrowserEvidence: fixedNowIso is undefined when the run carries no clock (legitimate — not every scenario pins a clock)", () => {
	withTmpDir((dir) => {
		writeHar(join(dir, "run-0.har"), 1);
		writeStorageState(join(dir, "run-0.storage-state.json"));
		const evidence = resolveBrowserEvidence(dir, browserRun({}));
		assert.equal(evidence.fixedNowIso, undefined);
	});
});

/**
 * `findApiRequestHarMatch`/`buildApiResponseFromHarEntry` back the
 * APIRequestContext → HAR bridge (see browser-har-replay.ts's module
 * comment) — the fix for strava_browser/spotify/github_browser's
 * `context.request`-based session probes, which `context.routeFromHAR`
 * never intercepts at all (confirmed empirically against the real
 * patchright build; see that module comment). Reproduces the exact shape
 * of the real strava_browser scenario this bridge was built to fix: the
 * probe requests `per_page=1`, the HAR only has the connector's own list
 * fetch at `per_page=20` (plus an unrelated same-pathname browser request
 * with a disjoint query), and no exact match exists for either.
 */
function harEntry(
	method: string,
	url: string,
	status: number,
	text = "",
): ApiRequestHarEntry {
	return {
		request: { method, url },
		response: {
			status,
			content: { text },
			headers: [{ name: "content-type", value: "application/json" }],
		},
	};
}

test("findApiRequestHarMatch: an exact method+URL match (incl. query string) always wins", () => {
	const entries = [
		harEntry("GET", "https://x.example/list?page=1&per_page=1", 200, "exact"),
		harEntry(
			"GET",
			"https://x.example/list?page=1&per_page=20",
			200,
			"fallback",
		),
	];
	const match = findApiRequestHarMatch(
		entries,
		"GET",
		"https://x.example/list?page=1&per_page=1",
	);
	assert.equal(match?.response?.content?.text, "exact");
});

test("findApiRequestHarMatch: GET rejects query overlap without full URL equivalence", () => {
	const entries = [
		// Disjoint query (no shared param NAMES with the live request) —
		// never a plausible match, must be skipped even though it shares
		// the pathname.
		harEntry(
			"GET",
			"https://x.example/athlete/training_activities?keywords=&sport_type=&search_session_id=abc",
			200,
			"unrelated",
		),
		// Shares `page`/`per_page` NAMES; `page` agrees in value, `per_page`
		// does not — this is the real strava_browser shape (probe asks for
		// per_page=1, the only recorded list fetch used per_page=20).
		harEntry(
			"GET",
			"https://x.example/athlete/training_activities?page=1&per_page=20",
			200,
			"fallback-match",
		),
	];
	const match = findApiRequestHarMatch(
		entries,
		"GET",
		"https://x.example/athlete/training_activities?page=1&per_page=1",
	);
	assert.equal(
		match,
		undefined,
		"query-name overlap cannot prove request equivalence",
	);
});

test("findApiRequestHarMatch: GET rejects partial query scores and extra recorded parameters", () => {
	const entries = [
		// Shares both names; only `page` agrees in value (score 1). Not an
		// exact match (per_page differs), so it's a genuine fallback
		// candidate.
		harEntry(
			"GET",
			"https://x.example/list?page=1&per_page=1",
			200,
			"one-shared-value-matches",
		),
		// Shares both names and both agree in value (score 2) — but an
		// extra, live-unseen `extra` param keeps the full URL from being an
		// exact match, so this still exercises the SCORING tie-break
		// instead of the exact-match shortcut.
		harEntry(
			"GET",
			"https://x.example/list?page=1&per_page=5&extra=1",
			200,
			"both-shared-values-match",
		),
	];
	const match = findApiRequestHarMatch(
		entries,
		"GET",
		"https://x.example/list?page=1&per_page=5",
	);
	assert.equal(
		match,
		undefined,
		"partial scores must never select a different request",
	);
});

test("findApiRequestHarMatch: no entry shares even one query parameter NAME at the same pathname — returns undefined rather than guessing", () => {
	const entries = [
		harEntry(
			"GET",
			"https://x.example/list?totally=different&shape=yes",
			200,
			"disjoint",
		),
	];
	const match = findApiRequestHarMatch(
		entries,
		"GET",
		"https://x.example/list?page=1&per_page=1",
	);
	assert.equal(match, undefined);
});

test("findApiRequestHarMatch: a mutating method (non-GET) never falls back — an inexact match is undefined even with a same-pathname, query-sharing candidate", () => {
	const entries = [
		harEntry("POST", "https://x.example/list?page=1&per_page=20", 200, "x"),
	];
	const match = findApiRequestHarMatch(
		entries,
		"POST",
		"https://x.example/list?page=1&per_page=1",
	);
	assert.equal(match, undefined);
});

test("findApiRequestHarMatch: a different pathname at the same origin never matches, regardless of query overlap", () => {
	const entries = [
		harEntry("GET", "https://x.example/other?page=1&per_page=1", 200, "x"),
	];
	const match = findApiRequestHarMatch(
		entries,
		"GET",
		"https://x.example/list?page=1&per_page=1",
	);
	assert.equal(match, undefined);
});

test("buildApiResponseFromHarEntry: exposes status/ok/text/json/headers/url from the matched entry", async () => {
	const entry = harEntry(
		"GET",
		"https://x.example/probe",
		200,
		JSON.stringify({ ok: true }),
	);
	const response = buildApiResponseFromHarEntry(entry);
	assert.equal(response.status(), 200);
	assert.equal(response.ok(), true);
	assert.equal(await response.text(), '{"ok":true}');
	assert.deepEqual(await response.json(), { ok: true });
	assert.equal(response.headers()["content-type"], "application/json");
	assert.equal(response.url(), "https://x.example/probe");
	await response.dispose();
});

test("buildApiResponseFromHarEntry: a non-2xx status reports ok() false", () => {
	const entry = harEntry("GET", "https://x.example/probe", 401, "denied");
	const response = buildApiResponseFromHarEntry(entry);
	assert.equal(response.status(), 401);
	assert.equal(response.ok(), false);
});

test("buildApiResponseFromHarEntry: base64-encoded HAR content decodes before text()/json() see it", async () => {
	const entry: ApiRequestHarEntry = {
		request: { method: "GET", url: "https://x.example/probe" },
		response: {
			status: 200,
			content: {
				encoding: "base64",
				text: Buffer.from('{"ok":true}', "utf8").toString("base64"),
			},
		},
	};
	const response = buildApiResponseFromHarEntry(entry);
	assert.equal(await response.text(), '{"ok":true}');
	assert.deepEqual(await response.json(), { ok: true });
});

// See this file's module doc comment ("ONE exception") for why this one
// test is a deliberate exception to "not a change-detector on the
// template literal's exact text" — it checks a negative safety invariant,
// not shape. Kept in lockstep with the identically-named/identically-
// reasoned test in subprocess-fetch-preloads.test.ts for the other two
// preload generators.
test("writeBrowserHarReplayPreload: the generated preload's own code never calls Date.now()/new Date()/performance.now() directly", () => {
	withTmpDir((dir) => {
		const harPath = join(dir, "run.har");
		writeHar(harPath, 1);
		const storageStatePath = join(dir, "state.json");
		writeFileSync(storageStatePath, "{}");
		// writeBrowserHarReplayPreload writes into this package's own tracked
		// (not gitignored) tmp/ scratch dir — see its doc comment on why
		// (needs real package-tree module resolution, unlike the 0700 mkdtemp
		// evidence workspace the other two preloads use). Must be removed
		// explicitly, or it is left behind as an untracked file this check's
		// own biome pass then flags.
		const preloadPath = writeBrowserHarReplayPreload(
			{
				fixedNowIso: "2026-01-01T00:00:00.000Z",
				harEntryCount: 1,
				harPath,
				storageStatePath,
			},
			{ clockTrace: [1, 2, 3] },
		);
		try {
			const generatedSrc = readFileSync(preloadPath, "utf8");
			const withoutComments = generatedSrc
				.split("\n")
				.map((line) => line.replace(/\/\/.*$/, ""))
				.join("\n");
			assert.deepEqual(
				{
					bareDateNowCalls: (withoutComments.match(/\bDate\.now\(\)/g) ?? [])
						.length,
					bareNewDateCalls: (withoutComments.match(/\bnew Date\(\)/g) ?? [])
						.length,
					barePerformanceNowCalls: (
						withoutComments.match(/\bperformance\.now\(\)/g) ?? []
					).length,
				},
				{
					bareDateNowCalls: 0,
					bareNewDateCalls: 0,
					barePerformanceNowCalls: 0,
				},
				"writeBrowserHarReplayPreload: a generated preload's own bookkeeping must never call the live clock directly",
			);
		} finally {
			rmSync(preloadPath, { force: true });
		}
	});
});

const at = (seconds: number): string =>
	new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString();

function seqEntry(fields: {
	body?: string;
	bodySize?: number;
	contentType?: string;
	method?: string;
	postData?: string;
	seconds: number;
	status: number;
	url: string;
}) {
	return {
		request: {
			method: fields.method ?? "GET",
			url: fields.url,
			bodySize: fields.bodySize ?? fields.postData?.length ?? 0,
			headers: fields.contentType
				? [{ name: "Content-Type", value: fields.contentType }]
				: [],
			...(fields.postData === undefined
				? {}
				: { postData: { text: fields.postData } }),
		},
		response: {
			content: { size: fields.body?.length ?? 0, text: fields.body ?? "" },
			headers: [{ name: "content-type", value: "application/json" }],
			status: fields.status,
		},
		startedDateTime: at(fields.seconds),
	};
}

const STATUS_URL = "https://example.test/api/export/status";
const GRAPHQL_URL = "https://example.test/graphql";

test("sequentialHarResponseGroups: identifies ambiguous requests without inventing polling order", () => {
	const groups = sequentialHarResponseGroups([
		// Out of file order on purpose: the rule orders by start time.
		seqEntry({
			url: STATUS_URL,
			status: 200,
			body: '{"ready":true}',
			seconds: 9,
		}),
		seqEntry({ url: STATUS_URL, status: 404, body: "", seconds: 1 }),
		seqEntry({ url: STATUS_URL, status: 404, body: "", seconds: 5 }),
		seqEntry({
			url: "https://example.test/api/me",
			status: 200,
			body: "{}",
			seconds: 2,
		}),
		seqEntry({
			url: "https://example.test/api/me",
			status: 200,
			body: "{}",
			seconds: 3,
		}),
		seqEntry({
			url: "https://example.test/once",
			status: 200,
			body: "x",
			seconds: 6,
		}),
	]);
	assert.equal(groups.size, 1);
	assert.deepEqual(
		[...groups.values()][0]?.map((e) => e.response.status),
		[200, 404, 404],
	);
});

test("sequentialHarResponseGroups: equal-size but different bodies at one URL are detected as differing", () => {
	const groups = sequentialHarResponseGroups([
		seqEntry({
			url: STATUS_URL,
			status: 200,
			body: '{"state":"busy"}',
			seconds: 1,
		}),
		seqEntry({
			url: STATUS_URL,
			status: 200,
			body: '{"state":"done"}',
			seconds: 2,
		}),
	]);
	assert.deepEqual(
		[...groups.values()][0]?.map((e) => e.response.content.text),
		['{"state":"busy"}', '{"state":"done"}'],
	);
});

test("sequentialHarResponseGroups: POSTs to one URL with different bodies are different requests, never one sequence", () => {
	const groups = sequentialHarResponseGroups([
		seqEntry({
			method: "POST",
			url: GRAPHQL_URL,
			postData: '{"op":"A"}',
			status: 200,
			body: '{"a":1}',
			seconds: 1,
		}),
		seqEntry({
			method: "POST",
			url: GRAPHQL_URL,
			postData: '{"op":"B"}',
			status: 200,
			body: '{"b":2}',
			seconds: 2,
		}),
	]);
	assert.equal(
		groups.size,
		0,
		"each body has one entry; routeFromHAR serves them",
	);
	assert.notEqual(
		sequentialHarRequestKey("POST", GRAPHQL_URL, '{"op":"A"}'),
		sequentialHarRequestKey("POST", GRAPHQL_URL, '{"op":"B"}'),
	);
});

type SequentialRouteOutcome =
	| { kind: "fallback" }
	| { kind: "abort" }
	| { body: string; kind: "fulfill"; status: number };

/**
 * The generated preload's own `installSequentialHarRoutes`, cut out of the
 * real generated source between its BEGIN/END markers and run against a fake
 * context, so the inline copy (not only the TS rule) is what is tested.
 */
async function generatedSequentialRoute(
	entries: unknown[],
): Promise<
	| ((request: {
			contentType?: string;
			headers?: Record<string, string>;
			omitAllHeaders?: boolean;
			omitBodyBuffer?: boolean;
			method: string;
			postData: string | null;
			url: string;
	  }) => Promise<
			| { kind: "fallback" }
			| { kind: "abort" }
			| { body: string; kind: "fulfill"; status: number }
	  >)
	| null
> {
	return await withTmpDirAsync(async (dir) => {
		const harPath = join(dir, "run.har");
		writeFileSync(harPath, JSON.stringify({ log: { entries } }));
		const storageStatePath = join(dir, "state.json");
		writeFileSync(storageStatePath, "{}");
		const preloadPath = writeBrowserHarReplayPreload(
			{
				fixedNowIso: "2026-01-01T00:00:00.000Z",
				harEntryCount: entries.length,
				harPath,
				storageStatePath,
			},
			{ clockTrace: [] },
		);
		let source: string;
		try {
			source = readFileSync(preloadPath, "utf8");
		} finally {
			rmSync(preloadPath, { force: true });
		}
		const begin = source.indexOf("// BEGIN installSequentialHarRoutes");
		const end = source.indexOf("// END installSequentialHarRoutes");
		assert.ok(
			begin >= 0 && end > begin,
			"generated preload carries the marked block",
		);
		const install = new Function(
			"readFileSync",
			"createHash",
			"HAR_PATH",
			"Buffer",
			`${source.slice(source.indexOf("// BEGIN strictHarRequestIdentity"), begin)}\n${source.slice(begin, end)}\nreturn installSequentialHarRoutes;`,
		)(readFileSync, createHash, harPath, Buffer) as (
			context: unknown,
		) => Promise<void>;
		let handler: ((route: unknown) => Promise<void>) | null = null;
		await install({
			route: (_pattern: string, fn: (route: unknown) => Promise<void>) => {
				handler = fn;
				return Promise.resolve();
			},
		});
		const installed = handler as ((route: unknown) => Promise<void>) | null;
		if (!installed) {
			return null;
		}
		return async (request) => {
			let outcome:
				| { kind: "fallback" }
				| { kind: "abort" }
				| { body: string; kind: "fulfill"; status: number } = {
				kind: "fallback",
			};
			await installed({
				request: () => ({
					...(request.omitAllHeaders
						? {}
						: {
								allHeaders: async () => ({
									...request.headers,
									...(request.contentType
										? { "content-type": request.contentType }
										: {}),
								}),
							}),
					...(request.omitBodyBuffer
						? {}
						: {
								postDataBuffer: () =>
									request.postData === null
										? null
										: Buffer.from(request.postData, "utf8"),
							}),
					headers: () => ({
						...request.headers,
						...(request.contentType
							? { "content-type": request.contentType }
							: {}),
					}),
					method: () => request.method,
					postData: () => request.postData,
					url: () => request.url,
				}),
				fallback: () => {
					outcome = { kind: "fallback" };
					return Promise.resolve();
				},
				abort: () => {
					outcome = { kind: "abort" };
					return Promise.resolve();
				},
				fulfill: (r: { body: Buffer; status: number }) => {
					outcome = {
						body: r.body.toString("utf8"),
						kind: "fulfill",
						status: r.status,
					};
					return Promise.resolve();
				},
			});
			return outcome;
		};
	});
}

test("generated installSequentialHarRoutes: aborts ambiguous polling responses and directly fulfills a unique request", async () => {
	const route = await generatedSequentialRoute([
		seqEntry({
			url: STATUS_URL,
			status: 200,
			body: '{"state":"busy"}',
			seconds: 1,
		}),
		seqEntry({
			url: STATUS_URL,
			status: 200,
			body: '{"state":"done"}',
			seconds: 2,
		}),
		seqEntry({
			url: "https://example.test/api/me",
			status: 200,
			body: "{}",
			seconds: 3,
		}),
	]);
	assert.ok(route, "a differing group installs the route");
	const poll = { method: "GET", postData: null, url: STATUS_URL };
	assert.deepEqual(await route(poll), { kind: "abort" });
	assert.deepEqual(await route(poll), { kind: "abort" });
	assert.deepEqual(await route(poll), { kind: "abort" });
	assert.deepEqual(
		await route({
			method: "GET",
			postData: null,
			url: "https://example.test/api/me",
		}),
		{ kind: "fulfill", body: "{}", status: 200 },
	);
});

test("generated installSequentialHarRoutes: rejects changed credentials and pagination identities", async () => {
	const route = await generatedSequentialRoute([
		seqEntry({
			url: "https://youtube.test/api/profile?key=synthetic-key&continuation=first",
			status: 200,
			body: '{"profile":"synthetic-first"}',
			seconds: 1,
		}),
		seqEntry({
			url: "https://youtube.test/api/profile?continuation=second&key=synthetic-key",
			status: 200,
			body: '{"profile":"synthetic-second"}',
			seconds: 2,
		}),
	]);
	assert.ok(route, "the synthetic HAR has a changing response group");
	assert.deepEqual(
		await route({
			method: "GET",
			postData: null,
			url: "https://youtube.test/api/profile?key=replay-key&continuation=replay-first",
		}),
		{ kind: "abort" },
	);
	assert.deepEqual(
		await route({
			method: "GET",
			postData: null,
			url: "https://youtube.test/api/profile?continuation=replay-second&key=replay-key",
		}),
		{ kind: "abort" },
	);
});

test("generated installSequentialHarRoutes: rejects a singleton with changed credential query values", async () => {
	const route = await generatedSequentialRoute([
		seqEntry({
			url: "https://youtube.test/api/profile?key=synthetic-key&session=recorded-session",
			status: 200,
			body: '{"profile":"synthetic-profile"}',
			seconds: 1,
		}),
	]);
	assert.ok(
		route,
		"a single HAR entry still installs the generic fallback route",
	);
	assert.deepEqual(
		await route({
			method: "GET",
			postData: null,
			url: "https://youtube.test/api/profile?session=replay-session&key=replay-key",
		}),
		{ kind: "abort" },
	);
});

test("generated installSequentialHarRoutes: rejects changed opaque query values", async () => {
	const route = await generatedSequentialRoute([
		seqEntry({
			url: "https://example.test/api/profile?viewer_context=captured&hl=en",
			status: 200,
			body: '{"profile":true}',
			seconds: 1,
		}),
	]);
	assert.ok(route);
	assert.deepEqual(
		await route({
			method: "GET",
			postData: null,
			url: "https://example.test/api/profile?viewer_context=replayed&hl=en",
		}),
		{ kind: "abort" },
	);
});

test("generated installSequentialHarRoutes: rejects a singleton with a different query shape", async () => {
	const route = await generatedSequentialRoute([
		seqEntry({
			url: "https://example.test/api/profile?viewer_context=captured",
			status: 200,
			body: '{"profile":true}',
			seconds: 1,
		}),
	]);
	assert.ok(route);
	assert.deepEqual(
		await route({
			method: "GET",
			postData: null,
			url: "https://example.test/api/profile?replay_context=replayed",
		}),
		{ kind: "abort" },
	);
});

test("generated installSequentialHarRoutes: exact cursor identities replay independently of HAR order", async () => {
	const route = await generatedSequentialRoute([
		seqEntry({
			url: "https://example.test/api/profile?continuation=first",
			status: 200,
			body: '{"cursor":"first"}',
			seconds: 1,
		}),
		seqEntry({
			url: "https://example.test/api/profile?continuation=second",
			status: 200,
			body: '{"cursor":"second"}',
			seconds: 2,
		}),
	]);
	assert.ok(route);
	assert.deepEqual(
		await route({
			method: "GET",
			postData: null,
			url: "https://example.test/api/profile?continuation=second",
		}),
		{ body: '{"cursor":"second"}', kind: "fulfill", status: 200 },
	);
});

test("generated installSequentialHarRoutes: two POSTs to one URL with different bodies are matched by body, not by order", async () => {
	const route = await generatedSequentialRoute([
		seqEntry({
			method: "POST",
			url: GRAPHQL_URL,
			postData: '{"op":"A"}',
			status: 200,
			body: '{"a":1}',
			seconds: 1,
		}),
		seqEntry({
			method: "POST",
			url: GRAPHQL_URL,
			postData: '{"op":"A"}',
			status: 200,
			body: '{"a":2}',
			seconds: 3,
		}),
		seqEntry({
			method: "POST",
			url: GRAPHQL_URL,
			postData: '{"op":"B"}',
			status: 200,
			body: '{"b":1}',
			seconds: 2,
		}),
	]);
	assert.ok(route);
	// B is uniquely identified. A has divergent responses and is ambiguous.
	assert.deepEqual(
		await route({ method: "POST", postData: '{"op":"B"}', url: GRAPHQL_URL }),
		{ body: '{"b":1}', kind: "fulfill", status: 200 },
	);
	assert.deepEqual(
		await route({ method: "POST", postData: '{"op":"A"}', url: GRAPHQL_URL }),
		{ kind: "abort" },
	);
	assert.deepEqual(
		await route({ method: "POST", postData: '{"op":"A"}', url: GRAPHQL_URL }),
		{ kind: "abort" },
	);
});

test("generated installSequentialHarRoutes: installs strict routing even for singleton identities", async () => {
	const route = await generatedSequentialRoute([
		seqEntry({
			method: "POST",
			url: GRAPHQL_URL,
			postData: '{"op":"A"}',
			status: 200,
			body: '{"a":1}',
			seconds: 1,
		}),
		seqEntry({
			method: "POST",
			url: GRAPHQL_URL,
			postData: '{"op":"B"}',
			status: 200,
			body: '{"b":1}',
			seconds: 2,
		}),
	]);
	assert.ok(route);
	assert.deepEqual(
		await route({ method: "POST", postData: '{"op":"C"}', url: GRAPHQL_URL }),
		{ kind: "abort" },
	);
});

const UPLOAD_URL = "https://example.test/upload";
const multipart = (boundary: string, value: string): string =>
	`--${boundary}\r\nContent-Disposition: form-data; name="q"\r\n\r\n${value}\r\n--${boundary}--\r\n`;

/** A fixture that exercises every rule: polling, repeats, POST bodies, multipart, opaque bodies. */
function sharedSequencingFixture() {
	return [
		seqEntry({ url: STATUS_URL, status: 404, body: "", seconds: 1 }),
		seqEntry({
			url: STATUS_URL,
			status: 200,
			body: '{"state":"done"}',
			seconds: 9,
		}),
		seqEntry({
			url: "https://example.test/api/me",
			status: 200,
			body: "{}",
			seconds: 2,
		}),
		seqEntry({
			url: "https://example.test/api/me",
			status: 200,
			body: "{}",
			seconds: 3,
		}),
		seqEntry({
			method: "POST",
			url: GRAPHQL_URL,
			postData: '{"op":"A"}',
			status: 200,
			body: '{"a":1}',
			seconds: 4,
		}),
		seqEntry({
			method: "POST",
			url: GRAPHQL_URL,
			postData: '{"op":"A"}',
			status: 200,
			body: '{"a":2}',
			seconds: 6,
		}),
		seqEntry({
			method: "POST",
			url: GRAPHQL_URL,
			postData: '{"op":"B"}',
			status: 200,
			body: '{"b":1}',
			seconds: 5,
		}),
		// Same multipart content, different random boundaries, differing responses.
		seqEntry({
			method: "POST",
			url: UPLOAD_URL,
			contentType: "multipart/form-data; boundary=AAA111",
			postData: multipart("AAA111", "x"),
			status: 202,
			body: '{"queued":true}',
			seconds: 7,
		}),
		seqEntry({
			method: "POST",
			url: UPLOAD_URL,
			contentType: "multipart/form-data; boundary=BBB222",
			postData: multipart("BBB222", "x"),
			status: 200,
			body: '{"done":true}',
			seconds: 8,
		}),
		// A binary body the HAR kept no text for: never sequenced.
		seqEntry({
			method: "POST",
			url: `${UPLOAD_URL}/bin`,
			contentType: "application/octet-stream",
			bodySize: 512,
			status: 202,
			body: "1",
			seconds: 10,
		}),
		seqEntry({
			method: "POST",
			url: `${UPLOAD_URL}/bin`,
			contentType: "application/octet-stream",
			bodySize: 512,
			status: 200,
			body: "2",
			seconds: 11,
		}),
	];
}

test("sequentialHarResponseGroups: multipart bodies match across random boundaries; an opaque (octet-stream, no text) body is never sequenced", () => {
	const groups = sequentialHarResponseGroups(sharedSequencingFixture());
	const multipartKey = sequentialHarRequestKey(
		"POST",
		UPLOAD_URL,
		multipart("CCC333", "x"),
		"multipart/form-data; boundary=CCC333",
	);
	assert.deepEqual(
		groups.get(multipartKey)?.map((e) => e.response.status),
		[202, 200],
		"one multipart request identity, whatever the boundary",
	);
	assert.equal(
		[...groups.values()].some((group) =>
			group.some((e) => e.request.url === `${UPLOAD_URL}/bin`),
		),
		false,
		"opaque-body entries cannot establish an identity",
	);
});

test("generated installSequentialHarRoutes and sequentialHarResponseGroups agree on a shared fixture", async () => {
	const fixture = sharedSequencingFixture();
	const groups = sequentialHarResponseGroups(fixture);
	const route = await generatedSequentialRoute(fixture);
	assert.ok(route);
	// Repeating a request cannot turn an ambiguous or opaque identity into
	// permission to fabricate a response.
	const asked = new Set<string>();
	for (const entry of fixture) {
		const contentType = entry.request.headers[0]?.value;
		const key = sequentialHarRequestKey(
			entry.request.method,
			entry.request.url,
			entry.request.postData?.text,
			contentType,
		);
		if (asked.has(key)) {
			continue;
		}
		asked.add(key);
		const group = groups.get(key);
		const recorded = fixture.filter(
			(e) =>
				sequentialHarRequestKey(
					e.request.method,
					e.request.url,
					e.request.postData?.text,
					e.request.headers[0]?.value,
				) === key,
		);
		for (let i = 0; i <= recorded.length; i += 1) {
			const served: SequentialRouteOutcome = await route({
				method: entry.request.method,
				postData: entry.request.postData?.text ?? null,
				url: entry.request.url,
				...(contentType ? { contentType } : {}),
			});
			if (
				group ||
				(entry.request.bodySize > 0 && entry.request.postData === undefined)
			) {
				assert.deepEqual(served, { kind: "abort" }, key);
			} else {
				assert.deepEqual(
					served,
					{
						body: entry.response.content.text,
						kind: "fulfill",
						status: entry.response.status,
					},
					key,
				);
			}
		}
	}
	assert.equal(
		groups.size,
		3,
		"polled GET, POST op A, and the multipart upload",
	);
});

// Synthetic request identities only. These regressions prohibit guessed responses.
test("strict identity: a singleton wrong-query GET and ambiguous exact GET cannot match", () => {
	const url = "https://example.test/profile?id=A";
	assert.equal(
		findApiRequestHarMatch(
			[harEntry("GET", url, 200, "A")],
			"GET",
			"https://example.test/profile?id=B",
		),
		undefined,
	);
	assert.equal(
		findApiRequestHarMatch(
			[harEntry("GET", url, 200, "A"), harEntry("GET", url, 200, "B")],
			"GET",
			url,
		),
		undefined,
	);
});

test("strict identity: API POST bodies select their own response and reject unknown bodies", () => {
	const entries = ["A", "B"].map((op) => ({
		...harEntry("POST", GRAPHQL_URL, 200, op),
		request: {
			method: "POST",
			url: GRAPHQL_URL,
			postData: { text: JSON.stringify({ op }) },
		},
	}));
	const match = findApiRequestHarMatch as (
		...args: unknown[]
	) => ApiRequestHarEntry | undefined;
	assert.equal(
		match(entries, "POST", GRAPHQL_URL, '{"op":"B"}')?.response?.content?.text,
		"B",
	);
	assert.equal(match(entries, "POST", GRAPHQL_URL, '{"op":"C"}'), undefined);
});

test("strict identity: browser rejects unknown singleton IDs and unknown cursors", async () => {
	await Promise.all(
		[["id=A"], ["cursor=A", "cursor=B"]].map(async (recorded) => {
			const route = await generatedSequentialRoute(
				recorded.map((query, i) =>
					seqEntry({
						url: "https://example.test/profile?" + query,
						status: 200,
						body: String(i),
						seconds: i,
					}),
				),
			);
			assert.ok(route);
			assert.deepEqual(
				await route({
					method: "GET",
					postData: null,
					url:
						"https://example.test/profile?" +
						(recorded.length === 1 ? "id=B" : "cursor=C"),
				}),
				{ kind: "abort" },
			);
		}),
	);
});

async function generatedApiBridge(entries: unknown[]): Promise<
	((urlOrRequest: unknown, options?: unknown) => Promise<never>) & {
		childSource: string;
	}
> {
	return withTmpDirAsync(async (dir) => {
		const harPath = join(dir, "synthetic.har");
		writeFileSync(harPath, JSON.stringify({ log: { entries } }));
		const preloadPath = writeBrowserHarReplayPreload(
			{
				fixedNowIso: undefined,
				harPath,
				storageStatePath: join(dir, "synthetic-state.json"),
				harEntryCount: entries.length,
			},
			{},
		);
		let source: string;
		try {
			source = readFileSync(preloadPath, "utf8");
		} finally {
			rmSync(preloadPath, { force: true });
		}
		const begin = source.indexOf("// BEGIN strictHarRequestIdentity");
		const end = source.indexOf("// BEGIN installSequentialHarRoutes");
		assert.ok(begin >= 0 && end > begin);
		const childSource =
			"let apiRequestFallbackMatchCount = 0; let apiRequestUnsupportedCount = 0;\n" +
			source.slice(begin, end);
		// Never alter the unit-test runner's exit code when exercising denial.
		const fakeProcess = {
			exitCode: 0,
			once: (_event: string, _listener: () => void) => {},
		};
		const install = new Function(
			"readFileSync",
			"HAR_PATH",
			"Buffer",
			"createHash",
			"process",
			childSource + "\nreturn installApiRequestContextHarBridge;",
		)(readFileSync, harPath, Buffer, createHash, fakeProcess) as (
			context: unknown,
		) => void;
		const request = Object.create({});
		install({ request });
		return Object.assign(request.fetch.bind(request), { childSource });
	});
}

test("strict identity: pure JSON/form body matching is sound while all API body options remain unsupported", async () => {
	const entries = [
		{
			...harEntry("POST", GRAPHQL_URL, 200, "A"),
			request: {
				method: "POST",
				url: GRAPHQL_URL,
				postData: {
					text: '{"op":"A","variables":{"x":1}}',
					mimeType: "application/json",
				},
				headers: [{ name: "content-type", value: "application/json" }],
			},
		},
		{
			...harEntry("POST", GRAPHQL_URL, 200, "B"),
			request: {
				method: "POST",
				url: GRAPHQL_URL,
				postData: {
					text: '{"op":"B","variables":{"x":1}}',
					mimeType: "application/json",
				},
				headers: [{ name: "content-type", value: "application/json" }],
			},
		},
		{
			...harEntry("POST", UPLOAD_URL, 200, "form-B"),
			request: {
				method: "POST",
				url: UPLOAD_URL,
				postData: {
					text: "op=B",
					mimeType: "application/x-www-form-urlencoded",
				},
				headers: [
					{ name: "content-type", value: "application/x-www-form-urlencoded" },
				],
			},
		},
	];
	assert.equal(
		findApiRequestHarMatch(
			entries,
			"POST",
			GRAPHQL_URL,
			'{"variables":{"x":1},"op":"B"}',
			{ "content-type": "application/json" },
		)?.response?.content?.text,
		"B",
	);
	assert.equal(
		findApiRequestHarMatch(entries, "POST", UPLOAD_URL, "op=B", {
			"content-type": "application/x-www-form-urlencoded",
		})?.response?.content?.text,
		"form-B",
	);
	assert.equal(
		findApiRequestHarMatch(entries, "POST", GRAPHQL_URL, '{"op":"C"}', {
			"content-type": "application/json",
		}),
		undefined,
	);
	const fetch = await generatedApiBridge(entries);
	await Promise.all(
		[
			{ method: "POST", data: { op: "B", variables: { x: 1 } } },
			{
				method: "POST",
				data: '{"op":"B","variables":{"x":1}}',
				headers: { "content-type": "application/json" },
			},
			{ method: "POST", form: { op: "B" } },
			{ method: "POST", multipart: { op: "B" } },
		].map(async (options) => {
			await assert.rejects(
				() => fetch(GRAPHQL_URL, options),
				/effective request identity unavailable/,
			);
		}),
	);
});

test("strict identity: API bridge miss and unsupported inputs never disclose URL or body values", async () => {
	const fetch = await generatedApiBridge([]);
	await Promise.all(
		[
			{},
			{ method: "POST", multipart: { value: "SYNTHETIC_PRIVATE_BODY" } },
		].map(async (options) => {
			await assert.rejects(
				() =>
					fetch(
						"https://example.test/private?token=SYNTHETIC_PRIVATE_URL",
						options,
					),
				(error: unknown) => {
					assert.ok(error instanceof Error);
					assert.doesNotMatch(
						String(error.stack),
						/SYNTHETIC_PRIVATE|https:|token=/,
					);
					assert.equal(error.cause, undefined);
					return true;
				},
			);
		}),
	);
});

test("strict identity: pure matcher respects authorization, custom headers and Vary", () => {
	const url = "https://example.test/private";
	const entries = ["A", "B"].map((value) => ({
		...harEntry("GET", url, 200, value),
		request: {
			method: "GET",
			url,
			headers: [
				{ name: "authorization", value },
				{ name: "x-view", value },
			],
		},
		response: {
			status: 200,
			content: { text: value },
			headers: [{ name: "vary", value: "x-view" }],
		},
	}));
	assert.equal(
		findApiRequestHarMatch(entries, "GET", url, undefined, {
			authorization: "B",
			"x-view": "B",
		})?.response?.content?.text,
		"B",
	);
	assert.equal(
		findApiRequestHarMatch(entries, "GET", url, undefined, {
			authorization: "C",
			"x-view": "B",
		}),
		undefined,
	);
	assert.equal(findApiRequestHarMatch(entries, "GET", url), undefined);
	assert.equal(
		findApiRequestHarMatch(
			[
				{
					...harEntry("GET", url, 200, "wildcard"),
					response: {
						status: 200,
						content: { text: "wildcard" },
						headers: [{ name: "vary", value: "*" }],
					},
				},
			],
			"GET",
			url,
		),
		undefined,
	);
});

test("strict identity: browser rejects indistinguishable requests with divergent responses", async () => {
	const route = await generatedSequentialRoute([
		seqEntry({ url: STATUS_URL, status: 404, body: "pending", seconds: 1 }),
		seqEntry({ url: STATUS_URL, status: 200, body: "ready", seconds: 2 }),
	]);
	assert.ok(route);
	assert.deepEqual(
		await route({ method: "GET", postData: null, url: STATUS_URL }),
		{ kind: "abort" },
	);
});

test("replay response JSON errors do not expose synthetic payload fragments", async () => {
	const response = buildApiResponseFromHarEntry(
		harEntry(
			"GET",
			"https://example.test/json",
			200,
			'{"SYNTHETIC_PRIVATE_JSON": broken}',
		),
	);
	await assert.rejects(
		() => response.json(),
		(error: unknown) => {
			assert.ok(error instanceof Error);
			assert.doesNotMatch(String(error.stack), /SYNTHETIC_PRIVATE_JSON/);
			assert.equal(error.cause, undefined);
			return true;
		},
	);
});

test("strict identity: JSON normalization cannot collapse lossy numbers or duplicate keys", () => {
	const entries = [
		{
			...harEntry("POST", GRAPHQL_URL, 200, "large"),
			request: {
				method: "POST",
				url: GRAPHQL_URL,
				headers: [{ name: "content-type", value: "application/json" }],
				postData: { text: '{"n":9007199254740993}' },
			},
		},
		{
			...harEntry("POST", GRAPHQL_URL, 200, "duplicate"),
			request: {
				method: "POST",
				url: GRAPHQL_URL,
				headers: [{ name: "content-type", value: "application/json" }],
				postData: { text: '{"op":"A","op":"B"}' },
			},
		},
	];
	assert.equal(
		findApiRequestHarMatch(
			entries,
			"POST",
			GRAPHQL_URL,
			'{"n":9007199254740992}',
			{ "content-type": "application/json" },
		),
		undefined,
	);
	assert.equal(
		findApiRequestHarMatch(entries, "POST", GRAPHQL_URL, '{"op":"B"}', {
			"content-type": "application/json",
		}),
		undefined,
	);
});

test("strict identity: Vary can make otherwise incidental browser headers relevant", async () => {
	const url = "https://example.test/vary";
	const entries = ["A", "B"].map((value, i) => ({
		...seqEntry({ url, status: 200, body: value, seconds: i }),
		request: { method: "GET", url, headers: [{ name: "User-Agent", value }] },
		response: {
			status: 200,
			content: { text: value },
			headers: [{ name: "Vary", value: "User-Agent" }],
		},
	}));
	const route = await generatedSequentialRoute(entries);
	assert.ok(route);
	assert.deepEqual(
		await route({
			method: "GET",
			postData: null,
			url,
			headers: { "user-agent": "B" },
		}),
		{ body: "B", kind: "fulfill", status: 200 },
	);
	assert.deepEqual(await route({ method: "GET", postData: null, url }), {
		kind: "abort",
	});
});

test("browser evidence diagnostics never expose malformed session data or evidence paths", () => {
	withTmpDir((dir) => {
		writeHar(join(dir, "run-0.har"), 1);
		writeFileSync(
			join(dir, "run-0.storage-state.json"),
			'{"SYNTHETIC_PRIVATE_SESSION": broken}',
		);
		for (const run of [
			browserRun({}),
			browserRun({ har_path: "SYNTHETIC_PRIVATE_HAR_PATH" }),
			browserRun({ storage_state_path: "SYNTHETIC_PRIVATE_SESSION_PATH" }),
			{
				...browserRun({}),
				environment: { network: { driver: "SYNTHETIC_PRIVATE_DRIVER" } },
			} as unknown as ScenarioRun,
		]) {
			assert.throws(
				() => resolveBrowserEvidence(dir, run),
				(error: unknown) => {
					assert.ok(error instanceof BrowserReplayEvidenceError);
					assert.doesNotMatch(String(error.stack), /SYNTHETIC_PRIVATE/);
					assert.equal(error.cause, undefined);
					return true;
				},
			);
		}
	});
});

test("strict identity: multipart framing cannot collide with literal field contents", async () => {
	const recorded = multipart("AAA", "--BOUNDARY");
	const different = multipart("BBB", "--BBB");
	assert.notEqual(
		sequentialHarRequestKey(
			"POST",
			UPLOAD_URL,
			recorded,
			"multipart/form-data; boundary=AAA",
		),
		sequentialHarRequestKey(
			"POST",
			UPLOAD_URL,
			different,
			"multipart/form-data; boundary=BBB",
		),
	);
	const route = await generatedSequentialRoute([
		seqEntry({
			method: "POST",
			url: UPLOAD_URL,
			postData: recorded,
			contentType: "multipart/form-data; boundary=AAA",
			status: 200,
			body: "synthetic",
			seconds: 1,
		}),
	]);
	assert.ok(route);
	assert.deepEqual(
		await route({
			method: "POST",
			url: UPLOAD_URL,
			postData: different,
			contentType: "multipart/form-data; boundary=BBB",
		}),
		{ kind: "abort" },
	);
});

test("strict identity: browser aborts when complete headers or body bytes are unavailable", async () => {
	const route = await generatedSequentialRoute([
		seqEntry({
			method: "POST",
			url: GRAPHQL_URL,
			postData: "synthetic",
			status: 200,
			body: "response",
			seconds: 1,
		}),
	]);
	assert.ok(route);
	await Promise.all(
		[{ omitAllHeaders: true }, { omitBodyBuffer: true }].map(
			async (missing) => {
				assert.deepEqual(
					await route({
						method: "POST",
						url: GRAPHQL_URL,
						postData: "synthetic",
						...missing,
					}),
					{ kind: "abort" },
				);
			},
		),
	);
});

test("API bridge fails closed when context-added effective identity cannot be observed", async () => {
	const url = "https://example.test/public";
	const fetch = await generatedApiBridge([harEntry("GET", url, 200, "public")]);
	// Neither an exact URL nor a Request's headers proves that fetch will not
	// add context defaults or cookies. Both must stay unsupported.
	await Promise.all(
		[
			url,
			{
				url: () => url,
				method: () => "GET",
				headers: () => ({}),
				allHeaders: async () => ({}),
				postData: () => null,
				postDataBuffer: () => null,
			},
		].map(async (request) => {
			await assert.rejects(() => fetch(request));
		}),
	);
});

test("caught unsupported API replay stays a process failure even after process.exit(0)", async () => {
	const fetch = await generatedApiBridge([]);
	const program =
		fetch.childSource +
		[
			"const request = Object.create({});",
			"installApiRequestContextHarBridge({ request });",
			'try { await request.fetch("https://example.test/synthetic"); } catch {}',
			"process.stdout.write(String(apiRequestUnsupportedCount));",
			"process.exit(0);",
		].join("\n");
	const child = spawnSync(
		process.execPath,
		["--input-type=module", "-e", program],
		{ encoding: "utf8", timeout: 10_000 },
	);
	assert.equal(child.signal, null);
	assert.equal(
		child.status,
		1,
		"catching replay denial and explicitly exiting zero must not mask it",
	);
	assert.equal(child.stdout, "1");
	assert.equal(child.stderr, "");
});
