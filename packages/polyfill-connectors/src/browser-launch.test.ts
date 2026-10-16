// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import {
	acquireBrowserForConnector,
	acquireIsolatedBrowser,
	CDP_ATTACH_SESSION_RACE_EXHAUSTED_CODE,
	CdpAttachSessionRaceExhaustedError,
	closeRemoteCdpPageTargets,
	configuredBrowserChannel,
	connectOverCdpWithRetry,
	decideContainerHeadedBrowserGate,
	evaluateAfterNavigation,
	fetchPageTargetWsUrl,
	fileFlushOutcome,
	HAR_RECORD_PATH_ENV,
	HEADED_BROWSER_UNAVAILABLE_CODE,
	HeadedBrowserUnavailableError,
	isCdpAttachSessionRaceError,
	isDefinitivelyZeroViewport,
	redactCdpUrl,
	redactHarDocument,
	remoteCdpPageCleanupSkipReason,
	resolveDeploymentBrowserHeadless,
	resolvePageTargetWsUrl,
	runCdpAttemptWithRaceGuard,
	STORAGE_STATE_RECORD_PATH_ENV,
	scrubHarFileOrThrow,
	shouldCleanRemoteCdpPageTargets,
	startRemoteCdpHarRecording,
	type UnhandledRejectionHost,
	warnIfRecordingSharedRemoteBrowser,
	withScenarioClockPaused,
	writePrivateCaptureJsonAtomically,
	writeStorageStateBestEffort,
} from "./browser-launch.ts";

const ENV_VARS = [
	"PDPP_BROWSER_HEADLESS",
	"PDPP_FORCE_CONTAINER",
	"PDPP_ALLOW_HEADED_CONTAINER_BROWSER",
] as const;

test("evaluateAfterNavigation: waits for a HAR redirect before retrying session setup evaluation", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pdpp-har-redirect-setup-"));
	const browser = await chromium.launch({ headless: true });
	t.after(async () => {
		await browser.close();
		await rm(dir, { recursive: true, force: true });
	});
	const harPath = join(dir, "redirect.har");
	await writeFile(
		harPath,
		JSON.stringify({
			log: {
				version: "1.2",
				creator: { name: "synthetic-fixture", version: "1" },
				entries: [
					{
						startedDateTime: "2026-01-01T00:00:00.000Z",
						time: 0,
						request: {
							method: "GET",
							url: "https://setup.synthetic.test/start",
							httpVersion: "HTTP/1.1",
							headers: [],
							queryString: [],
							cookies: [],
							headersSize: -1,
							bodySize: 0,
						},
						response: {
							status: 302,
							statusText: "Found",
							httpVersion: "HTTP/1.1",
							headers: [
								{
									name: "location",
									value: "https://setup.synthetic.test/ready",
								},
							],
							cookies: [],
							content: { size: 0, mimeType: "text/html", text: "" },
							redirectURL: "https://setup.synthetic.test/ready",
							headersSize: -1,
							bodySize: 0,
						},
						cache: {},
						timings: { send: 0, wait: 0, receive: 0 },
					},
					{
						startedDateTime: "2026-01-01T00:00:01.000Z",
						time: 0,
						request: {
							method: "GET",
							url: "https://setup.synthetic.test/ready",
							httpVersion: "HTTP/1.1",
							headers: [],
							queryString: [],
							cookies: [],
							headersSize: -1,
							bodySize: 0,
						},
						response: {
							status: 200,
							statusText: "OK",
							httpVersion: "HTTP/1.1",
							headers: [{ name: "content-type", value: "text/html" }],
							cookies: [],
							content: {
								size: 39,
								mimeType: "text/html",
								text: "<html><body>ready</body></html>",
							},
							redirectURL: "",
							headersSize: -1,
							bodySize: 0,
						},
						cache: {},
						timings: { send: 0, wait: 0, receive: 0 },
					},
				],
			},
		}),
	);
	const context = await browser.newContext();
	t.after(async () => context.close());
	await context.routeFromHAR(harPath, { notFound: "abort" });
	const page = await context.newPage();
	await page.goto("https://setup.synthetic.test/start", {
		waitUntil: "commit",
	});
	let attempts = 0;
	let waitedForLoad = false;
	const navigationRacePage = {
		evaluate: async (callback: () => unknown) => {
			attempts += 1;
			if (attempts === 1) {
				throw new Error(
					"Execution context was destroyed, most likely because of a navigation",
				);
			}
			return await page.evaluate(callback);
		},
		waitForLoadState: async (
			...args: Parameters<typeof page.waitForLoadState>
		) => {
			waitedForLoad = true;
			return await page.waitForLoadState(...args);
		},
	} as unknown as typeof page;
	const ready = await evaluateAfterNavigation(
		navigationRacePage,
		() => document.body.textContent === "ready",
	);
	assert.equal(ready, true);
	assert.equal(attempts, 2);
	assert.equal(waitedForLoad, true);
});

function withEnv(values: Partial<Record<(typeof ENV_VARS)[number], string>>) {
	const previous = new Map<string, string | undefined>();
	for (const name of ENV_VARS) {
		previous.set(name, process.env[name]);
		delete process.env[name];
	}
	for (const [name, value] of Object.entries(values)) {
		if (typeof value === "string") {
			process.env[name] = value;
		}
	}
	return () => {
		for (const [name, value] of previous) {
			if (value === undefined) {
				delete process.env[name];
			} else {
				process.env[name] = value;
			}
		}
	};
}

// ─── In-container fail-closed gate (narrow: HEADED only) ──────────────
//
// We exercise the gate via the pure decision helper rather than against
// the live launcher. The launcher itself successfully spawns a Chromium
// in this test environment when the gate does NOT fire, which would
// turn every "must NOT throw the typed error" assertion into a real
// browser launch — slow, flaky, and unrelated to the policy under test.
// One integration test remains for the fail-closed case because it
// short-circuits before any launcher work runs.

test("decideContainerHeadedBrowserGate: host-direct headed acquisition proceeds", () => {
	assert.deepEqual(
		decideContainerHeadedBrowserGate({
			headless: false,
			inContainer: false,
			escapeHatchEnabled: false,
		}),
		{ kind: "proceed" },
	);
});

test("decideContainerHeadedBrowserGate: host-direct headless acquisition proceeds", () => {
	assert.deepEqual(
		decideContainerHeadedBrowserGate({
			headless: true,
			inContainer: false,
			escapeHatchEnabled: false,
		}),
		{ kind: "proceed" },
	);
});

test("decideContainerHeadedBrowserGate: HEADLESS in container proceeds (legitimate non-interactive workload)", () => {
	assert.deepEqual(
		decideContainerHeadedBrowserGate({
			headless: true,
			inContainer: true,
			escapeHatchEnabled: false,
		}),
		{
			kind: "proceed",
		},
	);
});

test("decideContainerHeadedBrowserGate: HEADED in container fails closed", () => {
	assert.deepEqual(
		decideContainerHeadedBrowserGate({
			headless: false,
			inContainer: true,
			escapeHatchEnabled: false,
		}),
		{ kind: "fail_closed" },
	);
});

test("decideContainerHeadedBrowserGate: Core's managed browser runtime permits headed local Chromium", () => {
	assert.deepEqual(
		decideContainerHeadedBrowserGate({
			headless: false,
			inContainer: true,
			escapeHatchEnabled: false,
			managedDisplayAvailable: true,
		}),
		{ kind: "proceed" },
	);
});

test("decideContainerHeadedBrowserGate: Core's omitted browser mode uses the managed headed path", () => {
	assert.deepEqual(
		decideContainerHeadedBrowserGate({
			headless: undefined,
			inContainer: true,
			escapeHatchEnabled: false,
			managedDisplayAvailable: true,
		}),
		{ kind: "proceed" },
	);
});

test("decideContainerHeadedBrowserGate: escape hatch downgrades HEADED-in-container to warn_and_proceed", () => {
	assert.deepEqual(
		decideContainerHeadedBrowserGate({
			headless: false,
			inContainer: true,
			escapeHatchEnabled: true,
		}),
		{
			kind: "warn_and_proceed",
		},
	);
});

test("decideContainerHeadedBrowserGate: escape hatch is a no-op when not in container", () => {
	assert.deepEqual(
		decideContainerHeadedBrowserGate({
			headless: false,
			inContainer: false,
			escapeHatchEnabled: true,
		}),
		{ kind: "proceed" },
	);
});

test("decideContainerHeadedBrowserGate: undefined headless in container fails closed (mirrors the headed baseline)", () => {
	assert.deepEqual(
		decideContainerHeadedBrowserGate({
			headless: undefined,
			inContainer: true,
			escapeHatchEnabled: false,
		}),
		{ kind: "fail_closed" },
	);
});

test("decideContainerHeadedBrowserGate: undefined headless on host (no container) proceeds", () => {
	assert.deepEqual(
		decideContainerHeadedBrowserGate({
			headless: undefined,
			inContainer: false,
			escapeHatchEnabled: false,
		}),
		{ kind: "proceed" },
	);
});

test("decideContainerHeadedBrowserGate: HEADED in container with remoteCdpUrl proceeds (remote browser is operator-visible)", () => {
	assert.deepEqual(
		decideContainerHeadedBrowserGate({
			headless: false,
			inContainer: true,
			escapeHatchEnabled: false,
			remoteCdpUrl: "http://neko:9223",
		}),
		{ kind: "proceed" },
	);
});

