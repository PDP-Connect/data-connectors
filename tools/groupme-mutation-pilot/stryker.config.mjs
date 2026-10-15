// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

const mode = process.env.MUTATION_MODE;

if (mode !== "a1" && mode !== "a2") {
	throw new Error("MUTATION_MODE must be a1 or a2");
}

const config = {
	commandRunner: {
		command:
			"node --import tsx --test --test-reporter=tap connectors/groupme/attachment-detail-coverage.test.ts connectors/groupme/attachments-stream.test.ts connectors/groupme/auth-probe.test.ts connectors/groupme/blob-security.test.ts connectors/groupme/carry-forward-projection.test.ts connectors/groupme/collection.test.ts connectors/groupme/completeness-anchor.test.ts connectors/groupme/incremental-frontier.test.ts connectors/groupme/index.test.ts connectors/groupme/production-dedup.test.ts connectors/groupme/schemas.test.ts connectors/groupme/setup-contract.test.ts connectors/groupme/skip-result-boundary-claim-contract.test.ts connectors/groupme/stream-coverage.test.ts",
	},
	concurrency: 2,
	coverageAnalysis: "off",
	jsonReporter: {
		fileName: `reports/groupme-${mode}.json`,
	},
	mutate: [
		"connectors/groupme/index.ts:1487-1495",
		"connectors/groupme/index.ts:1528-1529",
	],
	reporters: ["json"],
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
