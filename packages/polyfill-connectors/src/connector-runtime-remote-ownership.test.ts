// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A connector run attached to someone else's browser
 * (`PDPP_<NAME>_REMOTE_CDP_URL`) must only ever close the pages it created.
 *
 * Drives `src/test-fixtures/remote-browser-ownership-connector.ts` through the
 * real `runConnector` protocol, in a child process, against a real local
 * Chromium attached over CDP. The browser is a persistent context, so its
 * pages share the default context the connector attaches to. Three runs in the
 * same browser: a recording run that succeeds, a recording run that fails,
 * and a plain second success. Across all three: the owner's tabs survive, a
 * tab the owner opens mid-run survives, the run page and the provider popup
 * it opened are closed, and a recording run leaves a usable HAR and storage
 * state behind.
 *
 * A connector that declares page preservation (ChatGPT keeps its session in
 * the live page) is the one exception to "never reuse a tab": consecutive runs
 * share one preserved run page instead of piling up new ones, and the owner's
 * tabs stay untouched.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { type BrowserContext, chromium } from "playwright";

const FIXTURE = join(
	import.meta.dirname,
	"test-fixtures",
	"remote-browser-ownership-connector.ts",
);
const REMOTE_CDP_ENV = "PDPP_REMOTE_OWNERSHIP_FIXTURE_REMOTE_CDP_URL";

function freeLoopbackPort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createNetServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address ? address.port : 0;
			server.close(() => resolve(port));
		});
	});
}

interface ChildResult {
	code: number | null;
	done: { status?: string } | undefined;
	output: string;
	recordKeys: string[];
}

function runFixture(env: Record<string, string>): Promise<ChildResult> {
	const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env };
	for (const key of [
		"PDPP_BROWSER_SURFACE_REQUIRED",
		"PDPP_BROWSER_SURFACE_REMOTE_CDP_URL",
		"PDPP_BROWSER_SURFACE_LEASE_ID",
		"PDPP_CAPTURE_FIXTURES",
		"PDPP_CAPTURE_ON_FAILURE",
	]) {
		delete childEnv[key];
	}
	for (const key of [
		"PDPP_SCENARIO_HAR_RECORD_PATH",
		"PDPP_SCENARIO_STORAGE_STATE_RECORD_PATH",
	]) {
		if (!(key in env)) {
			delete childEnv[key];
		}
	}
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["--import", "tsx", FIXTURE], {
			env: childEnv,
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`fixture connector timed out\n${stderr}`));
		}, 90_000);
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			const messages = stdout
				.split("\n")
				.filter(Boolean)
				.map((line) => {
					try {
						return JSON.parse(line) as {
							key?: string;
							status?: string;
							type?: string;
						};
					} catch {
						return {};
					}
				});
			const done = messages.find((message) => message.type === "DONE");
			const recordKeys = messages
				.filter((message) => message.type === "RECORD")
				.map((message) => message.key ?? "");
			resolve({ code, done, output: `${stdout}\n${stderr}`, recordKeys });
		});
		child.stdin.end(
			`${JSON.stringify({ scope: { streams: [{ name: "items" }] }, type: "START" })}\n`,
		);
	});
}

function pageUrls(context: BrowserContext): string[] {
	return context
		.pages()
		.filter((page) => !page.isClosed())
		.map((page) => page.url());
}

