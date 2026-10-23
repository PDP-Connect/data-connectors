// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { connectorEntrypoint, packageRoot } from "./connector-paths.ts";
import { listDirectoryInventory } from "./local-source-inventory.ts";
import { runConnectorProtocolSubprocess } from "./test-harness.ts";

function statusFor(
	messages: readonly unknown[],
	stream: string,
	store: string,
): string | undefined {
	const done = messages.find(
		(message) => (message as { type?: string }).type === "DONE",
	) as
		| {
				coverage?: {
					streams?: Array<{
						stream: string;
						stores: Array<{ store: string; status: string }>;
					}>;
				};
		  }
		| undefined;
	return done?.coverage?.streams
		?.find((entry) => entry.stream === stream)
		?.stores.find((entry) => entry.store === store)?.status;
}

function assertMalformedTakeout(messages: readonly unknown[]): void {
	const doneEvents = messages.filter(
		(message) => (message as { type?: string }).type === "DONE",
	) as Array<{
		status?: string;
		error?: { message?: string };
		coverage?: {
			streams: Array<{
				stream: string;
				stores: Array<{ store: string; status: string }>;
			}>;
		};
	}>;
	assert.equal(doneEvents.length, 1, "exactly one DONE is required");
	const done = doneEvents[0];
	assert.ok(done);
	if (done.status === "failed") {
		assert.equal(
			done.coverage,
			undefined,
			"a failed run must carry no verdict",
		);
		assert.equal(
			done.error?.message,
			"Expected property name or '}' in JSON at position 1 (line 1 column 2)",
			"the malformed fixture must fail for its JSON parsing reason",
		);
		return;
	}
	assert.equal(done.status, "succeeded");
	assert.ok(
		done.coverage,
		"a successful run must provide incomplete-store evidence",
	);
	assert.deepEqual(done.coverage.streams.map((entry) => entry.stream).sort(), [
		"youtube_watch_history",
	]);
	const stream = done.coverage.streams[0];
	assert.ok(stream);
	assert.deepEqual(stream.stores.map((entry) => entry.store).sort(), [
		"youtube_watch_history",
	]);
	assert.ok(
		stream.stores.every(
			(entry) => entry.status === "partial" || entry.status === "failed",
		),
		"malformed history must be affirmatively partial or failed",
	);
}

function scopedFor(
	messages: readonly unknown[],
	stream: string,
): boolean | undefined {
	const done = messages.find(
		(message) => (message as { type?: string }).type === "DONE",
	) as
		| { coverage?: { streams?: Array<{ stream: string; scoped: boolean }> } }
		| undefined;
	return done?.coverage?.streams?.find((entry) => entry.stream === stream)
		?.scoped;
}

