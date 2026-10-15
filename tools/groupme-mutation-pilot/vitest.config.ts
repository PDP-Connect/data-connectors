// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["connectors/groupme/*.vitest.ts"],
		setupFiles: ["tools/groupme-mutation-pilot/native-owner-result-receipt.ts"],
		pool: "threads",
		maxWorkers: 1,
		maxConcurrency: 1,
		bail: 0,
	},
});
