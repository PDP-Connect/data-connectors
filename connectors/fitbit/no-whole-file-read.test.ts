// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Proves the collection path streams a member rather than parsing it whole,
 * and that the daily merge holds a bounded number of minutes. The connector
 * runs as a real subprocess, so this observes production code and the
 * child's resident memory.
 *
 * Each requested window lies after every reading, so each exercise and each
 * minute is extracted, parsed, placed and validated but none is emitted: the
 * cost measured is reading, not serialising records.
 */

import assert from "node:assert/strict";
import {
	closeSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	connectorDir,
	connectorEntrypoint,
	packageRoot as PACKAGE_ROOT,
} from "../../packages/polyfill-connectors/src/connector-paths.ts";
import {
	type ConnectorSubprocessResult,
	runConnectorProtocolSubprocess,
} from "../../packages/polyfill-connectors/src/test-harness.ts";
import {
	canonicalRows,
	exercise,
	fitbitJson,
	jsonMember,
	legacyMember,
	minute,
	partName,
	profileCsv,
	profileMember,
} from "./__fixtures__/synthetic-export.ts";
import { writeZip, type ZipMember } from "./__fixtures__/zip.ts";

const LARGE_FIXTURE_BASE_DIR =
	process.env.PDPP_TEST_LARGE_FIXTURE_DIR ?? join(homedir(), ".tmp");
const MIB = 1024 * 1024;
const TARGET_BYTES = 128 * MIB;
const RSS_CEILING_BYTES = 300 * MIB;
const MINUTE_MS = 60_000;
/** A 31-day batch of every minute, as one steps member holds at most. */
const MINUTES_PER_MEMBER = 31 * 24 * 60;
/** Five years of steps members. */
const STEPS_MEMBERS = 60;
const FIRST_MINUTE_MS = Date.UTC(2021, 0, 1);
const PAST_EVERY_READING = "2100-01-01T00:00:00Z";

/**
 * What reads a file whole or holds every member at once: `readFileSync`,
 * `await readFile(`, a `readFile` import from node:fs/promises, `.all(`
 * (which `Promise.all(` is), and a zip entry's `.data()`. A buffer sized to
 * a whole member has no one spelling to match, and the resident-memory tests
 * in this file do not reliably catch one either: a single buffer the size of
 * their 128 MiB member can stay under the ceiling. They do catch a member
 * parsed whole.
 */
