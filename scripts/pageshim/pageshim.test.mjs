// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Gate for the pageshim build target: build each manifest-compatible connector
// and run it in the PageShim harness against recorded fixtures. Each derived
// capability needs scripts/pageshim/fixtures/<name>.mjs exporting
// `pageshimCase`; a connector without one fails here.
//
// run: node --test scripts/pageshim/pageshim.test.mjs  (needs Playwright Chromium)

import assert from "node:assert/strict";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";
import { buildPageshim } from "./build.mjs";
import { pageShimConnectors } from "./capabilities.mjs";
import { desktopRecords } from "./fixtures/anthropic-desktop.mjs";
import { runHarness } from "./harness.mjs";

const scratchRoot = fileURLToPath(
	new URL("../../.tmp/pageshim/", import.meta.url),
);
mkdirSync(scratchRoot, { recursive: true });
const out = mkdtempSync(join(scratchRoot, "run-"));
const NODE_ONLY = new Set([
	"crypto",
	"fs",
	"fs/promises",
	"os",
	"patchright",
	"readline",
]);
const manifestVersion = (name) =>
	JSON.parse(
		readFileSync(
			new URL(`../../connectors/${name}/manifest.json`, import.meta.url),
			"utf8",
		),
	).version;

function assertCleanRun(run) {
	assert.deepEqual(
		run.stubHits,
		[],
		"the bundle called a Node-only stub or a missing Page member",
	);
}

function assertFatal(run, c, name, { errorClass, phase, requestedScopes }) {
	assert.deepEqual(run.ret, { ok: true }, run.log.slice(-20).join("\n"));
	assertCleanRun(run);
	// Legacy shape: an empty result whose only error is the fatal one.
	assert.deepEqual(run.result.requestedScopes, requestedScopes);
	assert.equal(run.result.version, manifestVersion(name));
	assert.deepEqual(run.result.exportSummary, c.emptyExportSummary);
	assert.equal(run.result.errors.length, 1, JSON.stringify(run.result.errors));
	const [error] = run.result.errors;
	assert.deepEqual(Object.keys(error), [
		"errorClass",
		"reason",
		"disposition",
		"phase",
	]);
	assert.equal(error.errorClass, errorClass);
	assert.equal(error.disposition, "fatal");
	assert.equal(error.phase, phase);
	assert.equal(run.data.error, error.reason);
	for (const scope of c.scopes) assert.equal(run.result[scope], undefined);
}

for (const name of pageShimConnectors(
	fileURLToPath(new URL("../..", import.meta.url)),
)) {
	test(`${name}: pageshim gate`, { timeout: 600_000 }, async (t) => {
		let c;
		try {
			({ pageshimCase: c } = await import(`./fixtures/${name}.mjs`));
		} catch (error) {
			assert.fail(`${name} has no fixtures/${name}.mjs: ${error.message}`);
		}
		assert.ok(c, `fixtures/${name}.mjs must export pageshimCase`);
		const suppliedBundle =
			process.env.PAGESHIM_CONNECTOR === name
				? process.env.PAGESHIM_BUNDLE
				: undefined;
		const built = suppliedBundle
			? { outfile: suppliedBundle, stubbed: [] }
			: await buildPageshim({
					connector: name,
					outfile: join(out, `${name}.js`),
				});
		const run = (o) =>
			runHarness({ bundle: built.outfile, fixtures: c.fixtures, ...o });

		await t.test("stubs only Node-only modules", () => {
			for (const spec of built.stubbed)
				assert.ok(NODE_ONLY.has(spec), `unexpected stub: ${spec}`);
		});

		const assertComplete = (r) => {
			assert.deepEqual(r.ret, { ok: true }, r.log.slice(-20).join("\n"));
			assert.equal(r.data.error, undefined);
			assertCleanRun(r);
			assert.deepEqual(r.result.errors, c.partialErrors ?? []);
			if (c.partialErrors) assert.match(r.data.status, /^Partial:/);
			else assert.match(r.data.status, /^Complete!/);
			for (const scope of c.scopes)
				assert.ok(r.result[scope], `missing ${scope}`);
			assert.deepEqual(r.result.exportSummary, c.exportSummary);
			// The export version is the connector manifest's semver.
			assert.equal(r.result.version, manifestVersion(name));
		};

		await t.test("signed in: every scope", async () => {
			const r = await run({ scopes: c.scopes });
			assertComplete(r);
			assert.equal(r.calls.showBrowser, undefined, "must not ask for login");
		});

		await t.test("signed out, then sign-in: every scope", async () => {
			const r = await run({ scopes: c.scopes, loginAfterMs: 5000 });
			assertComplete(r);
			assert.equal(r.calls.showBrowser, 1);
			assert.equal(r.calls.promptUser, 1);
			assert.equal(r.calls.goHeadless, 1);
		});

		await t.test("empty requestedScopes: protocol_violation", async () => {
			const r = await run({ scopes: [] });
			assertFatal(r, c, name, {
				errorClass: "protocol_violation",
				phase: "init",
				requestedScopes: c.scopes,
			});
		});

		await t.test("foreign requestedScopes: protocol_violation", async () => {
			const r = await run({ scopes: [c.scopes[0], "other.thing"] });
			assertFatal(r, c, name, {
				errorClass: "protocol_violation",
				phase: "init",
				requestedScopes: c.scopes,
			});
		});

		await t.test("login wait runs out: auth_failed", async () => {
			const r = await run({
				scopes: c.scopes,
				loginAfterMs: Number.POSITIVE_INFINITY,
				loginWaitMs: 3000,
			});
			assertFatal(r, c, name, {
				errorClass: "auth_failed",
				phase: "collect",
				requestedScopes: c.scopes,
			});
		});
	});
}

