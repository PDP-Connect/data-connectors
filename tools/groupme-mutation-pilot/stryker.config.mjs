// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { resolve } from "node:path";

const mode = process.env.MUTATION_MODE;

if (mode !== "a1" && mode !== "a2") {
	throw new Error("MUTATION_MODE must be a1 or a2");
}

const config = {
	commandRunner: {
		command: "node tools/groupme-mutation-pilot/run-tests.mjs",
	},
	concurrency: 2,
	coverageAnalysis: "off",
	ignorePatterns: ["reports/**", "coverage/**", ".stryker-tmp/**"],
	jsonReporter: {
		fileName: resolve(
			process.env.PILOT_REPORT_DIR ?? "reports",
			`groupme-${mode}.json`,
		),
	},
	eventReporter: {
		baseDir: resolve(
			process.env.PILOT_REPORT_DIR ?? "reports",
			"stryker-events",
		),
	},
	mutate:
		process.env.MUTATION_CANARY_CONTROL === "1"
			? ["connectors/groupme/index.ts:1491-1491"]
			: [
					"connectors/groupme/index.ts:1487-1495",
					"connectors/groupme/index.ts:1528-1529",
				],
	reporters: ["event-recorder", "json"],
	testRunner: "command",
	thresholds: {
		break: 0,
		high: 0,
		low: 0,
	},
	timeoutFactor: 1.5,
	timeoutMS: 120000,
};

if (mode === "a2") {
	config.buildCommand = "node tools/groupme-mutation-pilot/build-groupme.mjs";
}

export default config;
