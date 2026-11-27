// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { collectGitHubBrowser } from "./collector.ts";
import type { EmittedMessage } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import type { BrowserServices } from "./types.ts";

const ALL = ["profile", "repositories", "starred", "events", "contributions", "history"];
const fixtureModule = "../../scripts/pageshim/fixtures/github_browser.mjs";
const { resolveFixture } = await import(fixtureModule);

const owner = '<meta name="user-login" content="sample-user"><span class="p-nickname">sample-user</span>';
const streamOf = (message: EmittedMessage): string => (message as { stream?: string }).stream ?? "";
const isHomepage = (url: string) => url === "https://github.com/";
const isHistory = (url: string) => url.includes("/search/issues");
const timeout = (ms: number, what: string) =>
	new Promise<never>((_, reject) => setTimeout(() => reject(new Error(what)), ms));

interface Harness {
	log: string[];
	messages: EmittedMessage[];
	records: string[];
	run: Promise<void>;
	release: () => void;
	historyStarted: Promise<void>;
	eventsStarted: Promise<void>;
}

/** Browser pages stay pending until `release()`; API calls answer from the fixtures. */
function start(overrides: { emit?: (message: EmittedMessage) => Promise<void> } = {}): Harness {
	const log: string[] = [];
	const messages: EmittedMessage[] = [];
	const records: string[] = [];
	let release = () => {};
	const gate = new Promise<void>((resolve) => { release = resolve; });
	let markStarted = () => {};
	const historyStarted = new Promise<void>((resolve) => { markStarted = resolve; });
	let markEventsStarted = () => {};
	const eventsStarted = new Promise<void>((resolve) => { markEventsStarted = resolve; });
	const services: BrowserServices = {
		openPage: async (url) => {
			if (isHomepage(url)) return { requestedUrl: url, currentUrl: url, html: owner };
			log.push(`page:${url}`);
			await gate;
			return { requestedUrl: url, currentUrl: url, html: resolveFixture(url).body };
		},
		fetchPublicJson: async (url) => {
			if (url.includes("/events/public")) markEventsStarted();
			if (isHistory(url)) {
				log.push("history:request");
				markStarted();
			}
			const response = resolveFixture(url);
			return { requestedUrl: url, responseUrl: url, status: response.status,
				link: response.headers?.Link ?? null, data: JSON.parse(response.body) };
		},
		now: () => new Date(),
		sleep: async () => {},
	};
	const run = collectGitHubBrowser({
		requested: new Set(ALL), state: {}, progress: async () => {},
		emit: async (message) => {
			await overrides.emit?.(message);
			messages.push(message);
			log.push(`emit:${message.type}:${streamOf(message)}`);
		},
		emitRecord: async (stream) => { records.push(stream); log.push(`record:${stream}`); },
	}, services);
	return { log, messages, records, run, release, historyStarted, eventsStarted };
}

test("events starts while the browser streams are still loading pages", async () => {
	const harness = start();
	setTimeout(harness.release, 1_500).unref();
	await Promise.race([harness.eventsStarted, timeout(1_000, "events waited for the browser streams")]);
	assert.equal(harness.records.includes("profile"), false, "no browser stream has finished yet");
	harness.release();
	await harness.run;
});

test("history starts while the browser streams are still loading pages", async () => {
	const harness = start();
	// A regression must fail this test, not hang it behind the closed gate.
	setTimeout(harness.release, 1_500).unref();
	await Promise.race([harness.historyStarted, timeout(1_000, "history waited for the browser streams")]);
	assert.ok(harness.log.some((line) => line.startsWith("page:")), "a browser stream is waiting on its page");
	assert.equal(harness.records.includes("profile"), false, "no browser stream has finished yet");
	harness.release();
	await harness.run;
	assert.deepEqual([...harness.records].sort(), [...ALL].sort());
});

test("each stream still emits its record before its checkpoint and coverage, whatever the interleaving", async () => {
	const harness = start();
	setTimeout(harness.release, 1_500).unref();
	await Promise.race([harness.historyStarted, timeout(1_000, "history waited for the browser streams")]);
	harness.release();
	await harness.run;
	for (const stream of ALL) {
		const record = harness.log.indexOf(`record:${stream}`);
		const state = harness.log.indexOf(`emit:STATE:${stream}`);
		assert.ok(record >= 0 && state > record, `${stream}: record then STATE`);
		if (stream !== "profile") assert.ok(harness.log.indexOf(`emit:DETAIL_COVERAGE:${stream}`) > state, `${stream}: coverage after STATE`);
	}
	assert.equal(harness.messages.filter((message) => message.type === "SKIP_RESULT").length, 0);
	assert.equal(harness.messages.filter((message) => message.type === "STATE" && streamOf(message) === "history").length, 1);
});

test("a publication failure in a browser stream lets history finish before collection rejects", async () => {
	let failed = false;
	const harness = start({
		emit: async (message) => {
			if (message.type === "DETAIL_COVERAGE" && streamOf(message) === "repositories") {
				failed = true;
				throw new Error("sink closed");
			}
		},
	});
	setTimeout(harness.release, 1_500).unref();
	await Promise.race([harness.historyStarted, timeout(1_000, "history waited for the browser streams")]);
	harness.release();
	await assert.rejects(harness.run, (error: { failure?: { cause: string } }) => error.failure?.cause === "message_emit_failed");
	assert.equal(failed, true);
	assert.ok(harness.log.includes("emit:STATE:history"), "history settled before the run reported failure");
	assert.ok(harness.log.includes("emit:STATE:events"), "events settled before the run reported failure");
	const settled = harness.log.length;
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.equal(harness.log.length, settled, "nothing is emitted after collection rejects");
});
