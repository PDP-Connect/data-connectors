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

for (const commit of commits) {
	const [hash, authorEmail, committerEmail] = commit.split("\t");
	const changedPaths = execFileSync(
		"git",
		["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", hash],
		{ encoding: "utf8" },
	)
		.trim()
		.split("\n")
		.filter(Boolean);

	if (
		authorEmail !== botEmail ||
		committerEmail !== botEmail ||
		changedPaths.some((path) => path !== ".github/cross-repo-pins.json")
	) {
		console.log(hash);
	}
}
