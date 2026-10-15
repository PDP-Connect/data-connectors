// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

export default {
	mutate: ["connectors/groupme/index.ts:1491-1491"],
	ignorePatterns: ["reports"],
	testRunner: "command",
	commandRunner: {
		command:
			"node node_modules/vitest/vitest.mjs run --config tools/groupme-mutation-pilot/vitest.config.ts connectors/groupme/incremental-frontier.vitest.ts --testNamePattern='^repeated/nonprogressing cursor: a forward page violating documented ascending order fails as NonProgressError$' --reporter=verbose",
	},
	concurrency: 2,
	timeoutMS: 120000,
	timeoutFactor: 1.5,
	coverageAnalysis: "off",
	mutator: {
		excludedMutations: ["ConditionalExpression", "LogicalOperator"],
	},
	reporters: ["json", "event-recorder"],
	jsonReporter: {
		fileName: "reports/mutation/groupme-owner-canary-command.json",
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
