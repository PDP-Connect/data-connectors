// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Pilot fixture derived from a real live-account capture (2026-09-22, one
 * personal US/EN account, all six streams). Every owner-identifying value
 * (name, headline, company, school, photo/logo URLs, profile URLs, member
 * URN segments) is replaced with a `[REDACTED_*]` placeholder; structural
 * shape, field precision (e.g. D4 partial dates), and non-identifying
 * values (skill names, employment_type, industry) are preserved as
 * observed. See the lane report's "Live evidence" section for the full
 * capture provenance and what changed from pre-live inference.
 */

import { registerPilotFixtureTests } from "../../src/pilot-fixture-test-helper.ts";
import { validateRecord } from "./schemas.ts";

registerPilotFixtureTests({
	connector: "linkedin",
	validateRecord,
});
