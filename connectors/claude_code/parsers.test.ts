// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	applyProjectDirScope,
	buildMemoryNoteRecord,
	buildSkillRecord,
	buildSlashCommandRecord,
	buildUsageRecord,
	extractContent,
	makeEmptySessionAccumulator,
	mergeSessionObservations,
	parseCsvEnv,
	parseFrontmatter,
	SKILL_BODY_MAX_CHARS,
	textPreview,
	truncateBody,
	widenSessionTimeRange,
} from "./parsers.ts";
import type { SessionAccumulator } from "./types.ts";

// ─── textPreview / truncateBody ──────────────────────────────────────────

test("textPreview: non-string → null", () => {
	assert.equal(textPreview(null), null);
	assert.equal(textPreview(42), null);
});

test("textPreview: short string passes through", () => {
	assert.equal(textPreview("hi"), "hi");
});

test("textPreview: too-long string is truncated with ellipsis", () => {
	const got = textPreview("x".repeat(500), 10);
	assert.equal(got, `${"x".repeat(10)}…`);
});

test("truncateBody: caps long strings, leaves short ones", () => {
	assert.equal(truncateBody("abc"), "abc");
	const big = "x".repeat(SKILL_BODY_MAX_CHARS + 10);
	assert.equal(truncateBody(big).length, SKILL_BODY_MAX_CHARS);
});

// ─── extractContent ─────────────────────────────────────────────────────

test("extractContent: null/undefined → null", () => {
	assert.equal(extractContent(null), null);
	assert.equal(extractContent(undefined), null);
});

test("extractContent: string passthrough", () => {
	assert.equal(extractContent("hello"), "hello");
});

test("extractContent: array of text parts joined with newlines", () => {
	const got = extractContent([
		{ type: "text", text: "A" },
		{ type: "text", text: "B" },
	]);
	assert.equal(got, "A\nB");
});

test("extractContent: tool_use / tool_result placeholders", () => {
	const got = extractContent([
		{ type: "tool_use", name: "bash" },
		{ type: "tool_result" },
	]);
	assert.equal(got, "[tool_use: bash]\n[tool_result]");
});

test("extractContent: tool_use with no name labels 'unknown'", () => {
	assert.equal(extractContent([{ type: "tool_use" }]), "[tool_use: unknown]");
});

test("extractContent: plain string array element", () => {
	assert.equal(extractContent(["A", "B"]), "A\nB");
});

test("extractContent: array of only skippable items → null", () => {
	assert.equal(extractContent([{}]), null);
});

test("extractContent: object with nested content recurses", () => {
	const got = extractContent({ content: [{ type: "text", text: "hi" }] });
	assert.equal(got, "hi");
});

test("extractContent: object with text string", () => {
	assert.equal(extractContent({ text: "hi" }), "hi");
});

// ─── parseFrontmatter ────────────────────────────────────────────────────

test("parseFrontmatter: no fence → empty frontmatter, body=text", () => {
	const got = parseFrontmatter("no fence here");
	assert.deepEqual(got.frontmatter, {});
	assert.equal(got.body, "no fence here");
});

test("parseFrontmatter: simple key/value pairs", () => {
	const text = "---\nname: foo\ndescription: bar\n---\nbody here";
	const got = parseFrontmatter(text);
	assert.equal(got.frontmatter.name, "foo");
	assert.equal(got.frontmatter.description, "bar");
	assert.equal(got.body, "body here");
});

test("parseFrontmatter: strips surrounding double quotes", () => {
	const text = '---\nname: "foo bar"\n---\n';
	assert.equal(parseFrontmatter(text).frontmatter.name, "foo bar");
});

test("parseFrontmatter: strips surrounding single quotes", () => {
	const text = "---\nname: 'foo bar'\n---\n";
	assert.equal(parseFrontmatter(text).frontmatter.name, "foo bar");
});

