// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Gate for the pageshim build target: build each manifest-compatible connector
// and run it in the PageShim harness against recorded fixtures. Each derived
// capability needs scripts/pageshim/fixtures/<name>.mjs exporting
// `pageshimCase`; a connector without one fails here.
//
// run: node --test scripts/pageshim/pageshim.test.mjs  (needs Playwright Chromium)

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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

function thirtyDayScopes(scopes, now = Date.now()) {
	const time_range = {
		since: new Date(now - 30 * 86_400_000).toISOString(),
		until: new Date(now).toISOString(),
	};
	return scopes.map((name) => ({ name, time_range }));
}

function scopeEntries(scopes, timeRanges) {
	return scopes.map((name) => ({
		name,
		...(timeRanges[name] ? { time_range: timeRanges[name] } : {}),
	}));
}

function bundleSha256(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function stampChatGptDetail(response, timestamp) {
	const body = JSON.parse(response.body);
	body.create_time = timestamp;
	body.update_time = timestamp;
	for (const node of Object.values(body.mapping ?? {})) {
		if (!node.message) continue;
		node.message.create_time = timestamp;
		node.message.update_time = timestamp;
	}
	response.body = JSON.stringify(body);
	return response;
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

		await t.test("thin host: every scope streams and matches the one-message result", async () => {
			const legacy = await run({ scopes: c.scopes });
			assertComplete(legacy);
			const r = await run({
				scopes: c.scopes,
				resultStreaming: true,
				resultSpoolDirectory: join(out, `${name}-thin-host`),
			});
			assert.deepEqual(r.ret, { ok: true }, r.log.slice(-20).join("\n"));
			assert.equal(r.data.error, undefined);
			assertCleanRun(r);
			assert.equal(r.result, null, "a thin host never gets a one-message result");
			assert.equal(r.streamResult.completed, true);
			assert.equal(r.streamResult.scopeCount, c.scopes.length);
			// fetchedAt is wall-clock time, so it differs between the two runs.
			const withoutFetchedAt = ({ fetchedAt, ...value }) => value;
			for (const scope of c.scopes)
				assert.deepEqual(
					withoutFetchedAt(
						JSON.parse(await readFile(r.streamScopeFiles[scope], "utf8")),
					),
					withoutFetchedAt(legacy.result[scope]),
					scope,
				);
			assert.deepEqual(r.streamDone.exportSummary, legacy.result.exportSummary);
			assert.deepEqual(r.streamDone.errors, legacy.result.errors);
			assert.equal(r.data.status, legacy.data.status);
		});

		await t.test("thin host: a fatal run reports its error without a result", async () => {
			const r = await run({
				scopes: c.scopes,
				loginAfterMs: Number.POSITIVE_INFINITY,
				loginWaitMs: 3000,
				resultStreaming: true,
				resultSpoolDirectory: join(out, `${name}-thin-host-fatal`),
			});
			assert.deepEqual(r.ret, { ok: true }, r.log.slice(-20).join("\n"));
			assertCleanRun(r);
			assert.equal(r.result, null);
			assert.equal(r.streamResult, null);
			assert.match(r.data.error, /login/i);
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
				requestedScopes:
					name === "chatgpt"
						? [...c.scopes, "chatgpt.memories"]
						: c.scopes,
			});
		});

		await t.test("foreign requestedScopes: protocol_violation", async () => {
			const r = await run({ scopes: [c.scopes[0], "other.thing"] });
			assertFatal(r, c, name, {
				errorClass: "protocol_violation",
				phase: "init",
				requestedScopes:
					name === "chatgpt"
						? [...c.scopes, "chatgpt.memories"]
						: c.scopes,
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

test("oura_browser: a sign-in after 45 s outlives the 30 s bridge-call timeout", {
	timeout: 180_000,
}, async () => {
	const { pageshimCase: c } = await import("./fixtures/oura_browser.mjs");
	// Built exactly as scripts/pageshim/attach-to-artifact.mjs builds it, so
	// the published 30 s bridge-call timeout applies.
	const built = await buildPageshim({
		connector: "oura_browser",
		outfile: join(out, "oura_browser-slow-sign-in.js"),
	});
	const r = await runHarness({
		bundle: built.outfile,
		fixtures: c.fixtures,
		scopes: c.scopes,
		loginAfterMs: 45_000,
		resultStreaming: true,
		resultSpoolDirectory: join(out, "oura_browser-slow-sign-in"),
	});
	assert.deepEqual(r.ret, { ok: true }, r.log.slice(-20).join("\n"));
	assert.equal(r.data.error, undefined, r.log.slice(-20).join("\n"));
	assertCleanRun(r);
	assert.equal(r.calls.promptUser, 1);
	assert.equal(r.streamResult.completed, true);
	assert.deepEqual(r.streamDone.exportSummary, c.exportSummary);
});

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
			details: { conversations: 1, messages: 1, memories: 0 },
		});
	} finally {
		fx.useConversationCount(2);
	}
});