test("connector runs attached to an external browser close only their own pages", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pdpp-remote-ownership-"));
	let remote: BrowserContext | null = null;
	let userTabs = 0;
	const site = createHttpServer((req, res) => {
		const path = new URL(req.url ?? "/", "http://localhost").pathname;
		if (path === "/open-user-tab") {
			// The browser's owner opens a tab of their own while the run is in
			// flight. No opener: it is not the connector's popup.
			userTabs += 1;
			const label = `user-tab-${String(userTabs)}`;
			const context = remote;
			if (!context) {
				res.writeHead(500).end();
				return;
			}
			context
				.newPage()
				.then((page) => page.goto(`about:blank#${label}`))
				.then(
					() => res.writeHead(200, { "content-type": "text/plain" }).end(label),
					() => res.writeHead(500).end(),
				);
			return;
		}
		if (path === "/provider") {
			res
				.writeHead(200, { "content-type": "text/html" })
				.end("<html><body>provider sign-in</body></html>");
			return;
		}
		res
			.writeHead(200, {
				"content-type": "text/html",
				"set-cookie": "fixture_session=run-cookie; Path=/",
			})
			.end(
				'<html><body><p id="marker">fixture run page</p><button id="provider" onclick="window.open(\'/provider\', \'provider\')">Sign in</button></body></html>',
			);
	});
	await new Promise<void>((resolve) => {
		site.listen(0, "127.0.0.1", resolve);
	});
	const siteAddress = site.address();
	assert.ok(siteAddress && typeof siteAddress !== "string");
	const baseUrl = `http://127.0.0.1:${String(siteAddress.port)}`;
	const cdpPort = await freeLoopbackPort();
	remote = await chromium.launchPersistentContext(join(dir, "profile"), {
		args: [`--remote-debugging-port=${String(cdpPort)}`],
	});
	const browserContext = remote;
	t.after(async () => {
		await browserContext.close().catch(() => undefined);
		await new Promise<void>((resolve) => {
			site.close(() => resolve());
		});
		await rm(dir, { recursive: true, force: true });
	});
	const ownerTabs = await Promise.all([
		browserContext.newPage(),
		browserContext.newPage(),
	]);
	await Promise.all(
		ownerTabs.map((page, index) =>
			page.goto(`about:blank#owner-tab-${String(index + 1)}`),
		),
	);

	const baseEnv = {
		[REMOTE_CDP_ENV]: `http://127.0.0.1:${String(cdpPort)}`,
		PDPP_OWNERSHIP_FIXTURE_BASE_URL: baseUrl,
	};
	const runs = [
		{ fail: false, label: "success", record: true },
		{ fail: true, label: "failure", record: true },
		{ fail: false, label: "second success", record: false },
	];
	for (const [index, run] of runs.entries()) {
		const harPath = join(dir, `run-${String(index + 1)}.har`);
		const storageStatePath = join(dir, `run-${String(index + 1)}-state.json`);
		// Runs share one browser and must not overlap: each one asserts on the
		// tabs the previous runs left behind.
		const result = await runFixture({
			...baseEnv,
			...(run.fail ? { PDPP_OWNERSHIP_FIXTURE_FAIL: "1" } : {}),
			...(run.record
				? {
						PDPP_SCENARIO_HAR_RECORD_PATH: harPath,
						PDPP_SCENARIO_STORAGE_STATE_RECORD_PATH: storageStatePath,
					}
				: {}),
		});
		assert.equal(
			result.done?.status,
			run.fail ? "failed" : "succeeded",
			`${run.label} run DONE status\n${result.output}`,
		);
		assert.equal(result.code, run.fail ? 1 : 0, `${run.label} exit code`);

		const urls = pageUrls(browserContext);
		for (const index_ of [1, 2]) {
			assert.ok(
				urls.includes(`about:blank#owner-tab-${String(index_)}`),
				`${run.label}: owner tab ${String(index_)} must survive (open: ${urls.join(", ")})`,
			);
		}
		for (let tab = 1; tab <= userTabs; tab += 1) {
			assert.ok(
				urls.includes(`about:blank#user-tab-${String(tab)}`),
				`${run.label}: user tab ${String(tab)} opened mid-run must survive (open: ${urls.join(", ")})`,
			);
		}
		assert.equal(userTabs, index + 1, "each run opens one user tab");
		assert.deepEqual(
			urls.filter((url) => url.startsWith(baseUrl)),
			[],
			`${run.label}: the run page and its provider popup must be closed`,
		);

		if (run.record) {
			const har = JSON.parse(await readFile(harPath, "utf8")) as {
				log: { entries: { request: { url: string } }[] };
			};
			const harUrls = har.log.entries.map((entry) => entry.request.url);
			assert.ok(
				harUrls.includes(`${baseUrl}/run`),
				`${run.label}: HAR must hold the run page request`,
			);
			assert.ok(
				harUrls.includes(`${baseUrl}/provider`),
				`${run.label}: HAR must hold the popup request`,
			);
			const state = JSON.parse(await readFile(storageStatePath, "utf8")) as {
				cookies: { name: string; value: string }[];
			};
			assert.ok(
				state.cookies.some(
					(cookie) =>
						cookie.name === "fixture_session" && cookie.value === "run-cookie",
				),
				`${run.label}: storage state must hold the run cookie`,
			);
		}
	}

	// The artifacts are usable: a fresh browser replays the run page from the
	// HAR alone (the fixture server is closed first) with the recorded cookie.
	await new Promise<void>((resolve) => {
		site.close(() => resolve());
	});
	const replayBrowser = await chromium.launch();
	try {
		const replay = await replayBrowser.newContext({
			storageState: join(dir, "run-1-state.json"),
		});
		await replay.routeFromHAR(join(dir, "run-1.har"), { notFound: "abort" });
		const page = await replay.newPage();
		await page.goto(`${baseUrl}/run`);
		assert.equal(await page.textContent("#marker"), "fixture run page");
		const cookies = await replay.cookies(baseUrl);
		assert.ok(cookies.some((cookie) => cookie.name === "fixture_session"));
	} finally {
		await replayBrowser.close();
	}
});

