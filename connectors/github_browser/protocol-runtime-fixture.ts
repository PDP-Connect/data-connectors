// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Synthetic source pages, real connector runtime. Run only as a test subprocess.
import { readFileSync } from "node:fs";
import { runConnector } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { collectGitHubBrowser } from "./collector.ts";
import { validateRecord } from "./schemas.ts";

const fixture = (name: string): string =>
	readFileSync(
		new URL(`./__fixtures__/synthetic/${name}`, import.meta.url),
		"utf8",
	);
const profile = fixture("profile.html");
const repository = fixture("repositories.html");
const events = JSON.parse(fixture("events.json")) as unknown;
const history = JSON.parse(fixture("history-issue.json")) as {
	items: unknown[];
};
let profileLoads = 0;

function graph(start: string, end: string): string {
	let html = '<h2 class="f4 text-normal mb-2">1 contribution</h2>';
	for (
		let date = new Date(`${start}T00:00:00Z`);
		date.toISOString().slice(0, 10) <= end;
		date.setUTCDate(date.getUTCDate() + 1)
	) {
		html += `<td class="ContributionCalendar-day" data-date="${date.toISOString().slice(0, 10)}" data-count="1"></td>`;
	}
	return html;
}

runConnector({
	name: "github_browser_synthetic_runtime",
	validateRecord,
	async collect({ emit, emitRecord, progress, requested, state }) {
		await collectGitHubBrowser(
			{
				emit,
				emitRecord,
				progress,
				requested: new Set(requested.keys()),
				state,
			},
			{
				fetchPublicJson: async (url) =>
					url.includes("events")
						? events
						: url.includes("type%3Apr")
							? { items: [], total_count: 0, incomplete_results: false }
							: {
									...history,
									total_count: history.items.length,
									incomplete_results: false,
								},
				now: () => new Date("2026-01-01T00:00:00Z"),
				openPage: async (url) => {
					if (url.includes("?from=")) {
						const year = Number(/from=(\d{4})/u.exec(url)?.[1]);
						return graph(`${year}-01-01`, `${year}-12-31`);
					}
					if (url.includes("tab=repositories")) return repository;
					if (url.includes("tab=stars"))
						return '<main><div id="user-starred-repos"></div><p>sample-user hasn\'t starred any repositories yet</p></main>';
					if (url.endsWith("github.com/")) return profile;
					return ++profileLoads === 1
						? profile
						: graph("2025-01-02", "2026-01-01");
				},
				sleep: async () => {},
			},
		);
	},
});
