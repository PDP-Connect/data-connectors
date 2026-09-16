// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";

const policyScript = new URL("./repin-branch-policy.mjs", import.meta.url);
const workflowPath = new URL("../../workflows/cross-repo-integrity.yml", import.meta.url);
const workflow = parse(readFileSync(workflowPath, "utf8"));
const repinRun = workflow.jobs["pin-freshness"].steps
	.find((step) => step.name.startsWith("Open or update"))
	?.run.replaceAll("${{ matrix.repo.id }}", "data-connect");
const botName = "github-actions[bot]";
const botEmail = "41898282+github-actions[bot]@users.noreply.github.com";
const maintainerName = "Maintainer";
const maintainerEmail = "maintainer@example.invalid";
const pinPath = ".github/cross-repo-pins.json";

assert.ok(repinRun);
assert.doesNotMatch(repinRun, /\$\{\{/);

function git(cwd, ...args) {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function commit(cwd, message, {
	authorName,
	authorEmail,
	committerName = authorName,
	committerEmail = authorEmail,
}) {
	return execFileSync("git", ["commit", "-m", message], {
		cwd,
		encoding: "utf8",
		env: {
			...process.env,
			GIT_AUTHOR_NAME: authorName,
			GIT_AUTHOR_EMAIL: authorEmail,
			GIT_COMMITTER_NAME: committerName,
			GIT_COMMITTER_EMAIL: committerEmail,
		},
	});
}

function writePin(repo, sha) {
	writeFileSync(
		join(repo, pinPath),
		`${JSON.stringify({ repos: { "data-connect": { sha } } }, null, 2)}\n`,
	);
}

function makeRemoteFixture({ branch = "chore/repin-data-connect-abcdef0" } = {}) {
	const root = mkdtempSync(join(tmpdir(), "cross-repo-repin-policy-"));
	const remote = join(root, "remote.git");
	const seed = join(root, "seed");
	const runner = join(root, "runner");

	git(root, "init", "--bare", remote);
	git(root, "init", "-b", "main", seed);
	git(seed, "config", "user.name", "fixture");
	git(seed, "config", "user.email", "fixture@example.invalid");
	mkdirSync(join(seed, ".github"), { recursive: true });
	writePin(seed, "0".repeat(40));
	git(seed, "add", pinPath);
	commit(seed, "base", {
		authorName: "fixture",
		authorEmail: "fixture@example.invalid",
	});
	git(seed, "remote", "add", "origin", remote);
	git(seed, "push", "origin", "main");
	git(remote, "symbolic-ref", "HEAD", "refs/heads/main");

	git(root, "clone", "-b", "main", remote, runner);
	git(runner, "config", "user.name", "fixture");
	git(runner, "config", "user.email", "fixture@example.invalid");
	git(runner, "switch", "-c", branch, "origin/main");

	return { root, remote, runner, branch };
}

function pushBranch(repo, branch) {
	git(repo, "push", "origin", `HEAD:refs/heads/${branch}`);
	git(repo, "fetch", "origin", "main", branch);
}

function policyOutput(repo, branch) {
	return execFileSync(
		process.execPath,
		[
			policyScript.pathname,
			"--base-ref",
			"origin/main",
			"--branch",
			`refs/remotes/origin/${branch}`,
			"--bot-email",
			botEmail,
		],
		{ cwd: repo, encoding: "utf8" },
	).trim();
}

function copyWorkflowScripts(repo) {
	const scriptDir = join(repo, ".github/scripts/cross-repo-integrity");
	mkdirSync(scriptDir, { recursive: true });
	for (const filename of ["repin-branch-policy.mjs", "update-pin.mjs"]) {
		writeFileSync(
			join(scriptDir, filename),
			readFileSync(new URL(`./${filename}`, import.meta.url)),
		);
	}
}

function writeExecutable(path, contents) {
	writeFileSync(path, contents, { mode: 0o755 });
}

function writeGitWrapper(binDir) {
	const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
	const wrapper = join(binDir, "git");
	writeExecutable(
		wrapper,
		`#!/bin/sh
if [ "$1" = "ls-remote" ] && [ -n "$FAIL_REF" ] && [ "$5" = "$FAIL_REF" ]; then
  exit 128
fi
exec ${JSON.stringify(realGit)} "$@"
`,
	);
}

function writeGhStub(binDir, { oldBranch = "", logPath = "/dev/null" } = {}) {
	const stub = join(binDir, "gh");
	writeExecutable(
		stub,
		`#!/bin/sh
printf '%s\\n' "$*" >> "$GH_LOG"
if [ "$1" = "pr" ] && [ "$2" = "list" ] && [ "$5" = "--base" ]; then
  printf '123\\t${oldBranch}\\n'
fi
exit 0
`,
	);
	return { GH_LOG: logPath };
}

function runRepinWorkflow(repo, {
	currentHead,
	binDir,
	failRef = "",
	ghLog = "/dev/null",
}) {
	return execFileSync("bash", ["-c", repinRun], {
		cwd: repo,
		encoding: "utf8",
		env: {
			...process.env,
			PATH: `${binDir}:${process.env.PATH}`,
			FAIL_REF: failRef,
			GH_LOG: ghLog,
			GH_TOKEN: "fixture-token",
			REPO_ID: "data-connect",
			CURRENT_HEAD: currentHead,
			TRACK_REF: "main",
		},
	});
}

test("a pristine bot pin-only branch is eligible and can be refreshed", () => {
	const fixture = makeRemoteFixture();
	try {
		writePin(fixture.runner, "1".repeat(40));
		git(fixture.runner, "add", pinPath);
		commit(fixture.runner, "bot pin refresh", {
			authorName: botName,
			authorEmail: botEmail,
		});
		pushBranch(fixture.runner, fixture.branch);
		assert.equal(policyOutput(fixture.runner, fixture.branch), "");

		const previousRemoteHead = git(
			fixture.runner,
			"rev-parse",
			`refs/remotes/origin/${fixture.branch}`,
		);
		git(fixture.runner, "checkout", "-B", fixture.branch, "origin/main");
		writePin(fixture.runner, "2".repeat(40));
		git(fixture.runner, "add", pinPath);
		commit(fixture.runner, "bot pin refresh again", {
			authorName: botName,
			authorEmail: botEmail,
		});
		git(
			fixture.runner,
			"push",
			`--force-with-lease=refs/heads/${fixture.branch}:${previousRemoteHead}`,
			"origin",
			`HEAD:refs/heads/${fixture.branch}`,
		);
		git(fixture.runner, "fetch", "origin", fixture.branch);

		const refreshedHead = git(
			fixture.runner,
			"rev-parse",
			`refs/remotes/origin/${fixture.branch}`,
		);
		assert.notEqual(refreshedHead, previousRemoteHead);
		assert.equal(
			JSON.parse(git(fixture.runner, "show", `${refreshedHead}:${pinPath}`)).repos["data-connect"].sha,
			"2".repeat(40),
		);
	} finally {
		rmSync(fixture.root, { recursive: true, force: true });
	}
});

test("an amended bot commit with a human committer is refused", () => {
	const fixture = makeRemoteFixture();
	try {
		writePin(fixture.runner, "3".repeat(40));
		git(fixture.runner, "add", pinPath);
		commit(fixture.runner, "bot pin refresh", {
			authorName: botName,
			authorEmail: botEmail,
		});
		execFileSync("git", ["commit", "--amend", "--no-edit"], {
			cwd: fixture.runner,
			encoding: "utf8",
			env: {
				...process.env,
				GIT_AUTHOR_NAME: botName,
				GIT_AUTHOR_EMAIL: botEmail,
				GIT_COMMITTER_NAME: maintainerName,
				GIT_COMMITTER_EMAIL: maintainerEmail,
			},
		});
		const amendedCommit = git(fixture.runner, "rev-parse", "HEAD");
		pushBranch(fixture.runner, fixture.branch);

		assert.equal(policyOutput(fixture.runner, fixture.branch), amendedCommit);
	} finally {
		rmSync(fixture.root, { recursive: true, force: true });
	}
});

test("a human repair commit is refused and remains on the branch", () => {
	const fixture = makeRemoteFixture();
	try {
		writePin(fixture.runner, "4".repeat(40));
		git(fixture.runner, "add", pinPath);
		commit(fixture.runner, "bot pin refresh", {
			authorName: botName,
			authorEmail: botEmail,
		});
		writeFileSync(join(fixture.runner, "required-repair.txt"), "keep this repair\n");
		git(fixture.runner, "add", "required-repair.txt");
		commit(fixture.runner, "maintainer repair", {
			authorName: maintainerName,
			authorEmail: maintainerEmail,
		});
		const humanCommit = git(fixture.runner, "rev-parse", "HEAD");
		pushBranch(fixture.runner, fixture.branch);

		assert.equal(policyOutput(fixture.runner, fixture.branch), humanCommit);
		assert.equal(
			git(fixture.runner, "show", `refs/remotes/origin/${fixture.branch}:required-repair.txt`),
			"keep this repair",
		);
	} finally {
		rmSync(fixture.root, { recursive: true, force: true });
	}
});

test("a bot commit that changes a non-pin path is refused", () => {
	const fixture = makeRemoteFixture();
	try {
		writePin(fixture.runner, "5".repeat(40));
		writeFileSync(join(fixture.runner, "unexpected-change.txt"), "not pin-only\n");
		git(fixture.runner, "add", ".");
		commit(fixture.runner, "bot commit with unexpected tree change", {
			authorName: botName,
			authorEmail: botEmail,
		});
		const unsafeCommit = git(fixture.runner, "rev-parse", "HEAD");
		pushBranch(fixture.runner, fixture.branch);

		assert.equal(policyOutput(fixture.runner, fixture.branch), unsafeCommit);
	} finally {
		rmSync(fixture.root, { recursive: true, force: true });
	}
});

test("an ls-remote failure leaves the candidate branch untouched", () => {
	const currentHead = "a".repeat(40);
	const fixture = makeRemoteFixture({ branch: `chore/repin-data-connect-${currentHead.slice(0, 7)}` });
	try {
		copyWorkflowScripts(fixture.runner);
		writePin(fixture.runner, "6".repeat(40));
		git(fixture.runner, "add", pinPath);
		commit(fixture.runner, "bot pin refresh", {
			authorName: botName,
			authorEmail: botEmail,
		});
		pushBranch(fixture.runner, fixture.branch);
		const candidateHead = git(fixture.runner, "rev-parse", "HEAD");
		const binDir = join(fixture.root, "bin");
		mkdirSync(binDir);
		writeGitWrapper(binDir);
		writeGhStub(binDir);

		assert.throws(
			() => runRepinWorkflow(fixture.runner, {
				currentHead,
				binDir,
				failRef: fixture.branch,
			}),
			(error) => error.status !== 0,
		);
		assert.equal(git(fixture.runner, "rev-parse", "HEAD"), candidateHead);
		assert.equal(git(fixture.remote, "rev-parse", `refs/heads/${fixture.branch}`), candidateHead);
	} finally {
		rmSync(fixture.root, { recursive: true, force: true });
	}
});

test("an older-candidate ls-remote failure leaves its PR open", () => {
	const currentHead = "a".repeat(40);
	const currentBranch = `chore/repin-data-connect-${currentHead.slice(0, 7)}`;
	const oldBranch = "chore/repin-data-connect-bbbbbbb";
	const fixture = makeRemoteFixture({ branch: currentBranch });
	try {
		copyWorkflowScripts(fixture.runner);
		writePin(fixture.runner, "7".repeat(40));
		git(fixture.runner, "add", pinPath);
		commit(fixture.runner, "bot current pin refresh", {
			authorName: botName,
			authorEmail: botEmail,
		});
		pushBranch(fixture.runner, currentBranch);

		git(fixture.runner, "switch", "-c", oldBranch, "origin/main");
		writePin(fixture.runner, "8".repeat(40));
		git(fixture.runner, "add", pinPath);
		commit(fixture.runner, "bot older pin refresh", {
			authorName: botName,
			authorEmail: botEmail,
		});
		pushBranch(fixture.runner, oldBranch);
		const oldBranchHead = git(fixture.runner, "rev-parse", `refs/remotes/origin/${oldBranch}`);

		const binDir = join(fixture.root, "bin");
		mkdirSync(binDir);
		writeGitWrapper(binDir);
		const ghLog = join(fixture.root, "gh.log");
		writeGhStub(binDir, { oldBranch, logPath: ghLog });

		assert.throws(
			() => runRepinWorkflow(fixture.runner, {
				currentHead,
				binDir,
				failRef: oldBranch,
				ghLog,
			}),
			(error) => error.status !== 0,
		);
		assert.equal(git(fixture.remote, "rev-parse", `refs/heads/${oldBranch}`), oldBranchHead);
		assert.doesNotMatch(readFileSync(ghLog, "utf8"), /pr close/);
	} finally {
		rmSync(fixture.root, { recursive: true, force: true });
	}
});
