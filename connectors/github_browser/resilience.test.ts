// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// A failed read withholds the stream that made it, never the run. The cases
// are the two that ended whole mobile runs: unauthenticated api.github.com
// answering 403/429 (60/h core, 10/min search), and a page read that outlives
// the PageShim bridge call timeout.

import assert from "node:assert/strict";
import test from "node:test";
import { type BrowserCollectionPort, collectGitHubBrowser } from "./collector.ts";
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

// A failed read withholds the stream. A failed write to the output does not
// belong to the stream: it must reach the caller, and must not be reported as a
// withheld source.
async function collectToSink(
	port: (messages: Array<Record<string, unknown>>) => Partial<BrowserCollectionPort>,
	overrides: (base: BrowserServices) => Partial<BrowserServices> = () => ({}),
) {
	const base = await fixtureServices();
	const messages: Array<Record<string, unknown>> = [];
	const state: Record<string, unknown> = {};
	const outcome = await collectGitHubBrowser({
		requested: new Set(ALL), state, progress: async () => {},
		emitRecord: async (stream, record) => { messages.push({ type: "RECORD", stream, record }); },
		emit: async message => { messages.push(message as unknown as Record<string, unknown>); },
		...port(messages),
	}, { ...base, ...overrides(base) }).then(() => null, (error: unknown) => error);
	return { messages, state, outcome };
}

const skipsFor = (messages: Array<Record<string, unknown>>, stream: string) =>
	messages.filter(message => message.type === "SKIP_RESULT" && message.stream === stream);

test("a rejected record write reaches the caller and is not reported as a withheld source", async () => {
	const { messages, outcome } = await collectToSink(() => ({
		emitRecord: async stream => { if (stream === "events") throw new Error("sink down"); },
	}));
	assert.match(String((outcome as Error | null)?.message), /sink down/u);
	assert.equal(skipsFor(messages, "events").length, 0);
});

test("a rejected STATE write reaches the caller and leaves the cursor unchanged", async () => {
	const { messages, state, outcome } = await collectToSink(() => ({
		emit: async message => {
			if (message.type === "STATE" && message.stream === "profile") throw new Error("sink down");
		},
	}));
	assert.match(String((outcome as Error | null)?.message), /sink down/u);
	assert.equal(skipsFor(messages, "profile").length, 0);
	assert.equal(state.profile, undefined);
});

test("a rejected coverage write reaches the caller and is not reported as a withheld source", async () => {
	const { messages, outcome } = await collectToSink(() => ({
		emit: async message => {
			if (message.type === "DETAIL_COVERAGE" && message.stream === "events") throw new Error("sink down");
		},
	}));
	assert.match(String((outcome as Error | null)?.message), /sink down/u);
	assert.equal(skipsFor(messages, "events").length, 0);
});

test("a contributions year read past the bridge timeout is reported as a timeout", async () => {
	const { records, skips } = await collect(base => ({
		openContributionPage: async url => {
			if (url.includes("from=")) throw new Error(BRIDGE_TIMEOUT);
			return base.openPage(url);
		},
	}));
	assert.equal(records.has("contributions"), false);
	assert.equal(skipCause(skips.get("contributions")), "source_read_timeout");
	assert.equal(records.size, 5);
});

const searchAnswer = (url: string, data: unknown, link: string | null = null) =>
	({ requestedUrl: url, responseUrl: url, status: 200, link, data });
const isIssueSearch = (url: string) => url.includes("/search/issues") && url.includes("type%3Aissue");

test("a 200 search answer that is not JSON names invalid_api_response", async () => {
	const { records, skips } = await collect(base => ({
		fetchPublicJson: async url => isIssueSearch(url) ? searchAnswer(url, null) : base.fetchPublicJson(url),
	}));
	assert.equal(records.has("history"), false);
	assert.equal(skipCause(skips.get("history")), "search_incomplete: invalid_api_response");
});

test("a search answer of the wrong shape names invalid_api_response", async () => {
	const { skips } = await collect(base => ({
		fetchPublicJson: async url => isIssueSearch(url)
			? searchAnswer(url, { items: "none", total_count: 1, incomplete_results: false })
			: base.fetchPublicJson(url),
	}));
	assert.equal(skipCause(skips.get("history")), "search_incomplete: invalid_api_response");
});

test("a search answer with incomplete_results names incomplete_search_results", async () => {
	const { skips } = await collect(base => ({
		fetchPublicJson: async url => isIssueSearch(url)
			? searchAnswer(url, { items: [], total_count: 0, incomplete_results: true })
			: base.fetchPublicJson(url),
	}));
	assert.equal(skipCause(skips.get("history")), "search_incomplete: incomplete_search_results");
});

test("a search total that changes between pages names search_total_changed", async () => {
	const { skips } = await collect(base => ({
		fetchPublicJson: async url => {
			if (!isIssueSearch(url)) return base.fetchPublicJson(url);
			const first = await base.fetchPublicJson(url.replace(/page=\d+/u, "page=1"));
			const items = (first.data as { items: unknown[] }).items;
			return url.endsWith("page=1")
				? searchAnswer(url, { items, total_count: items.length + 50, incomplete_results: false },
					'<https://api.github.com/x?page=2>; rel="next"')
				: searchAnswer(url, { items: [], total_count: items.length + 51, incomplete_results: false });
		},
	}));
	assert.equal(skipCause(skips.get("history")), "search_incomplete: search_total_changed");
});

