// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Runs the real Slack connector against a stand-in `slackdump` that answers
// `list channels` from a mixed public/private/direct-message fixture and, like
// the real tool, archives only the channels it is given. Each case reads both
// outputs of a run: what slackdump was asked to do (every argv it received) and
// what the connector emitted.

import assert from "node:assert/strict";
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	connectorEntrypoint,
	packageRoot as PACKAGE_ROOT,
} from "../../packages/polyfill-connectors/src/connector-paths.ts";
import type { EmittedMessage } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { runConnectorProtocolSubprocess } from "../../packages/polyfill-connectors/src/test-harness.ts";

const SLACK_ENTRYPOINT = connectorEntrypoint("slack");

const PUBLIC = ["C0PUBLIC1", "C0PUBLIC2"];
const PRIVATE = ["C0PRIVATE2", "G0PRIVATE1"];
const DIRECT = ["D0DIRECT01"];
const GROUP_DIRECT = ["G0GROUPDM1"];

const LISTING = [
	{ id: "C0PUBLIC1", name: "general", is_channel: true },
	{ id: "C0PUBLIC2", name: "random", is_channel: true, is_private: false },
	{ id: "G0PRIVATE1", name: "board", is_group: true, is_private: true },
	{ id: "C0PRIVATE2", name: "plans", is_channel: true, is_private: true },
	{ id: "D0DIRECT01", name: "dm", is_im: true, is_private: true },
	{
		id: "G0GROUPDM1",
		name: "mpdm",
		is_mpim: true,
		is_group: true,
		is_private: true,
	},
];

// A stand-in for slackdump: it records every argv it receives, prints the
// fixture for `list channels`, and writes an archive holding exactly the
// channels named on the `archive` command line (all of them when none are).
const FAKE_SLACKDUMP = `#!/usr/bin/env node
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const argv = process.argv.slice(2);
appendFileSync(process.env.FAKE_LOG, JSON.stringify(argv) + "\\n");
const listing = JSON.parse(readFileSync(process.env.FAKE_LISTING, "utf8"));
const [command, sub] = argv;
if (command === "workspace") {
	process.stdout.write(sub === "list" ? "=> default\\n" : "ok\\n");
	process.exit(0);
}
if (command === "list" && sub === "channels") {
	const mode = process.env.FAKE_LIST_MODE || "ok";
	if (mode === "fail") {
		process.stderr.write("simulated listing failure\\n");
		process.exit(1);
	}
	if (mode === "garbage") {
		process.stdout.write("this is not json\\n");
		process.exit(0);
	}
	process.stdout.write(JSON.stringify(listing));
	process.exit(0);
}
if (command === "archive") {
	const valued = new Set(["-api-config", "-o", "-time-from", "-time-to"]);
	let out = "";
	const ids = [];
	for (let i = 1; i < argv.length; i += 1) {
		const token = argv[i];
		if (valued.has(token)) {
			if (token === "-o") out = argv[i + 1];
			i += 1;
		} else if (!token.startsWith("-")) {
			ids.push(token);
		}
	}
	const wanted =
		ids.length > 0 && !process.env.FAKE_ARCHIVE_ALL
			? listing.filter((c) => ids.includes(c.id))
			: listing;
	mkdirSync(out, { recursive: true });
	const db = new DatabaseSync(join(out, "slackdump.sqlite"));
	db.exec(\`
		CREATE TABLE CHANNEL (ID TEXT NOT NULL, NAME TEXT, DATA TEXT, CHUNK_ID INTEGER NOT NULL);
		CREATE TABLE MESSAGE (
			CHANNEL_ID TEXT NOT NULL, TS TEXT NOT NULL, THREAD_TS TEXT, IS_PARENT INTEGER,
			TXT TEXT, NUM_FILES INTEGER, DATA BLOB, CHUNK_ID INTEGER NOT NULL
		);
	\`);
	wanted.forEach((channel, index) => {
		db.prepare("INSERT INTO CHANNEL (ID, NAME, DATA, CHUNK_ID) VALUES (?, ?, ?, ?)").run(
			channel.id,
			channel.name,
			JSON.stringify(channel),
			1,
		);
		const text = "hello " + channel.id;
		db.prepare(
			"INSERT INTO MESSAGE (CHANNEL_ID, TS, THREAD_TS, IS_PARENT, TXT, NUM_FILES, DATA, CHUNK_ID) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		).run(
			channel.id,
			"171403284" + index + ".123456",
			null,
			null,
			text,
			null,
			new TextEncoder().encode(JSON.stringify({ text, user: "U1" })),
			1,
		);
	});
	db.close();
	process.exit(0);
}
process.stderr.write("unexpected slackdump call: " + argv.join(" ") + "\\n");
process.exit(2);
`;

