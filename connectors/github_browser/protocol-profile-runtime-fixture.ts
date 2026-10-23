// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Real-runtime, profile-only scenarios. Never contacts a provider.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runConnector } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { collectGitHubBrowser } from "./collector.ts";
import { inspectProfilePage } from "./page-evidence.ts";
import { validateRecord } from "./schemas.ts";

const scenario = process.env.GITHUB_PROFILE_SCENARIO ?? "busy-organizations";
assert.ok(
	[
		"busy-organizations",
		"wrong-owner",
		"unreadable-profile",
		"throw-now",
		"optional-name",
	].includes(scenario),
);
const privateSentinel = "PRIVATE_PROFILE_CLOCK_SENTINEL";
const profile = readFileSync(
	new URL("./__fixtures__/synthetic/profile.html", import.meta.url),
	"utf8",
);
let profileHtml = profile;
if (scenario === "busy-organizations") {
	profileHtml = profile.replace(
		'<div class="avatar-group"></div>',
		'<div class="avatar-group" aria-busy="true"></div>',
	);
} else if (scenario === "unreadable-profile") {
	profileHtml = profile.replace(
		/<span\b([^>]*\bclass=["'][^"']*\bp-nickname\b[^"']*["'][^>]*)>/u,
		'<span $1 aria-busy="true">',
	);
} else if (scenario === "optional-name") {
	profileHtml = profile.replace(
		/<span\b[^>]*\bclass=["'][^"']*\bp-name\b[^"']*["'][^>]*>[\s\S]*?<\/span>/u,
		"",
	);
}
if (
	["busy-organizations", "unreadable-profile", "optional-name"].includes(
		scenario,
	)
) {
	assert.notEqual(
		profileHtml,
		profile,
		"scenario must change its intended DOM fixture",
	);
}

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
		const prior = structuredClone(state.profile);
		let profileReads = 0;
		let clockReads = 0;
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
				now: () => {
					clockReads += 1;
					if (scenario === "throw-now") throw new Error(privateSentinel);
					return new Date("2026-10-22T00:00:00Z");
				},
				openPage: async (url) => {
					if (url === "https://github.com/") {
						return { requestedUrl: url, currentUrl: url, html: profile };
					}
					profileReads += 1;
					const page = {
						requestedUrl: url,
						currentUrl:
							scenario === "wrong-owner"
								? "https://github.com/another-owner"
								: url,
						html: profileHtml,
					};
					assert.equal(
						inspectProfilePage(page, "sample-user", url),
						scenario !== "wrong-owner",
					);
					return page;
				},
				sleep: async () => {},
			},
		);
		assert.equal(profileReads, 1, "exactly one profile scenario must run");
		if (scenario === "throw-now") assert.equal(clockReads, 1);
		if (scenario !== "optional-name") assert.deepEqual(state.profile, prior);
		else assert.notDeepEqual(state.profile, prior);
	},
});