test("decideContainerHeadedBrowserGate: undefined headless in container with remoteCdpUrl proceeds", () => {
	assert.deepEqual(
		decideContainerHeadedBrowserGate({
			headless: undefined,
			inContainer: true,
			escapeHatchEnabled: false,
			remoteCdpUrl: "http://neko:9223",
		}),
		{ kind: "proceed" },
	);
});

test("decideContainerHeadedBrowserGate: HEADED in container WITHOUT remoteCdpUrl still fails closed (local headed)", () => {
	assert.deepEqual(
		decideContainerHeadedBrowserGate({
			headless: false,
			inContainer: true,
			escapeHatchEnabled: false,
		}),
		{ kind: "fail_closed" },
	);
});

test("decideContainerHeadedBrowserGate: empty-string remoteCdpUrl does not bypass the gate", () => {
	assert.deepEqual(
		decideContainerHeadedBrowserGate({
			headless: false,
			inContainer: true,
			escapeHatchEnabled: false,
			remoteCdpUrl: "",
		}),
		{ kind: "fail_closed" },
	);
});

test("decideContainerHeadedBrowserGate: explicit headless: true in container proceeds even when undefined would not", () => {
	assert.deepEqual(
		decideContainerHeadedBrowserGate({
			headless: true,
			inContainer: true,
			escapeHatchEnabled: false,
		}),
		{
			kind: "proceed",
		},
	);
});

test("acquireBrowserForConnector fails closed when caller omits 'headless' in container", async () => {
	const restore = withEnv({ PDPP_FORCE_CONTAINER: "1" });
	try {
		await assert.rejects(
			() => acquireBrowserForConnector({ profileName: "test_connector" }),
			(err: unknown) => {
				assert.ok(
					err instanceof HeadedBrowserUnavailableError,
					`got ${String(err)}`,
				);
				if (err instanceof HeadedBrowserUnavailableError) {
					assert.equal(err.code, HEADED_BROWSER_UNAVAILABLE_CODE);
					assert.match(err.message, /collector/i);
				}
				return true;
			},
		);
	} finally {
		restore();
	}
});

test("acquireBrowserForConnector fails closed for HEADED in container with no local collector (PDPP_FORCE_CONTAINER=1)", async () => {
	const restore = withEnv({ PDPP_FORCE_CONTAINER: "1" });
	try {
		await assert.rejects(
			() =>
				acquireBrowserForConnector({
					profileName: "test_connector",
					headless: false,
				}),
			(err: unknown) => {
				assert.ok(
					err instanceof HeadedBrowserUnavailableError,
					`got ${String(err)}`,
				);
				if (err instanceof HeadedBrowserUnavailableError) {
					assert.equal(err.code, HEADED_BROWSER_UNAVAILABLE_CODE);
					assert.match(err.message, /container/i);
					assert.match(err.message, /collector/i);
					// Message must explicitly mention that headless is unaffected so
					// the operator who hits this never thinks the gate applies to
					// their non-interactive workload.
					assert.match(err.message, /[Hh]eadless/);
				}
				return true;
			},
		);
	} finally {
		restore();
	}
});

test("HeadedBrowserUnavailableError carries the stable code", () => {
	const err = new HeadedBrowserUnavailableError({ message: "test" });
	assert.equal(err.code, HEADED_BROWSER_UNAVAILABLE_CODE);
	assert.equal(err.name, "HeadedBrowserUnavailableError");
	assert.ok(err instanceof Error);
});

test("configuredBrowserChannel defaults to bundled Patchright Chromium", () => {
	assert.equal(configuredBrowserChannel({}), undefined);
	assert.equal(
		configuredBrowserChannel({ PDPP_BROWSER_CHANNEL: "   " }),
		undefined,
	);
});

test("configuredBrowserChannel preserves explicit channel override", () => {
	assert.equal(
		configuredBrowserChannel({ PDPP_BROWSER_CHANNEL: " chrome " }),
		"chrome",
	);
	assert.equal(
		configuredBrowserChannel({ PDPP_BROWSER_CHANNEL: "chromium" }),
		"chromium",
	);
});

test("resolveDeploymentBrowserHeadless keeps mode deployment-owned when callers omit it", () => {
	assert.equal(resolveDeploymentBrowserHeadless(undefined, {}), false);
	assert.equal(
		resolveDeploymentBrowserHeadless(undefined, { PDPP_BROWSER_HEADLESS: "1" }),
		true,
	);
	assert.equal(
		resolveDeploymentBrowserHeadless(undefined, { PDPP_BROWSER_HEADLESS: "0" }),
		false,
	);
	assert.equal(
		resolveDeploymentBrowserHeadless(false, { PDPP_BROWSER_HEADLESS: "1" }),
		false,
	);
	assert.equal(
		resolveDeploymentBrowserHeadless(true, { PDPP_BROWSER_HEADLESS: "0" }),
		true,
	);
});

// ─── wsUrl extraction (DevToolsActivePort + /json target listing) ──────
//
// We exercise the extraction helpers via injectable `fetch` and a real
// temp dir holding a `DevToolsActivePort` file written in Chromium's
// canonical format. We do NOT spin up a real Chromium for this — the
// extraction's contract is "given a userDataDir with a port file and a
// fetch returning the standard /json shape, return the first page
// target's webSocketDebuggerUrl"; that's a pure data-shape problem.

const FAKE_JSON_RESPONSE = [
	{
		type: "background_page",
		webSocketDebuggerUrl: "ws://127.0.0.1:9999/devtools/page/extension",
	},
	{
		type: "page",
		title: "about:blank",
		url: "about:blank",
		webSocketDebuggerUrl: "ws://127.0.0.1:9999/devtools/page/PAGE_TARGET_ID",
	},
];

function fakeFetchOk(body: unknown): typeof fetch {
	return ((): Promise<Response> =>
		Promise.resolve(
			new Response(JSON.stringify(body), { status: 200 }),
		)) as typeof fetch;
}

function urlOf(input: string | URL | Request): string {
	if (typeof input === "string") {
		return input;
	}
	if (input instanceof URL) {
		return input.toString();
	}
	return (input as Request).url;
}

test("fetchPageTargetWsUrl picks the first page target from /json", async () => {
	const wsUrl = await fetchPageTargetWsUrl({
		port: 9999,
		fetchImpl: fakeFetchOk(FAKE_JSON_RESPONSE),
	});
	assert.equal(wsUrl, "ws://127.0.0.1:9999/devtools/page/PAGE_TARGET_ID");
});

test("fetchPageTargetWsUrl returns null when no page target is present", async () => {
	const wsUrl = await fetchPageTargetWsUrl({
		port: 9999,
		fetchImpl: fakeFetchOk([
			{
				type: "service_worker",
				webSocketDebuggerUrl: "ws://127.0.0.1:9999/devtools/page/sw",
			},
			{
				type: "browser",
				webSocketDebuggerUrl: "ws://127.0.0.1:9999/devtools/browser/abc",
			},
		]),
	});
	assert.equal(wsUrl, null);
});

test("fetchPageTargetWsUrl returns null on /json non-200", async () => {
	const wsUrl = await fetchPageTargetWsUrl({
		port: 9999,
		fetchImpl: ((): Promise<Response> =>
			Promise.resolve(new Response("nope", { status: 500 }))) as typeof fetch,
	});
	assert.equal(wsUrl, null);
});

test("fetchPageTargetWsUrl returns null on /json network error (does not throw)", async () => {
	const wsUrl = await fetchPageTargetWsUrl({
		port: 9999,
		fetchImpl: ((): Promise<Response> =>
			Promise.reject(new Error("ECONNREFUSED"))) as typeof fetch,
	});
	assert.equal(wsUrl, null);
});

test("fetchPageTargetWsUrl returns null on non-JSON body (does not throw)", async () => {
	const wsUrl = await fetchPageTargetWsUrl({
		port: 9999,
		fetchImpl: ((): Promise<Response> =>
			Promise.resolve(
				new Response("not json", { status: 200 }),
			)) as typeof fetch,
	});
	assert.equal(wsUrl, null);
});

