// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// A failed read withholds the stream that made it, never the run. The cases
// are the two that ended whole mobile runs: unauthenticated api.github.com
// answering 403/429 (60/h core, 10/min search), and a page read that outlives
// the PageShim bridge call timeout.

import assert from "node:assert/strict";
import test from "node:test";
import { collectGitHubBrowser } from "./collector.ts";
import { fetchPublicJson } from "./index.ts";
import type { BrowserServices } from "./types.ts";

const ALL = ["profile", "repositories", "starred", "events", "contributions", "history"];
const BRIDGE_TIMEOUT = "PageShim bridge call evaluate timed out after 30000ms";

async function fixtureServices(): Promise<BrowserServices> {
	const fixtureModule = "../../scripts/pageshim/fixtures/github_browser.mjs";
	const { resolveFixture } = await import(fixtureModule);
	return {
		now: () => new Date(),
		sleep: async () => {},
		openPage: async url => ({ requestedUrl: url, currentUrl: url, html: resolveFixture(url).body }),
		fetchPublicJson: async url => {
			const response = resolveFixture(url);
			return { requestedUrl: url, responseUrl: url, status: response.status,
				link: response.headers?.Link ?? null, data: JSON.parse(response.body) };
		},
	};
}

async function collect(overrides: (base: BrowserServices) => Partial<BrowserServices>) {
	const base = await fixtureServices();
	const records = new Map<string, Record<string, unknown>>();
	const skips = new Map<string, Record<string, unknown>>();
	await collectGitHubBrowser({
		requested: new Set(ALL), state: {}, progress: async () => {},
		emitRecord: async (stream, record) => { records.set(stream, record); },
		emit: async message => {
			if (message.type === "SKIP_RESULT") skips.set(message.stream, message as unknown as Record<string, unknown>);
		},
	}, { ...base, ...overrides(base) });
	return { records, skips };
}

const skipCause = (skip: Record<string, unknown> | undefined): string => {
	const diagnostics = skip?.diagnostics as { reason?: string; cause?: string } | undefined;
	return String(diagnostics?.reason ?? diagnostics?.cause);
};

test("the fixture run proves all six streams (control)", async () => {
	const { records, skips } = await collect(() => ({}));
	assert.deepEqual([...records.keys()].sort(), [...ALL].sort());
	assert.equal(skips.size, 0);
});

for (const status of [403, 429]) {
	test(`api.github.com ${status} withholds only the API streams`, async () => {
		const { records, skips } = await collect(base => ({
			fetchPublicJson: async url => url.includes("/events/public") || url.includes("/search/issues")
				? { requestedUrl: url, responseUrl: url, status, link: null, data: null }
				: base.fetchPublicJson(url),
		}));
		assert.deepEqual([...records.keys()].sort(), ["contributions", "profile", "repositories", "starred"]);
		assert.deepEqual([...skips.keys()].sort(), ["events", "history"]);
		assert.equal(skipCause(skips.get("events")), "api_rate_limited");
		assert.equal(skipCause(skips.get("history")), "search_incomplete: api_rate_limited");
	});
}

test("api.github.com 5xx withholds the stream with its own reason", async () => {
	const { records, skips } = await collect(base => ({
		fetchPublicJson: async url => url.includes("/events/public")
			? { requestedUrl: url, responseUrl: url, status: 502, link: null, data: null }
			: base.fetchPublicJson(url),
	}));
	assert.equal(records.has("events"), false);
	assert.equal(skipCause(skips.get("events")), "api_unavailable");
	assert.equal(records.size, 5);
});

test("an API read that times out withholds only that stream", async () => {
	const { records, skips } = await collect(base => ({
		fetchPublicJson: async url => {
			if (url.includes("/search/issues")) throw new Error(BRIDGE_TIMEOUT);
			return base.fetchPublicJson(url);
		},
	}));
	assert.equal(records.has("history"), false);
	assert.equal(skipCause(skips.get("history")), "search_incomplete: api_read_timeout");
	assert.equal(records.size, 5);
});

for (const [stream, matches] of [
	["repositories", (url: string) => url.includes("tab=repositories")],
	["starred", (url: string) => url.includes("tab=stars") || url.includes("/stars/")],
] as const) {
	test(`a ${stream} page read past the bridge timeout withholds only ${stream}`, async () => {
		const { records, skips } = await collect(base => ({
			openPage: async url => {
				if (matches(url)) throw new Error(BRIDGE_TIMEOUT);
				return base.openPage(url);
			},
		}));
		assert.equal(records.has(stream), false);
		assert.equal(skipCause(skips.get(stream)), "source_read_timeout");
		assert.deepEqual([...records.keys()].sort(), ALL.filter(s => s !== stream).sort());
	});
}

test("a profile page read past the bridge timeout withholds only the profile", async () => {
	const { records, skips } = await collect(base => {
		let profileReads = 0;
		return {
			// The profile is the first read of the bare profile URL; the
			// contribution reads that follow it must still succeed.
			openContributionPage: async url => {
				if (url === "https://github.com/sample-user" && profileReads++ === 0) throw new Error(BRIDGE_TIMEOUT);
				return base.openPage(url);
			},
		};
	});
	assert.equal(records.has("profile"), false);
	assert.equal(skipCause(skips.get("profile")), "source_read_timeout");
	assert.equal(records.size, 5);
});

test("fetchPublicJson returns a non-2xx status instead of throwing", async () => {
	const previous = globalThis.fetch;
	const page = { evaluate: async (fn: (arg: string) => unknown, arg: string) => fn(arg) };
	try {
		for (const status of [403, 429, 503]) {
			globalThis.fetch = (async (target: string) => ({
				ok: false, status, url: target, headers: new Headers(),
				json: async () => ({ message: "API rate limit exceeded" }),
			})) as unknown as typeof fetch;
			const url = "https://api.github.com/users/sample-user/events/public?per_page=100&page=1";
			const response = await fetchPublicJson(page as never, url);
			assert.equal(response.status, status);
			assert.equal(response.data, null);
			assert.equal(response.requestedUrl, url);
		}
		globalThis.fetch = (async (target: string) => ({
			ok: true, status: 200, url: target, headers: new Headers({ Link: '<https://api.github.com/x?page=2>; rel="next"' }),
			json: async () => [{ id: "1" }],
		})) as unknown as typeof fetch;
		const ok = await fetchPublicJson(page as never, "https://api.github.com/users/sample-user/starred?per_page=100&page=1");
		assert.equal(ok.status, 200);
		assert.deepEqual(ok.data, [{ id: "1" }]);
		assert.match(String(ok.link), /rel="next"/u);
	} finally {
		globalThis.fetch = previous;
	}
});
