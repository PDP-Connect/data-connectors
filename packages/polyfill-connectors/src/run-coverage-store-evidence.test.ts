// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * What the five local-device connectors may claim in `DONE.coverage`.
 *
 * Every test here drives the real connector entrypoint over the protocol
 * harness, so it checks the verdict the runtime would send and not an internal
 * flag. The rules under test come from the collection profile's store
 * evidence text:
 *
 * - A connector MUST omit the whole coverage object when a requested stream
 *   has no declared inventory.
 * - Absence of records or a file-read failure MUST NOT by itself establish
 *   proven emptiness.
 * - `scoped: true` asserts that enumeration honored the requested boundary.
 */

import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildChatDbFixture } from "../../../connectors/imessage/fixtures.ts";
import { connectorEntrypoint, packageRoot } from "./connector-paths.ts";
import type { RunCoverageVerdict } from "./run-coverage.ts";
import { createRunCoverage } from "./run-coverage.ts";
import {
	type ConnectorSubprocessOptions,
	runConnectorProtocolSubprocess,
} from "./test-harness.ts";

type ConnectorKey =
	| "apple_photos"
	| "claude_code"
	| "codex"
	| "google_takeout"
	| "imessage";

interface StreamRequest {
	name: string;
	source_roots?: string[];
	time_range?: { since?: string };
}

interface ConnectorRun {
	/** The verdict attached to DONE, or undefined when the connector omitted it. */
	coverage: RunCoverageVerdict | undefined;
	/** The DONE status: a failed run carries no verdict. */
	status: string | undefined;
}

/**
 * Blanked on every run so a developer's shell cannot redirect a store, send a
 * blob upload to a real server, or hand the connector an owner token.
 */
const NEUTRAL_ENV = {
	APPLE_PHOTOS_EXPORT_DIR: "",
	CLAUDE_CODE_HOME: "",
	CLAUDE_CODE_PROJECTS_DIR: "",
	CODEX_HOME: "",
	CODEX_PROMPTS_DIR: "",
	CODEX_RULES_DIR: "",
	CODEX_SESSIONS_ARCHIVE_DIR: "",
	CODEX_SESSIONS_DIR: "",
	CODEX_SKILLS_DIR: "",
	CODEX_STATE_DB: "",
	GOOGLE_TAKEOUT_DIR: "",
	IMESSAGE_ATTACHMENTS_ROOT: "",
	IMESSAGE_DB_PATH: "",
	PDPP_OWNER_TOKEN: "",
	PDPP_RS_URL: "",
	RS_URL: "",
} as const;

/** A stream name no checked-in manifest declares, so no inventory exists for it. */
const UNDECLARED_STREAM = "stream_without_inventory";

type Lock = (path: string) => Promise<void>;

/**
 * A scratch home removed after the callback. `lock` makes a path unreadable
 * and restores it before removal, so a failed assertion cannot leave a
 * directory the cleanup cannot enter.
 */
async function withHome(
	fn: (home: string, lock: Lock) => Promise<void>,
): Promise<void> {
	const home = await mkdtemp(join(tmpdir(), "pdpp-store-evidence-"));
	const locked: string[] = [];
	try {
		await fn(home, async (path) => {
			await chmod(path, 0o000);
			locked.push(path);
		});
	} finally {
		for (const path of locked.reverse()) {
			await chmod(path, 0o755).catch(() => undefined);
		}
		await rm(home, { force: true, recursive: true });
	}
}

async function drive(input: {
	connector: ConnectorKey;
	env: Record<string, string>;
	home: string;
	scope?: string;
	streams: readonly StreamRequest[];
}): Promise<ConnectorRun> {
	const result = await runConnectorProtocolSubprocess({
		allowFailedDone: true,
		cwd: packageRoot,
		entrypoint: connectorEntrypoint(input.connector),
		env: { ...NEUTRAL_ENV, HOME: input.home, ...input.env },
		start: {
			collection_scope: input.scope ?? "unscoped",
			run_coverage_version: 1,
			scope: { streams: input.streams },
			state: {},
			type: "START",
		} as ConnectorSubprocessOptions["start"],
	});
	const done = result.messages.findLast((message) => message.type === "DONE") as
		| { coverage?: RunCoverageVerdict; status?: string }
		| undefined;
	return { coverage: done?.coverage, status: done?.status };
}

/** A corpus the connector can read, and a stream it declares an inventory for. */
interface Corpus {
	env: Record<string, string>;
	stream: string;
}

async function readableCorpus(
	connector: ConnectorKey,
	home: string,
): Promise<Corpus> {
	switch (connector) {
		case "apple_photos":
			await writeFile(join(home, "photo.jpg"), "bytes");
			return { env: { APPLE_PHOTOS_EXPORT_DIR: home }, stream: "photos" };
		case "claude_code":
			await mkdir(join(home, "skills"));
			return { env: { CLAUDE_CODE_HOME: home }, stream: "skills" };
		case "codex":
			await mkdir(join(home, "rules"));
			return { env: { CODEX_HOME: home }, stream: "rules" };
		case "google_takeout":
			return { env: { GOOGLE_TAKEOUT_DIR: home }, stream: "search_history" };
		case "imessage": {
			const database = join(home, "chat.db");
			buildChatDbFixture(database, { messages: [] });
			return { env: { IMESSAGE_DB_PATH: database }, stream: "participants" };
		}
		default:
			throw new Error(`no readable corpus for ${String(connector)}`);
	}
}

const CONNECTORS: readonly ConnectorKey[] = [
	"apple_photos",
	"claude_code",
	"codex",
	"google_takeout",
	"imessage",
];

// ─── A requested stream with no declared inventory ──────────────────────────

// No stream in a checked-in manifest lacks an inventory, so the stream without
// one is a name outside every manifest. The connector looks it up in the same
// inventory map it builds from the manifest, which is the path under test.
for (const connector of CONNECTORS) {
	test(`${connector} omits the whole coverage object when a requested stream has no declared inventory`, async () => {
		await withHome(async (home) => {
			const { env, stream } = await readableCorpus(connector, home);
			const control = await drive({
				connector,
				env,
				home,
				streams: [{ name: stream }],
			});
			assert.equal(control.status, "succeeded");
			assert.deepEqual(
				control.coverage?.streams.map((entry) => entry.stream),
				[stream],
				"control: the declared stream alone must produce a verdict, or omission proves nothing",
			);
			for (const streams of [
				[UNDECLARED_STREAM],
				[stream, UNDECLARED_STREAM],
			]) {
				const run = await drive({
					connector,
					env,
					home,
					streams: streams.map((name) => ({ name })),
				});
				assert.equal(run.status, "succeeded", streams.join(","));
				assert.equal(
					run.coverage,
					undefined,
					`a verdict must not cover ${streams.join(",")}: one requested stream has no inventory`,
				);
			}
		});
	});
}

// Each connector builds its inventory with
// Object.fromEntries(manifest.streams.map(...)), so a manifest stream that
// omits the optional coverage_stores becomes an entry whose value is undefined.
test("a manifest stream without coverage_stores omits the verdict instead of failing the run", () => {
	const coverage = createRunCoverage(
		{ items: ["local_items"], uninstrumented: undefined },
		"unscoped",
	);
	coverage.report("items", "local_items", "collected");
	assert.equal(
		coverage.done(["items"])?.streams[0]?.stores[0]?.status,
		"collected",
	);
	assert.equal(coverage.done(["items", "uninstrumented"]), undefined);
});
