// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import {
	buildDetailCoverageMessage,
	buildFullScanCoverageMessage,
	type EmittedMessage,
	type RecordData,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import {
	type BrowserPageObservation,
	hasExpectedOwner,
	inspectProfilePage,
	sameNavigation,
} from "./page-evidence.ts";
import {
	buildContributionSnapshot,
	inspectInventoryPage,
	parseContributionHtml,
	parseLegacyEvent,
	parseLegacyHistoryItem,
	parseLoggedInUsername,
	parseProfileHtml,
	parseRepositoriesPage,
	parseStarredPage,
} from "./parsers.ts";
import { resolveRecordId, validateRecord } from "./schemas.ts";
import type { BrowserServices, LegacyContributionDay } from "./types.ts";

const GITHUB = "https://github.com";
const API = "https://api.github.com";
const INVENTORY_PAGE_LIMIT = 60;
const HISTORY_PAGE_SIZE = 100;
const HISTORY_PAGE_LIMIT = 10;

export interface BrowserCollectionPort {
	emit(message: EmittedMessage): Promise<void>;
	emitRecord(stream: string, record: RecordData): Promise<void>;
	progress(message: string): Promise<void>;
	requested: ReadonlySet<string>;
	state: Record<string, unknown>;
}

interface CoverageCounts {
	considered: number;
	covered: number;
}

interface HistoryTypeResult extends CoverageCounts {
	complete: boolean;
	capped: boolean;
}

