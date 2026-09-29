// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { manifestPath } from "../../packages/polyfill-connectors/src/connector-paths.ts";
import type { EmittedMessage } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { runConnectorProtocolSubprocess } from "../../packages/polyfill-connectors/src/test-harness.ts";

test("claude_code connector fails instead of succeeding when requested local sources are missing", async () => {
	const claudeHome = await mkdtemp(join(tmpdir(), "pdpp-claude-missing-"));
	const result = await runConnectorProcess({
		// Set every requested source explicitly so a sibling test that mutates
		// the parent process environment cannot make this preflight non-hermetic.
		env: {
			CLAUDE_CODE_HOME: claudeHome,
			CLAUDE_CODE_PROJECTS_DIR: join(claudeHome, "projects"),
		},
		start: {
			scope: {
				streams: [
					{ name: "sessions" },
					{ name: "skills" },
					{ name: "slash_commands" },
				],
			},
			type: "START",
		},
	});

	assert.notEqual(result.exitCode, 0);
	const done = result.messages.findLast(
		(msg): msg is Extract<EmittedMessage, { type: "DONE" }> =>
			msg.type === "DONE",
	);
	assert.equal(done?.status, "failed");
	assert.match(
		done?.error?.message ?? "",
		/requested Claude Code local source path\(s\) are missing or unreadable/,
	);
	assert.match(done?.error?.message ?? "", /CLAUDE_CODE_PROJECTS_DIR=/);
	assert.match(done?.error?.message ?? "", /skills directory=/);
});

test("claude_code names a missing slash-command source", async () => {
	const claudeHome = await mkdtemp(
		join(tmpdir(), "pdpp-claude-missing-commands-"),
	);
	const result = await runConnectorProcess({
		env: { CLAUDE_CODE_HOME: claudeHome },
		start: {
			scope: { streams: [{ name: "slash_commands" }] },
			type: "START",
		},
	});

	const done = result.messages.findLast(
		(msg): msg is Extract<EmittedMessage, { type: "DONE" }> =>
			msg.type === "DONE",
	);
	assert.equal(done?.status, "failed");
	assert.match(
		done?.error?.message ?? "",
		/CLAUDE_CODE_HOME commands directory=/,
	);
});

test("claude_code inventory streams emit safe metadata, one STATE per stream, and exclude auth payloads", async () => {
	const claudeHome = await mkdtemp(join(tmpdir(), "pdpp-claude-inventory-"));
	await mkdir(join(claudeHome, "file-history"), { recursive: true });
	await mkdir(join(claudeHome, "cache"), { recursive: true });
	await writeFile(
		join(claudeHome, "file-history", "snapshot.json"),
		'{"path":"/tmp/example"}',
	);
	await writeFile(join(claudeHome, "cache", "raw-cache.json"), "cache payload");
	await writeFile(join(claudeHome, "auth.json"), '{"token":"secret-token"}');

	const start = {
		scope: {
				streams: [
					{ name: "file_history" },
					{ name: "cache_inventory" },
				],
			},
		type: "START" as const,
	};
	const result = await runConnectorProcess({
		env: { CLAUDE_CODE_HOME: claudeHome },
		start,
	});

	assert.equal(result.exitCode, 0);
	const records = result.messages.filter(
		(msg): msg is Extract<EmittedMessage, { type: "RECORD" }> =>
			msg.type === "RECORD",
	);
	assert(
		records.some(
			(record) =>
				record.stream === "file_history" &&
				record.data.relative_path === "file-history",
		),
	);
	assert(
		records.some(
			(record) =>
				record.stream === "file_history" &&
				record.data.relative_path === "file-history/snapshot.json",
		),
	);
	assert(
		records.some(
			(record) =>
				record.stream === "cache_inventory" &&
				record.data.relative_path === "cache",
		),
	);
	assert(
		!records.some((record) => JSON.stringify(record).includes("secret-token")),
	);
	assert(
		!records.some(
			(record) => record.data.relative_path === "auth.json",
		),
	);

	const states = result.messages.filter(
		(msg): msg is Extract<EmittedMessage, { type: "STATE" }> =>
			msg.type === "STATE",
	);
	// Every inventory stream writes at most one STATE per collection pass.
	assert.equal(
		new Set(states.map((entry) => entry.stream)).size,
		states.length,
		"each inventory stream writes at most one STATE per collection pass",
	);
	const firstFileHistoryState = states.find(
		(entry) => entry.stream === "file_history",
	);
	assert.equal(firstFileHistoryState !== undefined, true);
	const fileHistoryCursor = (
		firstFileHistoryState as Extract<EmittedMessage, { type: "STATE" }>
	).cursor as {
		fingerprints?: Record<string, string>;
	};
	assert.equal(
		Object.keys(fileHistoryCursor.fingerprints ?? {}).length,
		2,
		"the file-history root and entry share one cursor",
	);

	const state = Object.fromEntries(
		states.map((message) => [message.stream, message.cursor]),
	);
	const second = await runConnectorProcess({
		env: { CLAUDE_CODE_HOME: claudeHome },
		start: { ...start, state },
	});
	assert.equal(second.exitCode, 0);
	assert.equal(
		second.messages.filter(
			(message) =>
				message.type === "RECORD" && message.stream === "file_history",
		).length,
		0,
		"unchanged file_history emits no records on the second run",
	);
	assert.equal(
		second.messages.filter(
			(message) =>
				message.type === "STATE" && message.stream === "file_history",
		).length,
		1,
		"file_history still writes exactly one carry-forward STATE",
	);
});