test("chatgpt: complete bounded walk is not marked partial just because STATE was emitted", {
	timeout: 180_000,
}, async () => {
	const fx = await import("./fixtures/chatgpt.mjs");
	fx.useConversationCount(1);
	try {
		const built = await buildPageshim({
			connector: "chatgpt",
			outfile: join(out, "chatgpt-complete.js"),
		});
		const r = await runHarness({
			bundle: built.outfile,
			fixtures: fx.pageshimCase.fixtures,
			scopes: fx.pageshimCase.scopes,
		});
		assert.deepEqual(r.ret, { ok: true }, r.log.slice(-20).join("\n"));
		assertCleanRun(r);
		assert.deepEqual(r.result.errors, []);
		assert.match(r.data.status, /^Complete!/);
		assert.deepEqual(r.result.exportSummary, {
			count: 1,
			label: "conversation",
			details: { conversations: 1, messages: 1 },
		});
	} finally {
		fx.useConversationCount(2);
	}
});

test("chatgpt: default walk has no 50-detail cap", {
	timeout: 180_000,
}, async () => {
	const fx = await import("./fixtures/chatgpt.mjs");
	fx.useConversationCount(51);
	try {
		const built = await buildPageshim({
			connector: "chatgpt",
			outfile: join(out, "chatgpt-full-walk.js"),
		});
		const r = await runHarness({
			bundle: built.outfile,
			fixtures: fx.pageshimCase.fixtures,
			scopes: fx.pageshimCase.scopes,
			env: {
				PDPP_CHATGPT_PACING_INITIAL_INTERVAL_MS: "1",
				PDPP_CHATGPT_PACING_MIN_INTERVAL_MS: "1",
			},
		});
		assert.deepEqual(r.ret, { ok: true }, r.log.slice(-20).join("\n"));
		assertCleanRun(r);
		assert.deepEqual(r.result.errors, []);
		assert.equal(r.result["chatgpt.conversations"].records.length, 51);
		assert.equal(r.result["chatgpt.messages"].records.length, 51);
		assert.match(r.data.status, /^Complete!/);
	} finally {
		fx.useConversationCount(2);
	}
});

test("chatgpt: 30-day PageShim filters old details and keeps scanning mixed pages", {
	timeout: 180_000,
}, async () => {
	const fx = await import("./fixtures/chatgpt.mjs");
	const built = await buildPageshim({
		connector: "chatgpt",
		outfile: join(out, "chatgpt-30d.js"),
		sinceDays: 30,
		streamResults: true,
	});
	const now = Date.now() / 1000;
	const detailCalls = [];
	fx.useConversationCount(4);
	const resolve = (raw) => {
		const response = fx.resolveFixture(raw);
		const url = new URL(raw);
		if (url.pathname === "/backend-api/conversations/search") {
			const body = JSON.parse(response.body);
			body.items = body.items.slice(0, 4).map((item, index) => ({
				...item,
				create_time: now - (index < 2 ? index + 1 : 30 + index) * 86400,
				update_time: now - (index < 2 ? index + 1 : 30 + index) * 86400,
			}));
			body.total = 4;
			body.has_more = false;
			body.next_cursor = null;
			response.body = JSON.stringify(body);
		} else if (/^\/backend-api\/conversation\//.test(url.pathname)) {
			detailCalls.push(url.pathname.split("/").pop());
		}
		return response;
	};
	let r;
	try {
		r = await runHarness({
			bundle: built.outfile,
			fixtures: { ...fx.pageshimCase.fixtures, resolve },
			scopes: fx.pageshimCase.scopes,
			resultStreaming: true,
			resultSpoolDirectory: join(out, "chatgpt-30d-stream"),
		});
	} finally {
		fx.useConversationCount(2);
	}
	assertCleanRun(r);
	const timingLogs = r.log.filter((line) => line.includes("[chatgpt-timing]"));
	assert.equal(timingLogs.length, 2, timingLogs.join("\n"));
	assert.ok(
		timingLogs.every(
			(line) =>
				/providerFetchMs=\d+/.test(line) &&
				/jsProcessMs=\d+/.test(line) &&
				/bridgeCalls=.*ms\/\d+\+\d+B/.test(line) &&
				/bridgeRoundTrips=\d+/.test(line) &&
				/shellAckMs=\d+/.test(line) &&
				/bridgeBytes=\d+/.test(line) &&
				/bytes=\d+/.test(line),
		),
		timingLogs.join("\n"),
	);
	assert.ok(
		timingLogs.every(
			(line) =>
				!line.includes("conv-") &&
				!line.includes("Mobile fixture") &&
				!line.includes("title"),
		),
		timingLogs.join("\n"),
	);
	assert.deepEqual(detailCalls, ["conv-1", "conv-2"]);
	assert.equal(r.streamResult.mode, "stream");
	assert.equal(r.streamResult.completed, true);
	assert.equal(r.streamDone.exportSummary.window?.sinceDays, 30);
	assert.equal(r.streamDone.exportSummary.partial, true);
	assert.equal(r.streamDone.exportSummary.partialReason, "time_window");
	assert.ok(r.streamDone.errors.some((e) => e.reason === "time_window"));
	const conversations = JSON.parse(
		await readFile(r.streamScopeFiles["chatgpt.conversations"], "utf8"),
	);
	assert.deepEqual(
		conversations.records.map((x) => x.id),
		["conv-1", "conv-2"],
	);
	assert.match(r.data.status, /^Partial:/);
});

