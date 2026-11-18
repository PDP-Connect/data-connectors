// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Test-only connector fixture for `connector-options-start.test.ts`.
 *
 * Reports the effective value of two options through `readOptions`, so the
 * test observes what a real connector process would see: the START
 * `connector_options` threaded onto `ctx.connectorOptions`, with the env
 * fallback and the default applied by `readOptions`.
 *
 * NOT registered in src/orchestrator.ts -- fixture-only.
 */

import { readOptions } from "../connector-options.ts";
import { runConnector } from "../connector-runtime.ts";

runConnector({
	name: "connector-options-echo-fixture",
	validateRecord: (_stream, data) => ({ ok: true, data }),
	async collect({ connectorOptions, emit, requested }) {
		const options = readOptions(
			{ connector_options: connectorOptions },
			{
				envPrefix: "ECHO_FIXTURE_",
				fields: {
					PAGE_SIZE: { parse: "int", default: 10 },
					SKIP_FILES: { parse: "bool", default: false },
				},
			},
		);
		const stream = [...requested.keys()][0] ?? "items";
		await emit({
			type: "PROGRESS",
			stream,
			message: `options ${JSON.stringify(options)}`,
		});
	},
});