const SLACK_TOKEN =
	"xoxc-1-2-3-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

interface Outcome {
	/** The `considered` and `covered` counts a stream declared, if it did. */
	coverage: (stream: string) => { considered: number; covered: number } | null;
	/** The record ids the `channels` stream remembered in its STATE. */
	rememberedChannels: () => string[];
	archiveCalls: string[][];
	done: Extract<EmittedMessage, { type: "DONE" }> | undefined;
	everyArgument: string;
	listCalls: string[][];
	recordChannels: (stream: string) => string[];
	slackdumpCalls: string[][];
}

/** Command-line words after `archive` that are not flags or flag values. */
function positionalChannels(argv: readonly string[]): string[] {
	const valued = new Set(["-api-config", "-o", "-time-from", "-time-to"]);
	const found: string[] = [];
	for (let index = 1; index < argv.length; index += 1) {
		const token = argv[index] ?? "";
		if (valued.has(token)) index += 1;
		else if (!token.startsWith("-")) found.push(token);
	}
	return found;
}

async function runWithFakeSlackdump(options: {
	allowlist?: string;
	archiveEverything?: boolean;
	/** The channels a grant names, as the `messages` stream's `resources`. */
	grantChannels?: readonly string[];
	listMode?: "fail" | "garbage" | "ok";
	listing?: unknown;
	skipSlackdump?: boolean;
	types?: string;
}): Promise<Outcome> {
	const root = await mkdtemp(join(tmpdir(), "pdpp-slack-types-"));
	try {
		const bin = join(root, "fake-slackdump.mjs");
		const log = join(root, "calls.jsonl");
		const listingPath = join(root, "listing.json");
		const artifactRoot = join(root, "artifacts");
		await mkdir(artifactRoot, { recursive: true });
		await writeFile(bin, FAKE_SLACKDUMP, "utf8");
		await chmod(bin, 0o755);
		await writeFile(
			listingPath,
			JSON.stringify(options.listing ?? LISTING),
			"utf8",
		);
		const result = await runConnectorProtocolSubprocess({
			allowFailedDone: true,
			cwd: PACKAGE_ROOT,
			entrypoint: SLACK_ENTRYPOINT,
			env: {
				FAKE_LIST_MODE: options.listMode ?? "ok",
				FAKE_LISTING: listingPath,
				FAKE_LOG: log,
				PDPP_CONNECTOR_ARTIFACT_ROOT: artifactRoot,
				SLACKDUMP_BIN: bin,
				SLACK_COOKIE: "xoxd-fake",
				SLACK_TOKEN,
				SLACK_WORKSPACE: "types-ws",
				...(options.archiveEverything ? { FAKE_ARCHIVE_ALL: "1" } : {}),
				...(options.skipSlackdump ? { PDPP_SLACK_SKIP_SLACKDUMP: "1" } : {}),
				...(options.types === undefined
					? {}
					: { SLACK_CHANNEL_TYPES: options.types }),
				...(options.allowlist === undefined
					? {}
					: { SLACK_CHANNEL_ALLOWLIST: options.allowlist }),
			},
			start: {
				type: "START",
				scope: {
					streams: [
						{
							name: "messages",
							...(options.grantChannels === undefined
								? {}
								: { resources: [...options.grantChannels] }),
						},
						{ name: "channels" },
					],
				},
			},
		});
		const calls: string[][] = await readFile(log, "utf8")
			.then((text) =>
				text
					.split("\n")
					.filter((line) => line.length > 0)
					.map((line) => JSON.parse(line) as string[]),
			)
			.catch(() => []);
		const records = result.messages.filter(
			(message): message is Extract<EmittedMessage, { type: "RECORD" }> =>
				message.type === "RECORD",
		);
		return {
			archiveCalls: calls.filter((argv) => argv[0] === "archive"),
			done: result.messages.findLast(
				(message): message is Extract<EmittedMessage, { type: "DONE" }> =>
					message.type === "DONE",
			),
			everyArgument: calls.flat().join(" "),
			listCalls: calls.filter((argv) => argv[0] === "list"),
			coverage: (stream) => {
				const report = result.messages.find(
					(
						message,
					): message is Extract<EmittedMessage, { type: "DETAIL_COVERAGE" }> =>
						message.type === "DETAIL_COVERAGE" && message.stream === stream,
				);
				return report
					? {
							considered: Number(report.considered),
							covered: Number(report.covered),
						}
					: null;
			},
			rememberedChannels: () => {
				const state = result.messages.findLast(
					(message): message is Extract<EmittedMessage, { type: "STATE" }> =>
						message.type === "STATE" && message.stream === "channels",
				);
				const cursor = (state?.cursor ?? {}) as {
					fingerprints?: Record<string, string>;
				};
				return Object.keys(cursor.fingerprints ?? {}).sort();
			},
			recordChannels: (stream) =>
				records
					.filter((record) => record.stream === stream)
					.map((record) =>
						String(
							(record.data as Record<string, unknown>)[
								stream === "channels" ? "id" : "channel_id"
							],
						),
					)
					.sort(),
			slackdumpCalls: calls,
		};
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

function assertNothingOutsideWasTouched(
	outcome: Outcome,
	excluded: string[],
): void {
	for (const id of excluded) {
		assert.ok(
			!outcome.everyArgument.includes(id),
			`${id} must never reach slackdump`,
		);
		assert.ok(
			!outcome.recordChannels("messages").includes(id),
			`${id} must emit no message`,
		);
		assert.ok(
			!outcome.recordChannels("channels").includes(id),
			`${id} must emit no channel record`,
		);
	}
}

test("a public-only run lists first, archives only the public channels and emits only theirs", async () => {
	const outcome = await runWithFakeSlackdump({ types: "public" });

	assert.equal(outcome.done?.status, "succeeded");
	assert.equal(outcome.listCalls.length, 1, "one listing");
	assert.deepEqual(
		outcome.listCalls[0]?.slice(0, 2),
		["list", "channels"],
		"it asks slackdump to list channels",
	);
	assert.ok(outcome.listCalls[0]?.includes("-no-json"));
	assert.ok(outcome.listCalls[0]?.includes("JSON"));
	assert.equal(outcome.archiveCalls.length, 1, "one archive");
	assert.deepEqual(positionalChannels(outcome.archiveCalls[0] ?? []), PUBLIC);
	assert.deepEqual(outcome.recordChannels("messages"), PUBLIC);
	assert.deepEqual(outcome.recordChannels("channels"), PUBLIC);
	assertNothingOutsideWasTouched(outcome, [
		...PRIVATE,
		...DIRECT,
		...GROUP_DIRECT,
	]);
	const order = outcome.slackdumpCalls.map((argv) => argv[0]);
	assert.ok(
		order.indexOf("list") < order.indexOf("archive"),
		"the listing comes before anything is downloaded",
	);
});

test("records of an excluded type are dropped even when the archive holds them", async () => {
	// A stale or misbehaving archive that returns every channel it was not
	// asked for must still not leak one into the output.
	const outcome = await runWithFakeSlackdump({
		archiveEverything: true,
		types: "public",
	});

	assert.equal(outcome.done?.status, "succeeded");
	assert.deepEqual(positionalChannels(outcome.archiveCalls[0] ?? []), PUBLIC);
	assert.deepEqual(outcome.recordChannels("messages"), PUBLIC);
	assert.deepEqual(outcome.recordChannels("channels"), PUBLIC);
	// The bookkeeping agrees with the output: the six channels the archive held
	// are not counted as covered, and the channels left out are not remembered
	// as emitted, so widening the choice later still emits them.
	assert.deepEqual(outcome.coverage("channels"), { considered: 2, covered: 2 });
	assert.deepEqual(outcome.coverage("messages"), { considered: 2, covered: 2 });
	assert.deepEqual(outcome.rememberedChannels(), PUBLIC);
});

test("an allowlist also bounds the records, even from an archive that returns more", async () => {
	// C0PUBLIC2 is of the chosen type but not on the allowlist: the archive is
	// asked only for C0PUBLIC1, and a record of C0PUBLIC2 that comes back anyway
	// must not be emitted.
	const outcome = await runWithFakeSlackdump({
		allowlist: "C0PUBLIC1",
		archiveEverything: true,
		types: "public",
	});

	assert.equal(outcome.done?.status, "succeeded");
	assert.deepEqual(positionalChannels(outcome.archiveCalls[0] ?? []), [
		"C0PUBLIC1",
	]);
	assert.deepEqual(outcome.recordChannels("messages"), ["C0PUBLIC1"]);
	assert.deepEqual(outcome.recordChannels("channels"), ["C0PUBLIC1"]);
});

test("private and direct messages can be chosen without the public channels", async () => {
	const outcome = await runWithFakeSlackdump({ types: "private,im" });

	assert.equal(outcome.done?.status, "succeeded");
	const expected = [...PRIVATE, ...DIRECT].sort();
	assert.deepEqual(positionalChannels(outcome.archiveCalls[0] ?? []), expected);
	assert.deepEqual(outcome.recordChannels("messages"), expected);
	assertNothingOutsideWasTouched(outcome, [...PUBLIC, ...GROUP_DIRECT]);
});

test("an allowlist narrows the chosen types and never adds a channel of another type", async () => {
	const outcome = await runWithFakeSlackdump({
		allowlist: "C0PUBLIC1,D0DIRECT01",
		types: "public",
	});

	assert.equal(outcome.done?.status, "succeeded");
	assert.deepEqual(positionalChannels(outcome.archiveCalls[0] ?? []), [
		"C0PUBLIC1",
	]);
	assert.deepEqual(outcome.recordChannels("messages"), ["C0PUBLIC1"]);
	assertNothingOutsideWasTouched(outcome, [
		"C0PUBLIC2",
		...PRIVATE,
		...DIRECT,
		...GROUP_DIRECT,
	]);
});

test("a grant's channels narrow the chosen types the same way", async () => {
	const outcome = await runWithFakeSlackdump({
		archiveEverything: true,
		grantChannels: ["C0PUBLIC1", "D0DIRECT01"],
		types: "public",
	});

	assert.equal(outcome.done?.status, "succeeded");
	assert.deepEqual(positionalChannels(outcome.archiveCalls[0] ?? []), [
		"C0PUBLIC1",
	]);
	assert.deepEqual(outcome.recordChannels("messages"), ["C0PUBLIC1"]);
	assert.deepEqual(outcome.recordChannels("channels"), ["C0PUBLIC1"]);
	assertNothingOutsideWasTouched(outcome, [
		"C0PUBLIC2",
		...PRIVATE,
		...DIRECT,
		...GROUP_DIRECT,
	]);
});

test("a grant and an allowlist that overlap are intersected, never united", async () => {
	// Each names one channel the other does not. A union would archive
	// C0PUBLIC1, C0PUBLIC2 and G0PRIVATE1 (less the excluded type); only the
	// channel both name may be read.
	const outcome = await runWithFakeSlackdump({
		allowlist: "C0PUBLIC2,G0PRIVATE1",
		archiveEverything: true,
		grantChannels: ["C0PUBLIC1", "C0PUBLIC2"],
		types: "public",
	});

	assert.equal(outcome.done?.status, "succeeded");
	assert.deepEqual(positionalChannels(outcome.archiveCalls[0] ?? []), [
		"C0PUBLIC2",
	]);
	assert.deepEqual(outcome.recordChannels("messages"), ["C0PUBLIC2"]);
	assert.deepEqual(outcome.recordChannels("channels"), ["C0PUBLIC2"]);
	assertNothingOutsideWasTouched(outcome, [
		"C0PUBLIC1",
		...PRIVATE,
		...DIRECT,
		...GROUP_DIRECT,
	]);
});

test("a grant and an allowlist with no channel in common stop the run instead of archiving either", async () => {
	const outcome = await runWithFakeSlackdump({
		allowlist: "C0PUBLIC2",
		grantChannels: ["C0PUBLIC1"],
		types: "public",
	});

	assert.equal(outcome.done?.status, "failed");
	assert.match(outcome.done?.error?.message ?? "", /every list of channels/);
	assert.equal(
		outcome.archiveCalls.length,
		0,
		"an empty intersection must not fall back to either list or to every channel",
	);
	assert.deepEqual(outcome.recordChannels("messages"), []);
});

test("a grant that names no channel is no restriction, not an empty one", async () => {
	const outcome = await runWithFakeSlackdump({
		grantChannels: [],
		types: "public",
	});

	assert.equal(outcome.done?.status, "succeeded");
	assert.deepEqual(positionalChannels(outcome.archiveCalls[0] ?? []), PUBLIC);
	assert.deepEqual(outcome.recordChannels("messages"), PUBLIC);
});

test("the default (every type) lists nothing and archives as it always did", async () => {
	const outcome = await runWithFakeSlackdump({});

	assert.equal(outcome.done?.status, "succeeded");
	assert.equal(outcome.listCalls.length, 0, "no listing is needed");
	assert.deepEqual(positionalChannels(outcome.archiveCalls[0] ?? []), []);
	assert.deepEqual(
		outcome.recordChannels("messages"),
		[...PUBLIC, ...PRIVATE, ...DIRECT, ...GROUP_DIRECT].sort(),
	);
});

test("naming every type is the same as the default", async () => {
	const outcome = await runWithFakeSlackdump({
		types: "public,private,im,mpim",
	});

	assert.equal(outcome.done?.status, "succeeded");
	assert.equal(outcome.listCalls.length, 0);
	assert.deepEqual(positionalChannels(outcome.archiveCalls[0] ?? []), []);
});

test("a listing that fails stops the run before anything is downloaded", async () => {
	const outcome = await runWithFakeSlackdump({
		listMode: "fail",
		types: "public",
	});

	assert.equal(outcome.done?.status, "failed");
	assert.equal(outcome.listCalls.length, 1);
	assert.equal(
		outcome.archiveCalls.length,
		0,
		"it must not fall back to archiving everything",
	);
	assert.deepEqual(outcome.recordChannels("messages"), []);
});

test("a listing that is not JSON stops the run before anything is downloaded", async () => {
	const outcome = await runWithFakeSlackdump({
		listMode: "garbage",
		types: "public",
	});

	assert.equal(outcome.done?.status, "failed");
	assert.match(outcome.done?.error?.message ?? "", /could not be read/i);
	assert.equal(outcome.archiveCalls.length, 0);
	assert.deepEqual(outcome.recordChannels("messages"), []);
});

test("a channel that is not clearly one type stops the run before anything is downloaded", async () => {
	const outcome = await runWithFakeSlackdump({
		listing: [...LISTING, { id: "C0MYSTERY", name: "mystery" }],
		types: "public",
	});

	assert.equal(outcome.done?.status, "failed");
	assert.match(outcome.done?.error?.message ?? "", /not clearly/i);
	assert.equal(outcome.archiveCalls.length, 0);
	assert.deepEqual(outcome.recordChannels("messages"), []);
});

test("a selection that matches no channel stops the run instead of archiving them all", async () => {
	const outcome = await runWithFakeSlackdump({
		listing: LISTING.filter((channel) => channel.id.startsWith("D")),
		types: "public",
	});

	assert.equal(outcome.done?.status, "failed");
	assert.match(outcome.done?.error?.message ?? "", /No channel you can see/);
	assert.equal(outcome.archiveCalls.length, 0);
});

test("skipping the download cannot be combined with a narrowed selection", async () => {
	const outcome = await runWithFakeSlackdump({
		skipSlackdump: true,
		types: "public",
	});

	assert.equal(outcome.done?.status, "failed");
	assert.match(
		outcome.done?.error?.message ?? "",
		/Skipping the Slack download/,
	);
	assert.equal(outcome.slackdumpCalls.length, 0, "slackdump is not run at all");
});

test("an unknown channel type stops the run before slackdump is run", async () => {
	const outcome = await runWithFakeSlackdump({ types: "public,bogus" });

	assert.equal(outcome.done?.status, "failed");
	assert.match(
		outcome.done?.error?.message ?? "",
		/unknown channel type \(bogus\)/,
	);
	assert.equal(outcome.slackdumpCalls.length, 0);
});