const WHOLE_READ_RE =
	/\breadFileSync\b|\bawait\s+readFile\s*\(|import\s*\{[^}]*\breadFile\b[^}]*\}\s*from\s*["']node:fs\/promises["']|\.all\s*\(|\.data\(\)/;

function largeRoot(label: string): string {
	mkdirSync(LARGE_FIXTURE_BASE_DIR, { recursive: true });
	return mkdtempSync(join(LARGE_FIXTURE_BASE_DIR, `pdpp-fitbit-${label}-`));
}

/**
 * Streams one exercise page of at least TARGET_BYTES to `path`: a root array
 * of logs with distinct ids, pretty-printed as the legacy files are. Returns
 * how many it wrote.
 */
function writeLargeExercisePage(path: string): number {
	const fd = openSync(path, "w");
	try {
		let written = writeSync(fd, "[");
		let count = 0;
		let block: Buffer[] = [];
		let blockBytes = 0;
		while (written + blockBytes < TARGET_BYTES) {
			const text = Buffer.concat([
				Buffer.from(count === 0 ? "" : ","),
				fitbitJson(exercise({ logId: 21_000_000_000 + count })),
			]);
			block.push(text);
			blockBytes += text.length;
			count += 1;
			if (blockBytes >= MIB) {
				written += writeSync(fd, Buffer.concat(block));
				block = [];
				blockBytes = 0;
			}
		}
		writeSync(fd, Buffer.concat([...block, Buffer.from("]")]));
		return count;
	} finally {
		closeSync(fd);
	}
}

/** `ms` as the legacy files write a UTC minute, `MM/DD/YY HH:MM:SS`. */
function legacyInstant(ms: number): string {
	const date = new Date(ms);
	const two = (n: number): string => String(n).padStart(2, "0");
	return `${two(date.getUTCMonth() + 1)}/${two(date.getUTCDate())}/${two(date.getUTCFullYear() % 100)} ${two(date.getUTCHours())}:${two(date.getUTCMinutes())}:00`;
}

/** Steps member `index`: every minute of its 31 days, each a step, none repeated in any other member. */
function writeStepsMember(path: string, index: number): string {
	const start = FIRST_MINUTE_MS + index * MINUTES_PER_MEMBER * MINUTE_MS;
	const rows = Array.from({ length: MINUTES_PER_MEMBER }, (_, offset) =>
		minute(legacyInstant(start + offset * MINUTE_MS), "1"),
	);
	writeFileSync(path, fitbitJson(rows));
	return new Date(start).toISOString().slice(0, 10);
}

function run(
	importDir: string,
	stream: string,
): Promise<ConnectorSubprocessResult> {
	return runConnectorProtocolSubprocess({
		cwd: PACKAGE_ROOT,
		entrypoint: connectorEntrypoint("fitbit"),
		env: {
			PDPP_OWNER_TOKEN: "",
			PDPP_RS_URL: "",
			RS_URL: "",
			FITBIT_EXPORT_DIR: importDir,
			TZ: "UTC",
		},
		peakRssPollIntervalMs: 25,
		start: {
			type: "START",
			scope: {
				streams: [{ name: stream, time_range: { since: PAST_EVERY_READING } }],
			},
		},
		timeoutMs: 180_000,
	});
}

function assertBoundedRss(
	result: ConnectorSubprocessResult,
	what: string,
	diagnostic: (message: string) => void,
): void {
	assert.ok(result.peakRssBytes !== null, "peak RSS must be sampled");
	const mib = Math.round(result.peakRssBytes / MIB);
	diagnostic(`peak RSS ${String(mib)} MiB over ${what}`);
	assert.ok(
		result.peakRssBytes < RSS_CEILING_BYTES,
		`expected streaming below ${String(RSS_CEILING_BYTES / MIB)} MiB RSS, got ${String(mib)} MiB`,
	);
}

/** The reason on the run's one `phase=coverage` line. */
function coverageReason(result: ConnectorSubprocessResult): string | undefined {
	const messages = result.messages as unknown as Record<string, unknown>[];
	const lines = messages
		.map((m) => String(m.message))
		.filter((text) => text.startsWith("Fitbit phase=coverage "));
	assert.equal(lines.length, 1, "one coverage line");
	return / reason=([a-z_]+) /.exec(lines[0] ?? "")?.[1];
}

/** The counters of the PROGRESS line starting `head`. */
function counters(
	result: ConnectorSubprocessResult,
	head: string,
): Readonly<Record<string, number>> {
	const messages = result.messages as unknown as Record<string, unknown>[];
	const line = messages
		.map((m) => String(m.message))
		.find((text) => text.startsWith(head));
	assert.ok(line !== undefined, `a line starting ${head}`);
	const found: Record<string, number> = {};
	for (const pair of line.slice(head.length).trim().split(" ")) {
		const [name = "", value = ""] = pair.split("=");
		found[name] = Number(value);
	}
	return found;
}

test("a 128 MiB exercise page is read with bounded memory", async (t) => {
	const root = largeRoot("large-exercise");
	const importDir = join(root, "import");
	mkdirSync(importDir);
	try {
		const pagePath = join(root, "page.json");
		const logs = writeLargeExercisePage(pagePath);
		writeZip(join(importDir, partName(1)), [
			{
				name: legacyMember("exercise-0.json"),
				data: { file: pagePath },
				method: "store",
			},
		]);
		rmSync(pagePath);

		const result = await run(importDir, "activities");
		assertBoundedRss(result, `${String(logs)} exercise logs`, (m) =>
			t.diagnostic(m),
		);
		// Every log was parsed and placed, and nothing was cut short.
		assert.equal(coverageReason(result), "nothing_in_range");
		const done = counters(result, "Fitbit phase=done stream=activities ");
		assert.equal(done.outside_window, logs);
		assert.equal(done.unreadable_total, 0);
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

test("five years of steps minutes are placed with a bounded minute window", async (t) => {
	const root = largeRoot("large-steps");
	const importDir = join(root, "import");
	mkdirSync(importDir);
	try {
		const members: ZipMember[] = [];
		for (let index = 0; index < STEPS_MEMBERS; index += 1) {
			const path = join(root, `steps-${String(index)}.json`);
			const nameDate = writeStepsMember(path, index);
			members.push({
				name: legacyMember(`steps-${nameDate}.json`),
				data: { file: path },
				method: "store",
			});
		}
		members.push(
			{ name: profileMember(), data: profileCsv() },
			jsonMember(
				"lightly_active_minutes-2026-04-03.json",
				canonicalRows().lightly,
			),
		);
		writeZip(join(importDir, partName(1)), members);
		for (const name of readdirSync(root)) {
			if (name.startsWith("steps-")) {
				rmSync(join(root, name));
			}
		}

		const result = await run(importDir, "daily_summaries");
		const minutes = STEPS_MEMBERS * MINUTES_PER_MEMBER;
		assertBoundedRss(result, `${String(minutes)} steps minutes`, (m) =>
			t.diagnostic(m),
		);
		assert.equal(coverageReason(result), "nothing_in_range");
		const steps = counters(
			result,
			"Fitbit phase=family stream=daily_summaries family=steps ",
		);
		// Every minute read and admitted: none repeated, none dropped.
		assert.equal(steps.files, STEPS_MEMBERS);
		assert.equal(steps.readable, minutes);
		assert.equal(steps.duplicates, 0);
		const done = counters(result, "Fitbit phase=done stream=daily_summaries ");
		assert.equal(done.duplicates, 0);
		assert.equal(done.unreadable_total, 0);
		assert.ok((done.outside_window ?? 0) > 1800, "every day was placed");
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

test("static guard: no source file reads a member or the export whole", () => {
	const dir = connectorDir("fitbit");
	const sources = readdirSync(dir).filter(
		(name) => name.endsWith(".ts") && !name.endsWith(".test.ts"),
	);
	for (const file of [
		"index.ts",
		"collect.ts",
		"archive.ts",
		"read.ts",
		"parsers.ts",
		"days.ts",
	]) {
		assert.ok(sources.includes(file), `the guard must read ${file}`);
	}
	for (const file of sources) {
		assert.doesNotMatch(
			readFileSync(join(dir, file), "utf8"),
			WHOLE_READ_RE,
			`${file} must stream the export rather than read it whole`,
		);
	}
});

test("static guard: the pattern catches each whole-file read it names", () => {
	for (const line of [
		'const text = readFileSync(path, "utf8");',
		"const text = await readFile(path);",
		'import { readFile } from "node:fs/promises";',
		"await Promise.all(members.map(read));",
		"const bytes = await entry.data();",
	]) {
		assert.match(line, WHOLE_READ_RE, line);
	}
});