test("chatgpt: memories are accepted and emitted with conversation scopes", {
	timeout: 180_000,
}, async () => {
	const fx = await import("./fixtures/chatgpt.mjs");
	const scopes = [...fx.pageshimCase.scopes, "chatgpt.memories"];
	const built = await buildPageshim({
		connector: "chatgpt",
		outfile: join(out, "chatgpt-memories.js"),
	});
	const spool = mkdtempSync(join(out, "chatgpt-memories-result-"));
	try {
		const legacy = await runHarness({
			bundle: built.outfile,
			fixtures: fx.pageshimCase.fixtures,
			scopes: scopeEntries(scopes, {
				"chatgpt.memories": {
					since: "2026-09-01T00:00:00.000Z",
					until: "2026-10-01T00:00:00.000Z",
				},
			}),
		});
		assert.deepEqual(
			legacy.ret,
			{ ok: true },
			legacy.log.slice(-20).join("\n"),
		);
		assert.deepEqual(legacy.result.errors, []);
		assert.deepEqual(
			legacy.result["chatgpt.memories"].records.map(({ id, content }) => ({
				id,
				content,
			})),
			[{ id: "memory-fixture-1", content: "Synthetic fixture memory" }],
		);
		assert.equal(legacy.result["chatgpt.conversations"].records.length, 2);
		assert.equal(legacy.result["chatgpt.messages"].records.length, 2);
		assert.deepEqual(legacy.result.exportSummary.details, {
			conversations: 2,
			messages: 2,
			memories: 1,
		});

		const streamed = await runHarness({
			bundle: built.outfile,
			fixtures: fx.pageshimCase.fixtures,
			scopes: scopeEntries(scopes, {
				"chatgpt.memories": {
					since: "2026-09-01T00:00:00.000Z",
					until: "2026-10-01T00:00:00.000Z",
				},
			}),
			resultStreaming: true,
			resultSpoolDirectory: spool,
		});
		assert.deepEqual(
			streamed.ret,
			{ ok: true },
			streamed.log.slice(-20).join("\n"),
		);
		assert.equal(streamed.streamResult?.completed, true);
		const memoryRecords = JSON.parse(
			readFileSync(streamed.streamScopeFiles["chatgpt.memories"], "utf8"),
		).records;
		assert.deepEqual(memoryRecords, legacy.result["chatgpt.memories"].records);
		assert.deepEqual(streamed.streamDone.exportSummary.details, {
			conversations: 2,
			messages: 2,
			memories: 1,
		});

		const unsupported = await runHarness({
			bundle: built.outfile,
			fixtures: fx.pageshimCase.fixtures,
			scopes: [...scopes, "chatgpt.unsupported"],
		});
		assert.deepEqual(
			unsupported.ret,
			{ ok: true },
			unsupported.log.slice(-20).join("\n"),
		);
		assert.match(
			unsupported.result.errors[0]?.reason ?? "",
			/unsupported requestedScopes: chatgpt\.unsupported/,
		);
		assert.equal(unsupported.result["chatgpt.memories"], undefined);

		const memoriesOnly = await runHarness({
			bundle: built.outfile,
			fixtures: fx.pageshimCase.fixtures,
			scopes: ["chatgpt.memories"],
		});
		assert.deepEqual(
			memoriesOnly.ret,
			{ ok: true },
			memoriesOnly.log.slice(-20).join("\n"),
		);
		assert.deepEqual(memoriesOnly.result.errors, []);
		assert.equal(memoriesOnly.result["chatgpt.conversations"], undefined);
		assert.equal(memoriesOnly.result["chatgpt.messages"], undefined);
		assert.equal(memoriesOnly.result["chatgpt.memories"].records.length, 1);
		assert.deepEqual(memoriesOnly.result.exportSummary.details, {
			conversations: 0,
			messages: 0,
			memories: 1,
		});
	} finally {
		rmSync(spool, { recursive: true, force: true });
	}
});