test("Claude malformed usage JSON cannot prove stats-cache coverage", async () => {
	const home = await mkdtemp(join(tmpdir(), "pdpp-cc-coverage-failure-"));
	try {
		await writeFile(join(home, "stats-cache.json"), "{invalid-json");
		const result = await runConnectorProtocolSubprocess({
			cwd: packageRoot,
			entrypoint: connectorEntrypoint("claude_code"),
			env: {
				CLAUDE_CODE_HOME: home,
				HOME: home,
				PDPP_OWNER_TOKEN: "",
				PDPP_RS_URL: "",
				RS_URL: "",
			},
			start: {
				type: "START",
				run_coverage_version: 1,
				collection_scope: "unscoped",
				scope: { streams: [{ name: "usage" }] },
				state: {},
			},
		});
		assert.notEqual(
			statusFor(result.messages, "usage", "stats_cache"),
			"collected",
		);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("Takeout malformed existing history requires incomplete evidence or its parse failure", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "pdpp-takeout-malformed-"));
	try {
		await mkdir(join(home, "YouTube and YouTube Music", "history"), {
			recursive: true,
		});
		await writeFile(
			join(home, "YouTube and YouTube Music", "history", "watch-history.json"),
			"{invalid-json",
		);
		const result = await runConnectorProtocolSubprocess({
			cwd: packageRoot,
			entrypoint: connectorEntrypoint("google_takeout"),
			env: {
				GOOGLE_TAKEOUT_DIR: home,
				HOME: home,
				PDPP_OWNER_TOKEN: "",
				PDPP_RS_URL: "",
				RS_URL: "",
			},
			start: {
				type: "START",
				run_coverage_version: 1,
				collection_scope: "unscoped",
				scope: { streams: [{ name: "youtube_watch_history" }] },
				state: {},
			},
			allowFailedDone: true,
		});
		assertMalformedTakeout(result.messages);
		// Keep the real transcript intact; corrupt independent copies of its DONE.
		const done = result.messages.find((message) => message.type === "DONE");
		assert.ok(done);
		const evidence = (status: string) => ({
			streams: [
				{
					stream: "youtube_watch_history",
					stores: [{ store: "youtube_watch_history", status }],
				},
			],
		});
		const corruptions = [
			[
				"absent coverage",
				{ ...done, status: "succeeded", coverage: undefined },
			],
			[
				"absent selected stream",
				{ ...done, status: "succeeded", coverage: { streams: [] } },
			],
			[
				"absent required store",
				{
					...done,
					status: "succeeded",
					coverage: {
						streams: [{ stream: "youtube_watch_history", stores: [] }],
					},
				},
			],
			[
				"false collected",
				{ ...done, status: "succeeded", coverage: evidence("collected") },
			],
			[
				"unrelated failed DONE",
				{
					...done,
					status: "failed",
					coverage: undefined,
					error: { message: "unrelated startup failure" },
				},
			],
		] as const;
		await Promise.all(
			corruptions.map(([label, corruptedDone]) => {
				return t.test(label, () => {
					const messages = result.messages.map((message) =>
						message === done ? corruptedDone : message,
					);
					assert.doesNotThrow(
						() =>
							assert.notEqual(
								statusFor(
									messages,
									"youtube_watch_history",
									"youtube_watch_history",
								),
								"unavailable",
							),
						"the old negative-only oracle accepted this corruption",
					);
					assert.throws(
						() => assertMalformedTakeout(messages),
						assert.AssertionError,
					);
				});
			}),
		);
		for (const status of ["partial", "failed"]) {
			assert.doesNotThrow(() =>
				assertMalformedTakeout([
					{ type: "DONE", status: "succeeded", coverage: evidence(status) },
				]),
			);
		}
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("Codex supported rules item read failure cannot prove rules coverage", async () => {
	const home = await mkdtemp(join(tmpdir(), "pdpp-codex-coverage-failure-"));
	try {
		await mkdir(join(home, "rules", "bad.rules"), { recursive: true });
		const result = await runConnectorProtocolSubprocess({
			cwd: packageRoot,
			entrypoint: connectorEntrypoint("codex"),
			env: {
				CODEX_HOME: home,
				HOME: home,
				PDPP_OWNER_TOKEN: "",
				PDPP_RS_URL: "",
				RS_URL: "",
			},
			start: {
				type: "START",
				run_coverage_version: 1,
				collection_scope: "unscoped",
				scope: { streams: [{ name: "rules" }] },
				state: {},
			},
			allowFailedDone: true,
		});
		assert.notEqual(statusFor(result.messages, "rules", "rules"), "collected");
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("Codex unreadable state DB is not covered by rollout fallback", async () => {
	const home = await mkdtemp(join(tmpdir(), "pdpp-codex-db-coverage-failure-"));
	try {
		await mkdir(join(home, "sessions"));
		await writeFile(join(home, "state_5.sqlite"), "not a sqlite database");
		const result = await runConnectorProtocolSubprocess({
			cwd: packageRoot,
			entrypoint: connectorEntrypoint("codex"),
			env: {
				CODEX_HOME: home,
				HOME: home,
				PDPP_OWNER_TOKEN: "",
				PDPP_RS_URL: "",
				RS_URL: "",
			},
			start: {
				type: "START",
				run_coverage_version: 1,
				collection_scope: "unscoped",
				scope: { streams: [{ name: "sessions" }] },
				state: {},
			},
			allowFailedDone: true,
		});
		assert.notEqual(
			statusFor(result.messages, "sessions", "state_db"),
			"collected",
		);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("Codex legacy START without a version request omits a verdict", async () => {
	const home = await mkdtemp(join(tmpdir(), "pdpp-codex-legacy-coverage-"));
	try {
		const result = await runConnectorProtocolSubprocess({
			cwd: packageRoot,
			entrypoint: connectorEntrypoint("codex"),
			env: {
				CODEX_HOME: home,
				HOME: home,
				PDPP_OWNER_TOKEN: "",
				PDPP_RS_URL: "",
				RS_URL: "",
			},
			start: {
				type: "START",
				collection_scope: "unscoped",
				scope: { streams: [{ name: "rules" }] },
				state: {},
			},
		});
		const done = result.messages.find((message) => message.type === "DONE") as
			| { coverage?: unknown }
			| undefined;
		assert.equal(done?.coverage, undefined);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("Claude since-only scan does not claim bounded enumeration", async () => {
	const home = await mkdtemp(join(tmpdir(), "pdpp-cc-scope-coverage-"));
	try {
		await mkdir(join(home, "projects"));
		const result = await runConnectorProtocolSubprocess({
			cwd: packageRoot,
			entrypoint: connectorEntrypoint("claude_code"),
			env: {
				CLAUDE_CODE_HOME: home,
				HOME: home,
				PDPP_OWNER_TOKEN: "",
				PDPP_RS_URL: "",
				RS_URL: "",
			},
			start: {
				type: "START",
				run_coverage_version: 1,
				collection_scope: "bounded-test",
				scope: {
					streams: [
						{ name: "sessions", time_range: { since: "2026-01-01T00:00:00Z" } },
					],
				},
				state: {},
			},
		});
		assert.equal(scopedFor(result.messages, "sessions"), false);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("Codex bounded sessions scan cannot claim coverage from an unbounded DB query", async () => {
	const home = await mkdtemp(join(tmpdir(), "pdpp-codex-scope-coverage-"));
	try {
		await mkdir(join(home, "sessions"));
		const result = await runConnectorProtocolSubprocess({
			cwd: packageRoot,
			entrypoint: connectorEntrypoint("codex"),
			env: {
				CODEX_HOME: home,
				HOME: home,
				PDPP_OWNER_TOKEN: "",
				PDPP_RS_URL: "",
				RS_URL: "",
			},
			start: {
				type: "START",
				run_coverage_version: 1,
				collection_scope: "bounded-test",
				scope: {
					streams: [
						{ name: "sessions", time_range: { since: "2026-01-01T00:00:00Z" } },
					],
				},
				state: {},
			},
		});
		assert.equal(scopedFor(result.messages, "sessions"), false);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("inventory directory traversal failure cannot masquerade as an empty source", async () => {
	const home = await mkdtemp(join(tmpdir(), "pdpp-inventory-read-failure-"));
	try {
		await writeFile(join(home, "shell-snapshots"), "not a directory");
		await assert.rejects(
			listDirectoryInventory({
				tool: "codex",
				sourceHome: home,
				relativeRoot: "shell-snapshots",
				store: "shell_snapshots",
				stream: "shell_snapshots",
				reason: "metadata only",
			}),
		);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

// A collected metadata inventory covers its declared obligation, not file content.
test("Codex negotiated metadata inventory reports its selected store only", async () => {
	const home = await mkdtemp(join(tmpdir(), "pdpp-codex-metadata-coverage-"));
	try {
		await mkdir(join(home, "shell-snapshots"));
		await writeFile(join(home, "shell-snapshots", "snapshot.sh"), "echo hello");
		const result = await runConnectorProtocolSubprocess({
			cwd: packageRoot,
			entrypoint: connectorEntrypoint("codex"),
			env: {
				CODEX_HOME: home,
				HOME: home,
				PDPP_OWNER_TOKEN: "",
				PDPP_RS_URL: "",
				RS_URL: "",
			},
			start: {
				type: "START",
				run_coverage_version: 1,
				collection_scope: "unscoped",
				scope: { streams: [{ name: "shell_snapshots" }] },
				state: {},
			},
		});
		assert.equal(
			statusFor(result.messages, "shell_snapshots", "shell_snapshots"),
			"collected",
		);
		assert.equal(statusFor(result.messages, "sessions", "sessions"), undefined);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});
