// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { runConnector, type CollectContext } from "../../src/connector-runtime.ts";
import {
	collectFixtureItems,
	DEFAULT_BASE_URL,
	isTombstone,
	validateRecord,
	type FixturePage,
} from "./data.ts";

runConnector({
	name: "scenario-consumer",
	isTombstone,
	validateRecord,
	async collect(context: CollectContext) {
		const baseUrl = process.env.PDPP_SCENARIO_CONSUMER_BASE_URL ?? DEFAULT_BASE_URL;
		await collectFixtureItems(context, baseUrl, async (url) => {
			const response = await fetch(url);
			if (!response.ok) {
				throw new Error(`local reference request failed with ${String(response.status)}`);
			}
			return (await response.json()) as FixturePage;
		});
	},
});
