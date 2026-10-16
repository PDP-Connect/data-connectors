// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { fileURLToPath } from "node:url";
import { resolveTool } from "./vitest.config.mjs";

export default {
	// A later reviewed selector supplies explicit changed-code ranges.
	mutate: [],
	testRunner: "vitest",
	plugins: [resolveTool("@stryker-mutator/vitest-runner")],
	coverageAnalysis: "perTest",
	concurrency: 2,
	timeoutMS: 120000,
	disableBail: true,
	vitest: {
		configFile: fileURLToPath(new URL("./vitest.config.mjs", import.meta.url)),
		related: false,
	},
	reporters: ["json", "clear-text", "html"],
	jsonReporter: { fileName: "reports/groupme-mutation/mutation.json" },
	htmlReporter: { fileName: "reports/groupme-mutation/index.html" },
	thresholds: { break: 0 },
};
