// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { runConnector, type BrowserCollectContext } from "../../src/connector-runtime.ts";
import {
	collectFixtureItems,
	DEFAULT_BASE_URL,
	isTombstone,
	validateRecord,
	type FixturePage,
} from "./data.ts";

runConnector({
	name: "scenario-consumer",
	validateRecord,
	isTombstone,
	browser: { profileName: "scenarioConsumerFixture" },
	async collect(context: BrowserCollectContext) {
		const baseUrl = process.env.PDPP_SCENARIO_CONSUMER_BASE_URL ?? DEFAULT_BASE_URL;
		await context.page.goto(new URL("/", baseUrl).toString(), { waitUntil: "load" });
		await collectFixtureItems(context, baseUrl, async (url) => {
			const result = await context.page.evaluate(async (requestUrl: string) => {
				const response = await fetch(requestUrl);
				if (!response.ok) {
					throw new Error(`local reference request failed with ${String(response.status)}`);
				}
				return response.json();
			}, url);
			return result as FixturePage;
		});
	},
});
