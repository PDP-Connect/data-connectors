// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Test-only connector for `requireAccountIdentity` (Collection Profile
 * Section 5.14). It learns its synthetic account id after it emitted a record,
 * as a source that reveals the id late would: the reporter writes the message
 * whenever it is called, so this pins that the wire order is the connector's
 * choice, not the reporter's. `FIXTURE_MODE` picks the case: `late` (default),
 * `twice_same`, `twice_different`, or `invalid` (an id with whitespace).
 * NOT a production connector.
 */

import { requireAccountIdentity } from "../account-identity.ts";
import { runConnector } from "../connector-runtime.ts";

runConnector({
	name: "account-identity-fixture",
	async collect(ctx) {
		await ctx.emitRecord("items", { id: "item-1" });
		const mode = process.env.FIXTURE_MODE ?? "late";
		if (mode === "invalid") {
			await requireAccountIdentity("has whitespace");
			return;
		}
		await requireAccountIdentity("synthetic-user-0001");
		if (mode === "twice_same") {
			await requireAccountIdentity("synthetic-user-0001");
		}
		if (mode === "twice_different") {
			await requireAccountIdentity("synthetic-user-0002");
		}
	},
});
