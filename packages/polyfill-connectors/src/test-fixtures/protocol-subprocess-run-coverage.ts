// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { runConnector } from "../connector-runtime.ts";

runConnector({
	name: "protocol-subprocess-run-coverage",
	coverageStores: { items: ["local_items"] },
	async collect({ requested, reportCoverage, emit }) {
		if (requested.has("items")) {
			reportCoverage?.("items", "local_items", "collected");
			if (requested.get("items")?.skip_for_test === true) {
				await emit({
					type: "SKIP_RESULT",
					stream: "items",
					reason: "item_unreadable",
					message: "An item could not be read",
				});
			}
		}
	},
});
