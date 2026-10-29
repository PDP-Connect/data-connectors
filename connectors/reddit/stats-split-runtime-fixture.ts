// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Test-only entry for stats-split-wire.test.ts. It runs the REAL runConnector
// protocol (START parsing, scope gates, validateRecord, makeEmitRecord,
// reportStreamFailure, DONE finalization, process exit) around the REAL Reddit
// `collectAllStreams`. Only the browser is replaced: a fake page answers the
// listing fetch from PDPP_TEST_REDDIT_LISTINGS, a JSON map of
// `<endpoint> -> RedditChild[]`, served in PDPP_TEST_REDDIT_PAGE_SIZE pages.
// When PDPP_TEST_REDDIT_FETCH_LOG names a file, each listing fetch appends one
// line to it, so a test can prove that a rejected request never reached Reddit.
import { appendFileSync } from "node:fs";
import { REDDIT_JSON_ORIGIN } from "../../packages/polyfill-connectors/src/auto-login/reddit.ts";
import { runConnector } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { collectAllStreams } from "./index.ts";
import { validateRecord } from "./schemas.ts";
import type { RedditChild } from "./types.ts";

const listings = JSON.parse(
	process.env.PDPP_TEST_REDDIT_LISTINGS ?? "{}",
) as Record<string, RedditChild[]>;
const pageSize = Number(process.env.PDPP_TEST_REDDIT_PAGE_SIZE ?? "100");
const fetchLog = process.env.PDPP_TEST_REDDIT_FETCH_LOG;

function listingPage(path: string) {
	if (fetchLog) {
		appendFileSync(fetchLog, "fetch\n");
	}
	const [endpointPath = "", query = ""] = path.split("?");
	const endpoint = endpointPath.replace("/user/anon/", "").replace(".json", "");
	const after = new URLSearchParams(query).get("after");
	const offset = after ? Number(after.slice(1)) : 0;
	const all = listings[endpoint] ?? [];
	const end = Math.min(offset + pageSize, all.length);
	return {
		status: 200,
		json: {
			data: {
				children: all.slice(offset, end),
				after: end < all.length ? `a${end}` : null,
			},
		},
	};
}

const page = {
	evaluate: (_fn: unknown, args: unknown) =>
		Promise.resolve(listingPage((args as { path: string }).path)),
	goto: (): Promise<null> => Promise.resolve(null),
	url: (): string => `${REDDIT_JSON_ORIGIN}/`,
};

runConnector({
	name: "reddit",
	validateRecord,
	async collect(ctx) {
		await collectAllStreams(
			// biome-ignore lint/suspicious/noExplicitAny: no browser in this fixture
			{ ...ctx, credentials: { REDDIT_USERNAME: "anon" }, page } as any,
			{ delay: () => Promise.resolve() },
		);
	},
});