export async function collectGitHubBrowser(
	context: BrowserCollectionPort,
	services: BrowserServices,
): Promise<void> {
	const homepage = await services.openPage(`${GITHUB}/`);
	const username = parseLoggedInUsername(homepage.html);
	if (
		username === null ||
		!sameNavigation(homepage.requestedUrl, homepage.currentUrl) ||
		homepage.currentUrl !== `${GITHUB}/` ||
		!hasExpectedOwner(homepage.html, username)
	)
		throw new Error("github_browser_session_missing");

	const wants = context.requested;
	const snapshotId = (stream: string): string => `${username}:${stream}`;
	const complete = async (
		stream: string,
		counts: CoverageCounts,
		metadata: Record<string, unknown> = {},
	): Promise<void> => {
		context.state[stream] = {
			fetched_at: services.now().toISOString(),
			...metadata,
		};
		await context.emit({
			type: "STATE",
			stream,
			cursor: context.state[stream],
		});
		await context.emit(buildFullScanCoverageMessage(stream, counts.covered));
	};
	const incomplete = async (
		stream: string,
		reason: string,
		counts?: CoverageCounts,
	): Promise<void> => {
		if (counts) {
			await context.emit(
				buildDetailCoverageMessage({
					stream,
					stateStream: stream,
					requiredKeys: [],
					hydratedKeys: [],
					considered: counts.considered,
					covered: counts.covered,
				}),
			);
		}
		await context.emit({
			type: "SKIP_RESULT",
			stream,
			reason: "github_browser_incomplete",
			recovery_hint: { action: "retry_by_runtime", retryable: true },
			message: `GitHub ${stream} was not complete (${reason}).`,
			diagnostics: counts,
		});
	};
	const emitEntity = async (stream: string, data: object): Promise<boolean> => {
		const recordData = data as RecordData;
		const id = resolveRecordId(stream, recordData);
		if (id === null) return false;
		const record = { ...recordData, id };
		const validated = validateRecord(stream, record);
		if (!validated.ok) return false;
		await context.emitRecord(stream, validated.data);
		return true;
	};
	const runIsolated = async (
		stream: string,
		work: () => Promise<void>,
	): Promise<void> => {
		try {
			await work();
		} catch {
			await incomplete(stream, "source_request_failed");
		}
	};

	if (wants.has("profile")) {
		await runIsolated("profile", async () => {
			const url = `${GITHUB}/${username}`;
			const page = await services.openPage(url);
			if (!inspectProfilePage(page, username, url)) {
				await incomplete("profile", "wrong_page_or_owner");
				return;
			}
			const record = parseProfileHtml(page.html, url);
			if (record === null || record.username !== username) {
				await incomplete("profile", "unreadable_profile");
				return;
			}
			const emitted = await emitEntity("profile", {
				id: snapshotId("profile"),
				...record,
			});
			if (!emitted) {
				await incomplete("profile", "invalid_record_shape", {
					considered: 1,
					covered: 0,
				});
				return;
			}
			await complete("profile", { considered: 1, covered: 1 });
		});
	}

	for (const stream of ["repositories", "starred"] as const) {
		if (!wants.has(stream)) continue;
		await runIsolated(stream, async () => {
			const seen = new Set<string>();
			const visited = new Set<string>();
			let considered = 0;
			let covered = 0;
			let done = false;
			let url = inventoryUrl(username, stream, 1);
			for (
				let pageNumber = 1;
				pageNumber <= INVENTORY_PAGE_LIMIT;
				pageNumber += 1
			) {
				if (visited.has(url)) {
					await incomplete(stream, "repeated_continuation", {
						considered,
						covered,
					});
					return;
				}
				visited.add(url);
				let page = await services.openPage(url);
				let parsed = inventoryRows(stream, page.html);
				const repeatedRows = parsed.rows.filter((row) =>
					seen.has(row.id),
				).length;
				let proof = inspectInventoryPage(
					page,
					stream,
					username,
					pageNumber,
					parsed.rows.length,
					parsed.rejectedRows + repeatedRows,
					parsed.rows.length > 0 &&
						parsed.rows.every((row) => seen.has(row.id)),
				);
				if (
					stream === "starred" &&
					pageNumber === 1 &&
					proof.reason === "unreadable_list"
				) {
					url = `${GITHUB}/stars/${username}?page=1`;
					if (visited.has(url)) {
						await incomplete(stream, "repeated_route", { considered, covered });
						return;
					}
					visited.add(url);
					page = await services.openPage(url);
					parsed = inventoryRows(stream, page.html);
					const repeatedFallbackRows = parsed.rows.filter((row) =>
						seen.has(row.id),
					).length;
					proof = inspectInventoryPage(
						page,
						stream,
						username,
						pageNumber,
						parsed.rows.length,
						parsed.rejectedRows + repeatedFallbackRows,
						parsed.rows.length > 0 &&
							parsed.rows.every((row) => seen.has(row.id)),
					);
				}
				const safeToIngest =
					proof.reason !== "blocked_page" &&
					proof.reason !== "wrong_navigation" &&
					proof.reason !== "wrong_owner" &&
					proof.reason !== "unreadable_list";
				considered += parsed.rawRows;
				if (safeToIngest) {
					for (const row of parsed.rows) {
						if (seen.has(row.id)) continue;
						seen.add(row.id);
						if (await emitEntity(stream, row)) covered += 1;
					}
				}
				if (!proof.valid) {
					await incomplete(stream, proof.reason, { considered, covered });
					return;
				}
				if (proof.nextUrl === null) {
					done = true;
					break;
				}
				url = proof.nextUrl;
			}
			if (!done) {
				await incomplete(stream, "page_limit_reached", { considered, covered });
				return;
			}
			if (covered !== seen.size || considered !== covered) {
				await incomplete(stream, "discarded_records", { considered, covered });
				return;
			}
			await complete(stream, { considered, covered });
		});
	}

	if (wants.has("events")) {
		await runIsolated("events", async () => {
			const seen = new Set<string>();
			let considered = 0;
			let covered = 0;
			let valid = true;
			let ended = false;
			let boundedWindow = false;
			for (let page = 1; page <= 3; page += 1) {
				const url = `${API}/users/${username}/events/public?per_page=100&page=${page}`;
				const response = await services.fetchPublicJson(url);
				if (!apiResponseMatches(response, url) || !Array.isArray(response.data))
					break;
				considered += response.data.length;
				for (const raw of response.data) {
					const event = parseLegacyEvent(raw);
					if (event === null || seen.has(event.id)) {
						valid = false;
						continue;
					}
					seen.add(event.id);
					if (await emitEntity("events", event)) covered += 1;
					else valid = false;
				}
				if (response.data.length < 100) {
					ended = true;
					break;
				}
				if (page === 3) {
					ended = true;
					boundedWindow = true;
				}
			}
			const counts = { considered, covered };
			if (!ended || !valid || covered !== seen.size) {
				await incomplete(
					"events",
					!valid ? "invalid_or_duplicate_rows" : "end_not_proven",
					counts,
				);
				return;
			}
			await complete("events", counts, {
				window: "github_public_events_retention",
				bounded_window: boundedWindow,
				window_limit: 300,
			});
		});
	}

	if (wants.has("contributions")) {
		await runIsolated("contributions", async () => {
			const year = services.now().getUTCFullYear();
			const graphs: Array<{
				days: LegacyContributionDay[];
				total: number;
				year: number;
			}> = [];
			let considered = 0;
			let rejected = 0;
			let sourceFailed = false;
			const openContributionPage =
				services.openContributionPage ?? services.openPage;
			for (let offset = 0; offset < 4; offset += 1) {
				const itemYear = year - offset;
				const suffix =
					offset === 0 ? "" : `?from=${itemYear}-01-01&to=${itemYear}-12-31`;
				const url = `${GITHUB}/${username}${suffix}`;
				let page: BrowserPageObservation;
				try {
					page = await openContributionPage(url);
				} catch {
					sourceFailed = true;
					continue;
				}
				if (
					!sameNavigation(page.requestedUrl, page.currentUrl) ||
					page.currentUrl !== url ||
					!hasExpectedOwner(page.html, username)
				) {
					sourceFailed = true;
					continue;
				}
				const graph = parseContributionHtml(page.html);
				considered += graph.rawDays;
				rejected += graph.rejectedDays;
				graphs.push({ ...graph, year: itemYear });
			}
			const snapshot = buildContributionSnapshot(
				graphs,
				services.now().toISOString(),
			);
			const days = new Map<string, LegacyContributionDay>();
			for (const graph of graphs) {
				for (const day of graph.days) {
					if (days.has(day.date)) {
						const prior = days.get(day.date);
						if (prior?.count !== day.count || prior.level !== day.level)
							rejected += 1;
						continue;
					}
					days.set(day.date, day);
				}
			}
			let covered = 0;
			for (const day of days.values()) {
				if (await emitEntity("contributions", { recordType: "day", ...day }))
					covered += 1;
				else rejected += 1;
			}
			if (snapshot !== null) {
				considered += 1;
				const summary = {
					recordType: "summary",
					id: snapshotId("contributions"),
					username,
					fetchedAt: snapshot.fetchedAt,
					totalContributionsLastYear: snapshot.totalContributionsLastYear,
					yearTotals: snapshot.yearTotals,
					monthlyTotals: snapshot.monthlyTotals,
					topDay: snapshot.topDay,
				};
				if (await emitEntity("contributions", summary)) covered += 1;
				else rejected += 1;
			}
			if (
				sourceFailed ||
				snapshot === null ||
				rejected > 0 ||
				covered !== days.size + (snapshot === null ? 0 : 1)
			) {
				await incomplete(
					"contributions",
					sourceFailed
						? "year_view_unavailable"
						: "date_coverage_or_shape_mismatch",
					{ considered, covered },
				);
				return;
			}
			await complete("contributions", { considered: covered, covered });
		});
	}

	if (wants.has("history")) {
		await runIsolated("history", async () => {
			let issueResult: HistoryTypeResult;
			let prResult: HistoryTypeResult;
			try {
				issueResult = await collectHistoryType("issue");
			} catch {
				issueResult = {
					complete: false,
					capped: false,
					considered: 0,
					covered: 0,
				};
			}
			try {
				prResult = await collectHistoryType("pr");
			} catch {
				prResult = {
					complete: false,
					capped: false,
					considered: 0,
					covered: 0,
				};
			}
			const considered = issueResult.considered + prResult.considered;
			const covered = issueResult.covered + prResult.covered;
			if (
				!issueResult.complete ||
				!prResult.complete ||
				issueResult.capped ||
				prResult.capped
			) {
				await incomplete(
					"history",
					issueResult.capped || prResult.capped
						? "search_cap_reached"
						: "search_incomplete",
					{ considered, covered },
				);
				return;
			}
			await complete(
				"history",
				{ considered, covered },
				{
					window: "github_author_search",
					window_limit_per_type: HISTORY_PAGE_SIZE * HISTORY_PAGE_LIMIT,
					bounded_window:
						issueResult.considered >= HISTORY_PAGE_SIZE * HISTORY_PAGE_LIMIT ||
						prResult.considered >= HISTORY_PAGE_SIZE * HISTORY_PAGE_LIMIT,
				},
			);
		});
	}

	async function collectHistoryType(
		type: "issue" | "pr",
	): Promise<HistoryTypeResult> {
		let expectedTotal: number | null = null;
		let considered = 0;
		let covered = 0;
		let completeType = false;
		let capped = false;
		const seen = new Set<string>();
		for (let page = 1; page <= HISTORY_PAGE_LIMIT; page += 1) {
			const kind = type === "pr" ? "type:pr" : "type:issue";
			const query = encodeURIComponent(`author:${username} ${kind}`);
			const url = `${API}/search/issues?q=${query}&sort=created&order=desc&per_page=${HISTORY_PAGE_SIZE}&page=${page}`;
			const response = await services.fetchPublicJson(url);
			if (!apiResponseMatches(response, url)) break;
			const body = asRecord(response.data);
			if (
				body === null ||
				!Array.isArray(body.items) ||
				body.incomplete_results !== false ||
				typeof body.total_count !== "number" ||
				!Number.isInteger(body.total_count) ||
				body.total_count < 0
			)
				break;
			if (expectedTotal !== null && body.total_count !== expectedTotal) break;
			expectedTotal = body.total_count;
			considered = Math.max(considered, body.total_count);
			if (body.total_count > HISTORY_PAGE_SIZE * HISTORY_PAGE_LIMIT) {
				capped = true;
			}
			let invalid = false;
			for (const raw of body.items) {
				const item = parseLegacyHistoryItem(raw, type);
				if (item === null || seen.has(item.id)) {
					invalid = true;
					continue;
				}
				seen.add(item.id);
				if (await emitEntity("history", item)) covered += 1;
				else invalid = true;
			}
			if (invalid) break;
			const exhaustedPageLimit = page === HISTORY_PAGE_LIMIT;
			if (body.items.length < HISTORY_PAGE_SIZE || exhaustedPageLimit) {
				completeType = expectedTotal === seen.size;
				if (
					exhaustedPageLimit &&
					expectedTotal === HISTORY_PAGE_SIZE * HISTORY_PAGE_LIMIT
				)
					completeType = true;
				break;
			}
			if (page < HISTORY_PAGE_LIMIT) await services.sleep(6500);
		}
		return { complete: completeType, capped, considered, covered };
	}
}

function inventoryUrl(
	username: string,
	stream: "repositories" | "starred",
	page: number,
): string {
	const tab = stream === "repositories" ? "repositories" : "stars";
	return `${GITHUB}/${username}?page=${page}&tab=${tab}`;
}

function inventoryRows(
	stream: "repositories" | "starred",
	html: string,
):
	| ReturnType<typeof parseRepositoriesPage>
	| ReturnType<typeof parseStarredPage> {
	return stream === "repositories"
		? parseRepositoriesPage(html)
		: parseStarredPage(html);
}

function apiResponseMatches(
	response: Awaited<ReturnType<BrowserServices["fetchPublicJson"]>>,
	expectedUrl: string,
): boolean {
	return (
		response.status === 200 &&
		response.requestedUrl === expectedUrl &&
		response.responseUrl === expectedUrl
	);
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}
