// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import {
	collectEvents,
	createGithubHttpGovernor,
	GITHUB_RETRYABLE_PATTERN,
	type StreamCtx,
} from "./index.ts";

// Match the mocked fetch, event shape and stream capture used by events-contributions.test.ts.
const api = "https://api.github.com";
const eventPath = "/users/octocat/events/public";
const pages = Array.from({ length: 4 }, (_, page) =>
	Array.from({ length: 2 }, (_, offset) => {
		const id = String(8 - page * 2 - offset);
		return {
			id,
			type: "WatchEvent",
			created_at: `2026-06-0${id}T00:00:00Z`,
			repo: { name: "octocat/hello" },
			public: true,
		};
	}),
);
const expectedIds = pages.flat().map(({ id }) => id);
const terminal = {
	last_created_at: "2026-06-08T00:00:00Z",
	last_created_ids: ["8"],
};

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
	return new Response(JSON.stringify(body), { status: 200, ...init });
}

function installEventsFetch(t: TestContext) {
	const visited: number[] = [];
	let stopOnThirdPage = false;
	t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		assert.equal(url.origin, api);
		if (url.pathname === "/user")
			return jsonResponse({ id: 42, login: "octocat" });
		assert.equal(url.pathname, eventPath);
		const page = Number(url.searchParams.get("page"));
		const items = pages[page - 1];
		assert.ok(items, `unexpected event page ${page}`);
		visited.push(page);
		if (stopOnThirdPage && page === 3) {
			return jsonResponse(
				{ message: "Rate limited" },
				{
					status: 429,
					headers: { "Retry-After": "1" },
				},
			);
		}
		return jsonResponse(
			items,
			page < pages.length
				? {
						headers: {
							Link: `<${api}${eventPath}?per_page=100&page=${page + 1}>; rel="next"`,
						},
					}
				: {},
		);
	});
	return {
		visited,
		failThird: () => {
			stopOnThirdPage = true;
		},
		recover: () => {
			stopOnThirdPage = false;
			visited.length = 0;
		},
	};
}

function makeCtx(state: Record<string, unknown> = {}) {
	const ids: string[] = [];
	const states: unknown[] = [];
	const coverages: Array<{
		considered: number | undefined;
		covered: number | undefined;
	}> = [];
	let clock = Date.UTC(2026, 5, 9);
	const advance = (ms: number) => {
		clock += ms;
	};
	const ctx: StreamCtx = {
		emit: async (msg) => {
			if (msg.stream !== "events") return;
			if (msg.type === "STATE") states.push(msg.cursor);
			if (msg.type === "DETAIL_COVERAGE")
				coverages.push({ considered: msg.considered, covered: msg.covered });
		},
		emitRecord: async (stream, data) => {
			assert.equal(stream, "events");
			assert.equal(typeof data.id, "string");
			ids.push(String(data.id));
		},
		httpGovernor: createGithubHttpGovernor({
			now: () => clock,
			sleep: advance,
			retrySleep: advance,
		}),
		progress: async () => undefined,
		requested: new Map([["events", { name: "events" }]]),
		state,
		token: ["fixture", "github", "no", "network"].join("-"),
	};
	return { ctx, ids, states, coverages };
}

test("GitHub events first run walks the whole available history and commits only the terminal watermark", async (t) => {
	const fetch = installEventsFetch(t);
	const run = makeCtx();
	await collectEvents(run.ctx);
	assert.deepEqual(fetch.visited, [1, 2, 3, 4]);
	assert.deepEqual(run.ids, expectedIds);
	assert.equal(new Set(run.ids).size, expectedIds.length);
	assert.deepEqual(run.states, [terminal]);
	assert.deepEqual(run.coverages, [
		{ considered: expectedIds.length, covered: expectedIds.length },
	]);
});

test("GitHub events retryable page-three stop cannot advance state or claim full history; restart reaches the end", async (t) => {
	const fetch = installEventsFetch(t);
	fetch.failThird();
	const initial = {};
	const stopped = makeCtx(initial);
	await assert.rejects(
		() => collectEvents(stopped.ctx),
		GITHUB_RETRYABLE_PATTERN,
	);
	assert.deepEqual(fetch.visited, [1, 2, 3, 3, 3, 3]);
	assert.deepEqual(stopped.ids, expectedIds.slice(0, 4));
	assert.deepEqual(stopped.coverages, []);
	assert.deepEqual(stopped.states, []);

	// Events do not persist a page checkpoint yet. The latest committed state is
	// the original usable input and the permitted retry starts at page one.
	const lastCursor = stopped.states.at(-1);
	fetch.recover();
	const resumed = makeCtx(
		lastCursor === undefined ? initial : { events: lastCursor },
	);
	await collectEvents(resumed.ctx);
	assert.deepEqual(fetch.visited, [1, 2, 3, 4]);
	assert.deepEqual(resumed.ids, expectedIds);
	assert.deepEqual([...new Set([...stopped.ids, ...resumed.ids])], expectedIds);
	assert.deepEqual(resumed.states, [terminal]);
	assert.deepEqual(resumed.coverages, [
		{ considered: expectedIds.length, covered: expectedIds.length },
	]);
});
