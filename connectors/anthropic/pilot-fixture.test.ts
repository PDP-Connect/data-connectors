// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { registerPilotFixtureTests } from "../../packages/polyfill-connectors/src/pilot-fixture-test-helper.ts";
import { validateRecord } from "./schemas.ts";

registerPilotFixtureTests({
	connector: "anthropic",
	evidence: "shape-only",
	exemptStreams: {
		account_plan:
			"No reviewed real-derived capture yet. schemas.test.ts, parsers.test.ts and integration.test.ts cover its shape with labeled synthetic records.",
	},
	validateRecord,
});
