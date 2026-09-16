// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const {
	CURRENT_HEAD,
	GITHUB_EVENT_NAME,
	GITHUB_OUTPUT,
	PINNED_SHA,
	PR_TOUCHES_PIN_BACKED_PATHS,
	RELEVANT_PATHS,
	REPO_ID,
	TRACK_REF,
} = process.env;

for (const [name, value] of Object.entries({
	CURRENT_HEAD,
	GITHUB_EVENT_NAME,
	PINNED_SHA,
	RELEVANT_PATHS,
	REPO_ID,
	TRACK_REF,
})) {
	if (!value) {
		throw new Error(`missing required environment variable: ${name}`);
	}
}

const relevantPaths = RELEVANT_PATHS.split(/\r?\n/).map((path) => path.trim()).filter(Boolean);
if (relevantPaths.length === 0) {
	throw new Error("RELEVANT_PATHS must contain at least one path");
}

const diff = execFileSync(
	"git",
	["diff", "--name-only", PINNED_SHA, CURRENT_HEAD, "--", ...relevantPaths],
	{ encoding: "utf8" },
).trim();

function setOutput(name, value) {
	if (!GITHUB_OUTPUT) {
		return;
	}
	appendFileSync(GITHUB_OUTPUT, `${name}=${value}\n`);
}

const isMainAutomation = GITHUB_EVENT_NAME === "push" || GITHUB_EVENT_NAME === "schedule";
setOutput("repin", "false");

if (!diff) {
	console.log(`Pin (${PINNED_SHA}) unchanged relative to ${REPO_ID}'s ${TRACK_REF} (${CURRENT_HEAD}) across: ${RELEVANT_PATHS}`);
	process.exit(0);
}

setOutput("stale", "true");
setOutput("repin", isMainAutomation ? "true" : "false");

if (GITHUB_EVENT_NAME === "pull_request" && PR_TOUCHES_PIN_BACKED_PATHS !== "true") {
	console.log(
		`::notice::${REPO_ID} pin is stale: ${TRACK_REF} (${CURRENT_HEAD}) changed paths backed by this repo's drift jobs since ${PINNED_SHA}. This unrelated PR does not touch those consumer-side paths; the daily/main automation will open or update chore/repin-${REPO_ID}-${CURRENT_HEAD.slice(0, 7)}.`,
	);
	setOutput("requires_failure", "false");
	console.log(diff);
	process.exit(0);
}

console.log(
	`::error::pin stale for relevant source paths — ${REPO_ID}'s ${TRACK_REF} (${CURRENT_HEAD}) has changed these paths since the pinned commit (${PINNED_SHA}):`,
);
console.log(diff);
setOutput("requires_failure", "true");
