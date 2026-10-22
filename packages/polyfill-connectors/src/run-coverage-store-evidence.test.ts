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
import { createHash } from "node:crypto";
import {
	chmod,
	mkdir,
	mkdtemp,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildChatDbFixture } from "../../../connectors/imessage/fixtures.ts";
import { connectorEntrypoint, packageRoot } from "./connector-paths.ts";
import type { RunCoverageStatus, RunCoverageVerdict } from "./run-coverage.ts";
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
	/** The failure message of a failed run. */
	error: string | undefined;
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
		| {
				coverage?: RunCoverageVerdict;
				error?: { message?: string };
				status?: string;
		  }
		| undefined;
	return {
		coverage: done?.coverage,
		error: done?.error?.message,
		status: done?.status,
	};
}

function storeStatus(
	run: ConnectorRun,
	stream: string,
	store: string,
): RunCoverageStatus | undefined {
	return run.coverage?.streams
		.find((entry) => entry.stream === stream)
		?.stores.find((entry) => entry.store === store)?.status;
}

/**
 * How a run described one store: its status, or that the run failed and sent
 * no verdict. A failed run claims nothing about any store, so it can never
 * claim an empty one.
 */
type StoreOutcome = RunCoverageStatus | "run_failed" | "not_in_verdict";

function outcomeFor(
	run: ConnectorRun,
	stream: string,
	store: string,
): StoreOutcome {
	if (run.status === "failed") {
		assert.equal(run.coverage, undefined, "a failed run must carry no verdict");
		return "run_failed";
	}
	return storeStatus(run, stream, store) ?? "not_in_verdict";
}

/**
 * A failed run is only evidence that a store was not claimed when it failed
 * for the stated reason, so a crash for an unrelated cause cannot pass.
 */
function assertFailedBecause(run: ConnectorRun, reason: RegExp): void {
	assert.match(run.error ?? "", reason, "the run failed for another reason");
}

/**
 * A store the connector could not reach is unavailable, not an empty
 * collection. `failure` names the reason a failed run is accepted for.
 */
function assertUnavailable(
	run: ConnectorRun,
	stream: string,
	store: string,
	failure?: RegExp,
): void {
	const outcome = outcomeFor(run, stream, store);
	assert.ok(
		outcome === "unavailable" || outcome === "run_failed",
		`${stream}/${store}: an absent store must be unavailable or fail the run, got ${outcome}`,
	);
	if (outcome === "run_failed" && failure) assertFailedBecause(run, failure);
}

/**
 * A store the connector could not finish reading is partial or failed, never
 * collected. `failure` names the reason a failed run is accepted for.
 */
function assertIncomplete(
	run: ConnectorRun,
	stream: string,
	store: string,
	failure?: RegExp,
): void {
	const outcome = outcomeFor(run, stream, store);
	assert.ok(
		outcome === "failed" || outcome === "partial" || outcome === "run_failed",
		`${stream}/${store}: a store that could not be read completely must be failed or partial, got ${outcome}`,
	);
	if (outcome === "run_failed" && failure) assertFailedBecause(run, failure);
}

// chmod bits do not restrain root, so an unreadable-file premise cannot hold.
const RUNNING_AS_ROOT =
	typeof process.getuid === "function" && process.getuid() === 0;

/**
 * A loopback stand-in for the reference blob endpoint that accepts every
 * upload. Without it a media store is partial whatever happens to a file,
 * because no photo can reach the hydrated state.
 */
async function withBlobEndpoint(
	fn: (env: Record<string, string>) => Promise<void>,
): Promise<void> {
	const server = createServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => {
			const body = Buffer.concat(chunks);
			const sha256 = createHash("sha256").update(body).digest("hex");
			const mimeType =
				new URL(request.url ?? "", "http://127.0.0.1").searchParams.get(
					"mime_type",
				) ?? "application/octet-stream";
			response.writeHead(200, { "Content-Type": "application/json" });
			response.end(
				JSON.stringify({
					blob_id: `blob_sha256_${sha256}`,
					mime_type: mimeType,
					object: "blob",
					sha256,
					size_bytes: body.byteLength,
				}),
			);
		});
	});
	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", () => resolve());
	});
	try {
		await fn({
			PDPP_OWNER_TOKEN: "store-evidence-test-token",
			PDPP_RS_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
		});
	} finally {
		await new Promise<void>((resolve, reject) => {
			server.close((error) => (error ? reject(error) : resolve()));
		});
	}
}

