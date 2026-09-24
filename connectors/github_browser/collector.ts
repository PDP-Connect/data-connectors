// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type {
	EmittedMessage,
	RecordData,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import {
	buildContributionSnapshot,
	inspectInventoryPage,
	parseContributionHtml,
	parseLegacyEvent,
	parseLegacyHistoryItem,
	parseLoggedInUsername,
	parseProfileHtml,
	parseRepositoriesHtml,
	parseStarredHtml,
} from "./parsers.ts";
import type { BrowserServices, LegacyHistoryItem } from "./types.ts";

const GITHUB = "https://github.com";
const API = "https://api.github.com";
const LIMIT = 60;

export interface BrowserCollectionPort {
	emit(message: EmittedMessage): Promise<void>;
	emitRecord(stream: string, record: RecordData): Promise<void>;
	progress(message: string): Promise<void>;
	requested: ReadonlySet<string>;
	state: Record<string, unknown>;
}

export async function collectGitHubBrowser(
	context: BrowserCollectionPort,
	services: BrowserServices,
): Promise<void> {
	const username = parseLoggedInUsername(await services.openPage(`${GITHUB}/`));
	if (!username) throw new Error("github_browser_session_missing");
	const wants = context.requested;
	// The legacy field envelopes remain intact. PDPP uses this stable snapshot
	// identity for filtering and upserts; fetchedAt describes observation time.
	const snapshotId = (stream: string): string => `${username}:${stream}`;
	const complete = async (stream: string): Promise<void> => {
		context.state[stream] = { fetched_at: services.now().toISOString() };
		await context.emit({
			type: "STATE",
			stream,
			cursor: context.state[stream],
		});
	};
	const incomplete = async (stream: string): Promise<void> => {
		await context.emit({
			type: "SKIP_RESULT",
			stream,
			reason: "github_browser_incomplete",
			message: "GitHub did not return a complete result for this stream.",
		});
	};
	if (wants.has("profile")) {
		const url = `${GITHUB}/${username}`;
		const record = parseProfileHtml(await services.openPage(url), url);
		if (!record) await incomplete("profile");
		else {
			await context.emitRecord("profile", {
				id: snapshotId("profile"),
				...record,
			});
			await complete("profile");
		}
	}
	for (const [stream, path, parse] of [
		["repositories", "?tab=repositories", parseRepositoriesHtml],
		["starred", "?tab=stars", parseStarredHtml],
	] as const) {
		if (!wants.has(stream)) continue;
		let done = false;
		const collected = [];
		let url = `${GITHUB}/${username}${path}&page=1`;
		const visited = new Set<string>();
		for (let page = 1; page <= LIMIT; page += 1) {
			if (visited.has(url)) break;
			visited.add(url);
			const html = await services.openPage(url);
			const rows = parse(html);
			const proof = inspectInventoryPage(
				html,
				stream,
				username,
				page,
				rows.length,
			);
			if (!proof.valid) break;
			collected.push(...rows);
			if (!proof.nextUrl) {
				done = true;
				break;
			}
			url = proof.nextUrl;
		}
		if (done) {
			if (stream === "repositories") {
				await context.emitRecord("repositories", {
					id: snapshotId(stream), repositories: collected,
				});
			} else {
				await context.emitRecord("starred", {
					id: snapshotId(stream), starred: collected,
				});
			}
			await complete(stream);
		} else await incomplete(stream);
	}
	if (wants.has("events")) {
		let done = false;
		let valid = true;
		const events = [];
		for (let page = 1; page <= 3; page += 1) {
			const response = await services.fetchPublicJson(
				`${API}/users/${username}/events/public?per_page=100&page=${page}`,
			);
			if (!Array.isArray(response)) break;
			for (const raw of response) {
				const event = parseLegacyEvent(raw);
				if (event) events.push(event);
				else valid = false;
			}
			if (response.length < 100) {
				done = true;
				break;
			}
		}
		if (done && valid) {
			await context.emitRecord("events", {
				id: snapshotId("events"),
				events,
				fetchedAt: services.now().toISOString(),
				windowDescription:
					"GitHub public events API retention window (up to 300 events).",
			});
			await complete("events");
		} else await incomplete("events");
	}
	if (wants.has("contributions")) {
		const year = services.now().getUTCFullYear();
		const graphs = [];
		for (let offset = 0; offset < 4; offset += 1) {
			const itemYear = year - offset;
			const suffix =
				offset === 0 ? "" : `?from=${itemYear}-01-01&to=${itemYear}-12-31`;
			const graph = parseContributionHtml(
				await services.openPage(`${GITHUB}/${username}${suffix}`),
			);
			graphs.push({ ...graph, year: itemYear });
		}
		const record = buildContributionSnapshot(
			graphs,
			services.now().toISOString(),
		);
		if (!record) await incomplete("contributions");
		else {
			await context.emitRecord("contributions", {
				id: snapshotId("contributions"),
				...record,
			});
			await complete("contributions");
		}
	}
	if (wants.has("history")) {
		let successful = true;
		const pullRequests: LegacyHistoryItem[] = [];
		const issues: LegacyHistoryItem[] = [];
		for (const type of ["issue", "pr"] as const) {
			let done = false;
			for (let page = 1; page <= 10; page += 1) {
				const kind = type === "pr" ? "type:pr" : "type:issue";
				const query = encodeURIComponent(`author:${username} ${kind}`);
				const response = await services.fetchPublicJson(
					`${API}/search/issues?q=${query}&sort=created&order=desc&per_page=100&page=${page}`,
				);
				if (
					typeof response !== "object" ||
					response === null ||
					!("items" in response) ||
					!Array.isArray(response.items) ||
					!("incomplete_results" in response) ||
					response.incomplete_results !== false ||
					!("total_count" in response) ||
					typeof response.total_count !== "number" ||
					!Number.isInteger(response.total_count) ||
					response.total_count < 0 ||
					response.total_count > 1000
				)
					break;
				for (const raw of response.items) {
					const item = parseLegacyHistoryItem(raw, type);
					if (item) (type === "pr" ? pullRequests : issues).push(item);
					else successful = false;
				}
				if (response.items.length < 100) {
					if (
						(type === "pr" ? pullRequests : issues).length !==
						response.total_count
					)
						break;
					done = true;
					break;
				}
				await services.sleep(6500);
			}
			if (!done) successful = false;
		}
		if (successful) {
			await context.emitRecord("history", {
				id: snapshotId("history"),
				pullRequests,
				issues,
				fetchedAt: services.now().toISOString(),
				windowDescription:
					"GitHub Search API results, capped at 1,000 items per type.",
			});
			await complete("history");
		} else await incomplete("history");
	}
}
