// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const policyScript = new URL("./repin-branch-policy.mjs", import.meta.url);
const botEmail = "41898282+github-actions[bot]@users.noreply.github.com";
const maintainerEmail = "maintainer@example.invalid";

function git(cwd, ...args) {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function commit(cwd, message, { name, email }) {
	return execFileSync("git", ["commit", "-m", message], {
		cwd,
		encoding: "utf8",
		env: {
			...process.env,
			GIT_AUTHOR_NAME: name,
			GIT_AUTHOR_EMAIL: email,
			GIT_COMMITTER_NAME: name,
			GIT_COMMITTER_EMAIL: email,
		},
	});
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

test("a local bare-remote refresh probe refuses a branch after a maintainer commit", () => {
	const root = mkdtempSync(join(tmpdir(), "cross-repo-repin-refresh-"));
	try {
		const remote = join(root, "remote.git");
		const seed = join(root, "seed");
		const runner = join(root, "runner");
		const branch = "chore/repin-data-connect-abcdef0";

		git(root, "init", "--bare", remote);
		git(root, "init", "-b", "main", seed);
		git(seed, "config", "user.name", "fixture");
		git(seed, "config", "user.email", "fixture@example.invalid");
		writeFileSync(join(seed, "pin.txt"), "old\n");
		git(seed, "add", "pin.txt");
		commit(seed, "base", { name: "fixture", email: "fixture@example.invalid" });
		git(seed, "remote", "add", "origin", remote);
		git(seed, "push", "origin", "main");
		git(remote, "symbolic-ref", "HEAD", "refs/heads/main");

		git(root, "clone", "-b", "main", remote, runner);
		git(runner, "config", "user.name", "fixture");
		git(runner, "config", "user.email", "fixture@example.invalid");
		git(runner, "switch", "-c", branch, "origin/main");
		writeFileSync(join(runner, "pin.txt"), "new\n");
		git(runner, "add", "pin.txt");
		commit(runner, "bot pin refresh", { name: "github-actions[bot]", email: botEmail });
		git(runner, "push", "origin", `HEAD:refs/heads/${branch}`);
		git(runner, "fetch", "origin", "main", branch);
		assert.equal(policyOutput(runner, branch), "");

		writeFileSync(join(runner, "maintainer-repair.txt"), "required vendored repair\n");
		git(runner, "add", "maintainer-repair.txt");
		const botHeadBeforeMaintainerCommit = git(runner, "rev-parse", "HEAD");
		commit(runner, "maintainer repair", { name: "Maintainer", email: maintainerEmail });
		const actualMaintainerCommit = git(runner, "rev-parse", "HEAD");
		assert.notEqual(actualMaintainerCommit, botHeadBeforeMaintainerCommit);
		git(runner, "push", "origin", `HEAD:refs/heads/${branch}`);
		git(runner, "fetch", "origin", "main", branch);

		assert.equal(policyOutput(runner, branch), actualMaintainerCommit);
		assert.equal(
			git(runner, "show", `refs/remotes/origin/${branch}:maintainer-repair.txt`),
			"required vendored repair",
		);
		assert.equal(readFileSync(join(runner, "maintainer-repair.txt"), "utf8"), "required vendored repair\n");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
