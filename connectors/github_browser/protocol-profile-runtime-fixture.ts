// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// A profile-only run whose organizations section never finishes loading, on
// the real connector runtime. Forwards reportStreamFailure as index.ts does.
// Run only as a test subprocess.
import { readFileSync } from "node:fs";
import { runConnector } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { collectGitHubBrowser } from "./collector.ts";
import { validateRecord } from "./schemas.ts";

const profile = readFileSync(
	new URL("./__fixtures__/synthetic/profile.html", import.meta.url),
	"utf8",
);
const busyOrganizations = profile.replace(
	'<div class="avatar-group"></div>',
	'<div class="avatar-group" aria-busy="true"></div>',
);

runConnector({
	name: "github_browser_profile_runtime",
	validateRecord,
	async collect({
		emit,
		emitRecord,
		progress,
		reportStreamFailure,
		requested,
		state,
	}) {
		await collectGitHubBrowser(
			{
				emit,
				emitRecord,
				progress,
				...(reportStreamFailure === undefined ? {} : { reportStreamFailure }),
				requested: new Set(requested.keys()),
				state,
			},
			{
				fetchPublicJson: async () => {
					throw new Error("a profile-only run must not call the API");
				},
				now: () => new Date("2026-01-01T00:00:00Z"),
				openPage: async (url) => ({
					requestedUrl: url,
					currentUrl: url,
					html: busyOrganizations,
				}),
				sleep: async () => {},
			},
		);
	},
});
