// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { registerPilotFixtureTests } from "../../packages/polyfill-connectors/src/pilot-fixture-test-helper.ts";
import { validateRecord } from "./schemas.ts";

// Synthetic-but-shape-real rows, built by this connector's parsers from the
// factory's synthetic fixtures in __fixtures__/ (no owner data).
registerPilotFixtureTests({
	connector: "tiktok",
	validateRecord,
	exemptStreams: {
		favorite_collections:
			"the recorded account had no Favorites collections, so no entry shape was observed",
	},
});
