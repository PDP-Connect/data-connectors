// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Real-browser fixture for `connector-runtime-remote-ownership.test.ts`. It
 * runs through `runConnector` against a browser attached with
 * `PDPP_REMOTE_OWNERSHIP_FIXTURE_REMOTE_CDP_URL`, and does what a connector
 * does in someone else's browser: load a page, make a request, open a blank
 * popup from its own page, then navigate it after the popup event. This gives
 * attached-CDP HAR a chance to capture the request (issue #523). The connector
 * then either finishes or fails.
 *
 * `PDPP_OWNERSHIP_FIXTURE_BASE_URL` points at the test's loopback server.
 * `/open-user-tab` makes the test open a tab in the same browser through its
 * own client while this run is in flight, the way the browser's owner would.
 *
 * `PDPP_OWNERSHIP_FIXTURE_PRESERVE_PAGE=1` makes it a connector that declares
 * page preservation (like ChatGPT): its run page stays open between runs and
 * the next run picks it up. In that mode a run counts how many runs the page
 * has served and emits the count as the record id.
 * `PDPP_OWNERSHIP_FIXTURE_DOWNLOAD=1` (with preserve) also downloads
 * `/export.zip` on the run page.
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

const preservePage = process.env.PDPP_OWNERSHIP_FIXTURE_PRESERVE_PAGE === "1";

async function collectOnPreservedPage(
	{ page, emitRecord }: BrowserCollectContext,
	baseUrl: string,
): Promise<void> {
	const runUrl = new URL("/run", baseUrl).toString();
	if (page.url() !== runUrl) {
		await page.goto(runUrl, { waitUntil: "load" });
	}
	const runsServed = await page.evaluate(() => {
		const served = Number(document.body.dataset.runsServed ?? "0") + 1;
		document.body.dataset.runsServed = String(served);
		return served;
	});
	const [popup] = await Promise.all([
		page.waitForEvent("popup"),
		page.click("#provider"),
	]);
	// Navigate after the popup event so the attached HAR recorder can observe this request.
	await popup.goto(new URL("/provider", baseUrl).toString(), {
		waitUntil: "load",
	});
	if (process.env.PDPP_OWNERSHIP_FIXTURE_DOWNLOAD === "1") {
		// A download on the reused run page: the launcher must count it as the
		// run's (it goes into a recording's HAR) although it did not create
		// the page.
		const download = page.waitForEvent("download");
		await page.evaluate((href) => {
			window.location.href = href;
		}, new URL("/export.zip", baseUrl).toString());
		await (await download).path();
	}
	await emitRecord("items", { id: String(runsServed) });
}

runConnector({
	name: "remote-browser-ownership-fixture",
	validateRecord,
	browser: {
		profileName: "remote_ownership_fixture",
		...(preservePage
			? { preservePageOnFailure: true, preservePageOnSuccess: true }
			: {}),
	},
	async collect(ctx: BrowserCollectContext) {
		const { page, emitRecord } = ctx;
		const baseUrl = process.env.PDPP_OWNERSHIP_FIXTURE_BASE_URL;
		if (!baseUrl) {
			throw new Error("PDPP_OWNERSHIP_FIXTURE_BASE_URL is not set");
		}
		if (preservePage) {
			await collectOnPreservedPage(ctx, baseUrl);
			return;
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
		// Navigate after the popup event so the attached HAR recorder can observe this request.
		await popup.goto(new URL("/provider", baseUrl).toString(), {
			waitUntil: "load",
		});
		await emitRecord("items", { id: userTab });
		if (process.env.PDPP_OWNERSHIP_FIXTURE_FAIL === "1") {
			throw new Error("ownership fixture: deliberate collect failure");
		}
	},
});