test("claude_code context_mode is diagnostics-only, not a requestable stream", async () => {
	const claudeHome = await mkdtemp(join(tmpdir(), "pdpp-claude-private-"));
	await mkdir(join(claudeHome, "context-mode"), { recursive: true });
	await writeFile(
		join(claudeHome, "context-mode", "local.json"),
		'{"private":"do-not-emit"}',
	);

	const result = await runConnectorProcess({
		env: { CLAUDE_CODE_HOME: claudeHome },
			start: {
				scope: {
					streams: [{ name: "context_mode" }],
				},
				type: "START",
			},
	});

	assert.equal(result.exitCode, 0);
	const records = result.messages.filter(
		(msg): msg is Extract<EmittedMessage, { type: "RECORD" }> =>
			msg.type === "RECORD",
	);
	assert(!records.some((record) => record.stream === "context_mode"));
	assert(
		!records.some((record) => JSON.stringify(record).includes("do-not-emit")),
	);
	const progress = result.messages.filter(
		(msg): msg is Extract<EmittedMessage, { type: "PROGRESS" }> =>
			msg.type === "PROGRESS",
	);
	assert(
		progress.some(
			(msg) =>
				msg.message.startsWith(
					"Claude Code phase=index pass=index local_inventory_stores=10 status_inventory_only=1 status_missing=9 stores=",
				) && msg.message.includes("context_mode:inventory_only"),
		),
	);
	assert(
		!progress.some((msg) => msg.message.includes("do-not-emit")),
		"diagnostics must not include context-mode payload text",
	);
	assert(
		!result.messages.some(
			(msg) =>
				msg.type === "STATE" &&
				(msg as Extract<EmittedMessage, { type: "STATE" }>).stream ===
					"context_mode",
		),
	);
});

test("claude_code markdown-backed streams skip unchanged files from state", async () => {
	const claudeHome = await mkdtemp(
		join(tmpdir(), "pdpp-claude-markdown-state-"),
	);
	const projectsDir = join(claudeHome, "projects");
	await mkdir(join(claudeHome, "skills", "demo-skill"), { recursive: true });
	await mkdir(join(claudeHome, "commands"), { recursive: true });
	await mkdir(join(projectsDir, "-tmp-demo", "memory"), { recursive: true });
	await writeFile(
		join(claudeHome, "skills", "demo-skill", "SKILL.md"),
		"---\nname: Demo Skill\n---\nbody",
	);
	await writeFile(
		join(claudeHome, "commands", "demo.md"),
		"---\nname: Demo Command\n---\nbody",
	);
	await writeFile(
		join(projectsDir, "-tmp-demo", "memory", "note.md"),
		"---\ntitle: Demo Note\n---\nbody",
	);

	const start = {
		scope: {
			streams: [
				{ name: "skills" },
				{ name: "slash_commands" },
				{ name: "memory_notes" },
			],
		},
		type: "START",
	};
	const env = {
		CLAUDE_CODE_HOME: claudeHome,
		CLAUDE_CODE_PROJECTS_DIR: projectsDir,
	};
	const first = await runConnectorProcess({ env, start });
	assert.equal(first.exitCode, 0);
	const firstRecords = first.messages.filter(
		(msg): msg is Extract<EmittedMessage, { type: "RECORD" }> =>
			msg.type === "RECORD",
	);
	assert.deepEqual(
		firstRecords
			.map((record) => record.stream)
			.sort((a, b) => a.localeCompare(b)),
		["memory_notes", "skills", "slash_commands"],
	);

	const state = Object.fromEntries(
		first.messages
			.filter(
				(msg): msg is Extract<EmittedMessage, { type: "STATE" }> =>
					msg.type === "STATE",
			)
			.map((msg) => [msg.stream, msg.cursor]),
	);
	assert.equal(
		Object.keys(
			(state.skills as { file_mtimes?: Record<string, number> }).file_mtimes ??
				{},
		).length,
		1,
	);
	assert.equal(
		Object.keys(
			(state.slash_commands as { file_mtimes?: Record<string, number> })
				.file_mtimes ?? {},
		).length,
		1,
	);
	assert.equal(
		Object.keys(
			(state.memory_notes as { file_mtimes?: Record<string, number> })
				.file_mtimes ?? {},
		).length,
		1,
	);

	const second = await runConnectorProcess({ env, start: { ...start, state } });
	assert.equal(second.exitCode, 0);
	const secondRecords = second.messages.filter((msg) => msg.type === "RECORD");
	assert.equal(
		secondRecords.length,
		0,
		"unchanged markdown-backed streams should not re-emit records",
	);
});

test("claude_code manifest does not expose context_mode as a consentable stream", async () => {
	const manifestFile = manifestPath("claude_code");
	const manifest = JSON.parse(await readFile(manifestFile, "utf8")) as {
		streams: Array<{ name: string }>;
	};

	assert(!manifest.streams.some((stream) => stream.name === "context_mode"));
});

async function runConnectorProcess(input: {
	env: NodeJS.ProcessEnv;
	start: unknown;
}): Promise<{
	exitCode: number | null;
	messages: EmittedMessage[];
	stderr: string;
}> {
	const result = await runConnectorProtocolSubprocess({
		allowFailedDone: true,
		cwd: join(import.meta.dirname, "../.."),
		entrypoint: "connectors/claude_code/index.ts",
		env: input.env,
		start: input.start as {
			scope: {
				streams: Array<{
					name: string;
					resources?: string[];
					time_range?: { since?: string; until?: string };
				}>;
			};
			state?: Record<string, unknown>;
			type: "START";
		},
	});
	return {
		exitCode: result.code,
		messages: result.messages,
		stderr: result.stderr,
	};
}
