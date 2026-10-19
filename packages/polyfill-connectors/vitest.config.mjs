// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { fileURLToPath } from "node:url";

// Keep Vitest 4.1.12 until stryker-js#6214 fixes Vitest 5 per-test filtering.
export default {
	root: fileURLToPath(new URL("../..", import.meta.url)),
	test: {
		include: ["**/*.{test,fixture}.ts"],
		pool: "forks",
		testTimeout: 120_000,
	},
};
