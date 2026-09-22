// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `fixtures/doordash/scrubbed/pilot-real-shape/` does not exist yet: no
 * live DoorDash account has been connected for this lane, so there is no
 * real capture to scrub and review. That directory is reserved for
 * reviewed real-derived captures only — see
 * docs/reference/connector-authoring-guide.md §9.1 and the cut-doordash
 * lane report. `expectMissing: true` opts out of the "fixture must exist"
 * failure until a real capture lands.
 *
 * Until then, `synthetic-shape.test.ts` locks the emitted-record shape
 * against a hand-authored SYNTHETIC fixture under `__fixtures__/synthetic/`
 * (same convention as connectors/apple_health/__fixtures__).
 */

import { registerPilotFixtureTests } from "../../src/pilot-fixture-test-helper.ts";
import { validateRecord } from "./schemas.ts";

registerPilotFixtureTests({
	connector: "doordash",
	evidence: "shape-only",
	validateRecord,
	expectMissing: true,
});