test("closeRemoteCdpPageTargets replaces stale page targets before closing them", async () => {
	const seenRequests: Array<{ method: string; url: string }> = [];
	let listCalls = 0;
	const fetchImpl = ((
		input: string | URL | Request,
		init?: RequestInit,
	): Promise<Response> => {
		const url = urlOf(input);
		seenRequests.push({ method: init?.method ?? "GET", url });
		if (url.endsWith("/json")) {
			listCalls += 1;
			const body =
				listCalls === 1
					? [
							{
								id: "PAGE_TARGET_ID",
								type: "page",
								url: "https://www.amazon.com/your-orders/orders",
							},
							{
								id: "IFRAME_TARGET_ID",
								type: "iframe",
								url: "https://www.amazon.com/frame",
							},
							{
								id: "SERVICE_WORKER_ID",
								type: "service_worker",
								url: "https://www.amazon.com/sw.js",
							},
						]
					: [
							{ id: "FRESH_PAGE_TARGET_ID", type: "page", url: "about:blank" },
							{
								id: "IFRAME_TARGET_ID",
								type: "iframe",
								url: "https://www.amazon.com/frame",
							},
							{
								id: "SERVICE_WORKER_ID",
								type: "service_worker",
								url: "https://www.amazon.com/sw.js",
							},
						];
			return Promise.resolve(
				new Response(JSON.stringify(body), { status: 200 }),
			);
		}
		if (url.endsWith("/json/new?about:blank")) {
			return Promise.resolve(
				new Response(
					JSON.stringify({
						id: "FRESH_PAGE_TARGET_ID",
						type: "page",
						url: "about:blank",
					}),
					{ status: 200 },
				),
			);
		}
		return Promise.resolve(new Response("Target is closing", { status: 200 }));
	}) as typeof fetch;

	const result = await closeRemoteCdpPageTargets({
		cdpUrl: "http://neko.example.test:9223/devtools/browser/browser-id",
		fetchImpl,
		timeoutMs: 500,
		pollMs: 1,
	});

	assert.deepEqual(result, {
		closed: 1,
		remaining: 0,
		replacementCreated: true,
		skipped: false,
	});
	assert.deepEqual(seenRequests, [
		{ method: "GET", url: "http://neko.example.test:9223/json" },
		{
			method: "PUT",
			url: "http://neko.example.test:9223/json/new?about:blank",
		},
		{
			method: "GET",
			url: "http://neko.example.test:9223/json/close/PAGE_TARGET_ID",
		},
		{ method: "GET", url: "http://neko.example.test:9223/json" },
	]);
});

test("closeRemoteCdpPageTargets does not close the last page when replacement creation fails", async () => {
	const seenRequests: Array<{ method: string; url: string }> = [];
	const fetchImpl = ((
		input: string | URL | Request,
		init?: RequestInit,
	): Promise<Response> => {
		const url = urlOf(input);
		seenRequests.push({ method: init?.method ?? "GET", url });
		if (url.endsWith("/json")) {
			return Promise.resolve(
				new Response(
					JSON.stringify([
						{
							id: "ONLY_PAGE_TARGET_ID",
							type: "page",
							url: "https://www.amazon.com",
						},
					]),
					{
						status: 200,
					},
				),
			);
		}
		if (url.endsWith("/json/new?about:blank")) {
			return Promise.resolve(new Response("nope", { status: 500 }));
		}
		return Promise.resolve(new Response("should not close", { status: 200 }));
	}) as typeof fetch;

	const result = await closeRemoteCdpPageTargets({
		cdpUrl: "http://neko.example.test:9223/",
		fetchImpl,
		timeoutMs: 500,
		pollMs: 1,
	});

	assert.deepEqual(result, {
		closed: 0,
		remaining: 1,
		replacementCreated: false,
		skipped: true,
	});
	assert.deepEqual(seenRequests, [
		{ method: "GET", url: "http://neko.example.test:9223/json" },
		{
			method: "PUT",
			url: "http://neko.example.test:9223/json/new?about:blank",
		},
	]);
});

test("closeRemoteCdpPageTargets skips when the CDP URL cannot expose an HTTP target list", async () => {
	let called = false;
	const result = await closeRemoteCdpPageTargets({
		cdpUrl: "unix:/tmp/chrome.sock",
		fetchImpl: (() => {
			called = true;
			return Promise.resolve(new Response("unexpected", { status: 200 }));
		}) as typeof fetch,
	});

	assert.deepEqual(result, {
		closed: 0,
		remaining: 0,
		replacementCreated: false,
		skipped: true,
	});
	assert.equal(called, false);
});

test("shouldCleanRemoteCdpPageTargets skips cleanup only for preserved remote pages", () => {
	assert.equal(shouldCleanRemoteCdpPageTargets({}), true);
	assert.equal(
		shouldCleanRemoteCdpPageTargets({ preserveRemotePagesOnAcquire: false }),
		true,
	);
	assert.equal(
		shouldCleanRemoteCdpPageTargets({ preserveRemotePagesOnAcquire: true }),
		false,
	);
});

test("remoteCdpPageCleanupSkipReason names why cleanup is skipped; the env opt-in needs exactly 1", () => {
	assert.equal(remoteCdpPageCleanupSkipReason({}, {}), null);
	assert.equal(
		remoteCdpPageCleanupSkipReason(
			{},
			{ PDPP_REMOTE_CDP_SKIP_PAGE_CLEANUP: "1" },
		),
		"recording_host_fresh_browser",
	);
	for (const value of ["", "0", "true", "yes"]) {
		assert.equal(
			remoteCdpPageCleanupSkipReason(
				{},
				{ PDPP_REMOTE_CDP_SKIP_PAGE_CLEANUP: value },
			),
			null,
			`value ${JSON.stringify(value)} must not skip cleanup`,
		);
	}
	// The caller's own preserve option wins and is the reported reason.
	assert.equal(
		remoteCdpPageCleanupSkipReason(
			{ preserveRemotePagesOnAcquire: true },
			{ PDPP_REMOTE_CDP_SKIP_PAGE_CLEANUP: "1" },
		),
		"preserve_remote_pages_on_acquire",
	);
	assert.equal(
		shouldCleanRemoteCdpPageTargets(
			{},
			{ PDPP_REMOTE_CDP_SKIP_PAGE_CLEANUP: "1" },
		),
		false,
	);
});

test("withScenarioClockPaused nests, and restores the pause counter when the body throws", async () => {
	const scope = globalThis as { __pdppScenarioClockPaused?: number };
	const before = scope.__pdppScenarioClockPaused ?? 0;
	const seen: number[] = [];
	await withScenarioClockPaused(async () => {
		seen.push(scope.__pdppScenarioClockPaused ?? 0);
		await withScenarioClockPaused(async () => {
			seen.push(scope.__pdppScenarioClockPaused ?? 0);
		});
		seen.push(scope.__pdppScenarioClockPaused ?? 0);
	});
	assert.deepEqual(seen, [before + 1, before + 2, before + 1]);
	await assert.rejects(
		withScenarioClockPaused(() => Promise.reject(new Error("acquire failed"))),
		/acquire failed/,
	);
	assert.equal(scope.__pdppScenarioClockPaused ?? 0, before);
});

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

test("remote CDP attach records HAR and storage state, keeps existing tabs, and leaves the browser running", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pdpp-remote-har-test-"));
	const site = createHttpServer((_req, res) => {
		res.writeHead(200, {
			"content-type": "text/html",
			"set-cookie": "remote_session=abc123; Path=/",
		});
		res.end("<html><body>remote har fixture</body></html>");
	});
	await new Promise<void>((resolve) => {
		site.listen(0, "127.0.0.1", resolve);
	});
	const siteAddress = site.address();
	const sitePort =
		typeof siteAddress === "object" && siteAddress ? siteAddress.port : 0;
	const cdpPort = await freeLoopbackPort();
	// A persistent context is the browser's default context, the one a CDP
	// attach hands to the connector, so the owner's tab shares it with ours.
	const remote = await chromium.launchPersistentContext(join(dir, "profile"), {
		args: [`--remote-debugging-port=${String(cdpPort)}`],
	});
	t.after(async () => {
		await remote.close().catch(() => undefined);
		await new Promise<void>((resolve) => {
			site.close(() => resolve());
		});
		await rm(dir, { recursive: true, force: true });
	});
	const ownersTab = await remote.newPage();
	await ownersTab.goto("about:blank#owners-tab");

	const harPath = join(dir, "remote.har");
	const storageStatePath = join(dir, "remote-storage-state.json");
	const handle = await acquireIsolatedBrowser({
		profileName: "remote_har_test",
		remoteCdpUrl: `http://127.0.0.1:${String(cdpPort)}`,
		preserveRemotePagesOnAcquire: true,
		harRecording: { path: harPath },
		storageStateRecording: { path: storageStatePath },
	});
	const page = await handle.context.newPage();
	await page.goto(`http://127.0.0.1:${String(sitePort)}/fixture`);
	// The runtime leaves its page open during a recording run and expects
	// release() to close it, so the test does not close it either.
	await handle.release();

	assert.deepEqual(await handle.harRecordingOutcome?.(), {
		flushed: true,
		path: harPath,
	});
	assert.deepEqual(await handle.storageStateRecordingOutcome?.(), {
		flushed: true,
		path: storageStatePath,
	});
	const har = JSON.parse(await readFile(harPath, "utf8")) as {
		log: { entries: { request: { url: string } }[] };
	};
	assert.ok(
		har.log.entries.some((entry) =>
			entry.request.url.endsWith(`:${String(sitePort)}/fixture`),
		),
		"HAR must contain the request made through the attached context",
	);
	const storageState = JSON.parse(await readFile(storageStatePath, "utf8")) as {
		cookies: { name: string }[];
	};
	assert.ok(
		storageState.cookies.some((cookie) => cookie.name === "remote_session"),
		"storage state must contain the cookie set during the attached run",
	);
	assert.equal(
		remote.browser()?.isConnected() ?? true,
		true,
		"remote browser must keep running",
	);
	assert.equal(ownersTab.isClosed(), false, "pre-existing tab must stay open");
	assert.equal(
		remote.pages().some((p) => p.url().endsWith("/fixture")),
		false,
		"release() must close the page the run created",
	);
});

