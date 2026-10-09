// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Real-browser fixture for `connector-runtime-remote-ownership.test.ts`. It
 * runs through `runConnector` against a browser attached with
 * `PDPP_REMOTE_OWNERSHIP_FIXTURE_REMOTE_CDP_URL`, and does what a connector
 * does in someone else's browser: load a page, make a request, open a genuine
 * provider popup from its own page, and either finish or fail.
 *
 * `PDPP_OWNERSHIP_FIXTURE_BASE_URL` points at the test's loopback server.
 * `/open-user-tab` makes the test open a tab in the same browser through its
 * own client while this run is in flight, the way the browser's owner would.
 */

import type {
	BrowserCollectContext,
	RecordData,
	ValidateRecord,
} from "../connector-runtime.ts";
import { runConnector } from "../connector-runtime.ts";

const validateRecord: ValidateRecord = (stream: string, data: RecordData) => {
	if (stream === "items" && typeof data.id === "string") {
		return { ok: true, data };
	}
	return { ok: false, issues: [{ path: "id", message: "expected string id" }] };
};

runConnector({
	name: "remote-browser-ownership-fixture",
	validateRecord,
	browser: { profileName: "remote_ownership_fixture" },
	async collect({ page, emitRecord }: BrowserCollectContext) {
		const baseUrl = process.env.PDPP_OWNERSHIP_FIXTURE_BASE_URL;
		if (!baseUrl) {
			throw new Error("PDPP_OWNERSHIP_FIXTURE_BASE_URL is not set");
		}
		await page.goto(new URL("/run", baseUrl).toString(), { waitUntil: "load" });
		const userTab = await page.evaluate(async () => {
			const res = await fetch("/open-user-tab");
			return await res.text();
		});
		const [popup] = await Promise.all([
			page.waitForEvent("popup"),
			page.click("#provider"),
		]);
		await popup.waitForLoadState();
		await emitRecord("items", { id: userTab });
		if (process.env.PDPP_OWNERSHIP_FIXTURE_FAIL === "1") {
			throw new Error("ownership fixture: deliberate collect failure");
		}
	},
});
