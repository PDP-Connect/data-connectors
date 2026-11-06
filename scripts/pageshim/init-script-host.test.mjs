// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// The Mobile host's page.addInitScript rules (init-script-host.mjs), and the
// connectors' real capture installers under them: each one passes the
// host's checks, stays well under its size limit, and still works inside the
// host's block wrapper, on the row's host only and in the main frame only.

import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
import { GRAPHQL_CAPTURE_NAME, GRAPHQL_CAPTURE_RULES } from "../../connectors/facebook/index.ts";
import { POSTS_CAPTURE_MAX_BUFFERED, POSTS_CAPTURE_NAME, POSTS_CAPTURE_RULES } from "../../connectors/meta/mobile.ts";
import { HISTORY_CAPTURE_MAX_BUFFERED, HISTORY_CAPTURE_NAME, HISTORY_CAPTURE_RULES } from "../../connectors/youtube/pageshim.ts";
import {
	createPageExchangeCapture,
	exchangeCaptureInstallScript,
} from "../../packages/polyfill-connectors/src/page-exchange-capture.ts";
import { createFakePage } from "../../packages/polyfill-connectors/src/test-fixtures/page-exchange-realm.ts";
import {
	inspectWrappability,
	PAGE_INIT_SCRIPT_MAX_BYTES,
	PAGE_INIT_SCRIPT_MAX_COUNT,
	pageInitScriptRefusal,
	providerHostForCookieDomain,
	wrapPageInitScript,
} from "./init-script-host.mjs";

const CAPTURES = [
	{ connector: "meta", url: "https://www.instagram.com/someone/", cookieDomain: ".www.instagram.com",
		options: { name: POSTS_CAPTURE_NAME, rules: POSTS_CAPTURE_RULES, maxBuffered: POSTS_CAPTURE_MAX_BUFFERED } },
	{ connector: "youtube", url: "https://www.youtube.com/feed/history", cookieDomain: ".www.youtube.com",
		options: { name: HISTORY_CAPTURE_NAME, rules: HISTORY_CAPTURE_RULES, maxBuffered: HISTORY_CAPTURE_MAX_BUFFERED } },
	{ connector: "facebook", url: "https://www.facebook.com/me/friends", cookieDomain: ".www.facebook.com",
		options: { name: GRAPHQL_CAPTURE_NAME, rules: GRAPHQL_CAPTURE_RULES } },
];

const none = { count: 0, bytes: 0 };

test("the balance check refuses a source that could leave the host's wrapper", () => {
	assert.equal(inspectWrappability("var a = [1, (2)]; function f() { return /[)}]/.test(`${a}`); }"), "ok");
	assert.equal(inspectWrappability("}); (function () {"), "unbalancedClose");
	assert.equal(inspectWrappability("if (x) {"), "unbalancedOpen");
	assert.equal(inspectWrappability("var s = 'open"), "unterminated");
	assert.equal(inspectWrappability("/* open"), "unterminated");
	assert.equal(inspectWrappability("`${"), "unterminated");
});

test("the host refuses, never truncates, a script over a limit", () => {
	assert.equal(pageInitScriptRefusal(42, none), "page.addInitScript expects the script source as a string");
	assert.match(pageInitScriptRefusal("x".repeat(PAGE_INIT_SCRIPT_MAX_BYTES + 1), none), /limit is 65536 bytes/);
	assert.equal(pageInitScriptRefusal("x".repeat(PAGE_INIT_SCRIPT_MAX_BYTES), none), null);
	assert.match(pageInitScriptRefusal("x", { count: PAGE_INIT_SCRIPT_MAX_COUNT, bytes: 0 }), /at most 16 scripts/);
	assert.match(pageInitScriptRefusal("xx", { count: 1, bytes: 256 * 1024 - 1 }), /would pass 262144 bytes/);
	assert.match(pageInitScriptRefusal("}", none), /\(unbalancedClose\)/);
	assert.equal(providerHostForCookieDomain(".www.Instagram.com."), "www.instagram.com");
	assert.equal(providerHostForCookieDomain("localhost"), null);
});

for (const capture of CAPTURES) {
	test(`${capture.connector}: the capture installer passes the host's checks and works inside its wrapper`, async () => {
		const source = exchangeCaptureInstallScript(capture.options, "init");
		assert.equal(pageInitScriptRefusal(source, none), null);
		// Room for the run's other scripts: one installer is under a quarter of the limit.
		assert.ok(Buffer.byteLength(source) < PAGE_INIT_SCRIPT_MAX_BYTES / 4, `${Buffer.byteLength(source)} bytes`);

		const hosts = [providerHostForCookieDomain(capture.cookieDomain)];
		const host = { refuse: pageInitScriptRefusal, wrap: (script) => wrapPageInitScript(hosts, script) };
		const fake = createFakePage({ initScripts: true, initScriptHost: host });
		const page = await createPageExchangeCapture(fake, capture.options);
		assert.equal(page.mode, "init_script");

		// On the row's host the installer runs at document start and leaves only
		// its own non-enumerable window property behind.
		fake.navigate(capture.url, (document) => {
			const own = Object.getOwnPropertyNames(document.realm).filter((name) => name.startsWith("__"));
			assert.deepEqual(own, [`__pdppExchangeCapture_${capture.options.name}`]);
			assert.equal(Object.keys(document.realm).includes(own[0]), false);
		});
		assert.deepEqual(await page.attach(), { generation: 1, earlyTrafficMissed: false });

		// Off the row's host (a sign-in redirect) it never runs.
		fake.navigate("https://accounts.example/signin");
		assert.deepEqual(await page.attach(), { generation: 2, earlyTrafficMissed: true });

		// In a child frame it never runs.
		const child = vm.createContext({ location: { hostname: new URL(capture.url).hostname }, top: {} });
		child.window = child;
		vm.runInContext(fake.initScripts[0], child);
		assert.equal(Object.getOwnPropertyNames(child).some((name) => name.startsWith("__pdpp")), false);
	});
}

test("a device without document-start scripts rejects addInitScript; the capture installs in-page instead", async () => {
	const fake = createFakePage({ initScripts: "unsupported" });
	const page = await createPageExchangeCapture(fake, CAPTURES[1].options);
	assert.equal(page.mode, "evaluate");
	assert.deepEqual(fake.calls, ["addInitScript"]);
	fake.navigate(CAPTURES[1].url);
	assert.deepEqual(await page.attach(), { generation: 1, earlyTrafficMissed: true });
});
