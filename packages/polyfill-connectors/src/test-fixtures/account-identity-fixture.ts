// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Test-only connector for `ctx.reportAccountIdentity` (Collection Profile
 * Section 5.14). It learns its synthetic account id after it emitted a record,
 * as a source that reveals the id late would. `FIXTURE_MODE` picks the case:
 * `late` (default), `twice_same`, `twice_different`, or `invalid`.
 * NOT a production connector.
 */

import { runConnector } from "../connector-runtime.ts";

runConnector({
	name: "account-identity-fixture",
	async collect(ctx) {
		await ctx.emitRecord("items", { id: "item-1" });
		const mode = process.env.FIXTURE_MODE ?? "late";
		const report = ctx.reportAccountIdentity;
		if (report === undefined) {
			throw new Error("the runtime did not supply reportAccountIdentity");
		}
		if (mode === "invalid") {
			await report("has whitespace");
			return;
		}
		await report("synthetic-user-0001");
		if (mode === "twice_same") {
			await report("synthetic-user-0001");
		}
		if (mode === "twice_different") {
			await report("synthetic-user-0002");
		}
	},
});
