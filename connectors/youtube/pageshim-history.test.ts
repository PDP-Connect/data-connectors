// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// pageShimHistoryResponses: watch history's browse responses on PageShim,
// read from the shared in-page capture. The page is a fake whose documents
// are node:vm realms with the real capture script; the "app" sends browse
// requests through the realm's wrapped XMLHttpRequest and fetch.
// scripts/pageshim/pageshim.test.mjs runs the full walk in Chromium.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	createFakePage,
	type FakeDocument,
	type FakePage,
} from "../../packages/polyfill-connectors/src/test-fixtures/page-exchange-realm.ts";
import type { BrowserCollectContext } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import type { HistoryBrowseResponse } from "./index.ts";
import { HISTORY_CAPTURE_MAX_BUFFERED, pageShimHistoryResponses } from "./pageshim.ts";

const HISTORY = "https://www.youtube.com/feed/history";
const BROWSE = "/youtubei/v1/browse?prettyPrint=false";

function browse(doc: FakeDocument, continuation: string, status = 200): void {
	doc.xhr("POST", BROWSE, JSON.stringify({ continuation }))
		.finish(status, JSON.stringify({ onResponseReceivedActions: [{ appendContinuationItemsAction: { continuationItems: [] } }] }));
}

async function open(fake: FakePage, duringLoad?: (doc: FakeDocument) => void) {
	const source = pageShimHistoryResponses(fake)(null as unknown as BrowserCollectContext["page"]);
	const seen: HistoryBrowseResponse[] = [];
	source.listen((response) => seen.push(response));
	await source.beforeNavigation?.();
	fake.navigate(HISTORY, duringLoad);
	await source.afterNavigation?.();
	return { source, seen };
}

const tokens = async (seen: HistoryBrowseResponse[]) =>
	seen.map((response) => (response.requestJson() as { continuation: string }).continuation);

test("evaluate mode: delivers browse responses on poll, in arrival order, and misses load-time traffic", async () => {
	const fake = createFakePage({
		onFetch: async () => new Response('{"onResponseReceivedActions":[]}', { status: 200 }),
	});
	const { source, seen } = await open(fake, (doc) => browse(doc, "during-load"));
	browse(fake.document, "c1");
	await fake.document.fetch(BROWSE, { method: "POST", body: JSON.stringify({ continuation: "c2" }) });
	fake.document.xhr("POST", "/youtubei/v1/next", "{}").finish(200, "{}");
	await fake.settle();
	assert.equal(seen.length, 0);
	await source.poll?.();
	assert.deepEqual(await tokens(seen), ["c1", "c2"]);
	assert.equal(seen[0]?.status(), 200);
	assert.deepEqual(await seen[1]?.json(), { onResponseReceivedActions: [] });
	assert.equal(source.complete, true);
	assert.deepEqual(source.diagnostics, {
		mode: "evaluate", attached: true, earlyTrafficMissed: true,
		overflowed: false, documentReplaced: false, drainFailed: false,
	});
});

test("init-script mode: a response sent while the document loads is delivered", async () => {
	const fake = createFakePage({ initScripts: true });
	const { source, seen } = await open(fake, (doc) => browse(doc, "during-load"));
	await fake.settle();
	await source.poll?.();
	assert.deepEqual(await tokens(seen), ["during-load"]);
	assert.equal(source.complete, true);
	assert.equal(source.diagnostics?.mode, "init_script");
	assert.equal(source.diagnostics?.earlyTrafficMissed, false);
});

test("a host that rejects addInitScript: evaluate mode, and the walk can still prove the end", async () => {
	const fake = createFakePage({ initScripts: "unsupported" });
	const { source, seen } = await open(fake);
	browse(fake.document, "c1");
	await fake.settle();
	await source.poll?.();
	assert.deepEqual(await tokens(seen), ["c1"]);
	assert.equal(source.complete, true);
	assert.equal(source.diagnostics?.mode, "evaluate");
});

test("a full buffer between polls makes the source incomplete", async () => {
	const fake = createFakePage();
	const { source, seen } = await open(fake);
	for (let index = 0; index <= HISTORY_CAPTURE_MAX_BUFFERED; index += 1) browse(fake.document, `c${index}`);
	await fake.settle();
	await source.poll?.();
	assert.equal(seen.length, HISTORY_CAPTURE_MAX_BUFFERED);
	assert.equal(source.complete, false);
	assert.equal(source.diagnostics?.overflowed, true);
});

for (const initScripts of [false, true]) {
	test(`a replaced document makes the source incomplete (${initScripts ? "init script" : "evaluate"})`, async () => {
		const fake = createFakePage({ initScripts });
		const { source, seen } = await open(fake);
		browse(fake.document, "c1");
		await fake.settle();
		await source.poll?.();
		fake.navigate(HISTORY, (doc) => browse(doc, "c1-again"));
		await fake.settle();
		await source.poll?.();
		assert.deepEqual(await tokens(seen), ["c1"]);
		assert.equal(source.complete, false);
		assert.equal(source.diagnostics?.documentReplaced, true);
	});
}

test("a page that refuses the capture script leaves the source incomplete, never failing the walk", async () => {
	const fake = createFakePage();
	const refusing = { evaluate: async () => { throw new Error("document not ready"); } };
	const source = pageShimHistoryResponses(refusing)(null as unknown as BrowserCollectContext["page"]);
	await source.beforeNavigation?.();
	fake.navigate(HISTORY);
	await source.afterNavigation?.();
	await source.poll?.();
	assert.equal(source.complete, false);
	assert.equal(source.diagnostics?.attached, false);
});

test("an unreadable request or response body throws to the tracker, which counts it", async () => {
	const fake = createFakePage();
	const { source, seen } = await open(fake);
	fake.document.xhr("POST", BROWSE, new ReadableStream()).finish(200, "not json");
	await fake.settle();
	await source.poll?.();
	assert.equal(seen.length, 1);
	assert.throws(() => seen[0]?.requestJson(), /youtube_history_request_unreadable/);
	await assert.rejects(async () => seen[0]?.json(), SyntaxError);
});
