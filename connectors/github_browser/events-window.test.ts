// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { collectGitHubBrowser } from "./collector.ts";
import { parseLegacyEventPageItem } from "./parsers.ts";

const owner = '<meta name="user-login" content="sample-user"><span class="p-nickname">sample-user</span>';
const compactPr = { id: 77, number: 7, url: "https://api.github.com/repos/sample-owner/demo/pulls/7", head: { ref: "feature" }, base: { ref: "main" } };
const review = (pull_request: unknown, id = "900") => ({
	id, type: "PullRequestReviewEvent", public: true, created_at: "2026-10-19T12:00:00Z", repo: { name: "sample-owner/demo" },
	payload: { action: "created", review: { state: "approved", body: null, html_url: "https://github.com/sample-owner/demo/pull/7#pullrequestreview-1" }, pull_request },
});
const push = (id: string) => ({ id, type: "PushEvent", public: true, created_at: "2026-10-19T12:00:00Z", repo: { name: "sample-owner/demo" },
	payload: { ref: "refs/heads/main", size: 1, commits: [{ message: "Invented commit" }] } });

test("a review event with a compact pull-request reference is complete and stores no title", () => {
	const parsed = parseLegacyEventPageItem(review(compactPr));
	assert.equal(parsed.complete, true);
	assert.deepEqual(parsed.unreadableFields, []);
	assert.equal(parsed.row?.title ?? null, null);
});

test("a review event keeps its title and still vetoes outside the compact shape", () => {
	assert.equal(parseLegacyEventPageItem(review({ ...compactPr, title: "Invented title" })).row?.title, "Invented title");
	for (const pull_request of [
		{ ...compactPr, title: 5 },
		{ ...compactPr, url: "https://api.github.com/repos/other-owner/demo/pulls/7" },
		{ ...compactPr, head: {} },
		{ ...compactPr, base: { ref: "" } },
		{ ...compactPr, id: "77" },
		{ ...compactPr, number: 0 },
		{ id: 77, number: 7 },
		{},
	]) {
		const parsed = parseLegacyEventPageItem(review(pull_request));
		assert.equal(parsed.complete, false);
		assert.ok(parsed.unreadableFields.includes("title"));
	}
});

async function walkEvents(pages: unknown[][]) {
	const messages: Array<{ type: string; diagnostics?: unknown; cursor?: unknown }> = [];
	const records: Array<Record<string, unknown>> = [];
	const api = "https://api.github.com/users/sample-user/events/public?per_page=100";
	await collectGitHubBrowser({
		emit: async message => { messages.push(message); },
		emitRecord: async (_stream, data) => { records.push(data); },
		progress: async () => {}, requested: new Set(["events"]), state: {},
	}, {
		openPage: async url => ({ requestedUrl: url, currentUrl: url, html: owner }),
		fetchPublicJson: async url => {
			const page = Number(new URL(url).searchParams.get("page"));
			const target = (n: number, rel: string) => `<${api}&page=${n}>; rel="${rel}"`;
			const link = pages.length === 1 ? null : page === 1 ? target(2, "next")
				: page === pages.length ? `${target(page - 1, "prev")}, ${target(1, "first")}`
				: `${target(page + 1, "next")}, ${target(page - 1, "prev")}, ${target(1, "first")}`;
			return { requestedUrl: url, responseUrl: url, status: 200, link, data: pages[page - 1] ?? [] };
		},
		now: () => new Date("2026-10-20T00:00:00Z"), sleep: async () => {},
	});
	return { messages, records };
}

test("a fully accounted events window publishes its aggregate and a window STATE without whole-inventory coverage", async () => {
	const { messages, records } = await walkEvents([[push("1"), review(compactPr, "2")]]);
	assert.equal(records.length, 1);
	assert.equal((records[0]?.events as unknown[]).length, 2);
	assert.match(String(records[0]?.windowDescription), /at most 300 events from the last 30 days/);
	assert.deepEqual(messages.map(m => m.type), ["STATE"]);
	const cursor = (messages[0] as { cursor?: Record<string, unknown> }).cursor;
	assert.equal(cursor?.window, "github_public_events");
	assert.equal(cursor?.window_limit, 300);
	assert.equal(cursor?.window_days, 30);
});

test("an events window with a pending successor or a bad row still fails", async () => {
	const full = Array.from({ length: 100 }, (_, i) => push(`p${i}`));
	const pending = await walkEvents([full, full.map(e => ({ ...e, id: `q${e.id}` })), full.map(e => ({ ...e, id: `r${e.id}` })), [push("extra")]]);
	assert.deepEqual(pending.records, []);
	assert.deepEqual(pending.messages.map(m => m.type), ["SKIP_RESULT"]);
});