test("parseFrontmatter: comments skipped", () => {
	const text = "---\n# a comment\nname: foo\n---\n";
	assert.equal(parseFrontmatter(text).frontmatter.name, "foo");
});

test("parseFrontmatter: folded block scalar (>) collapses whitespace", () => {
	const text = "---\ndescription: >\n  line one\n  line two\n---\nbody";
	const got = parseFrontmatter(text);
	assert.equal(got.frontmatter.description, "line one line two");
	assert.equal(got.body, "body");
});

test("parseFrontmatter: literal block scalar (|) keeps newlines", () => {
	const text = "---\ncontent: |\n  line one\n  line two\n---\n";
	assert.equal(
		parseFrontmatter(text).frontmatter.content,
		"line one\nline two",
	);
});

test("parseFrontmatter: skips malformed key/value lines", () => {
	const text = "---\nbad line\nname: foo\n---\n";
	assert.equal(parseFrontmatter(text).frontmatter.name, "foo");
});

// ─── makeEmptySessionAccumulator / mergeSessionObservations / widenSessionTimeRange ─

test("makeEmptySessionAccumulator: nulls + zero count", () => {
	const acc = makeEmptySessionAccumulator("s1", "proj/a", "session", null);
	assert.equal(acc.id, "s1");
	assert.equal(acc.project_path, "proj/a");
	assert.equal(acc.cwd, null);
	assert.equal(acc.message_count, 0);
	assert.equal(acc.kind, "session");
	assert.equal(acc.parent_session_id, null);
});

test("makeEmptySessionAccumulator: subagent kind + parent id", () => {
	const acc = makeEmptySessionAccumulator(
		"agent-abc",
		"proj/a",
		"subagent",
		"s1",
	);
	assert.equal(acc.kind, "subagent");
	assert.equal(acc.parent_session_id, "s1");
});

test("SessionAccumulator: stores only bounded scalar summary fields", () => {
	const acc = makeEmptySessionAccumulator("s1", "proj/a", "session", null);
	mergeSessionObservations(acc, {
		cwd: "/home/user owner/project",
		entrypoint: "claude",
		gitBranch: "main",
		title: "Fix the flaky test",
		userType: "human",
		version: "1.2.3",
	});
	widenSessionTimeRange(
		acc,
		"2026-01-01T00:00:00.000Z",
		"2026-01-01T00:10:00.000Z",
	);
	acc.message_count += 1000;

	assert.deepEqual(Object.keys(acc).sort(), [
		"cwd",
		"entrypoint",
		"git_branch",
		"id",
		"kind",
		"last_event_at",
		"message_count",
		"parent_session_id",
		"project_path",
		"started_at",
		"title",
		"user_type",
		"version",
	]);
	for (const forbidden of [
		"messages",
		"content",
		"transcript",
		"tool_outputs",
		"lines",
		"raw",
	]) {
		assert.equal(
			forbidden in acc,
			false,
			`SessionAccumulator must not retain raw ${forbidden}`,
		);
	}
	for (const [key, value] of Object.entries(acc)) {
		assert.notEqual(
			Array.isArray(value),
			true,
			`${key} must not be an unbounded array`,
		);
		assert.ok(
			value === null || typeof value !== "object",
			`${key} must stay scalar/null`,
		);
	}
});

test("mergeSessionObservations: only non-null fields replace", () => {
	const acc: SessionAccumulator = makeEmptySessionAccumulator(
		"s1",
		"p",
		"session",
		null,
	);
	mergeSessionObservations(acc, {
		cwd: "/home",
		gitBranch: "main",
		title: null,
		userType: null,
		entrypoint: null,
		version: null,
	});
	assert.equal(acc.cwd, "/home");
	assert.equal(acc.git_branch, "main");
	assert.equal(acc.user_type, null);
});

test("widenSessionTimeRange: picks min started, max last", () => {
	const acc: SessionAccumulator = makeEmptySessionAccumulator(
		"s1",
		"p",
		"session",
		null,
	);
	widenSessionTimeRange(acc, "2026-02-01", "2026-02-10");
	widenSessionTimeRange(acc, "2026-01-01", "2026-03-10");
	assert.equal(acc.started_at, "2026-01-01");
	assert.equal(acc.last_event_at, "2026-03-10");
});