test("remote CDP recording embeds the bodies of downloads from run-owned pages only", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pdpp-remote-har-download-test-"));
	const site = createHttpServer((req, res) => {
		if (req.url?.endsWith(".zip")) {
			res.writeHead(200, {
				"content-type": "application/zip",
				"content-disposition": "attachment; filename=export.zip",
			});
			res.end(`zip-bytes-for-${req.url}`);
			return;
		}
		res.writeHead(200, { "content-type": "text/html" });
		res.end("<html><body>downloads</body></html>");
	});
	await new Promise<void>((resolve) => {
		site.listen(0, "127.0.0.1", resolve);
	});
	const siteAddress = site.address();
	const sitePort =
		typeof siteAddress === "object" && siteAddress ? siteAddress.port : 0;
	const origin = `http://127.0.0.1:${String(sitePort)}`;
	const cdpPort = await freeLoopbackPort();
	const remote = await chromium.launchPersistentContext(join(dir, "profile"), {
		args: [`--remote-debugging-port=${String(cdpPort)}`],
	});
	t.after(async () => {
		await remote.close().catch(() => undefined);
		await new Promise<void>((resolve) => {
			site.close(() => resolve());
		});
		await rm(dir, { recursive: true, force: true });
	});
	const harPath = join(dir, "remote.har");
	const handle = await acquireIsolatedBrowser({
		profileName: "remote_har_download_test",
		remoteCdpUrl: `http://127.0.0.1:${String(cdpPort)}`,
		preserveRemotePagesOnAcquire: true,
		harRecording: { path: harPath },
	});
	// The owner opens a tab in the attached browser and downloads a file
	// while the run is recording; the run downloads its own export.
	const attachedContext = handle.context;
	const ownersTab = await remote.newPage();
	await ownersTab.goto(`${origin}/owner`);
	const ownerDownload = ownersTab.waitForEvent("download");
	await ownersTab.evaluate((href) => {
		window.location.href = href;
	}, `${origin}/owner-private.zip`);
	await (await ownerDownload).path();

	const page = await attachedContext.newPage();
	await page.goto(`${origin}/run`);
	const runDownload = page.waitForEvent("download");
	await page.evaluate((href) => {
		window.location.href = href;
	}, `${origin}/export.zip`);
	await (await runDownload).path();
	await handle.release();

	const har = JSON.parse(await readFile(harPath, "utf8")) as {
		log: {
			entries: {
				request: { url: string };
				response: { content?: { encoding?: string; text?: string } };
			}[];
		};
	};
	const bodyFor = (suffix: string): string | undefined => {
		const entry = har.log.entries.findLast((e) =>
			e.request.url.endsWith(suffix),
		);
		const content = entry?.response.content;
		return content?.encoding === "base64" && content.text
			? Buffer.from(content.text, "base64").toString("utf8")
			: undefined;
	};
	assert.equal(bodyFor("/export.zip"), "zip-bytes-for-/export.zip");
	assert.equal(
		bodyFor("/owner-private.zip"),
		undefined,
		"a download in the owner's tab must not be embedded",
	);
	assert.equal(ownersTab.isClosed(), false, "owner's tab must stay open");
});

test("remote CDP HAR start failure disconnects without closing any page", async () => {
	let disconnects = 0;
	let failureHook = 0;
	await assert.rejects(
		startRemoteCdpHarRecording({
			browser: {
				close: () => {
					disconnects += 1;
					return Promise.resolve();
				},
			},
			context: {
				routeFromHAR: () => Promise.reject(new Error("har start refused")),
			},
			harPath: "/nonexistent/remote.har",
			onFailure: () => {
				failureHook += 1;
			},
			profileName: "remote_har_test",
		}),
		/Remote HAR recording could not start/,
	);
	// The fake context exposes no pages and no close(), so the only way to
	// pass is to disconnect the client and touch nothing else.
	assert.equal(disconnects, 1);
	assert.equal(failureHook, 1);
});

test("warnIfRecordingSharedRemoteBrowser warns once when other pages are open, not for blank ones", () => {
	const writes: string[] = [];
	const original = process.stderr.write.bind(process.stderr);
	process.stderr.write = ((chunk: string | Uint8Array): boolean => {
		writes.push(String(chunk));
		return true;
	}) as typeof process.stderr.write;
	const page = (url: string) => ({ isClosed: () => false, url: () => url });
	try {
		warnIfRecordingSharedRemoteBrowser(
			{ pages: () => [page("about:blank")] } as never,
			"p",
		);
		assert.equal(writes.length, 0);
		warnIfRecordingSharedRemoteBrowser(
			{
				pages: () => [page("about:blank"), page("https://mail.example/")],
			} as never,
			"p",
		);
	} finally {
		process.stderr.write = original;
	}
	assert.equal(writes.length, 1);
	assert.match(writes[0] ?? "", /1 other open page/);
	assert.match(writes[0] ?? "", /dedicated sandbox profile/);
});

test("resolvePageTargetWsUrl reads DevToolsActivePort then queries /json with the parsed port", async () => {
	const userDataDir = await mkdtemp(join(tmpdir(), "pdpp-launch-test-"));
	try {
		// Chromium writes two lines: PORT, then /devtools/browser/<id>.
		await writeFile(
			join(userDataDir, "DevToolsActivePort"),
			"9999\n/devtools/browser/abc-123\n",
			"utf8",
		);
		let calledUrl: string | null = null;
		const wsUrl = await resolvePageTargetWsUrl({
			userDataDir,
			timeoutMs: 200,
			pollMs: 5,
			fetchImpl: ((input: string | URL | Request): Promise<Response> => {
				calledUrl = urlOf(input);
				return Promise.resolve(
					new Response(JSON.stringify(FAKE_JSON_RESPONSE), { status: 200 }),
				);
			}) as typeof fetch,
		});
		assert.equal(
			calledUrl,
			"http://127.0.0.1:9999/json",
			"fetch should target the parsed port on loopback",
		);
		assert.equal(wsUrl, "ws://127.0.0.1:9999/devtools/page/PAGE_TARGET_ID");
	} finally {
		await rm(userDataDir, { recursive: true, force: true });
	}
});

test("resolvePageTargetWsUrl returns null when DevToolsActivePort never appears", async () => {
	const userDataDir = await mkdtemp(join(tmpdir(), "pdpp-launch-test-"));
	try {
		// Don't write the file; resolver should give up after timeoutMs.
		const wsUrl = await resolvePageTargetWsUrl({
			userDataDir,
			timeoutMs: 100,
			pollMs: 10,
			fetchImpl: fakeFetchOk(FAKE_JSON_RESPONSE),
		});
		assert.equal(wsUrl, null);
	} finally {
		await rm(userDataDir, { recursive: true, force: true });
	}
});

test("resolvePageTargetWsUrl returns null when DevToolsActivePort is malformed", async () => {
	const userDataDir = await mkdtemp(join(tmpdir(), "pdpp-launch-test-"));
	try {
		await writeFile(
			join(userDataDir, "DevToolsActivePort"),
			"not-a-port\n/devtools/browser/abc\n",
			"utf8",
		);
		const wsUrl = await resolvePageTargetWsUrl({
			userDataDir,
			timeoutMs: 100,
			pollMs: 10,
			fetchImpl: fakeFetchOk(FAKE_JSON_RESPONSE),
		});
		assert.equal(wsUrl, null);
	} finally {
		await rm(userDataDir, { recursive: true, force: true });
	}
});

// ─── Remote-CDP attach session-closed race recognition + retry ─────────
//
// The production failure was `connectOverCDP` rejecting with
// `Protocol error (Network.setCacheDisabled): Internal server error,
// session closed.` when Patchright auto-attaches to a transient n.eko
// target that is being torn down mid-attach. The race is transient, so we
// retry the WHOLE attach. We exercise the predicate and the retry policy
// directly with an injectable `connect` and `sleep` — no live browser.

// The exact production error message shape (patchright crConnection.js
// `dispose()` sets this message; `setMessage` prefixes the CDP method).
const PRODUCTION_RACE_MESSAGE =
	"Protocol error (Network.setCacheDisabled): Internal server error, session closed.";

test("isCdpAttachSessionRaceError matches the production setCacheDisabled session-closed error", () => {
	assert.equal(
		isCdpAttachSessionRaceError(new Error(PRODUCTION_RACE_MESSAGE)),
		true,
	);
	// Bare string form (some transports surface message-only).
	assert.equal(isCdpAttachSessionRaceError(PRODUCTION_RACE_MESSAGE), true);
});

test("isCdpAttachSessionRaceError does NOT match unrelated protocol errors (fail fast)", () => {
	// Wrong CDP method — a session-closed on some other command is not this race.
	assert.equal(
		isCdpAttachSessionRaceError(
			new Error("Protocol error (Target.attachToTarget): session closed"),
		),
		false,
	);
	// setCacheDisabled but not session-closed (e.g. a real argument error).
	assert.equal(
		isCdpAttachSessionRaceError(
			new Error(
				"Protocol error (Network.setCacheDisabled): Invalid parameters",
			),
		),
		false,
	);
	// Completely unrelated failures must fail fast.
	assert.equal(
		isCdpAttachSessionRaceError(
			new Error("connect ECONNREFUSED 127.0.0.1:9223"),
		),
		false,
	);
	assert.equal(
		isCdpAttachSessionRaceError(new Error("WebSocket error: 403 Forbidden")),
		false,
	);
	assert.equal(isCdpAttachSessionRaceError(undefined), false);
	assert.equal(isCdpAttachSessionRaceError(null), false);
	assert.equal(isCdpAttachSessionRaceError({}), false);
});

