// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type {
	EmittedMessage,
	RecordData,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { InventoryEvidence } from "./inventory-evidence.ts";
import { fullInventoryCoverage } from "./inventory-coverage.ts";
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
	parseLegacyEventPageItem,
	parseLegacyHistoryPageItem,
	parseLoggedInUsername,
	parseProfilePage,
	parseRepositoriesPage,
	parseStarredPage,
} from "./parsers.ts";
import { validateEntity, validateRecord } from "./schemas.ts";
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
		homepage.currentUrl !== `${GITHUB}/`
	)
		throw new Error("github_browser_session_missing");

	const wants = context.requested;
	const snapshotId = (stream: string): string => `${username}:${stream}`;
	const pending = new Map<string, RecordData[]>();
	const flushed = new Map<string, boolean>();
	const flush = async (stream: string, allowEmpty = false): Promise<boolean> => {
		if (flushed.has(stream)) return flushed.get(stream) === true;
		const rows = pending.get(stream) ?? [];
		if (rows.length === 0 && !allowEmpty) return false;
		let data: RecordData;
		const fetchedAt = services.now().toISOString();
		if (stream === "profile") data = { ...rows[0], id: snapshotId(stream) };
		else if (stream === "repositories" || stream === "starred")
			data = { id: snapshotId(stream), [stream]: rows.map(({ id: _id, ...row }) => row) };
		else if (stream === "events") data = {
			id: snapshotId(stream), events: rows, fetchedAt,
			windowDescription: "GitHub public events API retention window (up to 300 events from the past 90 days).",
		};
		else if (stream === "history") data = {
			id: snapshotId(stream), issues: rows.filter((row) => row.type === "issue"),
			pullRequests: rows.filter((row) => row.type === "pr"), fetchedAt,
			windowDescription: "GitHub Search API results, capped at 1,000 items per type.",
		};
		else {
			const summary = rows.find((row) => row.recordType === "summary");
			const { recordType: _type, username: _username, id: _id, ...fields } = summary ?? {};
			data = { ...fields, id: snapshotId(stream), fetchedAt,
				days: rows.filter((row) => row.recordType === "day").map(
					({ recordType: _kind, id: _key, ...day }) => day),
			};
		}
		const validated = validateRecord(stream, data);
		flushed.set(stream, validated.ok);
		if (!validated.ok) return false;
		await context.emitRecord(stream, validated.data);
		return true;
	};
	const complete = async (
		stream: string,
		counts: CoverageCounts,
		metadata: Record<string, unknown> = {},
	): Promise<void> => {
		if (!(await flush(stream, true))) {
			await incomplete(stream, "invalid_snapshot_shape", counts);
			return;
		}
		context.state[stream] = {
			fetched_at: services.now().toISOString(),
			...metadata,
		};
		await context.emit({
			type: "STATE",
			stream,
			cursor: context.state[stream],
		});
		await context.emit(fullInventoryCoverage(stream, { kind: "enumerated", complete: true, considered: 1, covered: 1 }));
	};
	const incomplete = async (
		stream: string,
		reason: string,
		counts?: CoverageCounts,
	): Promise<void> => {
		if (stream === "profile") {
			await context.emit({ type: "SKIP_RESULT", stream, reason: "github_browser_incomplete", message: `GitHub did not return a complete result for this stream: ${reason}.`, diagnostics: { cause: reason },
				recovery_hint: { action: "retry_by_runtime", retryable: true } });
			return;
		}
		// Inventory snapshots are withheld until their source window is complete.
		await context.emit(fullInventoryCoverage(stream, {
			kind: "enumerated", complete: false,
			considered: counts?.considered ?? 0, covered: counts?.covered ?? 0,
		}, reason));
	};
	const emitEntity = async (stream: string, data: object): Promise<boolean> => {
		const record = data as RecordData;
		const validated = validateEntity(stream, record);
		if (!validated.ok) return false;
		const rows = pending.get(stream) ?? [];
		rows.push(validated.data);
		pending.set(stream, rows);
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
			// The contribution heading loads after the profile shell, so read the
			// profile through the loader that waits for the contribution section.
			const page = await (services.openContributionPage ?? services.openPage)(url);
			if (!inspectProfilePage(page, username, url)) {
				await incomplete("profile", "wrong_page_or_owner");
				return;
			}
			const parsed = parseProfilePage(page.html, url);
			const record = parsed.row;
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
			// Singleton presence only. Embedded lists are best-effort, not inventories.
			// Never issue self coverage or derive deletes from these fields.
			if (await flush("profile")) {
				context.state.profile = { fetched_at: services.now().toISOString() };
				await context.emit({ type: "STATE", stream: "profile", cursor: context.state.profile });
			} else await incomplete("profile", "invalid_snapshot_shape");
		});
	}

	for (const stream of ["repositories", "starred"] as const) {
		if (!wants.has(stream)) continue;
		await runIsolated(stream, async () => {
			const seen = new Set<string>();
			let covered = 0;
			const evidence = new InventoryEvidence();
			let endProven = false;
			let failure: string | null = "page_limit_reached";
			let entriesComplete = true;
			let rejected = 0;
			let url = inventoryUrl(username, stream, 1);
			for (let pageNumber = 1; pageNumber <= INVENTORY_PAGE_LIMIT; pageNumber += 1) {
				let page = await services.openPage(url);
				let parsed = inventoryRows(stream, page.html);
				let proof = inspectInventoryPage(page, stream, username, pageNumber, new Set([...seen, ...parsed.rows.map(row => row.id)]).size, rejected + parsed.rejectedRows);
				evidence.add(proof);
				if (stream === "starred" && pageNumber === 1 && (proof.reason === "terminal_unverified" || proof.reason === "unreadable_list")) {
					const primary = { parsed, proof };
					url = `${GITHUB}/stars/${username}?page=1`;
					page = await services.openPage(url);
					parsed = inventoryRows(stream, page.html);
					proof = inspectInventoryPage(page, stream, username, pageNumber, parsed.rows.length, parsed.rejectedRows);
					evidence.add(proof);
					// An unreadable alternate route must not discard a readable primary list.
					if (proof.reason === "unreadable_list" && primary.proof.reason === "terminal_unverified") {
						parsed = primary.parsed;
						proof = primary.proof;
					}
				}
				if (proof.reason === "wrong_navigation" || proof.reason === "wrong_owner") {
					await incomplete(stream, proof.reason); return;
				}
				rejected += parsed.rejectedRows;
				entriesComplete &&= parsed.entriesComplete;
				for (const row of parsed.rows) {
					if (seen.has(row.id)) continue;
					seen.add(row.id);
					if (await emitEntity(stream, row)) covered += 1;
				}
				if (proof.nextUrl !== null) {
					url = proof.nextUrl;
					continue;
				}
				failure = proof.reason;
				if (entriesComplete && rejected === 0 &&
					(proof.complete || proof.reason === "terminal_unverified") && covered === seen.size) {
					failure = null;
					endProven = proof.complete;
					if (!endProven && proof.total === null && stream === "starred") {
						failure = await inspectStarredRest(services, username, seen, evidence);
						endProven = failure === null;
					}
				}
				break;
			}
			const reason = evidence.decide(seen.size, endProven, failure);
			const counts = { considered: evidence.expectedTotal ?? seen.size, covered };
			if (reason === null) await complete(stream, counts);
			else await incomplete(stream, reason, counts);
		});
	}

	if (wants.has("events")) {
		await runIsolated("events", async () => {
			const seen = new Set<string>();
			let considered = 0;
			let covered = 0;
			let valid = true;
			for (let page = 1; page <= 3; page += 1) {
				const url = `${API}/users/${username}/events/public?per_page=100&page=${page}`;
				const response = await services.fetchPublicJson(url);
				if (!apiResponseMatches(response, url) || !Array.isArray(response.data))
					break;
				considered += response.data.length;
				for (const raw of response.data) {
					const parsed = parseLegacyEventPageItem(raw);
					const event = parsed.row;
					if (!parsed.complete) valid = false;
					if (event === null || seen.has(event.id)) {
						valid = false;
						continue;
					}
					seen.add(event.id);
					if (await emitEntity("events", event)) covered += 1;
					else valid = false;
				}
				if (response.data.length === 0 || apiWindowEnded(response.link)) {
					if (valid) await complete("events", { considered, covered });
					else await incomplete("events", "invalid_or_duplicate_rows", { considered, covered });
					return;
				}
			}
			const counts = { considered, covered };
			// Neither a short page nor our loop limit establishes the source end.
			await incomplete("events", !valid ? "invalid_or_duplicate_rows" : "end_not_proven", counts);
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
				if (!graph.complete) sourceFailed = true;
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
				!prResult.complete
			) {
				await incomplete(
					"history",
					"search_incomplete",
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
						issueResult.capped || prResult.capped,
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
				const parsed = parseLegacyHistoryPageItem(raw, type);
				const item = parsed.row;
				if (!parsed.complete) invalid = true;
				if (item === null || seen.has(item.id)) {
					invalid = true;
					continue;
				}
				seen.add(item.id);
				if (await emitEntity("history", item)) covered += 1;
				else invalid = true;
			}
			if (invalid) break;
			// The API caps this search window, not the underlying authored history.
			// Short pages and our page budget are never completion evidence.
			if (expectedTotal === seen.size ||
				(capped && (apiWindowEnded(response.link) || seen.size === HISTORY_PAGE_SIZE * HISTORY_PAGE_LIMIT))) {
				completeType = true;
				break;
			}
			if (body.items.length === 0 || apiWindowEnded(response.link)) break;
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

// undefined means the adapter did not observe headers; null means an observed
// absent Link header. Only the latter is GitHub source-end evidence.
function apiWindowEnded(link: string | null | undefined): boolean {
	if (link === undefined) return false;
	if (link === null) return true;
	return !/;\s*rel\s*=\s*(?:"[^"]*\bnext\b[^"]*"|next\b)/iu.test(link);
}

/** REST supplies enumeration evidence; browser rows remain the emitted payload. */
async function inspectStarredRest(
	services: BrowserServices,
	username: string,
	browserRepos: ReadonlySet<string>,
	evidence: InventoryEvidence,
): Promise<string | null> {
	const seen = new Set<string>();
	for (let page = 1; page <= INVENTORY_PAGE_LIMIT; page += 1) {
		const url = `${API}/users/${username}/starred?per_page=100&page=${page}`;
		const response = await services.fetchPublicJson(url);
		if (!apiResponseMatches(response, url) || !Array.isArray(response.data))
			return "invalid_starred_rest_response";
		for (const raw of response.data) {
			const repo = asRecord(raw);
			const name = repo?.full_name;
			if (typeof name !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(name) ||
				repo?.html_url !== `${GITHUB}/${name}` || seen.has(repo.html_url))
				return "invalid_or_duplicate_rows";
			seen.add(repo.html_url as string);
		}
		if ((page === 1 && response.data.length === 0) || apiWindowEnded(response.link)) {
			evidence.addEnumeration(seen.size);
			if (seen.size !== browserRepos.size) return "total_mismatch";
			if (Array.from(seen).some(repo => !browserRepos.has(repo))) return "repository_mismatch";
			return null;
		}
	}
	return "end_not_proven";
}
