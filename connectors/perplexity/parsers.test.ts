// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
	answerText,
	conversationRecord,
	entryCitations,
	entryMessages,
	normalizeInstant,
	parseListedThread,
	parseThreadDetailPage,
	parseThreadListPage,
} from "./parsers.ts";
import { validateRecord } from "./schemas.ts";

function fixture(name: string): string {
	return readFileSync(
		new URL(`./__fixtures__/${name}`, import.meta.url),
		"utf8",
	);
}

test("a library list page parses with its end marker and total", () => {
	const parsed = parseThreadListPage(fixture("thread-list-page-more.json"));
	assert.equal(parsed.ok, true);
	if (!parsed.ok) return;
	assert.equal(parsed.page.items.length, 2);
	assert.equal(parsed.page.hasNextPage, true);
	assert.equal(parsed.page.totalThreads, 4);

	const final = parseThreadListPage(fixture("thread-list-page-final.json"));
	assert.equal(final.ok, true);
	if (!final.ok) return;
	assert.equal(final.page.hasNextPage, false);
	assert.equal(final.page.totalThreads, 4);
});

test("an empty list page is a complete list, not a failure", () => {
	const parsed = parseThreadListPage("[]");
	assert.deepEqual(parsed, {
		ok: true,
		page: { items: [], hasNextPage: false, totalThreads: null },
	});
});

test("a list body that is not a JSON array fails loudly", () => {
	assert.equal(parseThreadListPage("<html>").ok, false);
	assert.equal(parseThreadListPage('{"models":[]}').ok, false);
	assert.equal(parseThreadListPage('{"total_threads":1}').ok, false);
	const noMarker = parseThreadListPage('[{"context_uuid": "abc"}]');
	assert.equal(noMarker.ok, false);
	if (noMarker.ok) return;
	assert.match(noMarker.message, /has_next_page/);
});