test("chatgpt: legacy string-only scope bridge runs full history", {
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
			legacyScopeBridge: true,
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

test("chatgpt: one publishing bundle handles full, ranged, legacy, and invalid requests", {
	timeout: 300_000,
}, async () => {
	const fx = await import("./fixtures/chatgpt.mjs");
	const dates = [
		"2026-01-10T00:00:00.000Z",
		"2026-01-20T00:00:00.000Z",
		"2026-01-30T00:00:00.000Z",
		"2026-02-02T00:00:00.000Z",
	];
	const resolve = (raw) => {
		const response = fx.resolveFixture(raw);
		const url = new URL(raw);
		if (url.pathname === "/backend-api/conversations/search") {
			const body = JSON.parse(response.body);
			body.items = body.items.map((item) => {
				const timestamp =
					Date.parse(dates[Number(item.id.slice(5)) - 1]) / 1000;
				return { ...item, create_time: timestamp, update_time: timestamp };
			});
			response.body = JSON.stringify(body);
		} else {
			const match = url.pathname.match(
				/^\/backend-api\/conversation\/(conv-\d+)$/,
			);
			if (match) {
				const body = JSON.parse(response.body);
				const timestamp =
					Date.parse(dates[Number(match[1].slice(5)) - 1]) / 1000;
				body.create_time = timestamp;
				body.update_time = timestamp;
				for (const node of Object.values(body.mapping ?? {}))
					if (node.message) node.message.create_time = timestamp;
				response.body = JSON.stringify(body);
			}
		}
		return response;
	};
	const fixtures = { ...fx.pageshimCase.fixtures, resolve };
	const built = await buildPageshim({
		connector: "chatgpt",
		outfile: join(out, "chatgpt-publishing-range.js"),
	});
	const digest = bundleSha256(built.outfile);
	fx.useConversationCount(4);
	const run = (scopes, legacyScopeBridge = false) =>
		runHarness({
			bundle: built.outfile,
			fixtures,
			scopes,
			env: {
				PDPP_CHATGPT_PACING_INITIAL_INTERVAL_MS: "1",
				PDPP_CHATGPT_PACING_MIN_INTERVAL_MS: "1",
			},
			legacyScopeBridge,
		});
	try {
		const full = await run(fx.pageshimCase.scopes);
		assert.deepEqual(full.ret, { ok: true }, full.log.slice(-20).join("\n"));
		assert.deepEqual(full.result.errors, []);
		assert.equal(full.streamResult, null);
		assert.equal(full.result["chatgpt.conversations"].records.length, 4);
		assert.equal(full.result["chatgpt.messages"].records.length, 4);
		assert.equal(bundleSha256(built.outfile), digest);

		const legacy = await run(fx.pageshimCase.scopes, true);
		assert.deepEqual(
			legacy.ret,
			{ ok: true },
			legacy.log.slice(-20).join("\n"),
		);
		assert.deepEqual(legacy.result.errors, []);
		assert.equal(legacy.result["chatgpt.conversations"].records.length, 4);
		assert.equal(legacy.result["chatgpt.messages"].records.length, 4);
		assert.equal(bundleSha256(built.outfile), digest);

		// Mobile sends the same range on both streams; the base list walk shares one cutoff.
		const ranged = await run(
			scopeEntries(fx.pageshimCase.scopes, {
				"chatgpt.conversations": {
					since: "2026-01-25T00:00:00.000Z",
					until: "2026-02-01T00:00:00.000Z",
				},
				"chatgpt.messages": {
					since: "2026-01-25T00:00:00.000Z",
					until: "2026-02-01T00:00:00.000Z",
				},
			}),
		);
		assert.deepEqual(
			ranged.ret,
			{ ok: true },
			ranged.log.slice(-20).join("\n"),
		);
		assert.deepEqual(ranged.result.errors, []);
		assert.deepEqual(
			ranged.result["chatgpt.conversations"].records.map((record) => record.id),
			["conv-3", "conv-4"],
		);
		assert.deepEqual(
			ranged.result["chatgpt.messages"].records.map((record) => record.id),
			["msg-3-a", "msg-4-a"],
		);
		assert.equal(bundleSha256(built.outfile), digest);

		const messagesOnly = await run([
			{
				name: "chatgpt.messages",
				time_range: {
					since: "2026-01-25T00:00:00.000Z",
					until: "2026-02-01T00:00:00.000Z",
				},
			},
		]);
		assert.deepEqual(
			messagesOnly.ret,
			{ ok: true },
			messagesOnly.log.slice(-20).join("\n"),
		);
		assert.deepEqual(messagesOnly.result.errors, []);
		assert.deepEqual(
			messagesOnly.result["chatgpt.messages"].records.map(
				(record) => record.id,
			),
			["msg-3-a", "msg-4-a"],
		);
		assert.equal(bundleSha256(built.outfile), digest);

		for (const since of [
			"2026-02-30T00:00:00.000Z",
			"2026-04-31T00:00:00.000Z",
			"2026-13-01T00:00:00.000Z",
			"2025-02-29T00:00:00.000Z",
			"2026-01-01T00:00:00+01:00",
			"bad ISO",
		]) {
			const invalid = await run(
				scopeEntries(fx.pageshimCase.scopes, {
					"chatgpt.conversations": { since },
				}),
			);
			assert.equal(
				invalid.result.errors.length,
				1,
				JSON.stringify(invalid.result.errors),
			);
			assert.match(
				invalid.result.errors[0].reason,
				/valid UTC ISO-8601 bounds/,
			);
			assert.equal(invalid.result["chatgpt.conversations"], undefined);
			assert.equal(bundleSha256(built.outfile), digest);
		}

		const leapDay = await run(
			scopeEntries(fx.pageshimCase.scopes, {
				"chatgpt.conversations": {
					since: "2024-02-29T00:00:00.000Z",
					until: "2026-03-01T00:00:00.000Z",
				},
			}),
		);
		assert.deepEqual(leapDay.result.errors, []);
		assert.equal(bundleSha256(built.outfile), digest);
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
			stampChatGptDetail(response, now - 86400);
		}
		return response;
	};
	let r;
	try {
		r = await runHarness({
			bundle: built.outfile,
			fixtures: { ...fx.pageshimCase.fixtures, resolve },
			scopes: thirtyDayScopes(fx.pageshimCase.scopes),
			resultStreaming: true,
			resultSpoolDirectory: join(out, "chatgpt-30d-stream"),
		});
	} finally {
		fx.useConversationCount(2);
	}
	assertCleanRun(r);
	const timingLogs = r.log.filter((line) => line.includes("[chatgpt-timing]"));
	assert.equal(
		timingLogs.length,
		2,
		`${timingLogs.join("\n")}\n${r.log.slice(-30).join("\n")}`,
	);
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
	assert.equal(r.streamDone.exportSummary.window, undefined);
	assert.deepEqual(r.streamDone.errors, []);
	const conversations = JSON.parse(
		await readFile(r.streamScopeFiles["chatgpt.conversations"], "utf8"),
	);
	assert.deepEqual(
		conversations.records.map((x) => x.id),
		["conv-1", "conv-2"],
	);
	assert.match(r.data.status, /^Complete!/);
});

test("chatgpt: the published bundle streams a large 30-day result only when the host offers page.input", {
	timeout: 300_000,
}, async () => {
	const fx = await import("./fixtures/chatgpt.mjs");
	// Built exactly as scripts/pageshim/attach-to-artifact.mjs builds it.
	const built = await buildPageshim({
		connector: "chatgpt",
		outfile: join(out, "chatgpt-published.js"),
	});
	const now = Date.now();
	const resolve = (raw) => {
		const response = fx.resolveFixture(raw);
		const url = new URL(raw);
		if (url.pathname === "/backend-api/conversations/search") {
			const body = JSON.parse(response.body);
			body.items = body.items.map((item) => ({
				...item,
				create_time: now / 1000 - 86400,
				update_time: now / 1000 - 86400,
			}));
			response.body = JSON.stringify(body);
		} else if (/^\/backend-api\/conversation\//.test(url.pathname)) {
			stampChatGptDetail(response, now / 1000 - 86400);
			const body = JSON.parse(response.body);
			for (const node of Object.values(body.mapping))
				if (node.message) node.message.content.parts = ["x".repeat(50_000)];
			response.body = JSON.stringify(body);
		}
		return response;
	};
	const run = (name, resultStreaming) =>
		runHarness({
			bundle: built.outfile,
			fixtures: { ...fx.pageshimCase.fixtures, resolve },
			scopes: thirtyDayScopes(fx.pageshimCase.scopes, now),
			env: {
				PDPP_CHATGPT_PACING_INITIAL_INTERVAL_MS: "1",
				PDPP_CHATGPT_PACING_MIN_INTERVAL_MS: "1",
			},
			resultStreaming,
			resultSpoolDirectory: join(out, name),
		});
	fx.useConversationCount(4);
	let thinHost;
	let olderShell;
	try {
		thinHost = await run("chatgpt-published-thin-host", true);
		olderShell = await run("chatgpt-published-older-shell", false);
	} finally {
		fx.useConversationCount(2);
	}

	assertCleanRun(thinHost);
	assert.deepEqual(thinHost.ret, { ok: true }, thinHost.log.slice(-20).join("\n"));
	assert.equal(thinHost.result, null);
	assert.equal(thinHost.streamResult.mode, "stream");
	assert.equal(thinHost.streamResult.completed, true);
	assert.deepEqual(thinHost.streamDone.errors, []);
	assert.ok(thinHost.maxBridgePayloadUnits <= 256 * 1024);
	const messages = await readFile(
		thinHost.streamScopeFiles["chatgpt.messages"],
		"utf8",
	);
	assert.ok(messages.length > 125 * 1024, `${messages.length}`);
	assert.equal(JSON.parse(messages).records.length, 4);
	assert.match(thinHost.data.status, /^Complete!/);

	// Without page.input the same bundle sends one result message, which an
	// older shell cannot carry at this size.
	assertCleanRun(olderShell);
	assert.equal(olderShell.streamResult, null);
	assert.match(
		olderShell.data.error,
		/exceeds the 128000-unit legacy bridge limit/,
	);
});

test("chatgpt: 30-day bundle stops after three old pages without fetching old details", {
	timeout: 180_000,
}, async () => {
	const fx = await import("./fixtures/chatgpt.mjs");
	const built = await buildPageshim({
		connector: "chatgpt",
		outfile: join(out, "chatgpt-30d-full-history.js"),
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
		scopes: thirtyDayScopes(fx.pageshimCase.scopes),
		resultStreaming: true,
		gotoDelayMs: 0,
		resultSpoolDirectory: join(out, "chatgpt-30d-full-history-stream"),
	});
	assertCleanRun(run);
	assert.deepEqual(cursors, [0, 30, 60]);
	assert.deepEqual(detailCalls, []);
	// Nothing in the window means no scope to stream; a thin host fails a
	// zero-scope run (A7), so the runtime reports why instead of a result.
	assert.equal(run.result, null);
	assert.equal(run.streamResult, null);
	assert.equal(run.data.error, "no records collected");
});

test("chatgpt: 30-day walk keeps later in-window rows after older rows on unordered pages", {
	timeout: 180_000,
}, async () => {
	const fx = await import("./fixtures/chatgpt.mjs");
	const built = await buildPageshim({
		connector: "chatgpt",
		outfile: join(out, "chatgpt-30d-unordered-pages.js"),
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
			stampChatGptDetail(response, now - 86400);
		}
		return response;
	};
	fx.useConversationCount(4);
	let run;
	try {
		run = await runHarness({
			bundle: built.outfile,
			fixtures: { ...fx.pageshimCase.fixtures, resolve },
			scopes: thirtyDayScopes(fx.pageshimCase.scopes),
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
			stampChatGptDetail(response, now - 86400);
		}
		return response;
	};
	let r;
	try {
		r = await runHarness({
			bundle: built.outfile,
			fixtures: { ...fx.pageshimCase.fixtures, resolve },
			scopes: thirtyDayScopes(fx.pageshimCase.scopes),
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
	assert.equal(r.streamDone.exportSummary.window, undefined);
	assert.deepEqual(r.streamDone.errors, []);
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
		details: { conversations: 1, messages: 1, memories: 0 },
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
	const run = (o, initialState) => {
		fx.reset(o);
		return runHarness({
			bundle: built.outfile,
			fixtures: c.fixtures,
			scopes: c.scopes,
			initialState,
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

	// An account with no projects: the thin host must still get both project
	// scopes, empty, or it cannot tell "none" from "not collected".
	await t.test("streamed result sends confirmed-empty project scopes", async () => {
		const streamBundle = await buildPageshim({
			connector: "anthropic",
			outfile: join(out, "anthropic-streamed-no-projects.js"),
		});
		const spool = mkdtempSync(join(out, "anthropic-no-projects-"));
		const conversation = {
			uuid: "syn-conv-0000-0000-0000-000000000003",
			name: "No project",
			created_at: "2026-01-01T00:00:00.000Z",
			updated_at: "2026-01-02T00:00:00.000Z",
			is_starred: false,
			project_uuid: null,
			chat_messages: [],
		};
		fx.reset({ zip: fx.zipOf({ "conversations.json": [conversation] }) });
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
			assert.deepEqual(r.streamDone.errors, []);
			const streamed = Object.fromEntries(
				Object.entries(r.streamScopeFiles).map(([scope, path]) => [
					scope,
					JSON.parse(readFileSync(path, "utf8")).records.length,
				]),
			);
			assert.deepEqual(streamed, {
				"claude.account_profile": 1,
				"claude.conversations": 1,
				"claude.messages": 0,
				"claude.projects": 0,
				"claude.project_documents": 0,
			});
		} finally {
			rmSync(spool, { recursive: true, force: true });
		}
	});

	// A skipped stream is not confirmed: it sends no scope at all.
	await t.test("streamed result omits a skipped conversations scope", async () => {
		const streamBundle = await buildPageshim({
			connector: "anthropic",
			outfile: join(out, "anthropic-streamed-skipped.js"),
		});
		const spool = mkdtempSync(join(out, "anthropic-skipped-"));
		fx.reset({ zip: fx.zipOf({ "conversations.json": {}, "projects/p.json": [] }) });
		try {
			const r = await runHarness({
				bundle: streamBundle.outfile,
				fixtures: c.fixtures,
				scopes: c.scopes,
				resultStreaming: true,
				resultSpoolDirectory: spool,
			});
			assert.deepEqual(r.ret, { ok: true }, r.log.slice(-20).join("\n"));
			for (const scope of ["claude.conversations", "claude.messages"])
				assert.equal(r.streamScopeFiles?.[scope], undefined, scope);
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

	await t.test("spent nonce of a fresh export: the host error ends the run", async () => {
		const r = await run({ spentNonces: [fx.NONCE] });
		assertFatalReason(r, /only issues each one once/);
		assert.equal(r.calls.captureDownload, 1);
		assert.deepEqual(fx.counts, { exportRequests: 1, mints: 1 });
	});

	// The iPhone failure: a run after a successful import resumed the spent
	// nonce and ended with "Couldn't import your data".
	const requestedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
	const spentRef = {
		organization_id: fx.ORG,
		nonce: "nonce-spent",
		requested_at: requestedAt,
	};
	for (const [label, cursor] of [
		[
			"consumed export within 24 h",
			{
				consumed_export: spentRef,
				last_export_requested_at: requestedAt,
				synced_at: requestedAt,
			},
		],
		[
			"pending export",
			{ pending_export: spentRef, last_export_requested_at: requestedAt },
		],
	])
		await t.test(
			`spent nonce of a resumed ${label}: drops it and imports a fresh export`,
			async () => {
				const r = await run(
					{ spentNonces: ["nonce-spent"] },
					{ "claude.conversations": cursor },
				);
				assert.deepEqual(r.ret, { ok: true }, r.log.slice(-20).join("\n"));
				assertCleanRun(r);
				assert.deepEqual(r.result.errors, []);
				assert.equal(r.data.error, null, "the host error is cleared");
				assert.deepEqual(r.result.exportSummary, c.exportSummary);
				assert.deepEqual(fx.counts, { exportRequests: 1, mints: 2 });
				const committed = r.states["claude.conversations"];
				assert.equal(committed.consumed_export.nonce, fx.NONCE);
				assert.equal(committed.pending_export, undefined);
				assert.ok(committed.synced_at > requestedAt);
				assert.ok(
					!JSON.stringify(r.stateMessages.at(-1)).includes("nonce-spent"),
				);
			},
		);

	await t.test(
		"resumed export refused for another reason: fatal, nonce not dropped",
		async () => {
			const pending = {
				organization_id: fx.ORG,
				nonce: fx.NONCE,
				requested_at: requestedAt,
			};
			const r = await run(
				{ mintFailure: { error: "forbidden" }, mintFailureStatus: 403 },
				{ "claude.conversations": { pending_export: pending } },
			);
			assertFatalReason(r, /could not be downloaded \(auth\)/);
			assert.deepEqual(fx.counts, { exportRequests: 0, mints: 1 });
			assert.deepEqual(r.stateMessages, []);
			assert.deepEqual(r.states["claude.conversations"], {
				pending_export: pending,
			});
		},
	);

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

// resultStreaming models the thin host, which offers page.input.
for (const resultStreaming of [false, true])
test(`anthropic: five-part metadata-only shell contract reads part entries through bounded chunks (${resultStreaming ? "streamed" : "one message"})`, {
	timeout: 300_000,
}, async () => {
	const fx = await import("./fixtures/anthropic.mjs");
	const c = fx.pageshimCase;
	const built = await buildPageshim({
		connector: "anthropic",
		outfile: join(
			out,
			`anthropic-multipart-chunks-${resultStreaming ? "streamed" : "one"}.js`,
		),
	});
	// esbuild emits "use strict" when it finds a strict tsconfig.json above
	// the checkout, as the served 0.2.20 bundle had. Run in strict mode so an
	// undeclared assignment in a shim fails here too.
	writeFileSync(
		built.outfile,
		`"use strict";\n${readFileSync(built.outfile, "utf8")}`,
	);
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
	const spool = mkdtempSync(join(out, "anthropic-multipart-result-"));
	const run = await runHarness({
		bundle: built.outfile,
		fixtures: shellFixtures,
		scopes: c.scopes,
		resultStreaming,
		resultSpoolDirectory: spool,
	});
	assert.deepEqual(run.ret, { ok: true }, run.log.slice(-20).join("\n"));
	assertCleanRun(run);
	if (resultStreaming) {
		assert.equal(run.streamResult?.completed, true, run.data.error);
		run.result = Object.fromEntries(
			Object.entries(run.streamScopeFiles).map(([scope, path]) => [
				scope,
				JSON.parse(readFileSync(path, "utf8")),
			]),
		);
	}
	rmSync(spool, { recursive: true, force: true });
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

test("anthropic: conversation range filters conversations and messages but retains streamed project inventory", {
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
	});
	const spool = mkdtempSync(join(scratchRoot, "anthropic-window-"));
	try {
		fx.reset({ zip });
		const range = {
			since: "2026-01-01T00:00:00.000Z",
			until: "2026-02-01T00:00:00.000Z",
		};
		const timeRanges = {
			"claude.conversations": range,
			"claude.messages": range,
		};
		const run = await runHarness({
			bundle: streamBundle.outfile,
			fixtures: c.fixtures,
			scopes: scopeEntries(c.scopes, timeRanges),
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
			["project-recent", "project-old"],
		);
		assert.deepEqual(
			streamed["claude.project_documents"]?.map((record) => record.id),
			["doc-recent", "doc-old"],
		);
		const projectIds = new Set(
			streamed["claude.projects"]?.map((record) => record.id),
		);
		assert.ok(
			streamed["claude.project_documents"]?.every((record) =>
				projectIds.has(record.project_id),
			),
			"retained project documents must join to an exported project",
		);
		assert.equal(
			run.streamResult?.donePayload?.exportSummary?.window,
			undefined,
		);
		assert.deepEqual(run.streamResult?.donePayload?.errors, []);
	} finally {
		rmSync(spool, { recursive: true, force: true });
	}
});

test("anthropic: one publishing bundle handles full, ranged, legacy, and invalid requests", {
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
					filename: "recent.md",
					content: "recent",
					updated_at: "2026-01-20T00:00:00.000Z",
				},
			],
		},
		"projects/project-old.json": {
			uuid: "project-old",
			name: "old project",
			updated_at: "2025-12-31T00:00:00.000Z",
			docs: [
				{
					uuid: "doc-old",
					filename: "old.md",
					content: "old",
					updated_at: "2025-12-31T00:00:00.000Z",
				},
			],
		},
	});
	const built = await buildPageshim({
		connector: "anthropic",
		outfile: join(out, "anthropic-publishing-range.js"),
	});
	const digest = bundleSha256(built.outfile);
	const run = (scopes, legacyScopeBridge = false) => {
		fx.reset({ zip });
		return runHarness({
			bundle: built.outfile,
			fixtures: c.fixtures,
			scopes,
			legacyScopeBridge,
		});
	};
	const recordIds = (result, scope) =>
		result[scope]?.records?.map((record) => record.id);
	const assertDigest = () => assert.equal(bundleSha256(built.outfile), digest);

	const full = await run(c.scopes);
	assert.deepEqual(full.ret, { ok: true }, full.log.slice(-20).join("\\n"));
	assert.deepEqual(full.result.errors, []);
	assert.deepEqual(recordIds(full.result, "claude.conversations"), [
		"conv-recent",
		"conv-old",
	]);
	assert.deepEqual(recordIds(full.result, "claude.messages"), [
		"msg-recent",
		"msg-old",
	]);
	assert.deepEqual(recordIds(full.result, "claude.projects"), [
		"project-recent",
		"project-old",
	]);
	assert.deepEqual(recordIds(full.result, "claude.project_documents"), [
		"doc-recent",
		"doc-old",
	]);
	assertDigest();

	const legacy = await run(c.scopes, true);
	assert.deepEqual(legacy.ret, { ok: true }, legacy.log.slice(-20).join("\\n"));
	assert.deepEqual(legacy.result.errors, []);
	assert.deepEqual(recordIds(legacy.result, "claude.conversations"), [
		"conv-recent",
		"conv-old",
	]);
	assert.deepEqual(recordIds(legacy.result, "claude.messages"), [
		"msg-recent",
		"msg-old",
	]);
	assertDigest();

	const sameRange = {
		since: "2026-01-01T00:00:00.000Z",
		until: "2026-02-01T00:00:00.000Z",
	};
	const ranges = Object.fromEntries(c.scopes.map((scope) => [scope, sameRange]));
	const filtered = await run(scopeEntries(c.scopes, ranges));
	assert.deepEqual(
		filtered.ret,
		{ ok: true },
		filtered.log.slice(-20).join("\\n"),
	);
	assert.deepEqual(filtered.result.errors, []);
	assert.deepEqual(recordIds(filtered.result, "claude.conversations"), ["conv-recent"]);
	assert.deepEqual(recordIds(filtered.result, "claude.messages"), ["msg-recent"]);
	assert.deepEqual(recordIds(filtered.result, "claude.projects"), [
		"project-recent",
		"project-old",
	]);
	assert.deepEqual(recordIds(filtered.result, "claude.project_documents"), [
		"doc-recent",
		"doc-old",
	]);
	assertDigest();

	for (const since of [
		"2026-02-30T00:00:00.000Z",
		"2026-04-31T00:00:00.000Z",
		"2026-13-01T00:00:00.000Z",
		"2025-02-29T00:00:00.000Z",
		"2026-01-01T00:00:00+01:00",
		"bad ISO",
	]) {
		const invalid = await run(
			scopeEntries(c.scopes, {
				"claude.conversations": { since },
			}),
		);
		assert.equal(
			invalid.result.errors.length,
			1,
			JSON.stringify(invalid.result.errors),
		);
		assert.match(invalid.result.errors[0].reason, /valid UTC ISO-8601 bounds/);
		assert.equal(invalid.result["claude.conversations"], undefined);
		assertDigest();
	}
	const leapDay = await run(
		scopeEntries(c.scopes, {
			"claude.conversations": {
				since: "2024-02-29T00:00:00.000Z",
				until: "2026-03-01T00:00:00.000Z",
			},
		}),
	);
	assert.deepEqual(leapDay.result.errors, []);
	assertDigest();
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

	// The mobile host stores each { activities } payload as the newest whole
	// version. A prefix of the list would replace the full stored list.
	const listPage2Fails = (raw) => {
		const url = new URL(raw);
		return url.pathname === "/athlete/training_activities" &&
			url.searchParams.get("page") === "2"
			? {
					status: 503,
					contentType: "text/html",
					body: "<html>Service Unavailable</html>",
				}
			: resolveFixture(raw);
	};

	await t.test(
		"a list page that fails mid-walk fails the run, with no prefix",
		async () => {
			const r = await run(listPage2Fails);
			assert.deepEqual(r.ret, { ok: true }, r.log.slice(-20).join("\n"));
			assertCleanRun(r);
			assert.equal(r.result["strava.activities"], undefined);
			assert.equal(r.result.errors.length, 1, JSON.stringify(r.result.errors));
			assert.equal(r.result.errors[0].disposition, "fatal");
			assert.match(r.result.errors[0].reason, /HTTP 503/);
			assert.equal(r.data.error, r.result.errors[0].reason);
			assert.equal(r.states?.["strava.activities"], undefined);
		},
	);

	await t.test(
		"a list page that fails mid-walk streams no scope on the thin host",
		async () => {
			const r = await runHarness({
				bundle: built.outfile,
				fixtures: { ...c.fixtures, resolve: listPage2Fails },
				scopes: c.scopes,
				resultStreaming: true,
				resultSpoolDirectory: join(out, "strava-list-fails-thin-host"),
			});
			assert.deepEqual(r.ret, { ok: true }, r.log.slice(-20).join("\n"));
			assertCleanRun(r);
			assert.notEqual(r.streamResult?.completed, true);
			assert.deepEqual(r.streamScopeFiles, {});
			assert.match(r.data.error, /HTTP 503/);
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

test("strava_browser: a large activity list streams only when the host offers page.input", {
	timeout: 300_000,
}, async () => {
	const { pageshimCase: c, resolveFixture } = await import(
		"./fixtures/strava_browser.mjs"
	);
	// Built exactly as scripts/pageshim/attach-to-artifact.mjs builds it.
	const built = await buildPageshim({
		connector: "strava_browser",
		outfile: join(out, "strava_browser-published.js"),
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
	const resolveFor = (count) => {
		const activities = Array.from({ length: count }, (_, i) => {
			const model = structuredClone(sourceModels[i % sourceModels.length]);
			const id = String(92000000000 + i);
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
		return (raw) => {
			const url = new URL(raw);
			if (url.pathname !== "/athlete/training_activities")
				return resolveFixture(raw);
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
		};
	};
	const run = (name, count, resultStreaming) =>
		runHarness({
			bundle: built.outfile,
			fixtures: { ...c.fixtures, resolve: resolveFor(count) },
			scopes: c.scopes,
			timerScale: 0.01,
			resultStreaming,
			resultSpoolDirectory: join(out, name),
		});

	// A bounded list: the streamed scope is byte-for-byte what an older shell
	// receives in its one result message.
	const smallStream = await run("strava-small-thin-host", 205, true);
	const smallLegacy = await run("strava-small-older-shell", 205, false);
	assertCleanRun(smallStream);
	assertCleanRun(smallLegacy);
	assert.equal(smallStream.result, null);
	assert.equal(smallStream.streamResult.completed, true);
	assert.equal(smallLegacy.streamResult, null);
	assert.deepEqual(
		JSON.parse(
			await readFile(smallStream.streamScopeFiles["strava.activities"], "utf8"),
		),
		smallLegacy.result["strava.activities"],
	);
	assert.deepEqual(
		smallStream.streamDone.exportSummary,
		smallLegacy.result.exportSummary,
	);
	assert.deepEqual(smallStream.states, smallLegacy.states);

	const large = await run("strava-large-thin-host", 2000, true);
	assertCleanRun(large);
	assert.deepEqual(large.ret, { ok: true }, large.log.slice(-20).join("\n"));
	assert.equal(large.streamResult.completed, true);
	assert.deepEqual(large.streamDone.errors, []);
	assert.ok(large.maxBridgePayloadUnits <= 256 * 1024);
	const scope = await readFile(
		large.streamScopeFiles["strava.activities"],
		"utf8",
	);
	assert.ok(scope.length > 125 * 1024, `${scope.length}`);
	assert.equal(JSON.parse(scope).activities.length, 2000);
	assert.equal(
		large.states["strava.activities"].pending_detail_ids.length,
		2000,
	);
	assert.match(large.data.status, /^Complete! 2000 activities/);

	const largeLegacy = await run("strava-large-older-shell", 2000, false);
	assertCleanRun(largeLegacy);
	assert.equal(largeLegacy.streamResult, null);
	assert.match(
		largeLegacy.data.error,
		/exceeds the 128000-unit legacy bridge limit/,
	);
	assert.deepEqual(largeLegacy.states, {});
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
