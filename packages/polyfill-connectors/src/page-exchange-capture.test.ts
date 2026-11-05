// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// The page-side capture script runs in a node:vm realm with fake fetch and
// XMLHttpRequest (test-fixtures/page-exchange-realm.ts). The PageShim
// harness test scripts/pageshim/exchange-capture.test.mjs runs the same
// helper in Chromium through the Mobile page API.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	createPageExchangeCapture,
	type ExchangeRule,
	exchangeCaptureInstallScript,
	exchangeJson,
	pageOffersInitScript,
	parseExchangeDrain,
} from "./page-exchange-capture.ts";
import { createFakePage, plain } from "./test-fixtures/page-exchange-realm.ts";

const API: ExchangeRule = {
	url: /^https:\/\/app\.example\/api\//,
	method: "POST",
	requestHeaders: ["x-op"],
};
const OP_RULE: ExchangeRule = {
	url: /\/graphql$/,
	method: "POST",
	body: /ListQuery/,
};

const okText =
	(body: string, status = 200) =>
	async () =>
		new Response(body, { status });

test("evaluate mode: keeps matching XHR and fetch exchanges in arrival order with their bodies", async () => {
	const page = createFakePage({
		onFetch: async (url) =>
			new Response(`fetched ${new URL(url).pathname}`, { status: 201 }),
	});
	const capture = await createPageExchangeCapture(page, {
		name: "t",
		rules: [API],
	});
	assert.equal(capture.mode, "evaluate");
	assert.deepEqual(await capture.attach(), {
		generation: 1,
		earlyTrafficMissed: true,
	});
	const doc = page.document;

	doc
		.xhr("POST", "/api/one", "plain=1", [
			["X-Op", "first"],
			["Cookie", "secret"],
		])
		.finish(200, '{"n":1}');
	doc.xhr("GET", "/api/ignored-method", null).finish(200, "{}");
	doc.xhr("POST", "/other/ignored-url", "x").finish(200, "{}");
	const form = new FormData();
	form.append("a", "1");
	form.append("file", new Blob(["bytes"]), "f.bin");
	doc.xhr("POST", "/api/form", form).finish(200, "form");
	doc
		.xhr("POST", "/api/params", new URLSearchParams({ q: "x y" }))
		.finish(500, "nope");
	doc.xhr("POST", "/api/json", "{}").finish(200, '{"ok":true}', "json");
	doc
		.xhr("POST", "/api/binary", new TextEncoder().encode("bin"))
		.finish(200, "ab", "arraybuffer");
	// The app reads the fetch body itself, first.
	const response = await doc.fetch("/api/fetch", {
		method: "POST",
		body: new Blob(["blob body"]),
		headers: { "x-op": "f" },
	});
	assert.equal(await response.text(), "fetched /api/fetch");
	await doc.fetch(
		new Request("https://app.example/api/request", {
			method: "POST",
			body: "from request",
			headers: { "X-Op": "r" },
		}),
	);
	await doc.fetch("/api/stream", {
		method: "POST",
		body: new ReadableStream(),
	});
	await page.settle();

	const drained = await capture.drain();
	assert.equal(drained.generation, 1);
	assert.equal(drained.earlyTrafficMissed, true);
	assert.equal(drained.overflowed, false);
	assert.equal(drained.documentReplaced, false);
	assert.equal(drained.documentUrl, "https://app.example/");
	const rows = plain(drained.exchanges).map(
		({
			seq,
			url,
			transport,
			requestBody,
			requestBodyGap,
			requestHeaders,
			status,
			responseText,
			responseGap,
		}) => ({
			seq,
			path: new URL(url).pathname,
			transport,
			requestBody,
			requestBodyGap,
			requestHeaders,
			status,
			responseText,
			responseGap,
		}),
	);
	assert.deepEqual(rows, [
		{
			seq: 1,
			path: "/api/one",
			transport: "xhr",
			requestBody: "plain=1",
			requestBodyGap: null,
			requestHeaders: { "x-op": "first" },
			status: 200,
			responseText: '{"n":1}',
			responseGap: null,
		},
		{
			seq: 2,
			path: "/api/form",
			transport: "xhr",
			requestBody: "a=1",
			requestBodyGap: "form_file_omitted",
			requestHeaders: {},
			status: 200,
			responseText: "form",
			responseGap: null,
		},
		{
			seq: 3,
			path: "/api/params",
			transport: "xhr",
			requestBody: "q=x+y",
			requestBodyGap: null,
			requestHeaders: {},
			status: 500,
			responseText: "nope",
			responseGap: null,
		},
		{
			seq: 4,
			path: "/api/json",
			transport: "xhr",
			requestBody: "{}",
			requestBodyGap: null,
			requestHeaders: {},
			status: 200,
			responseText: '{"ok":true}',
			responseGap: null,
		},
		{
			seq: 5,
			path: "/api/binary",
			transport: "xhr",
			requestBody: "bin",
			requestBodyGap: null,
			requestHeaders: {},
			status: 200,
			responseText: "ab",
			responseGap: null,
		},
		{
			seq: 6,
			path: "/api/fetch",
			transport: "fetch",
			requestBody: "blob body",
			requestBodyGap: null,
			requestHeaders: { "x-op": "f" },
			status: 201,
			responseText: "fetched /api/fetch",
			responseGap: null,
		},
		{
			seq: 7,
			path: "/api/request",
			transport: "fetch",
			requestBody: "from request",
			requestBodyGap: null,
			requestHeaders: { "x-op": "r" },
			status: 201,
			responseText: "fetched /api/request",
			responseGap: null,
		},
		{
			seq: 8,
			path: "/api/stream",
			transport: "fetch",
			requestBody: null,
			requestBodyGap: "stream",
			requestHeaders: {},
			status: 201,
			responseText: "fetched /api/stream",
			responseGap: null,
		},
	]);
	assert.deepEqual(exchangeJson(drained.exchanges[0]!), { n: 1 });
	assert.equal(exchangeJson(drained.exchanges[2]!), undefined);
	assert.doesNotMatch(JSON.stringify(drained), /secret/);
	assert.deepEqual((await capture.drain()).exchanges, []);
});

