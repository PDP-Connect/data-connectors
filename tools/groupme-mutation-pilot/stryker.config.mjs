// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

export default {
	mutate: [
		"connectors/groupme/index.ts:1487-1495",
		"connectors/groupme/index.ts:1528-1529",
	],
	ignorePatterns: ["reports"],
	testRunner: "vitest",
	vitest: {
		configFile: "tools/groupme-mutation-pilot/vitest.config.ts",
		related: false,
	},
	reporters: ["clear-text", "json"],
	jsonReporter: {
		fileName: "reports/mutation/groupme-vitest-mutation.json",
	},
	concurrency: 2,
	timeoutMS: 120000,
	timeoutFactor: 1.5,
	coverageAnalysis: "perTest",
	// StrykerJS #6146 documents a Vitest bail race that can turn empty filtered
	// runs into false survivors. Keep bail disabled to retain selected test results.
	disableBail: true,
	thresholds: {
		high: 0,
		low: 0,
		break: 0,
	},
};
