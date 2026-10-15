import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
	nodeVersionSupported,
	parseChangedHeadLines,
	parseNameStatus,
	parseReporterOutput,
	replaceExactly,
	restoreFile,
	verifyOwnerFailure,
} from "./run.ts";
import { GROUPME_FAULTS } from "./faults.ts";

const focused = "connectors/groupme/incremental-frontier.test.ts";

function event(status: "passed" | "failed", id = "owner", error?: object) {
	return {
		kind: "test" as const,
		eventId: `${focused}#${id}`,
		identity: { file: focused, hierarchy: ["suite", GROUPME_FAULTS[0]!.ownerTest], line: 20, column: 1 },
		status,
		durationMs: 1,
		...(error ? { error } : {}),
	};
}

function reporter(events: object[], failed: number, exitCode: number) {
	return parseReporterOutput([
		...events.map((entry) => JSON.stringify(entry)),
		JSON.stringify({ kind: "complete", completionEvents: events.length, counts: { tests: events.length, passed: events.length - failed, failed, skipped: 0, todo: 0, cancelled: 0 } }),
	].join("\n"), exitCode, null, false);
}

test("accepts only a complete, consistent node:test leaf stream", () => {
	assert.equal(reporter([event("passed")], 0, 0).status, "passed");
	assert.equal(parseReporterOutput("", 0, null, false).status, "reporter_incomplete");
	assert.equal(parseReporterOutput("{broken", 1, null, false).status, "reporter_malformed");
	assert.equal(reporter([event("passed"), event("passed")], 0, 0).status, "reporter_malformed");
	assert.equal(reporter([event("failed")], 1, 0).status, "event_exit_disagreement");
	assert.equal(reporter([{ ...event("passed"), status: "unknown" }], 0, 0).status, "reporter_malformed");
	assert.equal(parseReporterOutput("", null, "SIGINT", false).status, "signal");
	assert.equal(parseReporterOutput("", 0, null, true).status, "output_truncated");
});

test("requires the sole expected owning assertion", () => {
	const fault = GROUPME_FAULTS[0]!;
	assert.equal(verifyOwnerFailure([event("failed", "owner", { name: "AssertionError", code: "ERR_ASSERTION", message: fault.ownerAssertion })], fault).ok, true);
	assert.equal(verifyOwnerFailure([], fault).reason, "missing_or_skipped_owner");
	assert.equal(verifyOwnerFailure([event("failed", "owner", { code: "ERR_ASSERTION", message: "different assertion" })], fault).ok, false);
	assert.equal(verifyOwnerFailure([
		event("failed", "owner", { code: "ERR_ASSERTION", message: fault.ownerAssertion }),
		{ ...event("failed", "other", { code: "ERR_ASSERTION", message: "another assertion" }), eventId: "other" },
	], fault).reason, "non_sole_assertion_failure");
});

test("rejects stale and duplicate mutation preimages", () => {
	assert.throws(() => replaceExactly(Buffer.from("changed"), "expected", "replacement"), /preimage count 0/);
	assert.throws(() => replaceExactly(Buffer.from("x x"), "x", "y"), /preimage count 2/);
	assert.throws(() => parseNameStatus("M\0file\0R100\0old\0"), /path list/);
});

test("parses rename and delete records and changed HEAD lines", () => {
	assert.deepEqual(parseNameStatus("R100\0old.ts\0new.ts\0D\0gone.ts\0"), [
		{ status: "R100", paths: ["old.ts", "new.ts"] },
		{ status: "D", paths: ["gone.ts"] },
	]);
	assert.throws(() => parseNameStatus("M\0file\0".slice(0, -1)), /malformed/);
	assert.deepEqual([...parseChangedHeadLines("diff --git a/a b/a\n+++ b/a\n@@ -3,0 +4,2 @@\n+x\n+y\n")], [4, 5]);
	assert.throws(() => parseChangedHeadLines("+++ b/a\n@@ malformed @@"), /malformed/);
});

test("restores only the snapshot file after interruption and detects restore failure", async () => {
	const root = await mkdtemp(path.join(os.homedir(), ".tmp", "groupme-mutation-selftest-"));
	try {
		const snapshot = path.join(root, "snapshot");
		const caller = path.join(root, "caller.ts");
		await mkdir(snapshot);
		const file = path.join(snapshot, "target.ts");
		const before = Buffer.from("baseline");
		const callerBytes = Buffer.from("caller-owned");
		await writeFile(file, before);
		await writeFile(caller, callerBytes);
		await writeFile(file, replaceExactly(before, "base", "mutated"));
		assert.equal(parseReporterOutput("", null, "SIGTERM", false).status, "signal");
		const expected = createHash("sha256").update(before).digest("hex");
		await assert.rejects(restoreFile(file, before, "wrong-hash"), /restore hash mismatch/);
		assert.equal(await restoreFile(file, before, expected), expected);
		assert.deepEqual(await readFile(caller), callerBytes);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("accepts the supported Node 24 range", () => {
	assert.equal(nodeVersionSupported("v24.15.0"), true);
	assert.equal(nodeVersionSupported("v24.21.0"), true);
	assert.equal(nodeVersionSupported("v25.0.0"), false);
	assert.equal(nodeVersionSupported("v24.14.9"), false);
});
