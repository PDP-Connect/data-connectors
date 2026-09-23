// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * fixtures/uber/scrubbed/pilot-real-shape/ holds two trips + receipts
 * derived from a real live account capture (2026-09-22 — see the
 * connector cutover report's "Live evidence" section), scrubbed and
 * reviewed by eye: trip UUIDs, driver names, and street-level address
 * components are replaced with `[REDACTED_*]` placeholders; amounts,
 * fare-breakdown labels, airport/terminal names, and dates are real.
 */

import { registerPilotFixtureTests } from "../../packages/polyfill-connectors/src/pilot-fixture-test-helper.ts";
import { validateRecord } from "./schemas.ts";

registerPilotFixtureTests({ connector: "uber", validateRecord });
