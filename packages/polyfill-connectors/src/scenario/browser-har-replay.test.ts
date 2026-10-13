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

test("findApiRequestHarMatch: GET falls back to the same origin+pathname entry sharing the most query-name/value agreement, ignoring an unrelated same-pathname entry with a disjoint query", () => {
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
	assert.equal(match?.response?.content?.text, "fallback-match");
});

test("findApiRequestHarMatch: GET fallback picks the HIGHEST-scoring candidate when several share the pathname and at least one query name", () => {
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
	assert.equal(match?.response?.content?.text, "both-shared-values-match");
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

test("sequentialHarResponseGroups: a polled URL whose responses differ replays in recorded order; identical repeats and single entries are left to routeFromHAR", () => {
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
		[404, 404, 200],
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

/**
 * The generated preload's own `installSequentialHarRoutes`, cut out of the
 * real generated source between its BEGIN/END markers and run against a fake
 * context, so the inline copy (not only the TS rule) is what is tested.
 */
async function generatedSequentialRoute(
	entries: unknown[],
): Promise<
	| ((request: {
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
			`${source.slice(begin, end)}\nreturn installSequentialHarRoutes;`,
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

test("generated installSequentialHarRoutes: serves a polled URL in recorded order (equal-size bodies), repeats the last, and leaves other requests to routeFromHAR", async () => {
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
	assert.deepEqual(await route(poll), {
		body: '{"state":"busy"}',
		kind: "fulfill",
		status: 200,
	});
	assert.deepEqual(await route(poll), {
		body: '{"state":"done"}',
		kind: "fulfill",
		status: 200,
	});
	assert.deepEqual(await route(poll), {
		body: '{"state":"done"}',
		kind: "fulfill",
		status: 200,
	});
	assert.deepEqual(
		await route({
			method: "GET",
			postData: null,
			url: "https://example.test/api/me",
		}),
		{ kind: "fallback" },
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
	// B first, although A was recorded first: B is not a sequence and falls
	// back to routeFromHAR (which matches the POST body); A keeps its order.
	assert.deepEqual(
		await route({ method: "POST", postData: '{"op":"B"}', url: GRAPHQL_URL }),
		{ kind: "fallback" },
	);
	assert.deepEqual(
		await route({ method: "POST", postData: '{"op":"A"}', url: GRAPHQL_URL }),
		{ body: '{"a":1}', kind: "fulfill", status: 200 },
	);
	assert.deepEqual(
		await route({ method: "POST", postData: '{"op":"A"}', url: GRAPHQL_URL }),
		{ body: '{"a":2}', kind: "fulfill", status: 200 },
	);
});

test("generated installSequentialHarRoutes: installs nothing when no request identity has differing responses", async () => {
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
	assert.equal(route, null);
});
