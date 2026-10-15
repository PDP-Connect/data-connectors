// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

export default {
	mutate: ["connectors/groupme/index.ts:1491-1491"],
	ignorePatterns: ["reports"],
	testRunner: "command",
	commandRunner: {
		command:
			"tools/groupme-mutation-pilot/node_modules/.bin/vitest run --config tools/groupme-mutation-pilot/vitest.config.ts connectors/groupme/incremental-frontier.vitest.ts --testNamePattern='^repeated/nonprogressing cursor: a forward page violating documented ascending order fails as NonProgressError$' --reporter=verbose",
	},
	reporters: ["json"],
	jsonReporter: {
		fileName: "reports/mutation/groupme-owner-canary-command.json",
	},
	concurrency: 2,
	timeoutMS: 120000,
	timeoutFactor: 1.5,
	coverageAnalysis: "off",
	disableBail: true,
	thresholds: {
		high: 0,
		low: 0,
		break: 0,
	},
};