test("widenSessionTimeRange: nulls no-op", () => {
	const acc: SessionAccumulator = makeEmptySessionAccumulator(
		"s1",
		"p",
		"session",
		null,
	);
	widenSessionTimeRange(acc, null, null);
	assert.equal(acc.started_at, null);
	assert.equal(acc.last_event_at, null);
});

// ─── buildSkillRecord / buildSlashCommandRecord ──────────────────────────

test("buildSkillRecord: frontmatter name beats directory name", () => {
	const r = buildSkillRecord({
		name: "dir-name",
		frontmatter: { name: "fm-name", description: "d" },
		body: "body",
		path: "/p/SKILL.md",
		mtimeMs: 5000,
	});
	assert.equal(r.id, "skills:dir-name");
	assert.equal(r.name, "fm-name");
	assert.equal(r.description, "d");
	assert.equal(r.source, "user");
	assert.equal(r.mtime_epoch, 5);
});

test("buildSkillRecord: falls back to dir name when frontmatter lacks name", () => {
	const r = buildSkillRecord({
		name: "dir-name",
		frontmatter: {},
		body: "body",
		path: "/p/SKILL.md",
		mtimeMs: 0,
	});
	assert.equal(r.name, "dir-name");
	assert.equal(r.description, null);
});

test("buildMemoryNoteRecord: stable id includes project and relative path", () => {
	const r = buildMemoryNoteRecord({
		projectDir: "-home-user-project",
		relPath: "nested/note.md",
		frontmatter: { title: "Project Note", description: "d" },
		body: "body",
		path: "/p/memory/nested/note.md",
		mtimeMs: 2000,
	});
	assert.equal(r.id, "memory_notes:-home-user-project/nested/note.md");
	assert.equal(r.project_path, "-home-user-project");
	assert.equal(r.note_path, "nested/note.md");
	assert.equal(r.name, "Project Note");
	assert.equal(r.description, "d");
	assert.equal(r.mtime_epoch, 2);
});

test("buildSlashCommandRecord: nested idPath + fallback base", () => {
	const r = buildSlashCommandRecord({
		idPath: "nested/cmd",
		base: "cmd",
		frontmatter: {},
		body: "body",
		path: "/p/cmd.md",
		mtimeMs: 1000,
	});
	assert.equal(r.id, "commands:nested/cmd");
	assert.equal(r.name, "cmd");
	assert.equal(r.mtime_epoch, 1);
});

// ─── applyProjectDirScope / parseCsvEnv ──────────────────────────────────

test("applyProjectDirScope: include narrows by substring match", () => {
	const got = applyProjectDirScope(
		["a-pdpp", "b-acme", "c-other"],
		["pdpp", "acme"],
		[],
	);
	assert.deepEqual(got, ["a-pdpp", "b-acme"]);
});

test("applyProjectDirScope: exclude removes by substring match", () => {
	const got = applyProjectDirScope(
		["a-pdpp", "b-acme", "c-other"],
		[],
		["acme"],
	);
	assert.deepEqual(got, ["a-pdpp", "c-other"]);
});

test("applyProjectDirScope: include+exclude both apply", () => {
	const got = applyProjectDirScope(
		["alpha", "beta", "alpha-beta"],
		["alpha"],
		["beta"],
	);
	assert.deepEqual(got, ["alpha"]);
});

test("applyProjectDirScope: empty filters → passthrough", () => {
	const got = applyProjectDirScope(["a", "b"], [], []);
	assert.deepEqual(got, ["a", "b"]);
});

test("parseCsvEnv: trims and drops empties", () => {
	assert.deepEqual(parseCsvEnv("a, b , , c"), ["a", "b", "c"]);
});

