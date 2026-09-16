// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
function option(name) {
	const index = args.indexOf(name);
	if (index === -1 || !args[index + 1]) {
		throw new Error(`missing required option: ${name}`);
	}
	return args[index + 1];
}

const baseRef = option("--base-ref");
const branchRef = option("--branch");
const botEmail = option("--bot-email");
const commits = execFileSync(
	"git",
	["log", "--format=%H%x09%ae%x09%ce", `${baseRef}..${branchRef}`],
	{ encoding: "utf8" },
)
	.trim()
	.split("\n")
	.filter(Boolean);

const violations = new Set();

for (const commit of commits) {
	const [hash, authorEmail, committerEmail] = commit.split("\t");
	const parents = execFileSync(
		"git",
		["rev-list", "--parents", "-n", "1", hash],
		{ encoding: "utf8" },
	)
		.trim()
		.split(" ")
		.filter(Boolean);

	if (authorEmail !== botEmail || committerEmail !== botEmail) {
		violations.add(hash);
	}

	if (parents.length > 2) {
		violations.add(
			`${hash}: merge commit is not allowed on a linear pin-only branch (${parents.length - 1} parents)`,
		);
	}
}

const changedPaths = execFileSync(
	"git",
	["diff", "--name-only", baseRef, branchRef],
	{ encoding: "utf8" },
)
	.trim()
	.split("\n")
	.filter(Boolean);

const hasUnexpectedPaths = changedPaths.some((path) => path !== ".github/cross-repo-pins.json");
if (hasUnexpectedPaths && violations.size === 0) {
	violations.add(commits.at(-1)?.split("\t", 1)[0] ?? branchRef);
}

console.log([...violations].join("\n"));
