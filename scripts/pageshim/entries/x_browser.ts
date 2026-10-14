// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// x_browser on PageShim. Each scope is `{ records }`. Two things the generic
// entry does not do:
//
//   - It passes the host's saved STATE to the connector. With it, a run stops
//     each list at the first post already collected. Without it (an old
//     shell), every run reads each list from the top to its cap, which spends
//     the owner's daily X reading allowance again.
//   - It opens x.com/home once before the first sign-in check. The check
//     reads the page it is on (cookies and path) and never navigates, so it
//     needs an x.com page to read. A signed-out session is sent from /home
//     to X's sign-in page, which the check then reports.
//   - It reports every stream that fell short as a failed stream. The
//     connector names each cause with its own reason code (a rate limit, a
//     lost session, an unread list). PageShim marks a result partial only
//     for the runtime's stream_collection_failed, and otherwise calls the run
//     complete, so each is forwarded under that reason with the connector's
//     own message. The records read before the stop are still returned.
//
// A host range for x.posts applies to created_at, an instant. x.likes and
// x.bookmarks have no time field (X does not say when a post was liked or
// bookmarked); with a range they collect nothing and the runtime reports
// scope_not_supported. The same holds for x.profile.
import {
	collectXBrowser,
	LOGIN_URL,
	openXHome,
	probeXSession,
	type XCollectContext,
} from "../../../connectors/x_browser/index.ts";
import { validateRecord } from "../../../connectors/x_browser/schemas.ts";
import { applyRequestedTimeRanges } from "../requested-time-range.ts";
import { runOnPageShim, type ShimPage } from "../runtime.ts";

// Defined by build.mjs from connectors/x_browser/manifest.json.
declare const PAGESHIM_CONNECTOR_VERSION: string;
// Set only by harness tests, to shorten the pauses between actions.
declare const PAGESHIM_X_ACTION_DELAY_MS: number | undefined;

type ScopeEntriesPage = ShimPage & {
	requestedScopeEntries?: () => unknown;
};

const STREAMS = ["profile", "posts", "likes", "bookmarks"];

const summarizeCounts = (counts: Record<string, number>) => {
	const details = Object.fromEntries(
		STREAMS.map((stream) => [stream, counts[stream] ?? 0]),
	);
	const count =
		(details.posts ?? 0) + (details.likes ?? 0) + (details.bookmarks ?? 0);
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
			platform: "x",
			scopes: STREAMS.map((stream) => `x.${stream}`),
			version: PAGESHIM_CONNECTOR_VERSION,
			loginUrl: LOGIN_URL,
			loginMessage: "Sign in to X, then return here.",
			validateRecord,
			prepareProbe: (pw) => openXHome(pw as never),
			probe: (pw) => probeXSession(pw as never),
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
					"x",
				);
				const context = ctx as unknown as XCollectContext;
				await collectXBrowser(
					{
						...context,
						emit: (message) =>
							context.emit(
								message.type === "SKIP_RESULT"
									? { ...message, reason: "stream_collection_failed" }
									: message,
							),
					},
					typeof PAGESHIM_X_ACTION_DELAY_MS === "number"
						? {
								actionDelayMs: [
									PAGESHIM_X_ACTION_DELAY_MS,
									PAGESHIM_X_ACTION_DELAY_MS,
								],
							}
						: {},
				);
			},
			toScope: (_stream, records) => ({ records }),
			streamScopeRecords: {
				order: ["posts", "likes", "bookmarks", "profile"],
				summarizeCounts,
			},
			summarize: (scopes) =>
				summarizeCounts(
					Object.fromEntries(
						STREAMS.map((stream) => [
							stream,
							(scopes[`x.${stream}`] as { records?: unknown[] } | undefined)
								?.records?.length ?? 0,
						]),
					),
				),
		},
		initialState,
		supportsState,
	);