// The Search API serves at most 1,000 results per query, 10 requests a minute.
// A fake clock and quota model it: sleep advances the clock, and the 11th
// Search request inside 60 seconds answers 403.
const SEARCH_WINDOW = 1000;
type SearchPlan = Record<"issue" | "pr", {
	total: number;
	// Rows served per page; defaults to the whole window in 100-row pages.
	pages?: readonly number[];
	// Link header served on the last page; defaults to none (window ended).
	lastLink?: string | null;
}>;

function searchQuota(plan: SearchPlan) {
	let clock = 0;
	const requestTimes: number[] = [];
	return {
		requests: () => requestTimes.length,
		services: (base: BrowserServices): Partial<BrowserServices> => ({
			now: () => new Date(clock),
			sleep: async ms => { clock += ms; },
			fetchPublicJson: async url => {
				if (!url.includes("/search/issues")) return base.fetchPublicJson(url);
				requestTimes.push(clock);
				if (requestTimes.filter(time => clock - time < 60_000).length > 10)
					return { requestedUrl: url, responseUrl: url, status: 403, link: null, data: null };
				const type = url.includes("type%3Apr") ? "pr" : "issue";
				const page = Number(new URL(url).searchParams.get("page"));
				const { total, pages, lastLink = null } = plan[type];
				const sizes = pages ?? Array.from({ length: Math.ceil(Math.min(total, SEARCH_WINDOW) / 100) },
					(_unused, index) => Math.min(100, Math.min(total, SEARCH_WINDOW) - index * 100));
				const template = ((await base.fetchPublicJson(url.replace(/page=\d+/u, "page=1").replace("type%3Apr", "type%3Aissue"))).data as {
					items: Array<Record<string, unknown>>;
				}).items[0];
				const items = Array.from({ length: sizes[page - 1] ?? 0 }, (_unused, index) => {
					const id = (type === "pr" ? 100_000 : 0) + (page - 1) * 100 + index + 1;
					const row = { ...template, id, number: id, html_url: `https://github.com/sample-user/sample-repo/issues/${id}` };
					return type === "pr" ? { ...row, draft: false, pull_request: { merged_at: null } } : row;
				});
				return searchAnswer(url, { items, total_count: total, incomplete_results: false },
					page < sizes.length ? '<https://api.github.com/x?page=2>; rel="next"' : lastLink);
			},
		}),
	};
}

const historyOutput = (messages: Array<Record<string, unknown>>) => ({
	record: messages.find(message => message.type === "RECORD" && message.stream === "history")?.record as
		{ issues: unknown[]; pullRequests: unknown[] } | undefined,
	state: messages.find(message => message.type === "STATE" && message.stream === "history"),
	coverage: messages.find(message => message.type === "DETAIL_COVERAGE" && message.stream === "history"),
	skips: skipsFor(messages, "history"),
});

test("a search window capped at 1,000 results completes with all 1,000 rows and bounded_window set", async () => {
	const quota = searchQuota({ issue: { total: 1001 }, pr: { total: 1 } });
	const { messages, outcome } = await collectToSink(() => ({}), quota.services);
	assert.equal(outcome, null);
	const { record, state, coverage, skips } = historyOutput(messages);
	assert.equal(skips.length, 0);
	assert.equal(record?.issues.length, 1000);
	assert.equal(record?.pullRequests.length, 1);
	assert.equal((state?.cursor as { bounded_window?: boolean }).bounded_window, true);
	assert.ok(coverage);
	assert.equal(quota.requests(), 11);
});

for (const [name, issue] of [
	["an empty first page", { total: 1001, pages: [0] }],
	["one page of 100", { total: 1001, pages: [100] }],
	["nine pages", { total: 1001, pages: Array.from({ length: 9 }, () => 100) }],
] as const) {
	test(`a capped search that ends early (${name}) is withheld`, async () => {
		const quota = searchQuota({ issue, pr: { total: 1 } });
		const { messages, outcome } = await collectToSink(() => ({}), quota.services);
		assert.equal(outcome, null);
		const { record, state, coverage, skips } = historyOutput(messages);
		assert.equal(record, undefined);
		assert.equal(state, undefined);
		assert.equal(coverage, undefined);
		assert.equal(skips.length, 1);
		assert.equal(skipCause(skips[0]), "search_incomplete: search_ended_before_total");
	});
}

test("Search requests are paced across the issue and PR queries", async () => {
	for (const plan of [
		{ issue: { total: 1001 }, pr: { total: 1 } },
		{ issue: { total: 1 }, pr: { total: 1001 } },
	] satisfies SearchPlan[]) {
		const quota = searchQuota(plan);
		const { messages, outcome } = await collectToSink(() => ({}), quota.services);
		assert.equal(outcome, null);
		const { record, skips } = historyOutput(messages);
		assert.equal(skips.length, 0, JSON.stringify(skips));
		assert.equal((record?.issues.length ?? 0) + (record?.pullRequests.length ?? 0), 1001);
		assert.equal(quota.requests(), 11);
	}
});

test("a source read that fails and then a rejected terminal write surfaces the original sink error", async () => {
	const sinkError = new Error("sink down");
	const { outcome } = await collectToSink(() => ({
		emit: async message => {
			if (message.type === "SKIP_RESULT" && message.stream === "repositories") throw sinkError;
		},
	}), () => ({
		openPage: async url => {
			if (url.includes("tab=repositories")) throw new Error("connection reset");
			return (await fixtureServices()).openPage(url);
		},
	}));
	assert.equal(outcome, sinkError);
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
