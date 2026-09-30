// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// github_browser on PageShim. Replaces mobile's legacy github-1.5.0.js, whose
// result shape github_browser keeps: each stream is one record, {id, ...envelope}.
import { collect } from "../../../connectors/github_browser/index.ts";
import { probeGitHubBrowserSession } from "../../../connectors/github_browser/probe.ts";
import { validateRecord } from "../../../connectors/github_browser/schemas.ts";
import { runOnPageShim, type ShimPage } from "../runtime.ts";

// Defined by build.mjs from connectors/github_browser/manifest.json.
declare const PAGESHIM_CONNECTOR_VERSION: string;

const length = (scope: unknown, key: string): number => {
	const value = (scope as Record<string, unknown> | undefined)?.[key];
	return Array.isArray(value) ? value.length : 0;
};

(globalThis as Record<string, unknown>).__pageshimMain = (
	page: ShimPage,
	initialState: Record<string, unknown>,
	supportsState: boolean,
) =>
	runOnPageShim(page, {
		platform: "github",
		scopes: [
			"profile",
			"repositories",
			"starred",
			"events",
			"contributions",
			"history",
		].map((s) => `github.${s}`),
		version: PAGESHIM_CONNECTOR_VERSION,
		loginUrl: "https://github.com/login",
		loginMessage: "Sign in to GitHub, then return here.",
		validateRecord,
		probe: (pw) => probeGitHubBrowserSession(pw as never),
		collect: (ctx) => collect(ctx as never),
		toScope: (_stream, records) => {
			if (records.length !== 1) return { records };
			const { id: _id, ...envelope } = records[0];
			return envelope;
		},
		// Same shape as the legacy script: details is an object of counts.
		summarize: (scopes) => {
			const repositories = length(
				scopes["github.repositories"],
				"repositories",
			);
			const starred = length(scopes["github.starred"], "starred");
			const events = length(scopes["github.events"], "events");
			const contributions = Number(
				(
					scopes["github.contributions"] as
						| { totalContributionsLastYear?: number }
						| undefined
				)?.totalContributionsLastYear ?? 0,
			);
			const count = repositories + starred + events;
			return {
				count,
				label: count === 1 ? "item" : "items",
				details: { repositories, starred, events, contributions },
			};
		},
	}, initialState, supportsState);
