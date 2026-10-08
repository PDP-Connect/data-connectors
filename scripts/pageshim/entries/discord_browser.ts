// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// discord_browser on PageShim. Three things the generic entry does not do:
//   - the sign-in check reads the page, so the app is opened once before it;
//   - the host's saved STATE is passed in, because the `messages` cursor
//     carries the queue of servers still to search;
//   - work a run leaves for the next one (its message and server limits, a
//     server whose search was refused) is reported as progress. The host
//     keeps a scope's STATE only when the scope has no error, so reporting
//     it as a skip would stop the queue from advancing.
//
// Each scope is `{ records }`. A host range for discord.messages applies to
// `timestamp`; the other streams have no time field, and the runtime reports
// a range on them as scope_not_supported.
import {
	collectDiscordBrowser,
	type DiscordCollectContext,
	LOGIN_URL,
	openDiscordApp,
	probeDiscordBrowserSession,
} from "../../../connectors/discord_browser/index.ts";
import { validateRecord } from "../../../connectors/discord_browser/schemas.ts";
import { applyRequestedTimeRanges } from "../requested-time-range.ts";
import { runOnPageShim, type ShimPage } from "../runtime.ts";

// Defined by build.mjs from connectors/discord_browser/manifest.json.
declare const PAGESHIM_CONNECTOR_VERSION: string;

type ScopeEntriesPage = ShimPage & {
	requestedScopeEntries?: () => unknown;
};

const STREAMS = ["profile", "servers", "connections", "messages"];

const summarizeCounts = (counts: Record<string, number>) => {
	const details = Object.fromEntries(
		STREAMS.map((stream) => [stream, counts[stream] ?? 0]),
	);
	const count = Object.values(details).reduce((sum, value) => sum + value, 0);
	return { count, label: count === 1 ? "item" : "items", details };
};

(globalThis as Record<string, unknown>).__pageshimMain = (
	page: ShimPage,
	initialState: Record<string, unknown>,
	supportsState: boolean,
) =>
	runOnPageShim(
		page,
		{
			platform: "discord",
			scopes: STREAMS.map((stream) => `discord.${stream}`),
			version: PAGESHIM_CONNECTOR_VERSION,
			loginUrl: LOGIN_URL,
			loginMessage: "Sign in to Discord, then return here.",
			validateRecord,
			prepareProbe: async (pw) => {
				await openDiscordApp(pw as never);
			},
			probe: (pw) => probeDiscordBrowserSession(pw as never),
			collect: async (ctx) => {
				const { requested } = ctx as unknown as {
					requested: Map<
						string,
						{ time_range?: { since?: string; until?: string } }
					>;
				};
				applyRequestedTimeRanges(
					requested,
					(page as ScopeEntriesPage).requestedScopeEntries?.(),
					"discord",
				);
				await collectDiscordBrowser(ctx as unknown as DiscordCollectContext, {
					deferredWork: "progress",
				});
			},
			toScope: (_stream, records) => ({ records }),
			streamScopeRecords: {
				order: ["messages", "profile", "servers", "connections"],
				summarizeCounts,
			},
			summarize: (scopes) =>
				summarizeCounts(
					Object.fromEntries(
						STREAMS.map((stream) => [
							stream,
							(
								scopes[`discord.${stream}`] as
									| { records?: unknown[] }
									| undefined
							)?.records?.length ?? 0,
						]),
					),
				),
		},
		initialState,
		supportsState,
	);
