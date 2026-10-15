// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

export default {
	mutate: ["connectors/groupme/index.ts:1491-1491"],
	ignorePatterns: ["reports"],
	testRunner: "vitest",
	vitest: {
		configFile: "tools/groupme-mutation-pilot/vitest.config.ts",
		related: false,
	},
	concurrency: 2,
	timeoutMS: 120000,
	timeoutFactor: 1.5,
	coverageAnalysis: "perTest",
	mutator: {
		excludedMutations: ["ConditionalExpression", "LogicalOperator"],
	},
	reporters: ["json", "event-recorder"],
	jsonReporter: {
		fileName: "reports/mutation/groupme-owner-canary.json",
	},
	eventReporter: {
		baseDir: path.resolve(
			process.cwd(),
			"reports/mutation/events/owner-canary",
		),
	},
	disableBail: true,
	thresholds: {
		high: 0,
		low: 0,
		break: 0,
	},
};
