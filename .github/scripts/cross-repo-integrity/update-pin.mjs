#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { readFileSync, writeFileSync } from "node:fs";

const [, , repo, sha, trackRef = "main"] = process.argv;
const pinFile = ".github/cross-repo-pins.json";

if (!repo || !sha || !/^[0-9a-f]{40}$/.test(sha)) {
	console.error("usage: update-pin.mjs <data-connect|pdpp> <40-char-sha> [track-ref]");
	process.exit(1);
}

const pins = JSON.parse(readFileSync(pinFile, "utf8"));
const pin = pins.repos?.[repo];
if (!pin) {
	console.error(`no pin entry for ${repo}`);
	process.exit(1);
}

const previousSha = pin.sha;
const driftJobs = repo === "data-connect"
	? "(a) collector-definitions, (b) connector-sources, (c) tarball-digests, and (e) collector-packaging-manifest"
	: "(d) reference-contract";

pin.sha = sha;
if (trackRef === "main") {
	delete pin.branch;
} else {
	pin.branch = trackRef;
}
pin.note = `Supersedes pinned SHA ${previousSha} with ${sha} on ${trackRef}. This pin backs drift jobs ${driftJobs}.`;

writeFileSync(pinFile, `${JSON.stringify(pins, null, 2)}\n`);
