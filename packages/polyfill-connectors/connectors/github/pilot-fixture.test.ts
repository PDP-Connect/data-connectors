// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { registerPilotFixtureTests } from "../../src/pilot-fixture-test-helper.ts";
import { validateRecord } from "./schemas.ts";

registerPilotFixtureTests({
	connector: "github",
	validateRecord,
	// pinned_repositories and organizations have no live-account capture yet
	// (capability-map parity work; see
	// docs/migration/connector-cutover/capability-map.json and
	// connectors/github/new-streams-shape.test.ts for the interim SYNTHETIC
	// shape lock). events and contributions WERE captured live on 2026-09-22
	// (Tim's own account, `gh auth token`, scopes repo/read:org/gist) and
	// their pilot-real-shape/records/ fixtures are the reviewed, scrubbed
	// output of that run (see the connector cutover report for counts and
	// scrub notes) — no exemption needed for them anymore. Remove an entry
	// below once a reviewed real capture for that stream lands under
	// fixtures/github/scrubbed/pilot-real-shape/records/.
	exemptStreams: {
		pinned_repositories:
			"no live-account capture yet; see new-streams-shape.test.ts",
		organizations: "no live-account capture yet; see new-streams-shape.test.ts",
	},
});
