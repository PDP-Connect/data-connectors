// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { parseHTML } from "linkedom";
import { openContributionPage } from "./index.ts";

function delayedPage(readyHtml: string) {
	let html = "<main>Loading contribution calendar</main>";
	let currentUrl = "";
	const calls: string[] = [];
	const page = {
		goto: async (url: string, options: { waitUntil: string }) => {
			assert.equal(options.waitUntil, "domcontentloaded");
			currentUrl = url;
			calls.push("goto");
		},
		evaluate: async () => currentUrl,
		waitForFunction: async (
			predicate: unknown,
			argument: { minimumDays: number; selector: string },
			options: { timeout: number },
		) => {
			assert.equal(typeof predicate, "function");
			assert.deepEqual(argument, {
				minimumDays: 365,
				selector: "td.ContributionCalendar-day[data-date], rect.day[data-date]",
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

	assert.equal(html.html, readyHtml);
	assert.equal(html.requestedUrl, "https://github.com/sample-user");
	assert.equal(html.currentUrl, html.requestedUrl);
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
	let currentUrl = "";
	const page = {
		goto: async (url: string) => {
			currentUrl = url;
			calls.push("goto");
		},
		evaluate: async () => currentUrl,
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

	assert.equal(html.html, partialHtml);
	assert.deepEqual(calls, ["goto", "waitForCalendar", "content"]);
});

function contributionReadinessFixtures(): readonly [string, string, boolean][] {
	const cells = Array.from({ length: 365 }, (_, index) =>
		`<td class="ContributionCalendar-day" data-date="${new Date(Date.UTC(2025, 0, index + 1)).toISOString().slice(0, 10)}" data-count="0"></td>`).join("");
	const html = `<main><section class="js-yearly-contributions"><h2 id="js-contribution-activity-description">0 contributions</h2><table class="ContributionCalendar-grid"><tbody><tr>${cells}</tr></tbody></table></section></main>`;
	return [
		["fully rendered graph", html, true],
		["busy graph", html.replace("<section ", '<section aria-busy="true" '), false],
		["busy heading", html.replace("<h2 ", '<h2 aria-busy="true" '), false],
		["busy cell", html.replace("<td ", '<td aria-busy="true" '), false],
		["loading graph", html.replace('class="ContributionCalendar-grid"', 'class="ContributionCalendar-grid loading"'), false],
		["deferred graph", html.replace("</table>", '<include-fragment src="/calendar"></include-fragment></table>'), false],
	];
}

for (const [name, html, expected] of contributionReadinessFixtures()) {
	test(`contribution readiness checks retained cells: ${name}`, async () => {
		let observed: unknown;
		const page = {
			goto: async () => undefined,
			evaluate: async () => "https://github.com/sample-user",
			content: async () => html,
			waitForFunction: async (
				predicate: (argument: unknown) => unknown,
				argument: unknown,
			) => {
				const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
				Object.defineProperty(globalThis, "document", {
					configurable: true,
					value: parseHTML(html).document,
				});
				try {
					observed = predicate(argument);
				} finally {
					if (previous) Object.defineProperty(globalThis, "document", previous);
					else Reflect.deleteProperty(globalThis, "document");
				}
				return { dispose: async () => undefined };
			},
		};
		await openContributionPage(page as never, "https://github.com/sample-user");
		assert.equal(observed, expected);
	});
}
