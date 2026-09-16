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
	["log", "--format=%H%x09%ae", `${baseRef}..${branchRef}`],
	{ encoding: "utf8" },
)
	.trim()
	.split("\n")
	.filter(Boolean);

for (const commit of commits) {
	const [, authorEmail] = commit.split("\t");
	if (authorEmail !== botEmail) {
		console.log(commit.split("\t", 1)[0]);
	}
}
