// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Pilot-real-shape fixture gate for iCloud Notes. `expectMissing: true`
 * because no live-account run has occurred for this connector yet — no
 * PROFILE READY has been issued for the cut-icloud-notes lane as of
 * authoring (2026-09-22). Per docs/connector-authoring-guide.md §9.1, this
 * is a legitimate opt-out for a connector still pending its first
 * live-account evidence, not a permanent exemption: once a live run
 * captures and scrubs real fixtures under
 * fixtures/icloud_notes/scrubbed/pilot-real-shape/records/, remove
 * `expectMissing` so this test locks the emitted-record shape as every
 * other connector's pilot fixture does.
 */

import { registerPilotFixtureTests } from "../../packages/polyfill-connectors/src/pilot-fixture-test-helper.ts";
import { validateRecord } from "./schemas.ts";

registerPilotFixtureTests({
	connector: "icloud_notes",
	evidence: "shape-only",
	validateRecord,
	expectMissing: true,
});
