// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const root = process.cwd();
const pilotRequire = createRequire(
	path.join(root, "tools/groupme-mutation-pilot/package.json"),
);
const packageNames = [
	"vitest",
	"@stryker-mutator/vitest-runner",
	"@stryker-mutator/core",
	"vite",
];
const read = (file) => {
	try {
		return readFileSync(file, "utf8").trim();
	} catch {
		return "unavailable";
	}
};
const packages = packageNames.map((name) => {
	const manifest = path.join(
		root,
		"tools/groupme-mutation-pilot/node_modules",
		name,
		"package.json",
	);
	return {
		name,
		version: JSON.parse(readFileSync(manifest, "utf8")).version,
		manifest,
		entry: pilotRequire.resolve(name),
	};
});
const metadata = {
	node: process.version,
	platform: os.platform(),
	arch: os.arch(),
	availableParallelism: os.availableParallelism(),
	hostMemoryBytes: os.totalmem(),
	cgroupMemoryLimitBytes: read("/sys/fs/cgroup/memory.max"),
	cgroupMemoryCurrentBytes: read("/sys/fs/cgroup/memory.current"),
	rootVitestEntry: createRequire(path.join(root, "package.json")).resolve(
		"vitest",
	),
	strykerConcurrency: 2,
	vitestPool: {
		pool: "threads",
		maxWorkers: 1,
		maxConcurrency: 1,
		bail: 0,
	},
	packages,
};

writeFileSync(
	"reports/mutation/evidence/resource-settings.json",
	`${JSON.stringify(metadata, null, 2)}\n`,
);
process.stdout.write(`${JSON.stringify(metadata, null, 2)}\n`);
