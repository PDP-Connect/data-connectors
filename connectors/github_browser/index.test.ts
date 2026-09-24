// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { openContributionPage } from "./index.ts";

function delayedPage(readyHtml: string) {
	let html = "<main>Loading contribution calendar</main>";
	const calls: string[] = [];
	const page = {
		goto: async (_url: string, options: { waitUntil: string }) => {
			assert.equal(options.waitUntil, "domcontentloaded");
			calls.push("goto");
		},
		waitForFunction: async (
			predicate: unknown,
			argument: { minimumDays: number; selector: string },
			options: { timeout: number },
		) => {
			assert.equal(typeof predicate, "function");
			assert.deepEqual(argument, {
				minimumDays: 365,
				selector:
					"td.ContributionCalendar-day[data-date], rect.day[data-date]",
			});
			assert.equal(options.timeout, 8_000);
			calls.push("waitForCalendar");
			await new Promise((resolve) => setTimeout(resolve, 5));
			html = readyHtml;
			return { dispose: async () => calls.push("dispose") };
		},
		content: async () => {
			calls.push("content");
			return html;
		},
	};
	return { calls, page };
}

test("contribution page waits for late calendar cells before reading HTML", async () => {
	const readyHtml =
		'<h2 class="f4 text-normal mb-2">1 contribution</h2><td class="ContributionCalendar-day" data-date="2026-01-01" data-count="1"></td>';
	const fixture = delayedPage(readyHtml);
	const html = await openContributionPage(
		fixture.page as never,
		"https://github.com/sample-user",
	);

	assert.equal(html, readyHtml);
	assert.deepEqual(fixture.calls, [
		"goto",
		"waitForCalendar",
		"dispose",
		"content",
	]);
});

test("contribution wait timeout returns HTML for the collector to reject as incomplete", async () => {
	const partialHtml = "<main>Calendar did not render</main>";
	const calls: string[] = [];
	const page = {
		goto: async () => calls.push("goto"),
		waitForFunction: async () => {
			calls.push("waitForCalendar");
			throw new Error("timeout");
		},
		content: async () => {
			calls.push("content");
			return partialHtml;
		},
	};

	const html = await openContributionPage(
		page as never,
		"https://github.com/sample-user",
	);

	assert.equal(html, partialHtml);
	assert.deepEqual(calls, ["goto", "waitForCalendar", "content"]);
});
