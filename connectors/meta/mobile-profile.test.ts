// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// The Mobile profile-info read (fetchMobileProfileUser) and the posts
// completeness rule it feeds. The in-page script runs in a node:vm realm
// with a fake `location` and `fetch`.

import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import type { Page } from "playwright";
import { inventoryGapReason, sourceInventoryComplete } from "./index.ts";
import { fetchMobileProfileUser } from "./mobile.ts";

const USER = { id: "u1", username: "testuser", media_count: 0 };

type Answer = { status: number; contentType: string; body: string } | Error;

function pageAnswering(answer: Answer, origin = "https://www.instagram.com"): Page & { urls: string[] } {
	const urls: string[] = [];
	const fetch = async (url: string) => {
		urls.push(url);
		if (answer instanceof Error) throw answer;
		return {
			status: answer.status,
			headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? answer.contentType : null) },
			text: async () => answer.body,
		};
	};
	const page = {
		urls,
		evaluate: async (script: unknown) => {
			assert.equal(typeof script, "string", "the read is a string script (CONNECTOR-GUIDELINES rule 4)");
			return await runInNewContext(String(script), { location: { origin }, fetch, AbortSignal });
		},
	};
	return page as unknown as Page & { urls: string[] };
}

async function read(page: Page) {
	const observed: Array<{ body: unknown; status: number }> = [];
	const result = await fetchMobileProfileUser(page, "testuser", (body, status) => observed.push({ body, status }));
	return { ...result, observed };
}

test("a JSON answer with the user returns the user", async () => {
	const page = pageAnswering({ status: 200, contentType: "application/json", body: JSON.stringify({ status: "ok", data: { user: USER } }) });
	const { user, problem, observed } = await read(page);
	assert.deepEqual(JSON.parse(JSON.stringify(user)), USER, "the user comes from the page realm");
	assert.equal(problem, null);
	assert.deepEqual(observed.map(o => o.status), [200]);
	assert.deepEqual(page.urls, ["/api/v1/users/web_profile_info/?username=testuser"]);
});

test("a login or challenge page keeps its real status and content type", async () => {
	const page = pageAnswering({ status: 200, contentType: "text/html; charset=utf-8", body: "<!doctype html><form><input type=password></form>" });
	const { user, problem, observed } = await read(page);
	assert.equal(user, null);
	assert.equal(problem, "web_profile_info answered HTTP 200 (text/html; charset=utf-8) with a body that is not JSON (49 bytes)");
	assert.deepEqual(observed.map(o => [o.body, o.status]), [[null, 200]]);
});

test("each other failing step is named", async () => {
	const cases: Array<{ name: string; page: Page; problem: string | RegExp; status: number }> = [
		{ name: "off the www host", page: pageAnswering({ status: 200, contentType: "application/json", body: "{}" }, "https://m.instagram.com"),
			problem: "web_profile_info was not requested: the page was on https://m.instagram.com, not https://www.instagram.com", status: 0 },
		{ name: "fetch throws", page: pageAnswering(new TypeError("Failed to fetch")),
			problem: "the web_profile_info request failed in the page (TypeError)", status: 0 },
		{ name: "page call fails", page: { evaluate: async () => { throw new Error("bridge closed"); } } as unknown as Page,
			problem: "the page call for web_profile_info failed (bridge closed)", status: 0 },
		{ name: "page call error that echoes the script", page: { evaluate: async () => { throw new Error('SyntaxError in (async () => { const username = "testuser"; })'); } } as unknown as Page,
			problem: 'the page call for web_profile_info failed (SyntaxError in (async () => { const username = "[account]"; }))', status: 0 },
		{ name: "HTTP error with JSON", page: pageAnswering({ status: 429, contentType: "application/json", body: JSON.stringify({ message: "wait" }) }),
			problem: "web_profile_info answered HTTP 429 (application/json)", status: 429 },
		{ name: "error envelope", page: pageAnswering({ status: 200, contentType: "application/json", body: JSON.stringify({ status: "fail" }) }),
			problem: "web_profile_info answered HTTP 200 (application/json) with an error or partial envelope", status: 200 },
		{ name: "no user", page: pageAnswering({ status: 200, contentType: "application/json", body: JSON.stringify({ status: "ok", data: {} }) }),
			problem: "web_profile_info answered HTTP 200 (application/json) with no user", status: 200 },
	];
	for (const c of cases) {
		const { user, problem, observed } = await read(c.page);
		assert.equal(user, null, c.name);
		assert.equal(problem, c.problem, c.name);
		assert.deepEqual(observed.map(o => o.status), [c.status], c.name);
	}
});

test("an empty list is complete with an owner-bound end page, or an exact zero", () => {
	// read, source total, end signal, empty owner-bound page
	assert.equal(sourceInventoryComplete(0, null, true, true), true);
	assert.equal(sourceInventoryComplete(0, 0, false, false), true);
	assert.equal(sourceInventoryComplete(0, null, true, false), false, "an end signal alone could be a login shell");
	assert.equal(sourceInventoryComplete(0, null, false, true), false, "no end signal");
	assert.equal(sourceInventoryComplete(0, 3, true, true), false, "an exact total vetoes the end signal");
	assert.equal(sourceInventoryComplete(2, null, true), true);
	assert.equal(sourceInventoryComplete(2, 3, true), false);
});

test("the gap reason says what was seen, not a fixed text", () => {
	const seen = { read: 0, sourceItems: 0, sourceTotal: null, sourceEnd: true, ownerBound: true, endSignal: "a page with has_next_page false" };
	assert.equal(inventoryGapReason("posts", { ...seen, ownerBound: false }),
		"the posts responses did not show that they belong to the signed-in account");
	assert.equal(inventoryGapReason("posts", { ...seen, sourceTotal: 3 }), "the profile reports 3 posts but 0 were read");
	assert.equal(inventoryGapReason("posts", { ...seen, sourceEnd: false, totalProblem: "web_profile_info answered HTTP 429 (application/json)" }),
		"the profile gave no exact posts count (web_profile_info answered HTTP 429 (application/json)), and the read never reached a page with has_next_page false");
	assert.equal(inventoryGapReason("posts", { ...seen, sourceItems: 2 }),
		"the profile gave no exact posts count, and 2 of the 2 posts the source listed could not be read");
	assert.doesNotMatch(inventoryGapReason("posts", seen), /no end signal/);
});
