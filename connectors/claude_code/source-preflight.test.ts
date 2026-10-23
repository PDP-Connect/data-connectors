// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { assertUserFacingProgress } from "../../packages/polyfill-connectors/src/connector-diagnostic.ts";
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
			streams: [{ name: "file_history" }, { name: "cache_inventory" }],
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
	assert(!records.some((record) => record.data.relative_path === "auth.json"));

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
				msg.message ===
				"Checked 10 places Claude Code keeps data (1 found, 9 missing)",
		),
	);
	const inventoryLine = result.stderr
		.split("\n")
		.find((line) =>
			line.startsWith("[claude_code-diagnostic] local_inventory "),
		);
	assert(inventoryLine, "inventory counters belong in a diagnostic line");
	assert(inventoryLine.includes('"local_inventory_stores":10'));
	assert(inventoryLine.includes('"status_inventory_only":1'));
	assert(inventoryLine.includes('"status_missing":9'));
	assert(inventoryLine.includes("context_mode:inventory_only"));
	// Other connector-specific PROGRESS lines are converted in a separate change.
	assertUserFacingProgress(
		progress.filter((msg) => msg.message.startsWith("Checked ")),
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

type CoverageDone = Extract<EmittedMessage, { type: "DONE" }> & {
	coverage?: {
		version: number;
		collection_scope: string;
		streams: Array<{
			stream: string;
			scoped: boolean;
			stores: Array<{ store: string; status: string }>;
		}>;
	};
};

const PROJECT_STREAMS = ["sessions", "messages", "attachments", "memory_notes"];

function assertProjectCoverage(
	result: Awaited<ReturnType<typeof runConnectorProcess>>,
	streams: string[],
	status: string,
) {
	const done = result.messages.findLast((message) => message.type === "DONE") as
		| CoverageDone
		| undefined;
	assert.ok(done?.coverage, "negotiated coverage must be present");
	assert.equal(done.coverage.version, 1);
	assert.equal(done.coverage.collection_scope, "project-coverage-test");
	assert.deepEqual(
		done.coverage.streams.map((entry) => entry.stream).sort(),
		[...streams].sort(),
		"coverage must contain exactly the requested streams",
	);
	for (const entry of done.coverage.streams) {
		assert.ok(entry.stores.length > 0);
		assert.ok(
			entry.stores.every((store) => store.status === status),
			JSON.stringify({ entry, messages: result.messages }),
		);
	}
}

async function runProjectCoverage(
	home: string,
	streams: string[],
	options: {
		roots?: string[];
		state?: Record<string, unknown>;
		negotiated?: boolean;
	} = {},
) {
	return runConnectorProcess({
		env: {
			CLAUDE_CODE_HOME: home,
			CLAUDE_CODE_PROJECTS_DIR: join(home, "projects"),
			CLAUDE_CODE_PROJECT_INCLUDE: "",
			CLAUDE_CODE_PROJECT_EXCLUDE: "",
			HOME: home,
			PDPP_OWNER_TOKEN: "",
			PDPP_RS_URL: "",
			RS_URL: "",
		},
		start: {
			type: "START",
			...(options.negotiated === false
				? {}
				: { run_coverage_version: 1, collection_scope: "project-coverage-test" }),
			scope: {
				streams: streams.map((name) => ({
					name,
					...(options.roots ? { source_roots: options.roots } : {}),
				})),
			},
			state: options.state ?? {},
		},
	});
}

test("project symlink exclusion reaches memory_notes alone and every requested dependent stream", async () => {
	const home = await mkdtemp(join(tmpdir(), "pdpp-claude-project-symlink-"));
	try {
		const target = join(home, "excluded-projects");
		await mkdir(join(target, "-tmp-demo", "memory"), { recursive: true });
		await writeFile(
			join(target, "-tmp-demo", "memory", "note.md"),
			"PRIVATE SYMLINK BODY",
		);
		await symlink(target, join(home, "projects"), "dir");
		const priorPath = join(home, "projects", "-tmp-demo", "memory", "note.md");
		for (const streams of [["memory_notes"], PROJECT_STREAMS]) {
			const result = await runProjectCoverage(home, streams, {
				state: { memory_notes: { file_mtimes: { [priorPath]: 42 } } },
			});
			assertProjectCoverage(result, streams, "partial");
			const skips = result.messages.filter(
				(message): message is Extract<EmittedMessage, { type: "SKIP_RESULT" }> =>
					message.type === "SKIP_RESULT" && message.reason === "symlink_skipped",
			);
			assert.deepEqual(
				skips.map((message) => message.stream).sort(),
				[...streams].sort(),
			);
			assert.equal(
				result.messages.filter((message) => message.type === "RECORD").length,
				0,
			);
			assert.ok(!JSON.stringify(result.messages).includes("PRIVATE SYMLINK BODY"));
			const state = result.messages.find(
				(message) => message.type === "STATE" && message.stream === "memory_notes",
			) as Extract<EmittedMessage, { type: "STATE" }> | undefined;
			assert.equal(
				(state?.cursor as { file_mtimes?: Record<string, number> })
					?.file_mtimes?.[priorPath],
				42,
			);
		}
		const legacy = await runProjectCoverage(home, ["memory_notes"], {
			negotiated: false,
		});
		const done = legacy.messages.findLast((message) => message.type === "DONE");
		assert.ok(done);
		assert.equal(
			Object.hasOwn(done, "coverage"),
			false,
			"older runtime DONE shape stays unchanged",
		);
		assert.ok(
			legacy.messages.some(
				(message) =>
					message.type === "SKIP_RESULT" &&
					message.stream === "memory_notes" &&
					message.reason === "symlink_skipped",
			),
		);

		// Restoring an enumerable source clears only this run's incomplete outcome.
		await rm(join(home, "projects"));
		await mkdir(join(home, "projects", "-tmp-demo", "memory"), { recursive: true });
		await writeFile(priorPath, "Restored memory note");
		const restored = await runProjectCoverage(home, ["memory_notes"], {
			state: {
				memory_notes: { file_mtimes: { [priorPath]: 42 } },
			},
		});
		assertProjectCoverage(restored, ["memory_notes"], "collected");
		assert.equal(
			restored.messages.filter((message) => message.type === "RECORD").length,
			1,
		);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

for (const streams of [
	["messages"],
	["attachments"],
	["messages", "attachments"],
	PROJECT_STREAMS,
]) {
	test(`unmatched source_roots are partial for ${streams.join(", ")}`, async () => {
		const home = await mkdtemp(join(tmpdir(), "pdpp-claude-unmatched-roots-"));
		try {
			await mkdir(join(home, "projects", "-tmp-present"), { recursive: true });
			await writeFile(
				join(home, "projects", "-tmp-present", "session.jsonl"),
				"PRIVATE OUT OF SCOPE BODY\n",
			);
			const result = await runProjectCoverage(home, streams, {
				roots: ["/tmp/absent"],
			});
			assertProjectCoverage(result, streams, "partial");
			const skips = result.messages.filter(
				(message): message is Extract<EmittedMessage, { type: "SKIP_RESULT" }> =>
					message.type === "SKIP_RESULT",
			);
			assert.deepEqual(
				skips.map((message) => message.stream).sort(),
				[...streams].sort(),
			);
			assert.ok(skips.every((message) => message.reason === "scope_matched_no_sources"));
			assert.equal(
				result.messages.filter((message) => message.type === "RECORD").length,
				0,
			);
			assert.ok(
				!JSON.stringify(result.messages).includes("PRIVATE OUT OF SCOPE BODY"),
			);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});
}

test("enumerable empty project stores and matched empty roots remain collected", async () => {
	const home = await mkdtemp(join(tmpdir(), "pdpp-claude-empty-projects-"));
	try {
		await mkdir(join(home, "projects"), { recursive: true });
		const empty = await runProjectCoverage(home, PROJECT_STREAMS);
		assertProjectCoverage(empty, PROJECT_STREAMS, "collected");
		await mkdir(join(home, "projects", "-tmp-empty"), { recursive: true });
		const matched = await runProjectCoverage(home, PROJECT_STREAMS, {
			roots: ["/tmp/empty"],
		});
		assertProjectCoverage(matched, PROJECT_STREAMS, "collected");
		assert.equal(
			matched.messages.filter((message) => message.type === "SKIP_RESULT").length,
			0,
		);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("valid scoped project collection keeps subset isolation and replay cursors", async () => {
	const home = await mkdtemp(join(tmpdir(), "pdpp-claude-valid-root-"));
	try {
		const project = join(home, "projects", "-tmp-valid");
		await mkdir(join(project, "memory"), { recursive: true });
		await writeFile(join(project, "memory", "note.md"), "A real memory note");
		await writeFile(
			join(project, "session.jsonl"),
			JSON.stringify({
				type: "user",
				uuid: "123e4567-e89b-42d3-a456-426614174000",
				sessionId: "coverage-session",
				isSidechain: false,
				timestamp: "2026-04-22T00:00:01.000Z",
				message: { content: "hello" },
			}) + "\n",
		);
		const streams = ["messages", "memory_notes"];
		const first = await runProjectCoverage(home, streams, {
			roots: ["/tmp/valid"],
		});
		assertProjectCoverage(first, streams, "collected");
		const records = first.messages.filter((message) => message.type === "RECORD");
		assert.deepEqual(
			records.map((message) => message.stream).sort(),
			[...streams].sort(),
		);
		const state = Object.fromEntries(
			first.messages
				.filter((message) => message.type === "STATE")
				.map((message) => [message.stream, message.cursor]),
		);
		const second = await runProjectCoverage(home, streams, {
			roots: ["/tmp/valid"],
			state,
		});
		assertProjectCoverage(second, streams, "collected");
		assert.equal(
			second.messages.filter((message) => message.type === "RECORD").length,
			0,
		);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("transcript symlink does not make healthy memory_notes partial", async () => {
	const home = await mkdtemp(join(tmpdir(), "pdpp-claude-transcript-symlink-"));
	try {
		const project = join(home, "projects", "-tmp-demo");
		await mkdir(join(project, "memory"), { recursive: true });
		const note = join(project, "memory", "note.md");
		await writeFile(note, "A healthy memory note");
		const target = join(home, "excluded-session.jsonl");
		await writeFile(target, "PRIVATE TRANSCRIPT TARGET\n");
		await symlink(target, join(project, "session.jsonl"));
		const result = await runProjectCoverage(home, ["memory_notes"]);
		assert.equal(result.exitCode, 0);
		const records = result.messages.filter((message) => message.type === "RECORD");
		assert.equal(records.length, 1);
		assert.equal(records[0]?.stream, "memory_notes");
		assert.ok(JSON.stringify(records).includes("A healthy memory note"));
		assert.ok(!JSON.stringify(result.messages).includes("PRIVATE TRANSCRIPT TARGET"));
		assertProjectCoverage(result, ["memory_notes"], "collected");
		assert.equal(
			result.messages.filter((message) => message.type === "SKIP_RESULT").length,
			0,
		);
		const states = result.messages.filter((message) => message.type === "STATE");
		assert.equal(states.length, 1);
		assert.equal(states[0]?.stream, "memory_notes");
		const cursor = states[0]?.cursor as
			| { file_mtimes?: Record<string, number> }
			| undefined;
		assert.ok((cursor?.file_mtimes?.[note] ?? 0) > 0);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});