test("a rejected events row names its type and field counts, never row values", async () => {
	const { messages, records } = await walkEvents([[push("1"), review({ ...compactPr, title: 5 }, "2"), review({ ...compactPr, title: 6 }, "3")]]);
	assert.deepEqual(records, []);
	assert.deepEqual(messages.map(m => m.type), ["SKIP_RESULT"]);
	const diagnostics = messages[0]?.diagnostics as { unreadable_fields_by_type?: unknown };
	assert.deepEqual(diagnostics.unreadable_fields_by_type, { PullRequestReviewEvent: { title: 2 } });
	assert.doesNotMatch(JSON.stringify(messages[0]), /Invented|sample-owner/);
});

test("a compact reference with a blank or whitespace-only ref is not complete", () => {
	for (const pull_request of [
		{ ...compactPr, head: { ref: " " } }, { ...compactPr, base: { ref: "\t\n" } },
		{ ...compactPr, head: { ref: "" } },
	]) {
		assert.equal(parseLegacyEventPageItem(review(pull_request)).complete, false);
		const pr = parseLegacyEventPageItem({ id: "5", type: "PullRequestEvent", public: true, created_at: "2026-10-19T12:00:00Z", repo: { name: "sample-owner/demo" },
			payload: { action: "opened", number: 7, pull_request } });
		assert.equal(pr.complete, false);
	}
});

test("a review whose own URL names another pull request or repository is not complete", () => {
	const withReview = (fields: Record<string, unknown>) => {
		const event = review(compactPr);
		Object.assign(event.payload.review, fields);
		return parseLegacyEventPageItem(event);
	};
	assert.equal(withReview({}).complete, true);
	assert.equal(withReview({ pull_request_url: compactPr.url }).complete, true);
	assert.equal(withReview({ html_url: "https://github.com/sample-owner/demo/pull/8#pullrequestreview-1" }).complete, false);
	assert.equal(withReview({ html_url: "https://github.com/other-owner/demo/pull/7#pullrequestreview-1" }).complete, false);
	assert.equal(withReview({ pull_request_url: "https://api.github.com/repos/sample-owner/demo/pulls/8" }).complete, false);
	assert.equal(withReview({ pull_request_url: 7 }).complete, false);
});

test("unreadable-field diagnostics key only known event types and fields; source text lands in other", async () => {
	const odd = { ...push("9"), type: "InventedSecretEvent", payload: { action: 5 } };
	const { messages } = await walkEvents([[odd, review({ ...compactPr, title: 5 }, "2")]]);
	const diagnostics = messages[0]?.diagnostics as { unreadable_fields_by_type?: Record<string, Record<string, number>> };
	assert.deepEqual(Object.keys(diagnostics.unreadable_fields_by_type ?? {}).sort(), ["PullRequestReviewEvent", "other"]);
	assert.doesNotMatch(JSON.stringify(messages[0]), /InventedSecret/);
});

test("more than 300 distinct served events fail closed with a bounded reason and no STATE", async () => {
	const page = (tag: string, n: number) => Array.from({ length: n }, (_, i) => push(`${tag}${i}`));
	const { messages, records } = await walkEvents([page("a", 100), page("b", 100), page("c", 101)]);
	assert.deepEqual(records, []);
	assert.deepEqual(messages.map(m => m.type), ["SKIP_RESULT"]);
	assert.equal((messages[0]?.diagnostics as { cause?: string }).cause, "events_window_exceeded");
});

test("a review's own URLs are bound to the pull request even when the PR object is full", () => {
	const fullPr = { ...compactPr, title: "Invented title", body: null, html_url: "https://github.com/sample-owner/demo/pull/7" };
	const withReview = (fields: Record<string, unknown>) => {
		const event = review(fullPr);
		Object.assign(event.payload.review, fields);
		return parseLegacyEventPageItem(event);
	};
	assert.equal(withReview({}).complete, true);
	assert.equal(withReview({ pull_request_url: fullPr.url }).complete, true);
	assert.equal(withReview({ html_url: null }).complete, true);
	for (const fields of [
		{ html_url: "https://github.com/sample-owner/demo/pull/8#pullrequestreview-1" },
		{ html_url: "https://github.com/other-owner/demo/pull/7#pullrequestreview-1" },
		{ pull_request_url: "https://api.github.com/repos/sample-owner/demo/pulls/8" },
		{ pull_request_url: null },
	]) {
		const parsed = withReview(fields);
		assert.equal(parsed.complete, false);
		assert.ok(parsed.unreadableFields.includes("url"));
	}
});
