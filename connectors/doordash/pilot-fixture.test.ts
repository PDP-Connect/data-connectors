// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `fixtures/doordash/scrubbed/pilot-real-shape/records/orders.jsonl` is
 * calibrated by the live 2026-09-22 capture (cut-doordash-live lane): the
 * real account's 3 orders all carried `status: null`, `item_count: null`,
 * `payment_method_summary: null` (those fields are absent from the real
 * `getConsumerOrdersWithDetails` response the account returned) and a
 * non-null `total_cents`/`order_date`/`restaurant_name`/`id`. Per
 * docs/reference/connector-authoring-guide.md §9.1, `pilot-real-shape` rows
 * are synthetic-but-shape-real — no real owner value (restaurant name,
 * address, order id, timestamp) from that capture is reproduced here; only
 * the null/non-null field pattern it proved is.
 *
 * `order_items.jsonl` has no live calibration: the real account's 3 orders
 * carried no `orderItems` array at all, so the connector never emitted an
 * `order_items` record in either live run. That stream's fixture is
 * fully invented shape (not calibrated by a real observation) — see the
 * cut-doordash-live lane report's Live evidence section.
 */

import { registerPilotFixtureTests } from "../../packages/polyfill-connectors/src/pilot-fixture-test-helper.ts";
import { validateRecord } from "./schemas.ts";

registerPilotFixtureTests({
	connector: "doordash",
	evidence: "shape-only",
	validateRecord,
});