// The retry-LOOP tests inject a trivial `runAttempt` that just calls `connect`
// directly. They exercise the loop's backoff/budget/fail-fast policy, NOT the
// per-attempt unhandled-rejection guard (which has its own block below). This
// keeps them fast (no 250ms settle window) and isolated to one concern.
const directAttempt: typeof runCdpAttemptWithRaceGuard = ({ connect }) =>
	connect();

test("connectOverCdpWithRetry returns immediately on first-attempt success (no retry)", async () => {
	let attempts = 0;
	let slept = 0;
	const browser = await connectOverCdpWithRetry<string>({
		connect: () => {
			attempts += 1;
			return Promise.resolve("BROWSER");
		},
		profileName: "amazon",
		redactedUrl: "http://neko/",
		runAttempt: directAttempt,
		sleep: () => {
			slept += 1;
			return Promise.resolve();
		},
	});
	assert.equal(browser, "BROWSER");
	assert.equal(attempts, 1);
	assert.equal(slept, 0, "no sleep on first-attempt success");
});

test("connectOverCdpWithRetry rides out a transient session-closed race then succeeds", async () => {
	let attempts = 0;
	const delays: number[] = [];
	const browser = await connectOverCdpWithRetry<string>({
		connect: () => {
			attempts += 1;
			if (attempts < 3) {
				return Promise.reject(new Error(PRODUCTION_RACE_MESSAGE));
			}
			return Promise.resolve("BROWSER");
		},
		profileName: "amazon",
		redactedUrl: "http://neko/",
		retryDelayMs: 7,
		runAttempt: directAttempt,
		sleep: (ms) => {
			delays.push(ms);
			return Promise.resolve();
		},
	});
	assert.equal(browser, "BROWSER");
	assert.equal(attempts, 3, "two failed attempts then a success");
	assert.deepEqual(
		delays,
		[7, 7],
		"slept the configured delay between each retry",
	);
});

test("connectOverCdpWithRetry rethrows a typed CdpAttachSessionRaceExhaustedError after exhausting the attempt budget", async () => {
	// This IS the source boundary the reference runtime must key off of: the
	// typed .code, not message-text pattern-matching downstream.
	let attempts = 0;
	let slept = 0;
	await assert.rejects(
		() =>
			connectOverCdpWithRetry<string>({
				connect: () => {
					attempts += 1;
					return Promise.reject(new Error(PRODUCTION_RACE_MESSAGE));
				},
				profileName: "amazon",
				redactedUrl: "http://neko/",
				maxAttempts: 3,
				runAttempt: directAttempt,
				sleep: () => {
					slept += 1;
					return Promise.resolve();
				},
			}),
		(err: unknown) => {
			assert.ok(err instanceof CdpAttachSessionRaceExhaustedError);
			assert.equal(err.code, CDP_ATTACH_SESSION_RACE_EXHAUSTED_CODE);
			assert.equal(err.code, "browser_surface_attach_exhausted");
			assert.match(
				err.message,
				/attach-session race/i,
				"stable failure category remains available without provider details",
			);
			assert.ok(err.cause instanceof Error, "a payload-free cause is retained");
			return true;
		},
	);
	assert.equal(attempts, 3, "tried the full budget");
	assert.equal(
		slept,
		2,
		"slept between attempts but not after the final failure",
	);
});

test("connectOverCdpWithRetry does NOT tag a non-race error with the exhausted code, even after retries would have applied", async () => {
	// Guards the negative direction: an unrelated failure (that happens to
	// fail on the first attempt, so there IS no retry) must never acquire the
	// typed code — only the narrow race, only on budget exhaustion.
	await assert.rejects(
		() =>
			connectOverCdpWithRetry<string>({
				connect: () =>
					Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:9223")),
				profileName: "amazon",
				redactedUrl: "http://neko/",
				maxAttempts: 3,
				runAttempt: directAttempt,
				sleep: () => Promise.resolve(),
			}),
		(err: unknown) => {
			assert.ok(!(err instanceof CdpAttachSessionRaceExhaustedError));
			assert.equal((err as { code?: unknown })?.code, undefined);
			return true;
		},
	);
});

test("connectOverCdpWithRetry fails fast on a non-race error (no retry, no sleep)", async () => {
	let attempts = 0;
	let slept = 0;
	await assert.rejects(
		() =>
			connectOverCdpWithRetry<string>({
				connect: () => {
					attempts += 1;
					return Promise.reject(
						new Error("connect ECONNREFUSED 127.0.0.1:9223"),
					);
				},
				profileName: "amazon",
				redactedUrl: "http://neko/",
				runAttempt: directAttempt,
				sleep: () => {
					slept += 1;
					return Promise.resolve();
				},
			}),
		/Remote browser attach failed/,
	);
	assert.equal(attempts, 1, "non-race error is not retried");
	assert.equal(slept, 0, "no sleep on a fail-fast error");
});

// ─── v2: scoped unhandled-rejection guard around each attach attempt ────
//
// The v1 fix wrapped `connectOverCDP` in a try/catch. That was the WRONG catch
// boundary: in production `connectOverCDP` RESOLVES, then patchright's floated
// `setRequestInterception(true)` (CRPage constructor, no await/no catch) rejects
// on a LATER tick as a Node UNHANDLED REJECTION — escaping the connect promise
// entirely and crashing the process (`node:internal/process/promises`). These
// tests drive a fake `unhandledRejection` host so we can model that escape
// deterministically without a live browser or touching the real process.

interface FakeRejectionHost {
	/** Emit an unhandled rejection to all currently-registered listeners. */
	emit: (reason: unknown) => void;
	host: UnhandledRejectionHost;
	/** How many listeners are currently registered (must return to 0). */
	listenerCount: () => number;
}

function makeFakeRejectionHost(): FakeRejectionHost {
	const listeners = new Set<(reason: unknown) => void>();
	return {
		host: {
			on: (_event, listener) => {
				listeners.add(listener);
			},
			off: (_event, listener) => {
				listeners.delete(listener);
			},
		},
		emit: (reason) => {
			// Copy so a listener removing itself mid-iteration is safe.
			for (const listener of [...listeners]) {
				listener(reason);
			}
		},
		listenerCount: () => listeners.size,
	};
}

test("runCdpAttemptWithRaceGuard resolves and removes its listener on a clean attach", async () => {
	const fake = makeFakeRejectionHost();
	const browser = await runCdpAttemptWithRaceGuard<string>({
		connect: () => Promise.resolve("BROWSER"),
		settleMs: 0,
		host: fake.host,
	});
	assert.equal(browser, "BROWSER");
	assert.equal(
		fake.listenerCount(),
		0,
		"guard listener is removed after a clean attach",
	);
});

test("runCdpAttemptWithRaceGuard converts an UNHANDLED setCacheDisabled rejection (after connect resolved) into a retryable throw", async () => {
	const fake = makeFakeRejectionHost();
	let disconnected: string | null = null;
	// Model production exactly: connect resolves with a live browser, THEN the
	// floated setRequestInterception rejection escapes as an unhandled rejection
	// a tick later — while the guard's settle window is still open.
	await assert.rejects(
		() =>
			runCdpAttemptWithRaceGuard<string>({
				connect: () => {
					// Schedule the escape for just after connect resolves, like the real
					// floated promise. The guard's settle window must still be open.
					setTimeout(() => fake.emit(new Error(PRODUCTION_RACE_MESSAGE)), 5);
					return Promise.resolve("LIVE_BROWSER");
				},
				disconnect: (b) => {
					disconnected = b;
				},
				settleMs: 200,
				host: fake.host,
			}),
		(err: unknown) => {
			assert.ok(err instanceof Error);
			assert.match((err as Error).message, /Network\.setCacheDisabled/);
			assert.match((err as Error).message, /session closed/i);
			return true;
		},
	);
	assert.equal(
		disconnected,
		"LIVE_BROWSER",
		"the orphaned just-connected browser is disconnected before retry",
	);
	assert.equal(
		fake.listenerCount(),
		0,
		"guard listener is removed even when it converts a race to a throw",
	);
});

test("runCdpAttemptWithRaceGuard converts an UNHANDLED race while connect is still pending", async () => {
	const fake = makeFakeRejectionHost();
	let resolveConnect: ((browser: string) => void) | undefined;
	const disconnected: string[] = [];

	await assert.rejects(
		() =>
			runCdpAttemptWithRaceGuard<string>({
				connect: () =>
					new Promise<string>((resolve) => {
						resolveConnect = resolve;
						setTimeout(() => fake.emit(new Error(PRODUCTION_RACE_MESSAGE)), 5);
					}),
				disconnect: (b) => {
					disconnected.push(b);
				},
				settleMs: 200,
				host: fake.host,
			}),
		(err: unknown) => {
			assert.ok(err instanceof Error);
			assert.match((err as Error).message, /Network\.setCacheDisabled/);
			assert.match((err as Error).message, /session closed/i);
			return true;
		},
	);

	assert.equal(
		fake.listenerCount(),
		0,
		"guard listener is removed after the pending-connect race",
	);
	assert.deepEqual(
		disconnected,
		[],
		"no Browser existed at the moment the guarded attempt rejected",
	);

	// If Patchright eventually resolves the stale connect promise after the
	// attempt already retried, the late Browser is still disconnected
	// best-effort so the abandoned CDP client does not leak.
	assert.ok(resolveConnect, "connect promise was started");
	resolveConnect("LATE_BROWSER");
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.deepEqual(
		disconnected,
		["LATE_BROWSER"],
		"late browser was disconnected after pending-connect race",
	);
});

