// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// createPageExchangeCapture on the PageShim page API, in Chromium, against a
// synthetic app: page 1 over XHR while the document loads, page 2 over fetch
// after a scroll (answered with an error status), a burst past the buffer, a
// child frame that sends its own request, and a full reload that replaces
// the document. Run on a host without page_init_script, with it, and with
// the member present but every call rejected (a device whose WebView cannot
// run scripts at document start).

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { buildPageshim } from "./build.mjs";
import { runHarness } from "./harness.mjs";

const root = join(process.cwd(), ".scratch", "exchange-capture-test");
after(() => rm(root, { recursive: true, force: true }));

const APP_HTML = `<!doctype html><html><body>
<script>
 const first = new XMLHttpRequest();
 first.open("POST", "/api/first");
 first.setRequestHeader("X-Op", "load");
 first.setRequestHeader("X-Secret", "never-kept");
 first.send("page=1");
 window.addEventListener("scroll", () => {
  if (window.__scrolled) return;
  window.__scrolled = true;
  fetch("/api/next", { method: "POST", body: new URLSearchParams({ page: "2" }), headers: { "x-op": "scroll" } })
   .then((response) => response.text());
 });
 window.__burst = (n) => {
  for (let i = 0; i < n; i += 1) fetch("/api/burst/" + i).then((response) => response.text());
  return n;
 };
</script>
<iframe src="/frame"></iframe>
<div style="height: 6000px"></div>
</body></html>`;

const FRAME_HTML = `<!doctype html><script>
 setTimeout(() => { const x = new XMLHttpRequest(); x.open("POST", "/api/frame"); x.send("frame"); }, 50);
</script>`;

function fixtures() {
	const requests = [];
	return {
		requests,
		hosts: /^https:\/\/capture\.test\//,
		resolve: (raw, request) => {
			const path = new URL(raw).pathname;
			requests.push({ path, method: request?.method });
			const json = (status, value) => ({ status, contentType: "application/json", body: JSON.stringify(value) });
			if (path === "/app") return { status: 200, contentType: "text/html", body: APP_HTML };
			if (path === "/frame") return { status: 200, contentType: "text/html", body: FRAME_HTML };
			if (path === "/api/first") return json(200, { page: 1 });
			if (path === "/api/next") return { status: 500, contentType: "text/plain", body: "server error" };
			if (path.startsWith("/api/")) return json(200, { path });
			return { status: 200, contentType: "text/html", body: "<!doctype html><p>login</p>" };
		},
		setLoggedIn: () => {},
		loginUrl: "https://capture.test/login",
		homeUrl: "https://capture.test/app",
	};
}

async function run(pageInitScript) {
	await mkdir(root, { recursive: true });
	const dir = await mkdtemp(join(root, `${pageInitScript}-`));
	const bundle = join(dir, "bundle.js");
	await buildPageshim({
		connector: "chatgpt",
		entryPoint: new URL("./test-fixtures/exchange-capture-runtime.ts", import.meta.url).pathname,
		outfile: bundle,
	});
	const fx = fixtures();
	const result = await runHarness({
		bundle, fixtures: fx, scopes: ["chatgpt.messages"], fixtureReady: true, pageInitScript,
		resultSpoolDirectory: join(dir, "spool"),
	});
	assert.deepEqual(result.ret, { ok: true });
	assert.deepEqual(result.stubHits, [], "the bundle read a missing page member");
	assert.deepEqual(result.result.errors, []);
	const steps = Object.fromEntries(result.result["chatgpt.messages"].records.map((record) => [record.step, record]));
	return { result, steps, fx };
}

const paths = (drain) => drain.exchanges.map((exchange) => exchange.path);

test("evaluate mode: installed after load, misses the load request and says so", { timeout: 120_000 }, async () => {
	const { result, steps, fx } = await run(false);
	assert.deepEqual(result.initScripts, []);
	assert.equal(steps.attach.mode, "evaluate");
	assert.deepEqual(steps.attach.attach, { generation: 1, earlyTrafficMissed: true });
	// The app sent page 1 (and the frame its request); neither was seen.
	assert.ok(fx.requests.some((request) => request.path === "/api/first"));
	assert.deepEqual(paths(steps.scroll.drain), ["/api/next"]);
	assert.equal(steps.scroll.drain.earlyTrafficMissed, true);
	assert.deepEqual(steps.scroll.drain.exchanges[0], {
		seq: 1, generation: 1, path: "/api/next", transport: "fetch", method: "POST",
		requestBody: "page=2", requestHeaders: { "x-op": "scroll" }, status: 500, responseText: "server error",
	});
	assert.equal(steps.burst.drain.exchanges.length, 3);
	assert.equal(steps.burst.drain.overflowed, true);
	assert.deepEqual(steps.burst.drain.exchanges.map((exchange) => exchange.seq), [2, 3, 4]);
	// A full reload: the new document has no capture until attach.
	assert.equal(steps.replaced.drain.documentReplaced, true);
	assert.equal(steps.replaced.drain.generation, 0);
	assert.deepEqual(steps.replaced.drain.exchanges, []);
	assert.deepEqual(steps.reattach.attach, { generation: 2, earlyTrafficMissed: true });
});

test("init-script mode: every later document is captured from its first request, main frame only", { timeout: 120_000 }, async () => {
	const { result, steps } = await run(true);
	assert.equal(result.initScripts.length, 1);
	assert.equal(steps.attach.mode, "init_script");
	assert.deepEqual(steps.attach.attach, { generation: 1, earlyTrafficMissed: false });
	assert.deepEqual(paths(steps.scroll.drain), ["/api/first", "/api/next"]);
	assert.equal(steps.scroll.drain.earlyTrafficMissed, false);
	assert.deepEqual(steps.scroll.drain.exchanges[0], {
		seq: 1, generation: 1, path: "/api/first", transport: "xhr", method: "POST",
		requestBody: "page=1", requestHeaders: { "x-op": "load" }, status: 200, responseText: '{"page":1}',
	});
	assert.equal(steps.scroll.drain.exchanges[1].status, 500);
	assert.equal(steps.burst.drain.exchanges.length, 3);
	assert.equal(steps.burst.drain.overflowed, true);
	// The reload is captured from its first request, under a new generation.
	assert.equal(steps.replaced.drain.documentReplaced, true);
	assert.equal(steps.replaced.drain.generation, 2);
	assert.equal(steps.replaced.drain.earlyTrafficMissed, false);
	assert.deepEqual(steps.replaced.drain.exchanges.map((exchange) => [exchange.generation, exchange.path]), [[2, "/api/first"]]);
	assert.deepEqual(steps.reattach.attach, { generation: 2, earlyTrafficMissed: false });
	for (const step of Object.values(steps))
		assert.ok(!JSON.stringify(step).includes("/api/frame"), "a child frame's request was captured");
	assert.ok(!JSON.stringify(steps).includes("never-kept"));
});

test("a host that has addInitScript but rejects it: the capture installs in-page, as without the feature", { timeout: 120_000 }, async () => {
	const { result, steps } = await run("unsupported");
	assert.equal(result.calls.addInitScript, 1);
	assert.deepEqual(result.initScripts, []);
	assert.equal(steps.attach.mode, "evaluate");
	assert.deepEqual(steps.attach.attach, { generation: 1, earlyTrafficMissed: true });
	assert.deepEqual(paths(steps.scroll.drain), ["/api/next"]);
});