test("chatgpt: 30-day bundle stops after three old pages without fetching old details", {
	timeout: 180_000,
}, async () => {
	const fx = await import("./fixtures/chatgpt.mjs");
	const built = await buildPageshim({
		connector: "chatgpt",
		outfile: join(out, "chatgpt-30d-full-history.js"),
		sinceDays: 30,
		streamResults: true,
	});
	const cursors = [];
	const detailCalls = [];
	const oldTime = Date.now() / 1000 - 31 * 86400;
	const resolve = (raw) => {
		const url = new URL(raw);
		if (url.pathname === "/backend-api/conversations/search") {
			const cursor = Number(url.searchParams.get("cursor") ?? 0);
			cursors.push(cursor);
			const count = Math.max(0, Math.min(30, 2984 - cursor));
			const items = Array.from({ length: count }, (_, index) => ({
				id: `old-conv-${cursor + index}`,
				title: "Old history fixture",
				create_time: oldTime,
				update_time: oldTime,
				current_node: null,
			}));
			return {
				status: 200,
				contentType: "application/json; charset=utf-8",
				body: JSON.stringify({
					items,
					total: 2984,
					has_more: cursor + count < 2984,
					next_cursor: cursor + count < 2984 ? cursor + count : null,
				}),
			};
		}
		if (/^\/backend-api\/conversation\//.test(url.pathname))
			detailCalls.push(url.pathname);
		return fx.resolveFixture(raw);
	};
	const run = await runHarness({
		bundle: built.outfile,
		fixtures: { ...fx.pageshimCase.fixtures, resolve },
		scopes: fx.pageshimCase.scopes,
		resultStreaming: true,
		gotoDelayMs: 0,
		resultSpoolDirectory: join(out, "chatgpt-30d-full-history-stream"),
	});
	assertCleanRun(run);
	assert.deepEqual(cursors, [0, 30, 60]);
	assert.deepEqual(detailCalls, []);
	assert.equal(run.result.exportSummary.count, 0);
	assert.equal(run.result.exportSummary.window?.sinceDays, 30);
});

test("chatgpt: 30-day walk keeps later in-window rows after older rows on unordered pages", {
	timeout: 180_000,
}, async () => {
	const fx = await import("./fixtures/chatgpt.mjs");
	const built = await buildPageshim({
		connector: "chatgpt",
		outfile: join(out, "chatgpt-30d-unordered-pages.js"),
		sinceDays: 30,
		streamResults: true,
	});
	const now = Date.now() / 1000;
	const cursors = [];
	const detailCalls = [];
	const rowsFor = (cursor) => {
		const daysAgo = (index) => {
			if (cursor === 0) return index === 0 ? 1 : index === 2 ? 2 : 31 + index;
			if (cursor === 30) return index === 1 ? 3 : 31 + index;
			if (cursor === 60) return 40 + index;
			if (cursor === 90) return index === 1 ? 5 : 41 + index;
			return 41 + index;
		};
		const count = cursor <= 180 ? 30 : 0;
		return Array.from({ length: count }, (_, index) => {
			const id =
				cursor === 0 && index === 0
					? "conv-1"
					: cursor === 0 && index === 2
						? "conv-2"
						: cursor === 30 && index === 1
							? "conv-3"
							: cursor === 90 && index === 1
								? "conv-4"
								: `old-${cursor + index}`;
			return {
				id,
				update_time: now - daysAgo(index) * 86400,
			};
		});
	};
	const resolve = (raw) => {
		const response = fx.resolveFixture(raw);
		const url = new URL(raw);
		if (url.pathname === "/backend-api/conversations/search") {
			const cursor = Number(url.searchParams.get("cursor") ?? 0);
			cursors.push(cursor);
			response.body = JSON.stringify({
				items: rowsFor(cursor),
				total: 300,
				has_more: cursor <= 180,
				next_cursor: cursor <= 180 ? cursor + 30 : null,
			});
		} else if (/^\/backend-api\/conversation\//.test(url.pathname)) {
			detailCalls.push(url.pathname.split("/").pop());
		}
		return response;
	};
	fx.useConversationCount(4);
	let run;
	try {
		run = await runHarness({
			bundle: built.outfile,
			fixtures: { ...fx.pageshimCase.fixtures, resolve },
			scopes: fx.pageshimCase.scopes,
			initialState: {
				"chatgpt.conversations": {
					last_update_time: new Date((now - 10 * 86400) * 1000).toISOString(),
				},
				"chatgpt.messages": {
					last_update_time: new Date((now - 10 * 86400) * 1000).toISOString(),
				},
			},
			resultStreaming: true,
			gotoDelayMs: 0,
			resultSpoolDirectory: join(out, "chatgpt-30d-unordered-stream"),
		});
	} finally {
		fx.useConversationCount(2);
	}
	assertCleanRun(run);
	assert.deepEqual(
		cursors,
		[0, 30, 60, 90, 120, 150, 180],
		"the walk must scan every mixed page, then stop after three fully older pages",
	);
	assert.deepEqual(detailCalls, ["conv-1", "conv-2", "conv-3", "conv-4"]);
	const listShapeLogs = run.log.filter((line) =>
		line.includes("[chatgpt-list-shape]"),
	);
	for (const page of [1, 2, 4]) {
		assert.ok(
			listShapeLogs.some(
				(line) =>
					line.includes(`page=${page}`) &&
					line.includes("order=not-newest-first"),
			),
			listShapeLogs.join("\n"),
		);
	}
	const conversations = JSON.parse(
		await readFile(run.streamScopeFiles["chatgpt.conversations"], "utf8"),
	);
	assert.deepEqual(
		conversations.records.map((record) => record.id),
		["conv-1", "conv-2", "conv-3", "conv-4"],
	);
});

test("chatgpt: 30-day PageShim skips missing times and includes later window pages", {
	timeout: 180_000,
}, async () => {
	const fx = await import("./fixtures/chatgpt.mjs");
	const built = await buildPageshim({
		connector: "chatgpt",
		outfile: join(out, "chatgpt-30d-multipage.js"),
		sinceDays: 30,
		streamResults: true,
	});
	const now = Date.now() / 1000;
	const detailCalls = [];
	fx.useConversationCount(60);
	const listCursors = [];
	const resolve = (raw) => {
		const response = fx.resolveFixture(raw);
		const url = new URL(raw);
		if (url.pathname === "/backend-api/conversations/search") {
			const start = Number(url.searchParams.get("cursor") ?? "0");
			listCursors.push(start);
			const pageCount =
				start === 0 ? 30 : start === 30 ? 21 : start === 51 ? 9 : 0;
			const items = Array.from({ length: pageCount }, (_, offset) => {
				const index = start + offset;
				return {
					id: `conv-${index + 1}`,
					...(index < 30
						? {}
						: {
								update_time:
									now - (index < 51 ? index - 29 : index - 20) * 86400,
							}),
				};
			});
			response.body = JSON.stringify({
				items,
				total: 60,
				has_more: start + items.length < 60,
				next_cursor: start + items.length < 60 ? start + items.length : null,
			});
		} else if (/^\/backend-api\/conversation\//.test(url.pathname)) {
			detailCalls.push(url.pathname.split("/").pop());
		}
		return response;
	};
	let r;
	try {
		r = await runHarness({
			bundle: built.outfile,
			fixtures: { ...fx.pageshimCase.fixtures, resolve },
			scopes: fx.pageshimCase.scopes,
			resultStreaming: true,
			resultSpoolDirectory: join(out, "chatgpt-30d-multipage-stream"),
		});
	} finally {
		fx.useConversationCount(2);
	}
	assertCleanRun(r);
	const listShapeLogs = r.log.filter((line) =>
		line.includes("[chatgpt-list-shape]"),
	);
	assert.ok(
		listShapeLogs.some((line) =>
			line.includes("dateFields=none itemShapes=none:30 order=unknown"),
		),
		listShapeLogs.join("\n"),
	);
	assert.ok(
		listShapeLogs.some((line) =>
			line.includes(
				"dateFields=update_time itemShapes=update_time:21 order=newest-first",
			),
		),
		listShapeLogs.join("\n"),
	);
	assert.ok(
		listShapeLogs.every(
			(line) =>
				!line.includes("conv-") &&
				!line.includes("2026-") &&
				!line.includes("title"),
		),
		listShapeLogs.join("\n"),
	);
	assert.deepEqual(listCursors, [0, 30, 30, 30, 51, 51, 51, 81, 81]);
	assert.deepEqual(
		detailCalls,
		Array.from({ length: 21 }, (_, index) => `conv-${index + 31}`),
	);
	assert.equal(r.streamResult?.completed, true);
	assert.equal(r.streamDone.exportSummary.details.conversations, 21);
	assert.equal(r.streamDone.exportSummary.details.messages, 21);
	assert.equal(r.streamDone.exportSummary.partialReason, "time_window");
});

test("chatgpt: capped PageShim walk reports partial with omitted detail evidence", {
	timeout: 180_000,
}, async () => {
	const fx = await import("./fixtures/chatgpt.mjs");
	fx.useConversationCount(2);
	const built = await buildPageshim({
		connector: "chatgpt",
		outfile: join(out, "chatgpt-partial.js"),
	});
	const r = await runHarness({
		bundle: built.outfile,
		fixtures: fx.pageshimCase.fixtures,
		scopes: fx.pageshimCase.scopes,
		env: {
			PDPP_CHATGPT_MAX_DETAIL_FETCHES_PER_RUN: "1",
			PDPP_CHATGPT_MAX_TAIL_DEFERRAL_GAPS_PER_RUN: "1",
		},
	});
	assert.deepEqual(r.ret, { ok: true }, r.log.slice(-20).join("\n"));
	assertCleanRun(r);
	assert.deepEqual(r.result.exportSummary, {
		count: 1,
		label: "conversation",
		details: { conversations: 1, messages: 1 },
	});
	assert.deepEqual(r.result.errors, [
		{
			errorClass: "partial",
			reason:
				"PageShim collected a bounded ChatGPT prefix with conversation details pending. PageShim does not persist STATE or DETAIL_GAP recovery state, so another PageShim run starts a new bounded walk instead of resuming this omitted tail.",
			disposition: "degraded",
			scope: "chatgpt.messages",
			phase: "collect",
		},
	]);
	assert.match(r.data.status, /^Partial:/);
});

test("chatgpt: HTTP 200 without a session token still prompts for login", {
	timeout: 180_000,
}, async () => {
	const fx = await import("./fixtures/chatgpt.mjs");
	fx.setEmptySession(true);
	try {
		const built = await buildPageshim({
			connector: "chatgpt",
			outfile: join(out, "chatgpt-empty-session.js"),
		});
		const r = await runHarness({
			bundle: built.outfile,
			fixtures: fx.pageshimCase.fixtures,
			scopes: fx.pageshimCase.scopes,
			loginWaitMs: 1000,
		});
		assert.deepEqual(r.ret, { ok: true }, r.log.slice(-20).join("\n"));
		assert.equal(r.calls.showBrowser, 1);
		assert.deepEqual(r.pageNavigations, [
			"https://chatgpt.com/",
			"https://chatgpt.com/auth/login",
		]);
		assert.equal(r.result.errors[0].errorClass, "auth_failed");
	} finally {
		fx.setEmptySession(false);
	}
});

test("github_browser: an incomplete stream is an omitted error", {
	timeout: 180_000,
}, async () => {
	const { pageshimCase: c, resolveFixture } = await import(
		"./fixtures/github_browser.mjs"
	);
	const built = await buildPageshim({
		connector: "github_browser",
		outfile: join(out, "github_browser-skip.js"),
	});
	// Starred page that parses to nothing usable.
	const resolve = (raw) => {
		const u = new URL(raw);
		return u.pathname === "/stars/sample-user" ||
			u.searchParams.get("tab") === "stars"
			? { status: 500, contentType: "text/html", body: "<html></html>" }
			: resolveFixture(raw);
	};
	const r = await runHarness({
		bundle: built.outfile,
		fixtures: { ...c.fixtures, resolve },
		scopes: c.scopes,
	});
	assert.deepEqual(r.ret, { ok: true }, r.log.slice(-20).join("\n"));
	assertCleanRun(r);
	assert.equal(r.result["github.starred"], undefined);
	assert.deepEqual(r.result.errors, [
		{
			errorClass: "runtime_error",
			reason: "GitHub did not return a complete result for this stream.",
			disposition: "omitted",
			scope: "github.starred",
			phase: "collect",
		},
	]);
});

test("harness rejects a page member the host does not offer", {
	timeout: 60_000,
}, async () => {
	const { pageshimCase: c } = await import("./fixtures/github_browser.mjs");
	const bundle = join(out, "negative.js");
	writeFileSync(
		bundle,
		"(async () => {\n  await page.requestInput({});\n})();\n",
	);
	const run = await runHarness({ bundle, fixtures: c.fixtures, scopes: [] });
	assert.equal(run.ret.ok, false);
	assert.match(
		run.ret.error,
		/page\.requestInput is not part of the PageShim API/,
	);
});

test("anthropic shim copies the desktop ZIP entry-name regexes exactly", () => {
	const source = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
	const desktop = source(
		"../../packages/polyfill-connectors/src/bounded-zip-archive.ts",
	);
	const shim = source("./shims/anthropic-export.ts");
	for (const name of [
		"UNSAFE_ZIP_ENTRY_NAME_RE",
		"WHITESPACE_PADDED_DOT_DOT_SEGMENT_RE",
	]) {
		const literal = (text) =>
			text.match(new RegExp(`const ${name} =\\s*(/.+/[a-z]*);`))?.[1];
		assert.ok(literal(desktop), `${name} not found in bounded-zip-archive.ts`);
		assert.equal(literal(shim), literal(desktop), name);
	}
});

test("anthropic: export paths on the PageShim host", {
	timeout: 300_000,
}, async (t) => {
	const fx = await import("./fixtures/anthropic.mjs");
	const c = fx.pageshimCase;
	const built = await buildPageshim({
		connector: "anthropic",
		outfile: join(out, "anthropic-paths.js"),
	});
	const run = (o) => {
		fx.reset(o);
		return runHarness({
			bundle: built.outfile,
			fixtures: c.fixtures,
			scopes: c.scopes,
		});
	};
	const assertFatalReason = (r, pattern) => {
		assert.deepEqual(r.ret, { ok: true }, r.log.slice(-20).join("\n"));
		assertCleanRun(r);
		assert.equal(r.result.errors.length, 1, JSON.stringify(r.result.errors));
		assert.equal(r.result.errors[0].disposition, "fatal");
		assert.match(r.result.errors[0].reason, pattern);
		assert.equal(r.data.error, r.result.errors[0].reason);
		for (const scope of c.scopes) assert.equal(r.result[scope], undefined);
	};

	const streams = c.scopes.map((scope) => scope.replace(/^claude\./, ""));
	const pageshimRecords = (r) =>
		Object.fromEntries(
			c.scopes.map((scope) => [
				scope,
				(r.result[scope]?.records ?? []).map(({ blob_ref: _, ...x }) => x),
			]),
		);

	await t.test("records deep-equal the desktop collectAnthropic", async () => {
		const r = await run();
		assertCleanRun(r);
		assert.deepEqual(r.result.errors, []);
		assert.equal(r.calls.captureDownload, 1);
		assert.equal(r.calls.extractZipEntries, 1);
		assert.ok(
			r.calls.readZipEntryChunk > 0,
			"collector uses bounded entry reads",
		);
		assert.deepEqual(fx.counts, { exportRequests: 1, mints: 1 });
		// No blob store on this host, so no blob_ref.
		for (const x of r.result["claude.conversations"].records)
			assert.equal(x.blob_ref, undefined);
		const desktop = await desktopRecords(fx.syntheticExport, streams);
		assert.deepEqual(
			Object.fromEntries(
				streams.map((s) => [s, desktop[`claude.${s}`].length]),
			),
			c.exportSummary.details,
		);
		assert.deepEqual(pageshimRecords(r), desktop);
	});

	await t.test("streamed result records deep-equal Desktop", async () => {
		const streamBundle = await buildPageshim({
			connector: "anthropic",
			outfile: join(out, "anthropic-streamed.js"),
			streamResults: true,
		});
		const spool = mkdtempSync(join(out, "anthropic-result-"));
		try {
			const r = await runHarness({
				bundle: streamBundle.outfile,
				fixtures: c.fixtures,
				scopes: c.scopes,
				resultStreaming: true,
				resultSpoolDirectory: spool,
			});
			assert.deepEqual(r.ret, { ok: true }, r.log.slice(-20).join("\n"));
			assert.equal(r.streamResult?.completed, true);
			const streamed = Object.fromEntries(
				Object.entries(r.streamScopeFiles).map(([scope, path]) => [
					scope,
					JSON.parse(readFileSync(path, "utf8")).records,
				]),
			);
			const desktop = await desktopRecords(fx.syntheticExport, streams);
			assert.deepEqual(streamed, desktop);
		} finally {
			rmSync(spool, { recursive: true, force: true });
		}
	});

	// Archives the desktop reader refuses. The shim must refuse them too.
	const refused = {
		"a duplicate entry name": [
			["conversations.json", []],
			["conversations.json", []],
		],
		"a traversal entry name": [
			["../evil.json", {}],
			["conversations.json", []],
		],
		"an absolute entry name": [
			["/abs.json", {}],
			["conversations.json", []],
		],
		"an entry that does not inflate": [
			["conversations.json", Buffer.from([0xff, 0xff, 0xff, 0xff])],
		],
	};
	for (const [label, entries] of Object.entries(refused))
		await t.test(`${label}: fatal, as on desktop`, async () => {
			const zip = fx.zipOf(entries);
			await assert.rejects(desktopRecords(zip, streams));
			assertFatalReason(await run({ zip }), /./);
		});

	await t.test("layout not recognized: fail closed, no records", async () => {
		const r = await run({
			zip: fx.zipOf({
				"memories.json": [{ id: "m1" }],
				"users.json": [{ uuid: "u1" }],
			}),
		});
		assert.deepEqual(r.ret, { ok: true }, r.log.slice(-20).join("\n"));
		assertCleanRun(r);
		assert.equal(r.data.error, undefined);
		for (const scope of c.scopes) assert.equal(r.result[scope], undefined);
		assert.deepEqual(
			r.result.errors.map((e) => [e.scope, e.disposition]),
			c.scopes.map((s) => [s, "omitted"]),
		);
		for (const e of r.result.errors)
			assert.match(e.reason, /does not claim the account is empty/);
		assert.deepEqual(r.result.exportSummary, c.emptyExportSummary);
	});

	for (const [label, value] of [
		["object root", {}],
		["null root", null],
		["invalid JSON", deflateRawSync(Buffer.from("{"))],
	]) {
		await t.test(
			`conversation ${label}: same fail-closed result as Desktop`,
			async () => {
				const zip = fx.zipOf({ "conversations.json": value });
				const desktop = await desktopRecords(zip, streams);
				assert.ok(
					Object.values(desktop).every((records) => records.length === 0),
				);
				const r = await run({ zip });
				assert.deepEqual(r.ret, { ok: true }, r.log.slice(-20).join("\n"));
				assertCleanRun(r);
				assert.deepEqual(
					r.result.errors.map((e) => e.disposition),
					c.scopes.map(() => "omitted"),
				);
				for (const scope of c.scopes) assert.equal(r.result[scope], undefined);
			},
		);
	}

	await t.test(
		"export not ready, then ready: polls the same nonce",
		async () => {
			const r = await run({ notReadyPolls: 1 });
			assertCleanRun(r);
			assert.deepEqual(r.result.errors, []);
			assert.deepEqual(r.result.exportSummary, c.exportSummary);
			assert.equal(r.calls.captureDownload, 2);
			assert.deepEqual(fx.counts, { exportRequests: 1, mints: 2 });
		},
	);

	await t.test("spent nonce: the host error ends the run", async () => {
		const r = await run({ mintFailure: { error: "nonce consumed" } });
		assertFatalReason(r, /could not be downloaded \(consumed\)/);
		assert.equal(r.calls.captureDownload, 1);
	});

	await t.test("multi-part export format: fatal, named", async () => {
		const r = await run({ exportFormat: "new" });
		assertFatalReason(r, /multi-part export format/);
		assert.equal(r.calls.captureDownload, undefined);
		// The storage URL is never loaded in the WebView.
		assert.ok(
			!r.log.some((l) => l.includes("claude-export.test")),
			r.log.join("\n"),
		);
		assert.equal(r.calls.goto, 1);
	});
});

test("anthropic: five-part metadata-only shell contract reads part entries through bounded chunks", {
	timeout: 300_000,
}, async () => {
	const fx = await import("./fixtures/anthropic.mjs");
	const c = fx.pageshimCase;
	const built = await buildPageshim({
		connector: "anthropic",
		outfile: join(out, "anthropic-multipart-chunks.js"),
	});
	const partData = [
		{
			category: "conversations",
			filename: "conversations-1.zip",
			entry: [
				"conversations.json",
				[
					{
						uuid: "conv-multipart",
						name: "multipart conversation",
						updated_at: "2026-01-20T00:00:00.000Z",
						chat_messages: [
							{
								uuid: "msg-multipart",
								sender: "human",
								created_at: "2026-01-20T00:00:00.000Z",
								content: [{ type: "text", text: "part bytes" }],
							},
						],
					},
				],
			],
		},
		{
			category: "projects",
			filename: "projects-1.zip",
			entry: [
				"projects/project-multipart.json",
				{
					uuid: "project-multipart",
					name: "multipart project",
					updated_at: "2026-01-20T00:00:00.000Z",
					docs: [
						{
							uuid: "doc-multipart",
							filename: "part.md",
							content: "part bytes",
							updated_at: "2026-01-20T00:00:00.000Z",
						},
					],
				},
			],
		},
		{
			category: "light_metadata",
			filename: "light-metadata-1.zip",
			entry: ["users.json", [{ full_name: "Sample User" }]],
		},
		{
			category: "memories",
			filename: "memories-1.zip",
			entry: ["memories.json", [{ uuid: "out-of-scope-memory" }]],
		},
		{
			category: "design_chats",
			filename: "design-chats-1.zip",
			entry: ["design_chats.json", [{ uuid: "out-of-scope-chat" }]],
		},
	];
	const archives = new Map(
		partData.map((part, index) => [
			`part-${index + 1}`,
			fx.zipOf([part.entry]),
		]),
	);
	const manifest = {
		version: "1",
		total_files: partData.length,
		data_files: partData.map((part, index) => ({
			batch_index: 0,
			category: part.category,
			part: index + 1,
			filename: part.filename,
			export_url: `https://claude.ai/export/org-syn-0000-0000-0000-000000000001/download/part-${index + 1}`,
		})),
	};
	const shellFixtures = {
		...c.fixtures,
		resolve(raw) {
			const url = new URL(raw);
			if (
				url.pathname ===
				"/api/organizations/org-syn-0000-0000-0000-000000000001/export_data"
			)
				return {
					status: 200,
					contentType: "application/json",
					body: JSON.stringify(manifest),
				};
			const mint = /\/export_signed_url\/part-(\d+)$/.exec(url.pathname);
			if (mint)
				return {
					status: 200,
					contentType: "application/json",
					body: JSON.stringify({
						signed_url: `https://storage.claude-export.test/part-${mint[1]}.zip`,
					}),
				};
			const archive = /^\/part-(\d+)\.zip$/.exec(url.pathname);
			if (url.hostname === "storage.claude-export.test" && archive)
				return {
					status: 200,
					contentType: "application/zip",
					body: archives.get(`part-${archive[1]}`),
				};
			return c.fixtures.resolve(raw);
		},
	};
	const run = await runHarness({
		bundle: built.outfile,
		fixtures: shellFixtures,
		scopes: c.scopes,
	});
	assert.deepEqual(run.ret, { ok: true }, run.log.slice(-20).join("\n"));
	assertCleanRun(run);
	assert.equal(run.calls.captureDownload, 5);
	assert.equal(run.calls.extractZipEntries, 5);
	assert.ok(
		run.calls.readZipEntryChunk > 0,
		"part JSON must be read through the shell chunk API",
	);
	assert.deepEqual(
		run.result["claude.conversations"]?.records?.map((record) => record.id),
		["conv-multipart"],
		JSON.stringify({
			result: run.result,
			data: run.data,
			log: run.log.slice(-20),
		}),
	);
	assert.deepEqual(
		run.result["claude.messages"]?.records?.map((record) => record.id),
		["msg-multipart"],
	);
	assert.deepEqual(
		run.result["claude.projects"]?.records?.map((record) => record.id),
		["project-multipart"],
	);
	assert.deepEqual(
		run.result["claude.project_documents"]?.records?.map((record) => record.id),
		["doc-multipart"],
	);
});

test("anthropic: 30-day window filters records during streamed collection and marks the result partial", {
	timeout: 300_000,
}, async () => {
	const fx = await import("./fixtures/anthropic.mjs");
	const c = fx.pageshimCase;
	const zip = fx.zipOf({
		"conversations.json": [
			{
				uuid: "conv-recent",
				name: "recent",
				updated_at: "2026-01-20T00:00:00.000Z",
				chat_messages: [
					{
						uuid: "msg-recent",
						sender: "human",
						created_at: "2026-01-20T00:00:00.000Z",
						content: [{ type: "text", text: "recent" }],
					},
				],
			},
			{
				uuid: "conv-old",
				name: "old",
				updated_at: "2025-12-31T00:00:00.000Z",
				chat_messages: [
					{
						uuid: "msg-old",
						sender: "human",
						created_at: "2025-12-31T00:00:00.000Z",
						content: [{ type: "text", text: "old" }],
					},
				],
			},
		],
		"projects/project-recent.json": {
			uuid: "project-recent",
			name: "recent project",
			updated_at: "2026-01-20T00:00:00.000Z",
			docs: [
				{
					uuid: "doc-recent",
					filename: "new.md",
					content: "new",
					updated_at: "2026-01-20T00:00:00.000Z",
				},
				{
					uuid: "doc-old",
					filename: "old.md",
					content: "old",
					updated_at: "2025-12-31T00:00:00.000Z",
				},
			],
		},
		"projects/project-old.json": {
			uuid: "project-old",
			name: "old project",
			updated_at: "2025-12-31T00:00:00.000Z",
			docs: [],
		},
	});
	const streamBundle = await buildPageshim({
		connector: "anthropic",
		outfile: join(out, "anthropic-window.js"),
		streamResults: true,
		sinceDays: 30,
	});
	const spool = mkdtempSync(join(scratchRoot, "anthropic-window-"));
	try {
		fx.reset({ zip });
		const run = await runHarness({
			bundle: streamBundle.outfile,
			fixtures: c.fixtures,
			scopes: c.scopes,
			resultStreaming: true,
			resultSpoolDirectory: spool,
			clockNowMs: Date.parse("2026-01-31T00:00:00.000Z"),
		});
		assert.deepEqual(run.ret, { ok: true }, run.log.slice(-20).join("\n"));
		const streamed = Object.fromEntries(
			Object.entries(run.streamScopeFiles).map(([scope, path]) => [
				scope,
				JSON.parse(readFileSync(path, "utf8")).records.map(
					({ blob_ref: _, ...record }) => record,
				),
			]),
		);
		assert.deepEqual(
			streamed["claude.conversations"]?.map((record) => record.id),
			["conv-recent"],
		);
		assert.deepEqual(
			streamed["claude.messages"]?.map((record) => record.id),
			["msg-recent"],
		);
		assert.deepEqual(
			streamed["claude.projects"]?.map((record) => record.id),
			["project-recent"],
		);
		assert.deepEqual(
			streamed["claude.project_documents"]?.map((record) => record.id),
			["doc-recent"],
		);
		assert.equal(
			run.streamResult?.donePayload?.exportSummary?.window?.sinceDays,
			30,
		);
		assert.equal(
			run.streamResult?.donePayload?.exportSummary?.partialReason,
			"time_window",
		);
		assert.ok(
			run.streamResult?.donePayload?.errors?.some(
				(error) => error.reason === "time_window",
			),
		);
	} finally {
		rmSync(spool, { recursive: true, force: true });
	}
});

test("strava_browser: records and fail-closed paths on the PageShim host", {
	timeout: 180_000,
}, async (t) => {
	const { pageshimCase: c, resolveFixture } = await import(
		"./fixtures/strava_browser.mjs"
	);
	const built = await buildPageshim({
		connector: "strava_browser",
		outfile: join(out, "strava_browser-paths.js"),
	});
	const run = (resolve = resolveFixture) =>
		runHarness({
			bundle: built.outfile,
			fixtures: { ...c.fixtures, resolve },
			scopes: c.scopes,
		});

	await t.test("activities cross as live records", async () => {
		const r = await run();
		assertCleanRun(r);
		assert.deepEqual(r.result.errors, []);
		const scopePayload = r.result["strava.activities"];
		assert.deepEqual(Object.keys(scopePayload), ["activities"]);
		const activities = scopePayload.activities;
		assert.deepEqual(
			activities.map((a) => [a.id, a.activity_type, a.freshness]),
			[
				["90000000005", "Ride", "live"],
				["90000000004", "Run", "live"],
				["90000000003", "Yoga", "live"],
				["90000000002", "EBikeRide", "live"],
				["90000000001", "Swim", "live"],
			],
		);
		const { desktopScopePayload } = await import(
			"./fixtures/strava_browser-desktop.mjs"
		);
		assert.deepEqual(scopePayload, await desktopScopePayload(resolveFixture));
	});

	await t.test(
		"an unrecognised list fails closed: no activities, one omitted error",
		async () => {
			const r = await run((raw) =>
				new URL(raw).pathname === "/athlete/training_activities"
					? {
							status: 200,
							contentType: "application/json",
							body: '{"activities":[]}',
						}
					: resolveFixture(raw),
			);
			assert.deepEqual(r.ret, { ok: true }, r.log.slice(-20).join("\n"));
			assertCleanRun(r);
			assert.equal(r.result["strava.activities"], undefined);
			assert.equal(r.result.errors.length, 1, JSON.stringify(r.result.errors));
			assert.equal(r.result.errors[0].scope, "strava.activities");
			assert.equal(r.result.errors[0].disposition, "omitted");
			assert.deepEqual(r.result.exportSummary, c.emptyExportSummary);
		},
	);
});

test("strava_browser: STATE resumes a synthetic multi-run detail backfill", {
	timeout: 180_000,
}, async () => {
	const { pageshimCase: c, resolveFixture } = await import(
		"./fixtures/strava_browser.mjs"
	);
	const built = await buildPageshim({
		connector: "strava_browser",
		outfile: join(out, "strava_browser-state.js"),
	});
	const sourceModels = JSON.parse(
		readFileSync(
			new URL(
				"../../connectors/strava_browser/fixtures/training-activities-page-1.json",
				import.meta.url,
			),
			"utf8",
		),
	).models;
	const activities = Array.from({ length: 205 }, (_, i) => {
		const model = structuredClone(sourceModels[i % sourceModels.length]);
		const id = String(91000000000 + i);
		return {
			...model,
			id: Number(id),
			id_str: id,
			name: `Synthetic activity ${i}`,
			activity_url: `https://www.strava.com/activities/${id}`,
			activity_url_for_twitter: `https://www.strava.com/activities/${id}`,
			bike_id: null,
			athlete_gear_id: null,
		};
	});
	const detailRequests = [];
	const resolve = (raw) => {
		const url = new URL(raw);
		if (url.pathname === "/athlete/training_activities") {
			const page = Number(url.searchParams.get("page") || 1);
			const perPage = 20;
			return {
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({
					models: activities.slice((page - 1) * perPage, page * perPage),
					page,
					perPage,
					total: activities.length,
				}),
			};
		}
		const detail = /^\/activities\/(\d+)$/.exec(url.pathname);
		if (detail) detailRequests.push(detail[1]);
		return resolveFixture(raw);
	};
	const run = (initialState = {}, overrides = {}) =>
		runHarness({
			bundle: built.outfile,
			fixtures: { ...c.fixtures, resolve },
			scopes: c.scopes,
			initialState,
			timerScale: 0.01,
			stateAckDelayMs: 5,
			...overrides,
		});
	let initialState = {};

	const first = await run(initialState);
	assert.deepEqual(first.ret, { ok: true }, first.log.slice(-20).join("\n"));
	assertCleanRun(first);
	assert.deepEqual(first.result.errors, []);
	assert.equal(first.result["strava.activities"].activities.length, 205);
	assert.deepEqual(
		detailRequests,
		[],
		"initial inventory must not backfill details",
	);
	assert.equal(first.states?.["strava.activities"]?.list_complete, true);
	assert.equal(
		first.states?.["strava.activities"]?.pending_detail_ids.length,
		205,
	);
	assert.deepEqual(first.stateMessages, [
		{
			type: "STATE",
			stream: "strava.activities",
			cursor: first.states["strava.activities"],
		},
	]);
	assert.ok(
		first.stateAckOrder < first.resultWriteOrder,
		"the runtime must await the shell's STATE acknowledgement before publishing the result",
	);
	assert.ok(
		!first.log.some((line) => line.includes("91000000000")),
		"cursor contents must not appear in logs",
	);
	initialState = first.states;

	detailRequests.length = 0;
	const second = await run(initialState);
	assert.deepEqual(second.ret, { ok: true }, second.log.slice(-20).join("\n"));
	assertCleanRun(second);
	assert.equal(
		detailRequests.length,
		100,
		"run two must fetch the first detail batch",
	);
	const secondBatch = new Set(detailRequests);
	assert.equal(second.result["strava.activities"].activities.length, 100);
	assert.equal(
		second.states?.["strava.activities"]?.pending_detail_ids.length,
		105,
	);
	assert.notDeepEqual(second.states, initialState);
	initialState = second.states;

	detailRequests.length = 0;
	const third = await run(initialState);
	assert.deepEqual(third.ret, { ok: true }, third.log.slice(-20).join("\n"));
	assertCleanRun(third);
	assert.equal(
		detailRequests.length,
		100,
		"run three must fetch the next detail batch",
	);
	assert.ok(
		detailRequests.every((id) => !secondBatch.has(id)),
		"run three must continue with activities left by run two",
	);
	assert.equal(third.result["strava.activities"].activities.length, 100);
	assert.equal(
		third.states?.["strava.activities"]?.pending_detail_ids.length,
		5,
	);

	detailRequests.length = 0;
	const failed = await run(third.states, { failResultWrite: true });
	assert.deepEqual(failed.ret, { ok: true }, failed.log.slice(-20).join("\n"));
	assert.equal(failed.data.error, "synthetic result write failed");
	assert.equal(failed.stateMessages[0].cursor.pending_detail_ids.length, 0);
	assert.deepEqual(
		failed.states,
		third.states,
		"a failed result write must not commit the staged cursor",
	);
});

test("strava_browser: old shell without initialState does not receive STATE", {
	timeout: 180_000,
}, async () => {
	const { pageshimCase: c } = await import("./fixtures/strava_browser.mjs");
	const built = await buildPageshim({
		connector: "strava_browser",
		outfile: join(out, "strava_browser-old-shell.js"),
	});
	const run = await runHarness({
		bundle: built.outfile,
		fixtures: c.fixtures,
		scopes: c.scopes,
		supportsStateArgument: false,
		timerScale: 0.01,
	});
	assert.deepEqual(run.ret, { ok: true }, run.log.slice(-20).join("\n"));
	assertCleanRun(run);
	assert.ok(run.result["strava.activities"].activities.length > 0);
	assert.deepEqual(run.stateMessages, []);
});