test("parseCsvEnv: undefined → []", () => {
	assert.deepEqual(parseCsvEnv(undefined), []);
});

// ─── buildUsageRecord ─────────────────────────────────────────────────────

test("buildUsageRecord: null raw → honest missing-file record", () => {
	const rec = buildUsageRecord(null);
	assert.equal(rec.id, "usage:aggregate");
	assert.equal(rec.source, "stats-cache-missing");
	assert.equal(rec.total_sessions, null);
	assert.equal(rec.total_cost_usd_cents, 0);
	assert.deepEqual(rec.models, []);
	assert.deepEqual(rec.daily_activity, []);
	assert.equal(rec.longest_session, null);
});

test("buildUsageRecord: real-shaped stats-cache.json parses and converts units", () => {
	const rec = buildUsageRecord({
		totalSessions: 54,
		totalMessages: 40548,
		firstSessionDate: "2026-01-06T09:33:39.062Z",
		lastComputedDate: "2026-02-23",
		totalSpeculationTimeSavedMs: 0,
		modelUsage: {
			"claude-opus-4-5-20251101": {
				inputTokens: 463_393,
				outputTokens: 2_253_207,
				cacheReadInputTokens: 2_326_238_529,
				cacheCreationInputTokens: 119_660_043,
				webSearchRequests: 0,
				costUSD: 1.5,
				contextWindow: 200_000,
				maxOutputTokens: 8192,
			},
		},
		dailyActivity: [
			{
				date: "2026-01-06",
				messageCount: 598,
				sessionCount: 2,
				toolCallCount: 151,
			},
		],
		dailyModelTokens: [
			{
				date: "2026-01-06",
				tokensByModel: { "claude-opus-4-5-20251101": 30_184 },
			},
		],
		hourCounts: { "0": 3, "1": 2 },
		longestSession: {
			sessionId: "07f0a80e-dcf2-412e-9f77-8d79824d7bb7",
			duration: 1_859_496_593,
			messageCount: 379,
			timestamp: "2026-01-06T09:33:39.062Z",
		},
	});
	assert.equal(rec.source, "stats-cache");
	assert.equal(rec.total_sessions, 54);
	assert.equal(rec.total_messages, 40_548);
	// costUSD 1.5 → 150 cents.
	assert.equal(rec.total_cost_usd_cents, 150);
	assert.equal(rec.currency, "USD");
	assert.deepEqual(rec.models, [
		{
			model: "claude-opus-4-5-20251101",
			input_tokens: 463_393,
			output_tokens: 2_253_207,
			cache_read_input_tokens: 2_326_238_529,
			cache_creation_input_tokens: 119_660_043,
			web_search_requests: 0,
			cost_usd_cents: 150,
			context_window: 200_000,
			max_output_tokens: 8192,
		},
	]);
	assert.deepEqual(rec.daily_activity, [
		{
			date: "2026-01-06",
			message_count: 598,
			session_count: 2,
			tool_call_count: 151,
		},
	]);
	assert.deepEqual(rec.daily_model_tokens, [
		{
			date: "2026-01-06",
			tokens_by_model: { "claude-opus-4-5-20251101": 30_184 },
		},
	]);
	assert.deepEqual(rec.hour_counts, { "0": 3, "1": 2 });
	// duration ms → seconds, rounded.
	assert.deepEqual(rec.longest_session, {
		session_id: "07f0a80e-dcf2-412e-9f77-8d79824d7bb7",
		duration_seconds: 1_859_497,
		message_count: 379,
		timestamp: "2026-01-06T09:33:39.062Z",
	});
});

test("buildUsageRecord: malformed daily entries are dropped, not crashed on", () => {
	const rec = buildUsageRecord({
		dailyActivity: [{ date: "not-a-date" }, { date: "2026-01-06" }],
	});
	assert.deepEqual(rec.daily_activity, [
		{
			date: "2026-01-06",
			message_count: 0,
			session_count: 0,
			tool_call_count: 0,
		},
	]);
});