const CLAUDE_SESSION = "11111111-1111-4111-8111-111111111111";

/** One well-formed Claude Code transcript under `projects/<project>/`. */
async function writeClaudeTranscript(
	home: string,
	project: string,
	sessionId = CLAUDE_SESSION,
): Promise<string> {
	const directory = join(home, "projects", project);
	await mkdir(directory, { recursive: true });
	const path = join(directory, `${sessionId}.jsonl`);
	const line = JSON.stringify({
		cwd: "/work/project",
		message: { content: [{ text: "hello", type: "text" }], role: "user" },
		sessionId,
		timestamp: "2026-07-01T00:00:00.000Z",
		type: "user",
		uuid: `aaaaaaaa-${sessionId.slice(9)}`,
	});
	await writeFile(path, `${line}\n`);
	return path;
}

const CODEX_SESSION = "019d922d-c38b-7e11-ae99-9187af386148";
// A rollout written moments ago counts as still being written and is deferred.
const CODEX_QUIET_OFF = { PDPP_CODEX_ACTIVE_ROLLOUT_QUIET_MS: "0" } as const;

function codexRollout(sessionId: string): string {
	const lines = [
		{
			payload: {
				cwd: "/repo",
				id: sessionId,
				originator: "codex-tui",
				timestamp: "2026-04-15T17:33:32.000Z",
			},
			timestamp: "2026-04-15T17:33:32.000Z",
			type: "session_meta",
		},
		{
			payload: { content: [{ text: "hello" }], role: "user", type: "message" },
			timestamp: "2026-04-15T17:34:00.000Z",
			type: "response_item",
		},
	];
	return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
}