test("runCdpAttemptWithRaceGuard does NOT swallow an unrelated unhandled rejection (re-throws to preserve crash semantics)", async () => {
	const fake = makeFakeRejectionHost();
	// A non-race unhandled rejection must NOT be consumed — the guard re-throws
	// it from the listener so Node's default crash-on-unhandled-rejection applies.
	// We assert that synchronous re-throw here (the real process would terminate).
	await runCdpAttemptWithRaceGuard<string>({
		connect: () => Promise.resolve("BROWSER"),
		settleMs: 0,
		host: fake.host,
	});
	// Listener was removed on the clean resolve above; re-arm one to assert the
	// non-race re-throw behavior directly against the guard's listener contract.
	const fake2 = makeFakeRejectionHost();
	let caught: unknown;
	const guarded = runCdpAttemptWithRaceGuard<string>({
		connect: () =>
			new Promise<string>((resolve) => {
				// Emit an unrelated unhandled rejection while the connect is pending.
				// The guard's listener must re-throw it synchronously.
				try {
					fake2.emit(new Error("some unrelated subsystem failure"));
				} catch (err) {
					caught = err;
				}
				resolve("BROWSER");
			}),
		settleMs: 0,
		host: fake2.host,
	});
	await guarded;
	assert.ok(
		caught instanceof Error,
		"the non-race rejection was re-thrown, not swallowed",
	);
	assert.equal((caught as Error).message, "Remote browser operation failed");
	assert.equal(
		fake2.listenerCount(),
		0,
		"guard removed its listener before re-throwing the non-race rejection",
	);
});

test("runCdpAttemptWithRaceGuard with no escape during the settle window resolves the connected browser", async () => {
	const fake = makeFakeRejectionHost();
	// No unhandled rejection emitted: a clean attach where the transient target
	// never raced. Short settle window so the test is fast.
	const browser = await runCdpAttemptWithRaceGuard<string>({
		connect: () => Promise.resolve("CLEAN_BROWSER"),
		settleMs: 10,
		host: fake.host,
	});
	assert.equal(browser, "CLEAN_BROWSER");
	assert.equal(fake.listenerCount(), 0);
});

test("connectOverCdpWithRetry rides out an UNHANDLED-rejection race end-to-end then succeeds", async () => {
	// Full integration of the loop + guard: attempt 1's connect resolves but the
	// floated rejection escapes as an unhandled rejection (converted to a retry);
	// attempt 2 attaches cleanly. Uses a per-call fake host so each attempt's
	// guard is independent, mirroring the real `process` host across attempts.
	let attempts = 0;
	let slept = 0;
	const disconnects: string[] = [];
	const browser = await connectOverCdpWithRetry<string>({
		connect: () => {
			attempts += 1;
			return Promise.resolve(`BROWSER_ATTEMPT_${attempts}`);
		},
		disconnect: (b) => {
			disconnects.push(b);
		},
		profileName: "amazon",
		redactedUrl: "http://neko/",
		retryDelayMs: 1,
		sleep: () => {
			slept += 1;
			return Promise.resolve();
		},
		runAttempt: ({ connect, disconnect }) => {
			const fake = makeFakeRejectionHost();
			return runCdpAttemptWithRaceGuard({
				connect: () => {
					const p = connect();
					// Only attempt 1 races: schedule the escape just after connect resolves.
					if (attempts === 1) {
						setTimeout(() => fake.emit(new Error(PRODUCTION_RACE_MESSAGE)), 2);
					}
					return p;
				},
				settleMs: attempts === 1 ? 200 : 5,
				host: fake.host,
				...(disconnect ? { disconnect } : {}),
			});
		},
	});
	assert.equal(browser, "BROWSER_ATTEMPT_2", "second attempt attached cleanly");
	assert.equal(attempts, 2, "one raced attempt, then a clean one");
	assert.equal(slept, 1, "slept once between the converted race and the retry");
	assert.deepEqual(
		disconnects,
		["BROWSER_ATTEMPT_1"],
		"the orphaned first browser was disconnected before retry",
	);
});

// ─── isDefinitivelyZeroViewport (unusable-display predicate) ──────────────
//
// `failFastOnUnusableViewport` itself is not practically testable
// headless-in-CI: a real headless launch has a real, non-zero viewport by
// construction, and reproducing the actual broken-display failure mode (a
// headed Chromium under a misconfigured X server / tmux with empty
// XAUTHORITY) needs a genuinely broken display, not something this suite
// can fabricate. Only the pure classification predicate is unit-tested
// here; the wiring around it (launch → evaluate → throw) was verified by
// reading `acquireIsolatedBrowser`'s launch path, not by an automated test.

test("isDefinitivelyZeroViewport: both dimensions zero is unusable", () => {
	assert.equal(
		isDefinitivelyZeroViewport({ innerWidth: 0, innerHeight: 0 }),
		true,
	);
});

test("isDefinitivelyZeroViewport: a normal viewport is not unusable", () => {
	assert.equal(
		isDefinitivelyZeroViewport({ innerWidth: 1280, innerHeight: 720 }),
		false,
	);
});

test("isDefinitivelyZeroViewport: a small-but-nonzero viewport is NOT flagged (conservative)", () => {
	assert.equal(
		isDefinitivelyZeroViewport({ innerWidth: 1, innerHeight: 1 }),
		false,
	);
});

test("isDefinitivelyZeroViewport: only width zero is not enough (must be BOTH dimensions)", () => {
	assert.equal(
		isDefinitivelyZeroViewport({ innerWidth: 0, innerHeight: 720 }),
		false,
	);
});

test("isDefinitivelyZeroViewport: only height zero is not enough (must be BOTH dimensions)", () => {
	assert.equal(
		isDefinitivelyZeroViewport({ innerWidth: 1280, innerHeight: 0 }),
		false,
	);
});

test("isDefinitivelyZeroViewport: undefined measurements (unreadable) are NOT flagged", () => {
	assert.equal(
		isDefinitivelyZeroViewport({
			innerWidth: undefined,
			innerHeight: undefined,
		}),
		false,
	);
	assert.equal(
		isDefinitivelyZeroViewport({ innerWidth: 0, innerHeight: undefined }),
		false,
	);
});

// ─── HAR secret-hygiene pass (redactHarDocument / scrubHarFileOrThrow) ────
//
// Pure-unit coverage of the actual redaction transform, independent of any
// subprocess/CLI wiring. A synthetic HAR document exercises every field
// this module claims to redact and, separately, every field it deliberately
// does NOT — both directions matter for a secret-hygiene claim.

function harWithOneEntry(overrides: {
	requestCookies?: Array<{ name: string; value: string }>;
	requestHeaders?: Array<{ name: string; value: string }>;
	requestPostData?: {
		mimeType?: string;
		params?: Array<{ name: string; type?: string; value: string }>;
		text?: string;
	};
	responseCookies?: Array<{ name: string; value: string }>;
	responseContent?: { text: string };
	responseHeaders?: Array<{ name: string; value: string }>;
	requestUrl?: string;
}) {
	return {
		log: {
			entries: [
				{
					request: {
						method: "POST",
						url: overrides.requestUrl ?? "https://provider.example.test/login",
						...(overrides.requestHeaders
							? { headers: overrides.requestHeaders }
							: {}),
						...(overrides.requestCookies
							? { cookies: overrides.requestCookies }
							: {}),
						...(overrides.requestPostData
							? { postData: overrides.requestPostData }
							: {}),
					},
					response: {
						status: 200,
						...(overrides.responseHeaders
							? { headers: overrides.responseHeaders }
							: {}),
						...(overrides.responseCookies
							? { cookies: overrides.responseCookies }
							: {}),
						...(overrides.responseContent
							? { content: overrides.responseContent }
							: {}),
					},
				},
			],
		},
	};
}

test("redactHarDocument: local HAR retains request header identities for replay", () => {
	const har = harWithOneEntry({
		requestHeaders: [
			{ name: "Cookie", value: "synthetic-session" },
			{ name: "Authorization", value: "Bearer synthetic-token" },
			{ name: "accept", value: "application/json" },
		],
	});
	assert.deepEqual(redactHarDocument(har), har);
});

test("redactHarDocument: local HAR retains response auth headers for replay", () => {
	const har = harWithOneEntry({
		responseHeaders: [
			{ name: "Set-Cookie", value: "session=synthetic-session; Path=/" },
			{ name: "X-CSRF-Token", value: "synthetic-csrf" },
			{ name: "x-xsrf-token", value: "synthetic-xsrf" },
			{ name: "content-type", value: "application/json" },
		],
	});
	assert.deepEqual(redactHarDocument(har), har);
});

