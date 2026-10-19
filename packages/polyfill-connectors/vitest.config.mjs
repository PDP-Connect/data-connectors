// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { fileURLToPath } from "node:url";

// Keep Vitest 4.1.12 until stryker-js#6214 fixes Vitest 5 per-test filtering.
const include = process.env.PDPP_VITEST_EXACT_FILES
	? JSON.parse(process.env.PDPP_VITEST_EXACT_FILES)
	: ["**/*.{test,fixture}.ts"];

export default {
	root: fileURLToPath(new URL("../..", import.meta.url)),
	test: {
		include,
		pool: "forks",
		testTimeout: 120_000,
	},
};
