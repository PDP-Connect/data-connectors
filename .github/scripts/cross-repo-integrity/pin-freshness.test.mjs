// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse } from "yaml";

const workflowPath = new URL("../../workflows/cross-repo-integrity.yml", import.meta.url);
const workflow = readFileSync(workflowPath, "utf8");
const parsedWorkflow = parse(workflow);
const matrixRepos = parsedWorkflow.jobs["pin-freshness"].strategy.matrix.repo;
const dataConnectMatrix = matrixRepos.find(({ id }) => id === "data-connect");
const checkScript = new URL("./check-pin-freshness.mjs", import.meta.url);

function pathspecs(matrixEntry) {
	assert.equal(typeof matrixEntry.paths, "string");
	return matrixEntry.paths.split(/\r?\n/).map((path) => path.trim()).filter(Boolean);
}

function git(cwd, ...args) {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function makeFixture() {
	const root = mkdtempSync(join(tmpdir(), "cross-repo-pin-freshness-"));
	git(root, "init", "-b", "main");
	git(root, "config", "user.name", "fixture");
	git(root, "config", "user.email", "fixture@example.invalid");
	writeFileSync(join(root, "README.md"), "base\n");
	git(root, "add", "README.md");
	git(root, "commit", "-m", "base");
	const pinnedSha = git(root, "rev-parse", "HEAD");

	const changedPath = "packages/polyfill-connectors/connectors/codex/index.ts";
	mkdirSync(dirname(join(root, changedPath)), { recursive: true });
	writeFileSync(join(root, changedPath), "export const changed = true;\n");
	writeFileSync(join(root, "README.md"), "unrelated change\n");
	git(root, "add", ".");
	git(root, "commit", "-m", "change producer source");
	const currentHead = git(root, "rev-parse", "HEAD");

	return { root, pinnedSha, currentHead, changedPath };
}

function runComparator(fixture, { eventName, prTouches, pinnedSha = fixture.pinnedSha, currentHead = fixture.currentHead }) {
	const outputPath = join(fixture.root, `github-output-${eventName}-${prTouches}-${currentHead}`);
	writeFileSync(outputPath, "");
	const stdout = execFileSync(process.execPath, [checkScript.pathname], {
		cwd: fixture.root,
		encoding: "utf8",
		env: {
			...process.env,
			CURRENT_HEAD: currentHead,
			GITHUB_EVENT_NAME: eventName,
			GITHUB_OUTPUT: outputPath,
			PINNED_SHA: pinnedSha,
			PR_TOUCHES_PIN_BACKED_PATHS: prTouches ? "true" : "false",
			RELEVANT_PATHS: dataConnectMatrix.paths,
			REPO_ID: "data-connect",
			TRACK_REF: "main",
		},
	});
	const outputs = Object.fromEntries(
		readFileSync(outputPath, "utf8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => line.split("=", 2)),
	);
	return { outputs, stdout };
}

test("data-connect freshness tracks the vendored-source revision and compared connector inputs", () => {
	assert.equal(dataConnectMatrix.paths.includes("\n"), true);
	assert.deepEqual(pathspecs(dataConnectMatrix), [
		"packages/local-collector/scripts/generate-collector-definitions-snapshot.ts",
		"packages/local-collector/src/generated/collector-definitions.generated.ts",
		"packages/local-collector/tsconfig.build.json",
		"packages/polyfill-connectors/vendor-source.json",
		"packages/polyfill-connectors/connectors/claude_code",
		"packages/polyfill-connectors/connectors/codex",
		"packages/polyfill-connectors/connectors/google_takeout",
		"packages/polyfill-connectors/connectors/imessage",
		"packages/polyfill-connectors/connectors/apple_photos",
		"packages/polyfill-connectors/connectors/google_messages",
	]);
});

test("the actual matrix representation detects a real producer-path change", () => {
	const fixture = makeFixture();
	try {
		const diff = git(
			fixture.root,
			"diff",
			"--name-only",
			fixture.pinnedSha,
			fixture.currentHead,
			"--",
			...pathspecs(dataConnectMatrix),
		);
		assert.equal(diff, fixture.changedPath);
	} finally {
		rmSync(fixture.root, { recursive: true, force: true });
	}
});

test("freshness comparator covers actionable, unrelated, scheduled, and clean outcomes", () => {
	const fixture = makeFixture();
	try {
		const actionable = runComparator(fixture, { eventName: "pull_request", prTouches: true });
		assert.equal(actionable.outputs.stale, "true");
		assert.equal(actionable.outputs.requires_failure, "true");
		assert.equal(actionable.outputs.repin, "false");
		assert.match(actionable.stdout, /::error::pin stale/);

		const unrelated = runComparator(fixture, { eventName: "pull_request", prTouches: false });
		assert.equal(unrelated.outputs.stale, "true");
		assert.equal(unrelated.outputs.requires_failure, "false");
		assert.equal(unrelated.outputs.repin, "false");
		assert.match(unrelated.stdout, /::notice::data-connect pin is stale/);

		const scheduled = runComparator(fixture, { eventName: "schedule", prTouches: false });
		assert.equal(scheduled.outputs.stale, "true");
		assert.equal(scheduled.outputs.requires_failure, "true");
		assert.equal(scheduled.outputs.repin, "true");

		const mainPush = runComparator(fixture, { eventName: "push", prTouches: false });
		assert.equal(mainPush.outputs.stale, "true");
		assert.equal(mainPush.outputs.requires_failure, "true");
		assert.equal(mainPush.outputs.repin, "true");

		const clean = runComparator(fixture, {
			eventName: "schedule",
			prTouches: false,
			currentHead: fixture.pinnedSha,
		});
		assert.equal(clean.outputs.stale, undefined);
		assert.equal(clean.outputs.repin, "false");
		assert.doesNotMatch(clean.stdout, /stale/);
	} finally {
		rmSync(fixture.root, { recursive: true, force: true });
	}
});