test("redactHarDocument: local HAR retains both cookie representations", () => {
	const har = harWithOneEntry({
		requestCookies: [{ name: "session", value: "synthetic-session" }],
		responseCookies: [{ name: "session", value: "synthetic-session" }],
	});
	assert.deepEqual(redactHarDocument(har), har);
});

test("redactHarDocument: local HAR preserves form identity without changing request bytes", () => {
	const har = harWithOneEntry({
		requestPostData: {
			mimeType: "application/x-www-form-urlencoded",
			text: "username=synthetic-user&password=synthetic-password",
			params: [
				{ name: "username", value: "synthetic-user" },
				{ name: "password", value: "synthetic-password" },
			],
		},
	});
	assert.deepEqual(redactHarDocument(har), har);
});

test("redactHarDocument: local HAR preserves query values and request identity", () => {
	for (const requestUrl of [
		"https://synthetic.test/oauth/callback?code=synthetic-code&state=synthetic-state",
		"https://synthetic.test/api/data?access_token=synthetic-token&page=2",
		"https://synthetic.test/api/profile?id=A",
	]) {
		const har = harWithOneEntry({ requestUrl });
		assert.deepEqual(redactHarDocument(har), har);
	}
});

test("redactHarDocument: local HAR preserves pwd form data for exact replay", () => {
	const har = harWithOneEntry({
		requestPostData: {
			mimeType: "application/x-www-form-urlencoded",
			params: [{ name: "pwd", value: "synthetic-password" }],
		},
	});
	assert.deepEqual(redactHarDocument(har), har);
});

test("redactHarDocument: local HAR preserves password-typed fields for exact replay", () => {
	const har = harWithOneEntry({
		requestPostData: {
			mimeType: "application/x-www-form-urlencoded",
			params: [
				{ name: "credential", type: "password", value: "synthetic-secret" },
			],
		},
	});
	assert.deepEqual(redactHarDocument(har), har);
});

test("redactCdpUrl: removes userinfo and credential query values", () => {
	const redacted = redactCdpUrl(
		"wss://synthetic-user:synthetic-password@cdp.example.test/session?token=synthetic-token&view=compact",
	);
	assert.doesNotMatch(
		redacted,
		/synthetic-user|synthetic-password|synthetic-token/,
	);
	assert.equal(redacted, "[redacted-cdp-url]");
});

test("connectOverCdpWithRetry: redacts credential URLs from both the error and its cause", async () => {
	const raw =
		"wss://operator:secret@browser.example/cdp?token=private&safe=visible";
	let thrown: unknown;
	try {
		await connectOverCdpWithRetry<string>({
			connect: () => Promise.reject(new Error(`failed to connect ${raw}`)),
			profileName: "synthetic",
			redactedUrl: "wss://browser.example/cdp?token=[redacted]",
			maxAttempts: 1,
			runAttempt: directAttempt,
		});
	} catch (error) {
		thrown = error;
	}
	assert.ok(thrown instanceof Error);
	const cause = thrown.cause;
	assert.ok(cause instanceof Error);
	assert.doesNotMatch(thrown.message, /operator|secret|private/);
	assert.doesNotMatch(cause.message, /operator|secret|private/);
});

test("redactHarDocument: a non-credential form POST is left untouched", () => {
	const har = harWithOneEntry({
		requestPostData: {
			mimeType: "application/x-www-form-urlencoded",
			text: "search=hello+world",
			params: [{ name: "search", value: "hello world" }],
		},
	});
	const redacted = redactHarDocument(har) as ReturnType<typeof harWithOneEntry>;
	const postData = redacted.log.entries[0]?.request.postData as {
		params: Array<{ name: string; value: string }>;
	};
	assert.equal(
		postData.params[0]?.value,
		"hello world",
		"a search param is not a credential and must survive",
	);
});

test("redactHarDocument: does NOT redact response/request body content — stated residual exposure", () => {
	const har = harWithOneEntry({
		responseContent: {
			text: JSON.stringify({
				account_id: "acct_12345",
				token: "not-a-header",
			}),
		},
	});
	const redacted = redactHarDocument(har) as ReturnType<typeof harWithOneEntry>;
	const content = redacted.log.entries[0]?.response.content as { text: string };
	assert.match(
		content.text,
		/acct_12345/,
		"body content must survive unredacted — this is a documented gap, not a bug",
	);
});

test("redactHarDocument: incomplete HAR structure fails without echoing values", () => {
	assert.throws(
		() => redactHarDocument({ log: {} }),
		/HAR capture validation failed/,
	);
	assert.throws(() => redactHarDocument({}), /HAR capture validation failed/);
});

// ─── scrubHarFileOrThrow (file-level strictness) ───────────────────────────