test("a preserve-page connector attached to an external browser reuses its one run page", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pdpp-remote-preserve-"));
	const site = createHttpServer((req, res) => {
		const path = new URL(req.url ?? "/", "http://localhost").pathname;
		if (path === "/provider") {
			res
				.writeHead(200, { "content-type": "text/html" })
				.end("<html><body>provider sign-in</body></html>");
			return;
		}
		res
			.writeHead(200, { "content-type": "text/html" })
			.end(
				'<html><body><p id="marker">fixture run page</p><button id="provider" onclick="window.open(\'/provider\', \'provider\')">Sign in</button></body></html>',
			);
	});
	await new Promise<void>((resolve) => {
		site.listen(0, "127.0.0.1", resolve);
	});
	const siteAddress = site.address();
	assert.ok(siteAddress && typeof siteAddress !== "string");
	const baseUrl = `http://127.0.0.1:${String(siteAddress.port)}`;
	const cdpPort = await freeLoopbackPort();
	const browserContext = await chromium.launchPersistentContext(
		join(dir, "profile"),
		{ args: [`--remote-debugging-port=${String(cdpPort)}`] },
	);
	t.after(async () => {
		await browserContext.close().catch(() => undefined);
		await new Promise<void>((resolve) => {
			site.close(() => resolve());
		});
		await rm(dir, { recursive: true, force: true });
	});
	const ownerTabs = await Promise.all([
		browserContext.newPage(),
		browserContext.newPage(),
	]);
	await Promise.all(
		ownerTabs.map((page, index) =>
			page.goto(`about:blank#owner-tab-${String(index + 1)}`),
		),
	);
	const env = {
		[REMOTE_CDP_ENV]: `http://127.0.0.1:${String(cdpPort)}`,
		PDPP_OWNERSHIP_FIXTURE_BASE_URL: baseUrl,
		PDPP_OWNERSHIP_FIXTURE_PRESERVE_PAGE: "1",
	};

	const first = await runFixture(env);
	assert.equal(first.done?.status, "succeeded", first.output);
	const second = await runFixture(env);
	assert.equal(second.done?.status, "succeeded", second.output);

	assert.deepEqual(
		[first.recordKeys, second.recordKeys],
		[["1"], ["2"]],
		"the second run served the page the first run preserved",
	);
	const urls = pageUrls(browserContext);
	assert.deepEqual(
		urls.filter((url) => url.startsWith(baseUrl)),
		[`${baseUrl}/run`],
		`exactly one run page remains and the provider popups are closed (open: ${urls.join(", ")})`,
	);
	assert.deepEqual(
		ownerTabs.map((page) => [page.isClosed(), page.url()]),
		[
			[false, "about:blank#owner-tab-1"],
			[false, "about:blank#owner-tab-2"],
		],
		"the owner's tabs are untouched",
	);
});
