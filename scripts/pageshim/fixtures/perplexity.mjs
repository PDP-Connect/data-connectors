// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Serves synthetic www.perplexity.ai responses for the PageShim harness:
// the NextAuth session check, one library page and each thread's entries.
const json = (body, status = 200) => ({
	status,
	contentType: "application/json",
	body: JSON.stringify(body),
});
const html = (body = "") => ({
	status: 200,
	contentType: "text/html; charset=utf-8",
	body: `<!doctype html><html><body>${body}</body></html>`,
});

let loggedIn = true;
export const setLoggedIn = (value) => {
	loggedIn = value;
};

const threads = [1, 2].map((n) => ({
	uuid: `aaaaaaaa-0000-4000-8000-00000000000${n}`,
	context_uuid: `cccccccc-0000-4000-8000-00000000000${n}`,
	slug: `bbbbbbbb-0000-4000-8000-00000000000${n}`,
	title: `Synthetic thread ${n}`,
	mode: "copilot",
	display_model: "sonar",
	query_count: 1,
	// The list's real clock: microseconds and no zone.
	last_query_datetime: `2026-10-0${n}T09:15:00.000000`,
	thread_access: 1,
	// Unrelated to the library size on the real site.
	total_threads: 99,
	has_next_page: n < 2,
	status: "COMPLETED",
	read_write_token: `kkkkkkkk-0000-4000-8000-00000000000${n}`,
}));

const detail = (n) => ({
	status: "success",
	has_next_page: false,
	next_cursor: null,
	entries: [
		{
			uuid: `eeeeeeee-0000-4000-8000-00000000000${n}`,
			status: "COMPLETED",
			context_uuid: `cccccccc-0000-4000-8000-00000000000${n}`,
			query_str: `Synthetic question ${n}?`,
			entry_created_datetime: `2026-10-0${n}T09:15:00.000000+00:00`,
			entry_updated_datetime: `2026-10-0${n}T09:15:04.000000+00:00`,
			display_model: "sonar",
			blocks: [
				{
					intended_usage: "web_results",
					web_result_block: {
						web_results: [{ name: `Synthetic source ${n}`, url: `https://example.com/synthetic-${n}` }],
					},
				},
				{ intended_usage: "ask_text", markdown_block: { answer: `Synthetic answer ${n}.`, progress: "DONE" } },
			],
		},
	],
});

export function resolveFixture(raw) {
	const url = new URL(raw);
	if (url.pathname === "/api/auth/session") {
		return json(loggedIn ? { user: { id: "synthetic-owner" }, expires: "2026-12-31T00:00:00Z" } : {});
	}
	if (url.pathname === "/rest/thread/list_ask_threads") {
		return loggedIn ? json(threads) : json({ error: "unauthorized" }, 401);
	}
	const thread = /^\/rest\/thread\/bbbbbbbb-0000-4000-8000-00000000000(\d)$/.exec(url.pathname);
	if (thread) {
		return loggedIn ? json(detail(Number(thread[1]))) : json({ error: "unauthorized" }, 401);
	}
	return html();
}

export const perplexityFixtures = {
	hosts: /^https:\/\/www\.perplexity\.ai\//,
	resolve: resolveFixture,
	setLoggedIn,
	loginUrl: "https://www.perplexity.ai/",
	homeUrl: "https://www.perplexity.ai/",
};

export const pageshimCase = {
	fixtures: perplexityFixtures,
	scopes: ["perplexity.conversations", "perplexity.messages"],
	exportSummary: {
		count: 6,
		label: "items",
		details: { conversations: 2, messages: 4 },
	},
	emptyExportSummary: {
		count: 0,
		label: "items",
		details: { conversations: 0, messages: 0 },
	},
};