/** The rollout path for one day, with its parent directories created. */
async function codexRolloutPath(
	sessionsRoot: string,
	day: readonly [string, string, string],
	sessionId = CODEX_SESSION,
): Promise<string> {
	const directory = join(sessionsRoot, ...day);
	await mkdir(directory, { recursive: true });
	return join(
		directory,
		`rollout-${day.join("-")}T12-00-00-${sessionId}.jsonl`,
	);
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

// ─── An absent store is not an empty store ──────────────────────────────────

test("apple_photos reports a missing export directory as unavailable", async () => {
	await withHome(async (home) => {
		const run = await drive({
			connector: "apple_photos",
			env: { APPLE_PHOTOS_EXPORT_DIR: join(home, "absent") },
			home,
			streams: [{ name: "photos" }],
		});
		assertUnavailable(run, "photos", "export_dir");
	});
});

test("google_takeout reports a missing export as unavailable for every stream", async () => {
	await withHome(async (home) => {
		const streams = [
			"location_history",
			"youtube_watch_history",
			"search_history",
			"photos",
		];
		const run = await drive({
			connector: "google_takeout",
			env: { GOOGLE_TAKEOUT_DIR: join(home, "absent") },
			home,
			streams: streams.map((name) => ({ name })),
		});
		for (const stream of streams) assertUnavailable(run, stream, stream);
	});
});

test("imessage claims no store when chat.db is missing", async () => {
	await withHome(async (home) => {
		const run = await drive({
			connector: "imessage",
			env: { IMESSAGE_DB_PATH: join(home, "absent.db") },
			home,
			streams: [
				{ name: "messages" },
				{ name: "participants" },
				{ name: "attachments" },
			],
		});
		const missing = /imessage_db_not_found/;
		assertUnavailable(run, "messages", "chat_db", missing);
		assertUnavailable(run, "participants", "chat_db", missing);
		assertUnavailable(run, "attachments", "chat_db", missing);
		assertUnavailable(run, "attachments", "attachment_files", missing);
	});
});

test("imessage does not prove an empty store from a table the database lacks", async () => {
	await withHome(async (home) => {
		const database = join(home, "chat.db");
		buildChatDbFixture(database, {
			includeAttachmentTables: false,
			includeChatHandleJoin: false,
			messages: [],
		});
		const run = await drive({
			connector: "imessage",
			env: { IMESSAGE_DB_PATH: database },
			home,
			streams: [{ name: "participants" }, { name: "attachments" }],
		});
		assertIncomplete(run, "participants", "chat_db");
		assertIncomplete(run, "attachments", "chat_db");
		assertIncomplete(run, "attachments", "attachment_files");
	});
});

test("claude_code reports absent single-file and inventory stores as unavailable", async () => {
	await withHome(async (home) => {
		const stores: Record<string, string> = {
			backup_inventory: "backups",
			cache_inventory: "cache",
			config_inventory: "config",
			file_history: "file_history",
			usage: "stats_cache",
		};
		const run = await drive({
			connector: "claude_code",
			env: { CLAUDE_CODE_HOME: home },
			home,
			streams: Object.keys(stores).map((name) => ({ name })),
		});
		for (const [stream, store] of Object.entries(stores)) {
			assertUnavailable(run, stream, store);
		}
	});
});

test("claude_code does not claim a project, skills or commands store that is absent", async () => {
	await withHome(async (home) => {
		const groups: Record<string, string>[] = [
			{
				attachments: "derived_attachments",
				memory_notes: "derived_memory_notes",
				messages: "derived_messages",
				sessions: "projects",
			},
			{ skills: "skills" },
			{ slash_commands: "commands" },
		];
		for (const group of groups) {
			const run = await drive({
				connector: "claude_code",
				env: { CLAUDE_CODE_HOME: home },
				home,
				streams: Object.keys(group).map((name) => ({ name })),
			});
			for (const [stream, store] of Object.entries(group)) {
				assertUnavailable(run, stream, store, /missing or unreadable/);
			}
		}
	});
});

// The stores a Codex home can hold, by the stream that reports each one.
const CODEX_STORES: readonly (readonly [stream: string, store: string])[] = [
	["sessions", "sessions"],
	["sessions", "sessions_archive"],
	["sessions", "state_db"],
	["messages", "derived_messages"],
	["function_calls", "derived_function_calls"],
	["rules", "rules"],
	["prompts", "prompts"],
	["skills", "skills"],
	["history", "history"],
	["session_index", "session_index"],
	["shell_snapshots", "shell_snapshots"],
	["config_inventory", "config"],
	["cache_inventory", "cache"],
];

function codexStreams(): StreamRequest[] {
	return [...new Set(CODEX_STORES.map(([stream]) => stream))].map((name) => ({
		name,
	}));
}

test("codex reports every absent store as unavailable, derived message stores included", async () => {
	await withHome(async (home) => {
		const run = await drive({
			connector: "codex",
			env: { CODEX_HOME: home, ...CODEX_QUIET_OFF },
			home,
			streams: codexStreams(),
		});
		assert.equal(run.status, "succeeded");
		for (const [stream, store] of CODEX_STORES) {
			assertUnavailable(run, stream, store);
		}
	});
});

test("codex reports the override path it reads, not the default path beside it", async () => {
	await withHome(async (home) => {
		// Every default store exists, but each override points at a path that does not.
		for (const directory of [
			"prompts",
			"rules",
			"sessions",
			"sessions-archive",
			"skills",
		]) {
			await mkdir(join(home, directory));
		}
		await writeFile(join(home, "state_5.sqlite"), "not read: overridden");
		const absent = join(home, "absent");
		const run = await drive({
			connector: "codex",
			env: {
				CODEX_HOME: home,
				CODEX_PROMPTS_DIR: join(absent, "prompts"),
				CODEX_RULES_DIR: join(absent, "rules"),
				CODEX_SESSIONS_ARCHIVE_DIR: join(absent, "sessions-archive"),
				CODEX_SESSIONS_DIR: join(absent, "sessions"),
				CODEX_SKILLS_DIR: join(absent, "skills"),
				CODEX_STATE_DB: join(absent, "state_5.sqlite"),
				...CODEX_QUIET_OFF,
			},
			home,
			streams: ["sessions", "messages", "rules", "prompts", "skills"].map(
				(name) => ({ name }),
			),
		});
		assert.equal(run.status, "succeeded");
		for (const [stream, store] of CODEX_STORES) {
			if (run.coverage?.streams.some((entry) => entry.stream === stream)) {
				assertUnavailable(run, stream, store);
			}
		}
	});
});

test("codex reports an override path that holds data as collected, though the default path is absent", async () => {
	await withHome(async (home) => {
		const rules = join(home, "elsewhere", "rules");
		await mkdir(rules, { recursive: true });
		await writeFile(join(rules, "default.rules"), "allow x\n");
		const run = await drive({
			connector: "codex",
			env: { CODEX_HOME: home, CODEX_RULES_DIR: rules },
			home,
			streams: [{ name: "rules" }],
		});
		assert.equal(storeStatus(run, "rules", "rules"), "collected");
	});
});

// ─── A read failure is not an empty store ───────────────────────────────────

test("apple_photos downgrades a collected export when a photo cannot be read", {
	skip: RUNNING_AS_ROOT,
}, async () => {
	await withHome(async (home, lock) => {
		await writeFile(join(home, "readable.jpg"), "bytes");
		await withBlobEndpoint(async (upload) => {
			const env = { APPLE_PHOTOS_EXPORT_DIR: home, ...upload };
			const control = await drive({
				connector: "apple_photos",
				env,
				home,
				streams: [{ name: "photos" }],
			});
			assert.equal(
				storeStatus(control, "photos", "export_dir"),
				"collected",
				"control: a readable, uploaded photo must be collected, or the downgrade proves nothing",
			);
			await writeFile(join(home, "unreadable.jpg"), "bytes");
			await lock(join(home, "unreadable.jpg"));
			const run = await drive({
				connector: "apple_photos",
				env,
				home,
				streams: [{ name: "photos" }],
			});
			assertIncomplete(run, "photos", "export_dir");
		});
	});
});

test("apple_photos claims nothing when the export path is not a directory", async () => {
	await withHome(async (home) => {
		await writeFile(join(home, "export"), "a file, not a directory");
		const run = await drive({
			connector: "apple_photos",
			env: { APPLE_PHOTOS_EXPORT_DIR: join(home, "export") },
			home,
			streams: [{ name: "photos" }],
		});
		assertIncomplete(run, "photos", "export_dir", /ENOTDIR/);
	});
});

test("google_takeout reports a Photos path it cannot list as failed", async () => {
	await withHome(async (home) => {
		await writeFile(join(home, "Photos"), "a file, not a directory");
		const run = await drive({
			connector: "google_takeout",
			env: { GOOGLE_TAKEOUT_DIR: home },
			home,
			streams: [{ name: "photos" }],
		});
		assertIncomplete(run, "photos", "photos");
		assert.equal(storeStatus(run, "photos", "photos"), "failed");
	});
});

test("google_takeout reports a sidecar it cannot parse as failed", async () => {
	await withHome(async (home) => {
		await mkdir(join(home, "Photos"));
		await writeFile(join(home, "Photos", "image.jpg"), "bytes");
		await writeFile(join(home, "Photos", "image.jpg.json"), "{not json");
		const run = await drive({
			connector: "google_takeout",
			env: { GOOGLE_TAKEOUT_DIR: home },
			home,
			streams: [{ name: "photos" }],
		});
		assert.equal(storeStatus(run, "photos", "photos"), "failed");
	});
});

test("google_takeout claims nothing when an export file cannot be read", async () => {
	await withHome(async (home) => {
		await mkdir(join(home, "Location History (Timeline)", "Records.json"), {
			recursive: true,
		});
		const run = await drive({
			connector: "google_takeout",
			env: { GOOGLE_TAKEOUT_DIR: home },
			home,
			streams: [{ name: "location_history" }],
		});
		assertIncomplete(run, "location_history", "location_history", /EISDIR/);
	});
});

test("google_takeout downgrades a history it read when one entry cannot be classified", async () => {
	await withHome(async (home) => {
		const history = join(home, "My Activity", "Search");
		await mkdir(history, { recursive: true });
		const entries = [
			{
				header: "Search",
				time: "2026-07-01T00:00:00.000Z",
				title: "Searched for x",
			},
		];
		await writeFile(join(history, "MyActivity.json"), JSON.stringify(entries));
		const control = await drive({
			connector: "google_takeout",
			env: { GOOGLE_TAKEOUT_DIR: home },
			home,
			streams: [{ name: "search_history" }],
		});
		assert.equal(
			storeStatus(control, "search_history", "search_history"),
			"collected",
			"control: a history of well-formed entries must be collected",
		);
		await writeFile(
			join(history, "MyActivity.json"),
			JSON.stringify([...entries, { title: "no timestamp" }]),
		);
		const run = await drive({
			connector: "google_takeout",
			env: { GOOGLE_TAKEOUT_DIR: home },
			home,
			streams: [{ name: "search_history" }],
		});
		assertIncomplete(run, "search_history", "search_history");
	});
});

test("imessage downgrades the attachment store when a referenced file is missing", async () => {
	await withHome(async (home) => {
		const root = join(home, "Attachments");
		await mkdir(root);
		await writeFile(join(root, "present.jpg"), "bytes");
		const database = join(home, "chat.db");
		const attachment = (rowid: number, filename: string) => ({
			filename: join(root, filename),
			messageRowid: 1,
			mimeType: "image/jpeg",
			rowid,
		});
		const fixture = (attachments: ReturnType<typeof attachment>[]) =>
			buildChatDbFixture(database, {
				attachments,
				chatIds: [1],
				handles: [{ id: "+15551234567", rowid: 10 }],
				messages: [
					{
						chatId: 1,
						dateAppleSec: 700_000_000,
						guid: "MSG-1",
						handleRowid: 10,
						hasAttachments: true,
						isFromMe: false,
						rowid: 1,
						text: null,
					},
				],
			});
		await withBlobEndpoint(async (upload) => {
			const env = {
				IMESSAGE_ATTACHMENTS_ROOT: root,
				IMESSAGE_DB_PATH: database,
				...upload,
			};
			fixture([attachment(100, "present.jpg")]);
			const control = await drive({
				connector: "imessage",
				env,
				home,
				streams: [{ name: "attachments" }],
			});
			assert.equal(
				storeStatus(control, "attachments", "attachment_files"),
				"collected",
				"control: an uploaded attachment must be collected, or the downgrade proves nothing",
			);
			await rm(database);
			fixture([attachment(100, "present.jpg"), attachment(101, "gone.jpg")]);
			const run = await drive({
				connector: "imessage",
				env,
				home,
				streams: [{ name: "attachments" }],
			});
			assertIncomplete(run, "attachments", "attachment_files");
		});
	});
});

test("imessage claims nothing when chat.db cannot be queried", async () => {
	await withHome(async (home) => {
		const database = join(home, "chat.db");
		await writeFile(database, "this is not a SQLite database");
		const run = await drive({
			connector: "imessage",
			env: { IMESSAGE_DB_PATH: database },
			home,
			streams: [
				{ name: "messages" },
				{ name: "participants" },
				{ name: "attachments" },
			],
		});
		assertIncomplete(run, "messages", "chat_db", /imessage_db_query_failed/);
	});
});

test("claude_code downgrades a collected projects store when a transcript cannot be read", {
	skip: RUNNING_AS_ROOT,
}, async () => {
	await withHome(async (home, lock) => {
		await writeClaudeTranscript(home, "-work-readable");
		const streams = ["sessions", "messages", "attachments"].map((name) => ({
			name,
		}));
		const control = await drive({
			connector: "claude_code",
			env: { CLAUDE_CODE_HOME: home },
			home,
			streams,
		});
		assert.equal(
			storeStatus(control, "sessions", "projects"),
			"collected",
			"control: readable transcripts must be collected, or the downgrade proves nothing",
		);
		await lock(
			await writeClaudeTranscript(
				home,
				"-work-unreadable",
				"22222222-2222-4222-8222-222222222222",
			),
		);
		const run = await drive({
			connector: "claude_code",
			env: { CLAUDE_CODE_HOME: home },
			home,
			streams,
		});
		assertIncomplete(run, "sessions", "projects");
		assertIncomplete(run, "messages", "derived_messages");
		assertIncomplete(run, "attachments", "derived_attachments");
	});
});

test("claude_code downgrades the project stores when a project directory cannot be listed", {
	skip: RUNNING_AS_ROOT,
}, async () => {
	await withHome(async (home, lock) => {
		await writeClaudeTranscript(home, "-work-readable");
		await writeClaudeTranscript(
			home,
			"-work-locked",
			"22222222-2222-4222-8222-222222222222",
		);
		await lock(join(home, "projects", "-work-locked"));
		const run = await drive({
			connector: "claude_code",
			env: { CLAUDE_CODE_HOME: home },
			home,
			streams: ["sessions", "messages", "attachments", "memory_notes"].map(
				(name) => ({ name }),
			),
		});
		assertIncomplete(run, "sessions", "projects");
		assertIncomplete(run, "messages", "derived_messages");
		assertIncomplete(run, "attachments", "derived_attachments");
		assertIncomplete(run, "memory_notes", "derived_memory_notes");
	});
});

test("claude_code downgrades the project stores when the projects root is a link it will not follow", async () => {
	await withHome(async (home) => {
		const target = join(home, "elsewhere");
		await writeClaudeTranscript(target, "-work-linked");
		await symlink(join(target, "projects"), join(home, "projects"));
		const run = await drive({
			connector: "claude_code",
			env: { CLAUDE_CODE_HOME: home },
			home,
			streams: ["sessions", "messages", "attachments"].map((name) => ({
				name,
			})),
		});
		assertIncomplete(run, "sessions", "projects");
		assertIncomplete(run, "messages", "derived_messages");
		assertIncomplete(run, "attachments", "derived_attachments");
	});
});

test("claude_code claims nothing when a single-file store is malformed or is not what it should be", async () => {
	await withHome(async (home) => {
		await writeFile(join(home, "stats-cache.json"), "{invalid-json");
		const usage = await drive({
			connector: "claude_code",
			env: { CLAUDE_CODE_HOME: home },
			home,
			streams: [{ name: "usage" }],
		});
		assertIncomplete(usage, "usage", "stats_cache", /malformed JSON/);

		await writeFile(join(home, "file-history"), "a file, not a directory");
		const history = await drive({
			connector: "claude_code",
			env: { CLAUDE_CODE_HOME: home },
			home,
			streams: [{ name: "file_history" }],
		});
		assertIncomplete(history, "file_history", "file_history", /ENOTDIR/);
	});
});

test("codex reports the stores derived from a rollout it cannot read as failed", async () => {
	await withHome(async (home) => {
		const sessions = join(home, "sessions");
		const rollout = await codexRolloutPath(sessions, ["2026", "04", "15"]);
		const streams = ["sessions", "messages", "function_calls"].map((name) => ({
			name,
		}));
		const env = { CODEX_HOME: home, ...CODEX_QUIET_OFF };
		await writeFile(rollout, codexRollout(CODEX_SESSION));
		const control = await drive({ connector: "codex", env, home, streams });
		assert.equal(
			storeStatus(control, "messages", "derived_messages"),
			"collected",
			"control: a readable rollout must be collected, or the failure proves nothing",
		);

		// A directory where the rollout file belongs cannot be read as a file.
		await rm(rollout);
		await mkdir(rollout);
		const unreadable = await drive({ connector: "codex", env, home, streams });
		// A rollout whose second line is not JSON is read in part.
		await rm(rollout, { recursive: true });
		await writeFile(rollout, `${codexRollout(CODEX_SESSION)}{broken json}\n`);
		const malformed = await drive({ connector: "codex", env, home, streams });
		for (const run of [unreadable, malformed]) {
			assert.equal(storeStatus(run, "sessions", "sessions"), "failed");
			assert.equal(storeStatus(run, "messages", "derived_messages"), "failed");
			assert.equal(
				storeStatus(run, "function_calls", "derived_function_calls"),
				"failed",
			);
		}
	});
});

test("codex reports the stores derived from a link it will not follow as failed", async () => {
	await withHome(async (home) => {
		const target = join(home, "elsewhere");
		await writeFile(
			await codexRolloutPath(target, ["2026", "04", "15"]),
			codexRollout(CODEX_SESSION),
		);
		await symlink(target, join(home, "sessions"));
		const run = await drive({
			connector: "codex",
			env: { CODEX_HOME: home, ...CODEX_QUIET_OFF },
			home,
			streams: ["sessions", "messages", "function_calls"].map((name) => ({
				name,
			})),
		});
		assertIncomplete(run, "sessions", "sessions");
		assertIncomplete(run, "messages", "derived_messages");
		assertIncomplete(run, "function_calls", "derived_function_calls");
	});
});

test("codex reports a state database it cannot open as failed", async () => {
	await withHome(async (home) => {
		await mkdir(join(home, "sessions"));
		await writeFile(join(home, "state_5.sqlite"), "not a sqlite database");
		const run = await drive({
			connector: "codex",
			env: { CODEX_HOME: home, ...CODEX_QUIET_OFF },
			home,
			streams: [{ name: "sessions" }],
		});
		assert.equal(storeStatus(run, "sessions", "state_db"), "failed");
	});
});

test("codex claims nothing when a user-authored source cannot be read", async () => {
	await withHome(async (home) => {
		// A directory where a rules or prompts file belongs, or where a skill's
		// SKILL.md belongs, cannot be read as a file.
		await mkdir(join(home, "rules", "bad.rules"), { recursive: true });
		await mkdir(join(home, "prompts", "bad.md"), { recursive: true });
		await mkdir(join(home, "skills", "bad", "SKILL.md"), { recursive: true });
		for (const [stream, store] of [
			["rules", "rules"],
			["prompts", "prompts"],
			["skills", "skills"],
		] as const) {
			const run = await drive({
				connector: "codex",
				env: { CODEX_HOME: home },
				home,
				streams: [{ name: stream }],
			});
			assertIncomplete(run, stream, store, /could not be read/);
		}
	});
});
