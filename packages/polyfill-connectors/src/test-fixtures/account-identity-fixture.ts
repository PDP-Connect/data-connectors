// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Test-only connector for `reportAccountIdentity` (Collection Profile
 * Section 5.14). It learns its synthetic account id after it emitted a record,
 * as a source that reveals the id late would. `FIXTURE_MODE` picks the case:
 * `late` (default), `twice_same`, `twice_different`, or `invalid`.
 * NOT a production connector.
 */

import { reportAccountIdentity } from "../account-identity.ts";
import { runConnector } from "../connector-runtime.ts";

runConnector({
	name: "account-identity-fixture",
	async collect(ctx) {
		await ctx.emitRecord("items", { id: "item-1" });
		const mode = process.env.FIXTURE_MODE ?? "late";
		if (mode === "invalid") {
			await reportAccountIdentity("has whitespace");
			return;
		}
		await reportAccountIdentity("synthetic-user-0001");
		if (mode === "twice_same") {
			await reportAccountIdentity("synthetic-user-0001");
		}
		if (mode === "twice_different") {
			await reportAccountIdentity("synthetic-user-0002");
		}
	},
});
