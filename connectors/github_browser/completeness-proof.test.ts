// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseHTML } from "linkedom";
import { collectGitHubBrowser } from "./collector.ts";
import { inspectInventoryPage, parseProfilePage } from "./parsers.ts";

const owner = '<meta name="user-login" content="sample-user"><span class="p-nickname">sample-user</span>';
const terminal = '<div class="pagination"><span class="next_page disabled" aria-disabled="true">Next</span></div>';
const prior = { fetched_at: "2025-12-01T00:00:00Z" };

async function collect(stream: string, htmlFor: (url: string) => string) {
	const records: object[] = [];
	const messages: Array<{ type: string; reason?: string }> = [];
	const state: Record<string, unknown> = { [stream]: structuredClone(prior) };
	await collectGitHubBrowser({
		emit: async message => { messages.push(message); },
		emitRecord: async (_stream, data) => { records.push(data); },
		progress: async () => {}, requested: new Set([stream]), state,
	}, {
		openPage: async url => ({ requestedUrl: url, currentUrl: url, html: htmlFor(url) }),
		fetchPublicJson: async url => ({ requestedUrl: url, responseUrl: url, status: 500, data: null }),
		now: () => new Date("2026-01-01T00:00:00Z"), sleep: async () => {},
	});
	return { records, messages, state };
}

for (const stream of ["repositories", "starred"] as const) {
	const tab = stream === "repositories" ? "repositories" : "stars";
	const list = (names: string[], changed = false) => `<ul id="${stream === "repositories" ? "user-repositories-list" : "user-starred-repos"}">${names.map(name => `<li><h3><a href="/sample-user/${name}">${name}</a></h3><p${stream === "repositories" ? ' itemprop="description"' : ""}>${changed ? "Changed" : "Original"}</p></li>`).join("")}</ul>`;
	const next = (page: number) => `<div class="pagination"><a class="next_page" rel="next" href="/sample-user?page=${page}&tab=${tab}">Next</a></div>`;
	for (const scenario of ["overlap", "contradiction", "repeated", "empty", "earlier-overlap", "exact-total-overlap"] as const) {
		test(`${stream} preserves prior snapshot after ${scenario} with explicit terminal pagination`, async () => {
			const result = await collect(stream, url => {
				if (url.endsWith("github.com/")) return owner;
				const page = Number(new URL(url).searchParams.get("page"));
				const counter = scenario === "exact-total-overlap" ? `<nav><a data-tab-item="${tab}" href="/sample-user?tab=${tab}"><span class="Counter">3</span></a></nav>` : "";
				const names = page === 1 ? ["a", "b"] : page === 3 ? ["d"] : scenario === "empty" ? [] : scenario === "repeated" ? ["a", "b"] : ["b", "c"];
				return owner + counter + list(names, scenario === "contradiction" && page === 2) +
					(page === 1 ? next(2) : scenario === "earlier-overlap" && page === 2 ? next(3) : terminal);
			});
			assert.deepEqual(result.records, []);
			assert.deepEqual(result.messages.map(message => [message.type, message.reason]), [["SKIP_RESULT", "inventory_not_proven_complete"]]);
			assert.deepEqual(result.state, { [stream]: prior });
		});
	}
	for (const empty of [false, true]) {
		test(`${stream} publishes a ${empty ? "legitimately empty" : "disjoint multi-page"} terminal inventory`, async () => {
			const result = await collect(stream, url => {
				if (url.endsWith("github.com/")) return owner;
				const first = new URL(url).searchParams.get("page") === "1";
				return owner + list(empty ? [] : first ? ["a", "b"] : ["c", "d"]) + (empty || !first ? terminal : next(2));
			});
			assert.equal(result.records.length, 1);
			assert.deepEqual(result.messages.map(message => message.type), ["STATE", "DETAIL_COVERAGE"]);
		});
	}
	test(`${stream} page proof rejects no progress before next or terminal evidence`, () => {
		for (const pagination of [next(3), terminal]) {
			const url = `https://github.com/sample-user?page=2&tab=${tab}`;
			const result = inspectInventoryPage({ requestedUrl: url, currentUrl: url, html: owner + list(["a"]) + pagination }, stream, "sample-user", 2, 1, 0, true);
			assert.equal(result.complete, false);
			assert.equal(result.nextUrl, null);
			assert.equal(result.reason, "no_progress");
		}
	});
}

for (const section of ["organizations", "achievements"] as const) {
	test(`headingless real ${section} remain uncertified beside unrelated README links`, async () => {
		const { document } = parseHTML(await readFile(new URL("./__fixtures__/synthetic/profile-with-readme-links.html", import.meta.url), "utf8"));
		for (const node of Array.from(document.querySelectorAll(".h-card h2"))) {
			if (node.textContent?.toLowerCase() === section) node.remove();
		}
		const article = document.querySelector("article");
		assert.ok(article);
		article.innerHTML += '<a href="/orgs/readme-only">README org</a><a href="/sample-user?achievement=readme-only&tab=achievements">README badge</a>';
		const html = document.toString();
		const parsed = parseProfilePage(html, "https://github.com/sample-user");
		assert.equal(parsed.complete, false);
		assert.equal(parsed.row?.[section]?.length, 1);
		const result = await collect("profile", () => html);
		assert.deepEqual(result.records, []);
		assert.deepEqual(result.messages.map(message => [message.type, message.reason]), [["SKIP_RESULT", "github_browser_incomplete"]]);
		assert.deepEqual(result.state, { profile: prior });
	});
}

for (const section of ["organizations", "achievements"] as const) {
	for (const prose of ["README", "bio"] as const) {
		test(`absent ${section} stay absent when ${prose} links mention them`, async () => {
			const { document } = parseHTML(await readFile(new URL("./__fixtures__/synthetic/profile-with-readme-links.html", import.meta.url), "utf8"));
			if (section === "organizations") {
				for (const node of Array.from(document.querySelectorAll('.h-card h2, .h-card [itemprop="follows"]'))) {
					if (node.matches('[itemprop="follows"]') || node.textContent === "Organizations") node.remove();
				}
			} else {
				for (const node of Array.from(document.querySelectorAll('.h-card a[href*="achievement"]'))) node.remove();
			}
			const target = document.querySelector(prose === "README" ? "article" : ".p-note");
			assert.ok(target);
			target.innerHTML += section === "organizations" ? '<a href="/orgs/example">Example organization</a>' : '<a href="/sample-user?achievement=example&tab=achievements">Example badge</a>';
			const html = document.toString();
			const parsed = parseProfilePage(html, "https://github.com/sample-user");
			assert.equal(parsed.complete, true);
			assert.equal(parsed.rejectedEntries, 0);
			assert.deepEqual(parsed.unreadableFields, []);
			assert.equal(parsed.row?.[section], undefined);
			const result = await collect("profile", () => html);
			assert.equal(result.records.length, 1);
			assert.deepEqual(result.messages.map(message => message.type), ["STATE"]);
		});
	}
}