test("a thread item becomes a listed thread, and never carries the token", () => {
	const page = parseThreadListPage(fixture("thread-list-page-more.json"));
	assert.equal(page.ok, true);
	if (!page.ok) return;
	const first = page.page.items[0];
	const listed = parseListedThread(first);
	assert.notEqual(listed, null);
	if (!listed) return;
	assert.equal(listed.id, "cccccccc-cccc-4ccc-8ccc-ccccccccccc1");
	assert.equal(listed.slug, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1");
	assert.equal(listed.title, "Synthetic thread one");
	assert.equal(listed.mode, "web");
	assert.equal(listed.model, "sonar-pro");
	assert.equal(listed.updateTime, "2026-10-02T09:15:00Z");
	assert.equal(listed.entryCount, 1);
	assert.equal(listed.access, 1);
	const record = conversationRecord(listed, "2026-10-02T09:15:00Z");
	assert.equal(record.create_time, "2026-10-02T09:15:00Z");
	assert.equal(record.update_time, "2026-10-02T09:15:00Z");
	assert.ok(
		!("read_write_token" in record),
		"the capability token must never be emitted",
	);
	assert.equal(validateRecord("conversations", { ...record }).ok, true);

	// An offset timestamp normalises to the same UTC instant.
	const second = parseListedThread(page.page.items[1]);
	assert.equal(second?.updateTime, "2026-10-01T16:30:00Z");
});

test("a thread item without an id is unreadable, and one without a slug still lists", () => {
	assert.equal(parseListedThread(null), null);
	assert.equal(parseListedThread("cccccccc-cccc-4ccc-8ccc-ccccccccccc1"), null);
	assert.equal(parseListedThread({ title: "no id" }), null);
	const slugless = parseListedThread({
		context_uuid: "cccccccc-cccc-4ccc-8ccc-ccccccccccc4",
		title: "Synthetic thread four",
	});
	assert.notEqual(slugless, null);
	assert.equal(slugless?.slug, null);
	const spaced = parseListedThread({
		context_uuid: "cccccccc-cccc-4ccc-8ccc-ccccccccccc4",
		slug: "not a slug",
	});
	assert.equal(spaced?.slug, null);
});

test("timestamps must state a zone; nothing else is guessed", () => {
	assert.equal(
		normalizeInstant("2026-10-02T09:15:00Z"),
		"2026-10-02T09:15:00Z",
	);
	assert.equal(
		normalizeInstant("2026-10-02T09:15:00.500Z"),
		"2026-10-02T09:15:00Z",
	);
	assert.equal(
		normalizeInstant("2026-10-02T11:15:00+02:00"),
		"2026-10-02T09:15:00Z",
	);
	assert.equal(
		normalizeInstant("2026-10-02T04:15:00-0500"),
		"2026-10-02T09:15:00Z",
	);
	assert.equal(normalizeInstant("2026-10-02T09:15:00"), null);
	assert.equal(normalizeInstant("Mon, 10/2/2026"), null);
	assert.equal(normalizeInstant(1789885800), null);
	assert.equal(normalizeInstant(null), null);
});

test("the whole-answer block wins; section blocks are never concatenated with it", () => {
	const detail = parseThreadDetailPage(fixture("thread-detail.json"));
	assert.equal(detail.ok, true);
	if (!detail.ok) return;
	const entry = detail.page.entries[0];
	assert.equal(
		answerText(entry as Record<string, unknown>),
		"A **synthetic fixture** is invented data shaped like the real thing.",
	);
});

test("with no whole-answer block, sections join in their numbered order", () => {
	const detail = parseThreadDetailPage(fixture("thread-detail-sections.json"));
	assert.equal(detail.ok, true);
	if (!detail.ok) return;
	const entry = detail.page.entries[0] as Record<string, unknown>;
	assert.equal(
		answerText(entry),
		"Section zero.\n\nSection one.\n\nSection two.",
	);
	assert.equal(answerText({ blocks: [] }), null);
	assert.equal(answerText({}), null);
});

test("only usable web results become citations, and only from the web_results block", () => {
	const detail = parseThreadDetailPage(fixture("thread-detail-sections.json"));
	assert.equal(detail.ok, true);
	if (!detail.ok) return;
	const entry = detail.page.entries[0] as Record<string, unknown>;
	assert.deepEqual(entryCitations(entry), [
		{ title: "Synthetic source three", url: "https://example.net/synthetic-3" },
	]);
	assert.deepEqual(entryCitations({}), []);
});

test("one entry splits into a question and an answer message", () => {
	const detail = parseThreadDetailPage(fixture("thread-detail.json"));
	assert.equal(detail.ok, true);
	if (!detail.ok) return;
	const parsed = entryMessages(
		detail.page.entries[0],
		"cccccccc-cccc-4ccc-8ccc-ccccccccccc1",
	);
	assert.notEqual(parsed, null);
	if (!parsed) return;
	assert.equal(parsed.firstCreateTime, "2026-10-02T09:15:00Z");
	assert.equal(parsed.user?.id, "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1:user");
	assert.equal(parsed.user?.role, "user");
	assert.equal(parsed.user?.content, "What is a synthetic fixture?");
	assert.equal(parsed.user?.create_time, "2026-10-02T09:15:00Z");
	assert.equal(parsed.user?.model, null);
	assert.deepEqual(parsed.user?.citations, []);
	assert.equal(
		parsed.assistant?.id,
		"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1:assistant",
	);
	assert.equal(parsed.assistant?.role, "assistant");
	assert.equal(
		parsed.assistant?.content,
		"A **synthetic fixture** is invented data shaped like the real thing.",
	);
	// The answer carries the entry's update time: when the answer finished.
	assert.equal(parsed.assistant?.create_time, "2026-10-02T09:15:04Z");
	assert.equal(parsed.assistant?.model, "sonar-pro");
	assert.deepEqual(parsed.assistant?.citations, [
		{ title: "Synthetic source one", url: "https://example.com/synthetic-1" },
		{ title: "Synthetic source two", url: "https://example.org/synthetic-2" },
	]);
	assert.ok(validateRecord("messages", { ...parsed.user }).ok);
	assert.ok(validateRecord("messages", { ...parsed.assistant }).ok);
	// The capability token never reaches a record.
	assert.ok(!("read_write_token" in parsed.assistant));
});

test("an entry without a usable uuid cannot be keyed", () => {
	assert.equal(entryMessages(null, "c1"), null);
	assert.equal(entryMessages({ query_str: "x" }, "c1"), null);
	assert.equal(entryMessages({ uuid: "" }, "c1"), null);
});