test("scrubHarFileOrThrow: preserves a private local capture, 0600", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pdpp-har-redact-test-"));
	try {
		const harPath = join(dir, "capture.har");
		await writeFile(
			harPath,
			JSON.stringify(
				harWithOneEntry({
					requestHeaders: [{ name: "cookie", value: "s3cr3t" }],
				}),
			),
			"utf8",
		);
		await scrubHarFileOrThrow(harPath);
		const written = JSON.parse(await readFile(harPath, "utf8")) as ReturnType<
			typeof harWithOneEntry
		>;
		const headers = written.log.entries[0]?.request.headers as Array<{
			name: string;
			value: string;
		}>;
		assert.equal(headers[0]?.value, "s3cr3t");
		const info = await stat(harPath);
		// 0600 => only owner read/write bits set.
		// biome-ignore lint/suspicious/noBitwiseOperators: masking a real POSIX file mode, not a boolean/logic bug
		assert.equal(info.mode & 0o777, 0o600);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("scrubHarFileOrThrow: a missing file fails loudly", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pdpp-har-redact-missing-test-"));
	try {
		await assert.rejects(
			() => scrubHarFileOrThrow(join(dir, "does-not-exist.har")),
			/HAR scrub failed: recorded HAR file is missing/,
		);
		assert.ok(existsSync(join(dir, "does-not-exist.har.scrub-failed")));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("scrubHarFileOrThrow: an unparseable file fails closed and removes bytes", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pdpp-har-redact-garbage-test-"));
	try {
		const harPath = join(dir, "garbage.har");
		await writeFile(harPath, "not valid json {{{", "utf8");
		await assert.rejects(() => scrubHarFileOrThrow(harPath), /HAR.*valid JSON/);
		assert.ok(existsSync(`${harPath}.scrub-failed`));
		assert.equal(existsSync(harPath), false);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

// ─── fileFlushOutcome (the shared "did the expected file actually land"
// honesty check backing HarRecordingOutcome/StorageStateRecordingOutcome) ──

test("fileFlushOutcome: a nonempty file reports flushed:true", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pdpp-flush-outcome-test-"));
	try {
		const filePath = join(dir, "artifact.json");
		await writeFile(filePath, "{}", "utf8");
		const outcome = await fileFlushOutcome(filePath);
		assert.deepEqual(outcome, { path: filePath, flushed: true });
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("fileFlushOutcome: a missing file reports flushed:false (the honest crash/SIGKILL signal)", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pdpp-flush-outcome-missing-test-"));
	try {
		const outcome = await fileFlushOutcome(join(dir, "never-written.json"));
		assert.equal(outcome.flushed, false);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("fileFlushOutcome: a zero-byte file reports flushed:false (not a real capture)", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pdpp-flush-outcome-empty-test-"));
	try {
		const filePath = join(dir, "empty.json");
		await writeFile(filePath, "", "utf8");
		const outcome = await fileFlushOutcome(filePath);
		assert.equal(
			outcome.flushed,
			false,
			"a zero-byte file must not be reported as a successful flush",
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

// ─── opt-in cost: HAR recording env vars have stable, documented names ─────
//
// A change to either constant is a silent breaking change for the
// subprocess-boundary contract (see HAR_RECORD_PATH_ENV's doc comment) —
// pinned here so a rename shows up as an intentional, reviewed diff instead
// of a runtime-only surprise.

test("HAR_RECORD_PATH_ENV and STORAGE_STATE_RECORD_PATH_ENV have stable names", () => {
	assert.equal(HAR_RECORD_PATH_ENV, "PDPP_SCENARIO_HAR_RECORD_PATH");
	assert.equal(
		STORAGE_STATE_RECORD_PATH_ENV,
		"PDPP_SCENARIO_STORAGE_STATE_RECORD_PATH",
	);
});

test("HAR privacy: local artifact preserves URL copies and header identities without diagnostic output", () => {
	const secret = "SYNTHETIC_PRIVATE_SENTINEL";
	const har = {
		_private: secret,
		log: {
			_private: secret,
			entries: [
				{
					_private: secret,
					request: {
						method: "GET",
						url: `https://${secret}:${secret}@synthetic.test/callback?code=${secret}#${secret}`,
						queryString: [
							{ name: "code", value: secret },
							{ name: "code", value: secret },
						],
						headers: [
							"Proxy-Authorization",
							"X-Api-Key",
							"X-Auth-Token",
							"X-Custom",
						].map((name) => ({ name, value: secret })),
						_private: secret,
					},
					response: {
						status: 302,
						redirectURL: `/callback?code=${secret}#${secret}`,
						headers: [
							{
								name: "Location",
								value: `https://synthetic.test/callback?code=${secret}`,
							},
							{ name: "Referer", value: `/callback?code=${secret}` },
							{ name: "Proxy-Authorization", value: secret },
							{ name: "X-Auth-Token", value: secret },
						],
						_private: secret,
					},
				},
			],
		},
	};
	assert.deepEqual(redactHarDocument(har), har);
});

test("HAR privacy: local artifact preserves supported and opaque request body identities", () => {
	const secret = "SYNTHETIC_BODY_SENTINEL";
	const cases = [
		{
			mimeType: "application/json",
			text: JSON.stringify({ password: secret }),
		},
		{
			mimeType: "application/x-www-form-urlencoded",
			text: `password=${secret}`,
		},
		{ mimeType: "multipart/form-data; boundary=synthetic", text: secret },
		{
			mimeType: "application/octet-stream",
			text: Buffer.from(secret).toString("base64"),
		},
		...["password", "code", "session", "assertion", "credential", "search"].map(
			(name) => ({
				mimeType: "application/x-www-form-urlencoded",
				params: [{ name, value: secret }],
			}),
		),
	];
	for (const requestPostData of cases) {
		const har = harWithOneEntry({ requestPostData });
		assert.deepEqual(redactHarDocument(har), har);
	}
});

test("HAR privacy: local artifact preserves JSON, HTML and downloaded bytes", () => {
	for (const content of [
		{ text: '{"token":"SYNTHETIC_RESPONSE_SENTINEL"}' },
		{ text: "<html>SYNTHETIC_RESPONSE_SENTINEL</html>" },
		{
			text: Buffer.from("SYNTHETIC_RESPONSE_SENTINEL").toString("base64"),
			encoding: "base64",
		},
	]) {
		const har = harWithOneEntry({ responseContent: content });
		assert.deepEqual(redactHarDocument(har), har);
	}
});

test("HAR privacy: malformed URL and malformed HAR fail closed without raw values", () => {
	for (const value of [
		harWithOneEntry({ requestUrl: "SYNTHETIC_URL_SENTINEL" }),
		{ log: { entries: "SYNTHETIC_STRUCTURE_SENTINEL" } },
	]) {
		let caught: unknown;
		try {
			redactHarDocument(value as Parameters<typeof redactHarDocument>[0]);
		} catch (error) {
			caught = error;
		}
		assert.ok(caught instanceof Error);
		assert.match(caught.message, /HAR capture validation failed/);
		assert.doesNotMatch(caught.message, /SYNTHETIC_/);
		assert.equal(caught.cause, undefined);
	}
});

test("HAR privacy: rejected capture leaves no raw artifact or payload-bearing error cause", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pdpp-har-private-test-"));
	try {
		const path = join(dir, "capture.har");
		await writeFile(path, "{SYNTHETIC_FILE_SENTINEL");
		await assert.rejects(
			() => scrubHarFileOrThrow(path),
			(error: unknown) => {
				assert.ok(error instanceof Error);
				assert.doesNotMatch(error.message, /SYNTHETIC_FILE_SENTINEL/);
				assert.equal(error.cause, undefined);
				return true;
			},
		);
		assert.equal(existsSync(path), false);
		assert.equal(existsSync(`${path}.scrub-failed`), true);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("storage privacy: replay session stays local and is atomically private", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pdpp-storage-private-test-"));
	try {
		const path = join(dir, "storage.json");
		await writeFile(path, "synthetic-old-state", { mode: 0o644 });
		const before = await stat(path);
		const state = {
			cookies: [{ name: "session", value: "SYNTHETIC_COOKIE_SENTINEL" }],
			origins: [
				{
					origin: "https://synthetic.test",
					localStorage: [
						{ name: "token", value: "SYNTHETIC_LOCAL_STORAGE_SENTINEL" },
					],
				},
			],
		};
		const context = {
			storageState: async () => state,
		} as unknown as Parameters<typeof writeStorageStateBestEffort>[0];
		await writeStorageStateBestEffort(context, path);
		assert.deepEqual(JSON.parse(await readFile(path, "utf8")), state);
		const after = await stat(path);
		assert.notEqual(before.ino, after.ino);
		// biome-ignore lint/suspicious/noBitwiseOperators: inspect POSIX file permissions
		assert.equal(after.mode & 0o777, 0o600);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("storage privacy: an empty synthetic session is written as empty state, 0600", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pdpp-storage-empty-test-"));
	try {
		const path = join(dir, "storage.json");
		const context = {
			storageState: async () => ({ cookies: [], origins: [] }),
		} as unknown as Parameters<typeof writeStorageStateBestEffort>[0];
		await writeStorageStateBestEffort(context, path);
		assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
			cookies: [],
			origins: [],
		});
		// biome-ignore lint/suspicious/noBitwiseOperators: inspect POSIX file permissions
		assert.equal((await stat(path)).mode & 0o777, 0o600);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("CDP diagnostics never retain free-form provider values or nested causes", async () => {
	let caught: unknown;
	try {
		await connectOverCdpWithRetry({
			connect: () =>
				Promise.reject(
					new Error("SYNTHETIC_CDP_MESSAGE_SENTINEL", {
						cause: new Error("SYNTHETIC_CDP_CAUSE_SENTINEL"),
					}),
				),
			profileName: "synthetic",
			redactedUrl: "SYNTHETIC_CDP_URL_SENTINEL",
			maxAttempts: 1,
			runAttempt: directAttempt,
		});
	} catch (error) {
		caught = error;
	}
	assert.ok(caught instanceof Error);
	assert.doesNotMatch(String(caught.stack), /SYNTHETIC_CDP_/);
	assert.doesNotMatch(String(caught.cause), /SYNTHETIC_CDP_/);
});

test("storage diagnostics never echo provider failures or output paths", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pdpp-storage-diagnostics-"));
	const original = process.stderr.write;
	let output = "";
	try {
		process.stderr.write = ((chunk: unknown) => {
			output += String(chunk);
			return true;
		}) as typeof process.stderr.write;
		const path = join(dir, "SYNTHETIC_STORAGE_PATH_SENTINEL.json");
		const context = {
			storageState: () =>
				Promise.reject(new Error("SYNTHETIC_STORAGE_ERROR_SENTINEL")),
		} as unknown as Parameters<typeof writeStorageStateBestEffort>[0];
		await writeStorageStateBestEffort(context, path);
		assert.doesNotMatch(output, /SYNTHETIC_STORAGE_/);
		assert.equal(existsSync(path), false);
	} finally {
		process.stderr.write = original;
		await rm(dir, { recursive: true, force: true });
	}
});

test("scrubHarFileOrThrow: atomic replacement retires a stale failure marker", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pdpp-har-atomic-"));
	try {
		const path = join(dir, "capture.har");
		const har = harWithOneEntry({
			responseContent: { text: "SYNTHETIC_LOCAL_BODY" },
		});
		await writeFile(path, JSON.stringify(har), { mode: 0o644 });
		await writeFile(`${path}.scrub-failed`, "");
		const before = await stat(path);
		await scrubHarFileOrThrow(path);
		const after = await stat(path);
		assert.notEqual(before.ino, after.ino);
		assert.deepEqual(JSON.parse(await readFile(path, "utf8")), har);
		assert.equal(existsSync(`${path}.scrub-failed`), false);
		// biome-ignore lint/suspicious/noBitwiseOperators: inspect POSIX file permissions
		assert.equal(after.mode & 0o777, 0o600);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("private capture writer retains the prior artifact when serialization fails", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pdpp-capture-atomic-failure-"));
	try {
		const path = join(dir, "capture.json");
		await writeFile(path, "SYNTHETIC_PREVIOUS_CAPTURE", { mode: 0o600 });
		const before = await stat(path);
		await assert.rejects(
			() =>
				writePrivateCaptureJsonAtomically(path, {
					toJSON: () => {
						throw new Error("SYNTHETIC_SERIALIZATION_SENTINEL");
					},
				}),
			(error: unknown) => {
				assert.ok(error instanceof Error);
				assert.doesNotMatch(
					String(error.stack),
					/SYNTHETIC_SERIALIZATION_SENTINEL/,
				);
				assert.equal(error.cause, undefined);
				return true;
			},
		);
		assert.equal(await readFile(path, "utf8"), "SYNTHETIC_PREVIOUS_CAPTURE");
		assert.equal((await stat(path)).ino, before.ino);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("storage provider failure retains the prior snapshot and invalidates this attempt", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pdpp-storage-atomic-failure-"));
	try {
		const path = join(dir, "state.json");
		const previous = JSON.stringify({ cookies: [], origins: [] });
		await writeFile(path, previous, { mode: 0o600 });
		const before = await stat(path);
		const context = {
			storageState: () =>
				Promise.reject(new Error("SYNTHETIC_PROVIDER_FAILURE")),
		} as unknown as Parameters<typeof writeStorageStateBestEffort>[0];
		await writeStorageStateBestEffort(context, path);
		assert.equal(await readFile(path, "utf8"), previous);
		assert.equal((await stat(path)).ino, before.ino);
		assert.equal(existsSync(`${path}.scrub-failed`), true);
		assert.equal((await fileFlushOutcome(path)).flushed, false);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