test("a body rule matches on the request body; an unreadable body is kept as uncertain", async () => {
	const page = createFakePage({ onFetch: okText("{}") });
	const capture = await createPageExchangeCapture(page, {
		name: "ops",
		rules: [OP_RULE],
	});
	await capture.attach();
	const doc = page.document;
	doc
		.xhr(
			"POST",
			"/graphql",
			"fb_api_req_friendly_name=ListQuery&variables=%7B%7D",
		)
		.finish(200, "list");
	doc
		.xhr("POST", "/graphql", "fb_api_req_friendly_name=WriteMutation")
		.finish(200, "write");
	await doc.fetch("/graphql", { method: "POST", body: new ReadableStream() });
	await page.settle();
	const { exchanges } = await capture.drain();
	assert.deepEqual(
		plain(exchanges).map(({ responseText, ruleCertain, requestBodyGap }) => ({
			responseText,
			ruleCertain,
			requestBodyGap,
		})),
		[
			{ responseText: "list", ruleCertain: true, requestBodyGap: null },
			{ responseText: "{}", ruleCertain: false, requestBodyGap: "stream" },
		],
	);
});

test("failed requests, kept-out bodies and oversized responses are reported, not hidden", async () => {
	const page = createFakePage({
		onFetch: async (url) => {
			if (url.endsWith("/fail")) throw new TypeError("network down");
			return new Response("x".repeat(50), { status: 200 });
		},
	});
	const capture = await createPageExchangeCapture(page, {
		name: "gaps",
		maxResponseChars: 10,
		rules: [{ url: /\/api\/nobody/, responseBody: false }, { url: /\/api\// }],
	});
	await capture.attach();
	const doc = page.document;
	await assert.rejects(
		doc.fetch("/api/fail", { method: "POST" }),
		/network down/,
	);
	await doc.fetch("/api/big");
	// Arrival is when the response text is read; let the fetch finish first.
	await page.settle();
	doc.xhr("GET", "/api/nobody", null).finish(200, "secret body");
	doc.xhr("GET", "/api/aborted", null).fail();
	await page.settle();
	const { exchanges } = await capture.drain();
	assert.deepEqual(
		plain(exchanges).map(({ rule, status, responseText, responseGap }) => ({
			rule,
			status,
			responseText,
			responseGap,
		})),
		[
			{ rule: 1, status: 0, responseText: null, responseGap: "network_error" },
			{ rule: 1, status: 200, responseText: null, responseGap: "too_large" },
			{ rule: 0, status: 200, responseText: null, responseGap: "not_kept" },
			{ rule: 1, status: 0, responseText: null, responseGap: "network_error" },
		],
	);
});

test("a full buffer drops new exchanges, never old ones, and says so until the end of the run", async () => {
	const page = createFakePage();
	const capture = await createPageExchangeCapture(page, {
		name: "small",
		maxBuffered: 2,
		rules: [API],
	});
	await capture.attach();
	for (const n of [1, 2, 3])
		page.document.xhr("POST", `/api/${n}`, "").finish(200, String(n));
	await page.settle();
	const first = await capture.drain();
	assert.deepEqual(
		first.exchanges.map((exchange) => exchange.responseText),
		["1", "2"],
	);
	assert.equal(first.overflowed, true);
	page.document.xhr("POST", "/api/4", "").finish(200, "4");
	await page.settle();
	const second = await capture.drain();
	assert.deepEqual(
		second.exchanges.map((exchange) => [exchange.seq, exchange.responseText]),
		[[3, "4"]],
	);
	assert.equal(second.overflowed, true);
});

test("drains split large buffers across calls and keep arrival order", async () => {
	const page = createFakePage();
	const capture = await createPageExchangeCapture(page, {
		name: "big",
		rules: [API],
	});
	await capture.attach();
	const body = (n: number) => String(n).repeat(600_000);
	for (const n of [1, 2, 3])
		page.document.xhr("POST", `/api/${n}`, "").finish(200, body(n));
	await page.settle();
	const evaluations = page.calls.length;
	const { exchanges } = await capture.drain();
	assert.deepEqual(
		exchanges.map((exchange) => exchange.responseText),
		[body(1), body(2), body(3)],
	);
	assert.equal(page.calls.length - evaluations, 3);
});

test("evaluate mode: a replaced document is reported, and its exchanges get a new generation after attach", async () => {
	const page = createFakePage();
	const capture = await createPageExchangeCapture(page, {
		name: "nav",
		rules: [API],
	});
	await capture.attach();
	page.document.xhr("POST", "/api/lost", "").finish(200, "lost");
	await page.settle();
	page.navigate("https://app.example/next", (doc) =>
		doc.xhr("POST", "/api/early", "").finish(200, "early"),
	);
	const replaced = await capture.drain();
	assert.equal(replaced.documentReplaced, true);
	assert.equal(replaced.generation, 0);
	assert.deepEqual(replaced.exchanges, []);
	assert.deepEqual(await capture.attach(), {
		generation: 2,
		earlyTrafficMissed: true,
	});
	page.document.xhr("POST", "/api/late", "").finish(200, "late");
	await page.settle();
	const after = await capture.drain();
	assert.equal(after.documentReplaced, false);
	assert.equal(after.documentUrl, "https://app.example/next");
	assert.deepEqual(
		after.exchanges.map((exchange) => [
			exchange.generation,
			exchange.responseText,
		]),
		[[2, "late"]],
	);
});

test("init-script mode: later documents are captured from their first request", async () => {
	const page = createFakePage({ initScripts: true });
	const capture = await createPageExchangeCapture(page, {
		name: "early",
		rules: [API],
	});
	assert.equal(capture.mode, "init_script");
	assert.equal(page.initScripts.length, 1);
	// The document open when the capture was created only gets it late.
	assert.deepEqual(await capture.attach(), {
		generation: 1,
		earlyTrafficMissed: true,
	});
	page.navigate("https://app.example/profile", (doc) =>
		doc.xhr("POST", "/api/first-page", "").finish(200, "first"),
	);
	await page.settle();
	// Without attach, the drain sees a document it was not told about.
	const unannounced = await capture.drain();
	assert.equal(unannounced.documentReplaced, true);
	assert.equal(unannounced.earlyTrafficMissed, false);
	assert.deepEqual(
		unannounced.exchanges.map((exchange) => [
			exchange.generation,
			exchange.responseText,
		]),
		[[2, "first"]],
	);
	page.navigate("https://app.example/again", (doc) =>
		doc.xhr("POST", "/api/again", "").finish(200, "again"),
	);
	assert.deepEqual(await capture.attach(), {
		generation: 3,
		earlyTrafficMissed: false,
	});
	await page.settle();
	const announced = await capture.drain();
	assert.equal(announced.documentReplaced, false);
	assert.deepEqual(
		announced.exchanges.map((exchange) => [exchange.seq, exchange.generation]),
		[[2, 3]],
	);
});

test("installing twice in one document keeps one capture and records each exchange once", async () => {
	const page = createFakePage();
	const capture = await createPageExchangeCapture(page, {
		name: "once",
		rules: [API],
	});
	const first = await capture.attach();
	const second = await capture.attach();
	assert.deepEqual(first, second);
	page.document.xhr("POST", "/api/x", "").finish(200, "x");
	await page.settle();
	assert.equal((await capture.drain()).exchanges.length, 1);
});

test("a child frame is never captured", () => {
	const page = createFakePage();
	page.document.realm.top = {};
	assert.equal(
		page.document.run(
			exchangeCaptureInstallScript({ name: "frame", rules: [API] }, "init"),
		),
		null,
	);
});

test("rules and names are checked before anything reaches the page", async () => {
	const page = createFakePage();
	await assert.rejects(
		createPageExchangeCapture(page, { name: "g", rules: [{ url: /x/g }] }),
		/g or y flag/,
	);
	await assert.rejects(
		createPageExchangeCapture(page, { name: "bad name", rules: [API] }),
		/name must match/,
	);
	await assert.rejects(
		createPageExchangeCapture(page, { name: "none", rules: [] }),
		/at least one rule/,
	);
	assert.deepEqual(page.calls, []);
});

test("an unexpected drain shape is an error, not an empty drain", async () => {
	const capture = await createPageExchangeCapture(
		{ evaluate: async () => ({ id: "x" }) },
		{ name: "shape", rules: [API] },
	);
	await assert.rejects(
		capture.drain(),
		/^Error: page_exchange_capture_unreadable/,
	);
	const entry = {
		seq: 1,
		rule: 0,
		ruleCertain: true,
		transport: "xhr",
		url: "u",
		method: "GET",
		requestBody: null,
		requestBodyGap: null,
		requestHeaders: {},
		status: 200,
		responseText: "",
		responseGap: null,
	};
	const drain = {
		id: "d",
		via: "evaluate",
		url: "u",
		entries: [entry],
		remaining: 0,
		dropped: 0,
	};
	assert.ok(parseExchangeDrain(drain, 1));
	for (const bad of [
		{ ...drain, via: "other" },
		{ ...drain, id: null },
		{ ...drain, remaining: -1 },
		{ ...drain, entries: [{ ...entry, rule: 1 }] },
		{ ...drain, entries: [{ ...entry, seq: 0 }] },
		{ ...drain, entries: [entry, entry] },
		{ ...drain, entries: [{ ...entry, responseGap: "why" }] },
		{ ...drain, entries: [{ ...entry, requestHeaders: { a: 1 } }] },
		{ ...drain, entries: [{ ...entry, transport: "ws" }] },
	])
		assert.equal(parseExchangeDrain(bad, 1), null, JSON.stringify(bad));
});

test("a host page that throws on unknown members does not offer init scripts", () => {
	const strict = new Proxy(
		{ evaluate: async () => null },
		{
			get(target, key) {
				if (!Object.hasOwn(target, key))
					throw new Error(
						`page.${String(key)} is not part of the PageShim API`,
					);
				return target[key as "evaluate"];
			},
		},
	);
	assert.equal(pageOffersInitScript(strict), false);
	assert.equal(
		pageOffersInitScript({
			evaluate: async () => null,
			addInitScript: async () => undefined,
		}),
		true,
	);
});

test("a host whose addInitScript fails falls back to evaluate mode", async () => {
	const page = createFakePage();
	const capture = await createPageExchangeCapture(
		{
			...page,
			evaluate: page.evaluate,
			addInitScript: async () => {
				throw new Error("unsupported");
			},
		},
		{ name: "fallback", rules: [API] },
	);
	assert.equal(capture.mode, "evaluate");
});
