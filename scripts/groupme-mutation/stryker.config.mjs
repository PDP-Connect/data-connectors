// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { join } from "node:path";
import { resolveTool } from "./vitest.config.mjs";

// run.ts passes the changed ranges as --mutate and the per-run directory through env.
const runDir =
	process.env.GROUPME_MUTATION_RUN_DIR ?? "reports/groupme-mutation";

export default {
	// Always supplied by run.ts; an empty list selects nothing and is never a proof.
	mutate: [],
	testRunner: "vitest",
	plugins: [resolveTool("@stryker-mutator/vitest-runner")],
	coverageAnalysis: "perTest",
	concurrency: 2,
	timeoutMS: 120000,
	disableBail: true,
	vitest: {
		// Relative to the sandbox root, so the sandbox copy (not the checkout) sets vitest's root.
		configFile: "scripts/groupme-mutation/vitest.config.mjs",
		related: false,
	},
	reporters: ["json", "html", "event-recorder", "clear-text"],
	jsonReporter: { fileName: join(runDir, "mutation.json") },
	htmlReporter: { fileName: join(runDir, "index.html") },
	eventReporter: { baseDir: join(runDir, "events") },
	thresholds: { break: 0 },
};
