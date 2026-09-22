// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * No `pilot-real-shape` fixture exists for this connector: Tim has no Shop
 * app account, so no real (or even scrubbed-real) Apollo cache capture has
 * ever been taken — see the GROUND-TRUTH CAVEAT in schemas.ts and
 * index.ts's header comment. A pilot fixture's job is to lock emitted shape
 * against drift from a real capture; authoring one from guessed data would
 * misrepresent that guarantee. `expectMissing: true` opts out honestly per
 * docs/reference/connector-authoring-guide.md §9.1's documented escape
 * hatch, matching this connector's `development`-tier, no-live-evidence
 * posture (docs/migration/connector-cutover/CONTRACTS.md D10). Revisit once
 * a live run captures real fixtures (see CONTRACT-CHANGE / next steps in
 * the lane report).
 */

import { registerPilotFixtureTests } from "../../src/pilot-fixture-test-helper.ts";
import { validateRecord } from "./schemas.ts";

registerPilotFixtureTests({
	connector: "shopify",
	evidence: "shape-only",
	expectMissing: true,
	validateRecord,
});
