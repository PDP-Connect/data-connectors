// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import base from "./stryker.config.mjs";

const workspace = process.cwd();

export default {
	...base,
	testRunner: "command",
	commandRunner: {
		command: `tools/groupme-mutation-pilot/node_modules/.bin/vitest run --config tools/groupme-mutation-pilot/vitest.config.ts --reporter=json --outputFile=${workspace}/reports/mutation/evidence/vitest-instrumented-unactivated.json`,
	},
	coverageAnalysis: "off",
	dryRunOnly: true,
};
