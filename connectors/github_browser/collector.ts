// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type {
	EmittedMessage,
	RecordData,
	StreamFailureOptions,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { inspectApiWindow } from "./page-evidence.ts";
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
	reportStreamFailure?: (stream: string, message: string, options?: StreamFailureOptions) => Promise<void>;
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

type CollectionFailure = CoverageCounts & (
	| { origin: "source"; cause: string; status?: number; collection?: string }
	| { origin: "sink"; cause: "record_emit_failed" | "state_emit_failed" | "message_emit_failed" }
);

// Only connector-owned classifications cross this boundary, never exception text.
class CollectionError extends Error {
	readonly failure: CollectionFailure;
	constructor(failure: CollectionFailure) {
		super(failure.cause);
		this.failure = failure;
	}
}

interface HistoryTypeResult extends CoverageCounts {
	failure: CollectionFailure | null;
	capped: boolean;
}

export async function collectGitHubBrowser(
	context: BrowserCollectionPort,
	services: BrowserServices,
): Promise<void> {
	const sourceRequest = async <T>(request: () => Promise<T>, counts: CoverageCounts = { considered: 0, covered: 0 }): Promise<T> => {
		try { return await request(); }
		catch (error) {
			if (error instanceof CollectionError) throw error;
			const status = error instanceof Error ? /^github_browser_http_(\d{3})$/u.exec(error.message)?.[1] : undefined;
			throw new CollectionError({ ...counts, origin: "source", cause: "source_request_failed",
				...(status === undefined ? {} : { status: Number(status) }) });
		}
	};
	const fetchJson = async (url: string, counts: CoverageCounts = { considered: 0, covered: 0 }) => {
		const response = await sourceRequest(() => services.fetchPublicJson(url), counts);
		if (response.status !== 200) throw new CollectionError({ ...counts, origin: "source",
			cause: response.status === 429 ? "http_rate_limited" : "http_status_failed", status: response.status });
		if (!apiResponseMatches(response, url)) throw new CollectionError({ ...counts, origin: "source", cause: "wrong_navigation" });
		return response;
	};
	const homepage = await sourceRequest(() => services.openPage(`${GITHUB}/`));
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
	const emitMessage = async (message: EmittedMessage, counts: CoverageCounts = { considered: 0, covered: 0 }): Promise<void> => {
		try { await context.emit(message); }
		catch { throw new CollectionError({ considered: counts.considered, covered: counts.covered, origin: "sink", cause: message.type === "STATE" ? "state_emit_failed" : "message_emit_failed" }); }
	};
	const checkpoint = async (stream: string, cursor: Record<string, unknown>, counts?: CoverageCounts): Promise<void> => {
		await emitMessage({ type: "STATE", stream, cursor }, counts);
		context.state[stream] = cursor;
	};
	const flush = async (stream: string, allowEmpty = false, counts: CoverageCounts = { considered: 1, covered: 1 }): Promise<boolean> => {
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
		if (!validated.ok) return false;
		try { await context.emitRecord(stream, validated.data); }
		catch { throw new CollectionError({ ...counts, origin: "sink", cause: "record_emit_failed" }); }
		flushed.set(stream, true);
		return true;
	};
	const complete = async (
		stream: string,
		counts: CoverageCounts,
		metadata: Record<string, unknown> = {},
	): Promise<void> => {
		if (!(await flush(stream, true, counts))) {
			await incomplete(stream, "invalid_snapshot_shape", counts);
			return;
		}
		await checkpoint(stream, {
			fetched_at: services.now().toISOString(),
			...metadata,
		}, counts);
		await emitMessage(fullInventoryCoverage(stream, { kind: "enumerated", complete: true, considered: 1, covered: 1 }));
	};
	const incomplete = async (
		stream: string,
		reason: string | CollectionFailure,
		counts: CoverageCounts = { considered: 0, covered: 0 },
	): Promise<void> => {
		const failure: CollectionFailure = typeof reason === "string"
			? { origin: "source", cause: reason, ...counts } : reason;
		const enumeration = { kind: "enumerated" as const, complete: false,
			considered: failure.considered, covered: failure.covered };
		const message: EmittedMessage = stream === "profile"
			? { type: "SKIP_RESULT", stream, reason: "github_browser_incomplete",
				message: `GitHub did not return a complete result for this stream: ${failure.cause}.`,
				recovery_hint: { action: "retry_by_runtime", retryable: true } }
			: fullInventoryCoverage(stream, enumeration, failure.cause);
		if (message.type === "SKIP_RESULT") {
			message.diagnostics = { ...(asRecord(message.diagnostics) ?? {}), ...failure };
			const requestFailed = failure.origin === "source" && ["source_request_failed", "http_rate_limited", "http_status_failed", "wrong_navigation"].includes(failure.cause);
			// An unreadable embedded section (organizations, pinned, achievements) is a
			// failed read of the profile. github_browser_incomplete is not a portable
			// reason, so the runtime would end this run as a success.
			const sectionFailed = failure.origin === "source" && failure.collection !== undefined;
			if (requestFailed || sectionFailed) {
				const text = requestFailed
					? `GitHub requests for this stream failed: ${failure.cause}.`
					: `GitHub did not return a complete result for this stream: ${failure.cause}.`;
				const diagnostics = { ...asRecord(message.diagnostics), reason: failure.cause,
					...(failure.status === undefined ? {} : { source_error: `http_${failure.status}` }) };
				const recoveryHint = { action: "retry_by_runtime", retryable: true };
				if (context.reportStreamFailure) {
					try { await context.reportStreamFailure(stream, text, { diagnostics, recoveryHint, retryable: true }); }
					catch { throw new CollectionError({ ...counts, origin: "sink", cause: "message_emit_failed" }); }
					return;
				}
				if (requestFailed) {
					message.reason = "stream_collection_failed";
					message.message = text;
					message.diagnostics = diagnostics;
				}
			}
			if (failure.origin === "sink") {
				message.reason = "github_browser_publication_failed";
				message.message = `GitHub stream publication failed: ${failure.cause}.`;
			}
		}
		await emitMessage(message, failure);
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
		} catch (error) {
			if (error instanceof CollectionError && error.failure.origin === "sink" && error.failure.cause === "message_emit_failed") throw error;
			await incomplete(stream, error instanceof CollectionError ? error.failure
				: { origin: "source", cause: "collection_failed", considered: 0, covered: 0 });
		}
	};

	if (wants.has("profile")) {
		await runIsolated("profile", async () => {
			const url = `${GITHUB}/${username}`;
			// The contribution heading loads after the profile shell, so read the
			// profile through the loader that waits for the contribution section.
			const page = await sourceRequest(() => (services.openContributionPage ?? services.openPage)(url));
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
			const collectionFailure = parsed.collectionFailures[0];
			if (collectionFailure !== undefined) {
				await incomplete("profile", { ...collectionFailure, origin: "source", considered: 1, covered: 0 });
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
			// Singleton presence only, with readable embedded collections.
			// Never issue self coverage or derive deletes from these fields.
			if (await flush("profile")) {
				await checkpoint("profile", { fetched_at: services.now().toISOString() }, { considered: 1, covered: 1 });
			} else await incomplete("profile", "invalid_snapshot_shape");
		});
	}

	for (const stream of ["repositories", "starred"] as const) {
		if (!wants.has(stream)) continue;
		await runIsolated(stream, async () => {
			let covered = 0;
			const evidence = new InventoryEvidence(inventoryUrl(username, stream, 1), { pages: INVENTORY_PAGE_LIMIT });
			const counts = () => ({ considered: evidence.expectedTotal ?? evidence.identities.size, covered });
			for (let request = evidence.next; request !== null; request = evidence.next) {
				const inspect = (page: BrowserPageObservation, parsed: ReturnType<typeof inventoryRows>) => {
					const { distinct, noProgress } = evidence.previewPage(parsed.rows.map(row => row.id));
					return inspectInventoryPage(page, stream, username, request.page, distinct, parsed.rejectedRows, noProgress);
				};
				const read = async (url: string) => {
					const page = await sourceRequest(() => services.openPage(url), counts());
					const parsed = inventoryRows(stream, page.html);
					return { ...inspect(page, parsed), rows: parsed.rows, ids: parsed.rows.map(row => row.id),
						rowsComplete: parsed.entriesComplete, rejectedRows: parsed.rejectedRows };
				};
				const primary = await read(request.url);
				const alternate = stream === "starred" && request.page === 1 &&
					(primary.reason === "terminal_unverified" || primary.reason === "unreadable_list")
					? await read(`${GITHUB}/stars/${username}?page=1`) : undefined;
				const { selected, added } = evidence.observeRoutes(primary, alternate);
				for (const row of selected.rows) {
					if (added.delete(row.id) && await emitEntity(stream, row)) covered += 1;
				}
			}
			// Without an exact total, the REST list is the independent enumeration.
			if (stream === "starred" && evidence.decide(covered) === "terminal_unverified") {
				evidence.reconcile(await sourceRequest(() => enumerateStarredRest(
					restUrl => fetchJson(restUrl, counts()), username), counts()));
			}
			const reason = evidence.decide(covered);
			if (reason === null) await complete(stream, counts());
			else await incomplete(stream, reason, counts());
		});
	}

	if (wants.has("events")) {
		await runIsolated("events", async () => {
			const evidence = new InventoryEvidence(`${API}/users/${username}/events/public?per_page=100&page=1`, { pages: 3 });
			let considered = 0;
			let covered = 0;
			for (let request = evidence.next; request !== null; request = evidence.next) {
				const response = await fetchJson(request.url, { considered, covered });
				if (!Array.isArray(response.data)) {
					evidence.fail("invalid_events_response");
					break;
				}
				considered += response.data.length;
				const events = response.data.map(raw => parseLegacyEventPageItem(raw));
				const rows = events.flatMap(parsed => parsed.row === null ? [] : [parsed.row]);
				const added = evidence.observePage({ ids: rows.map(row => row.id), rowsComplete: events.every(parsed => parsed.complete),
					rejectedRows: events.length - rows.length,
					...inspectApiWindow(response.link, request.url, response.data.length) });
				for (const event of rows) {
					if (added.delete(event.id) && await emitEntity("events", event)) covered += 1;
				}
			}
			// Neither a short page nor our loop limit establishes the source end.
			const reason = evidence.decide(covered);
			if (reason === null) await complete("events", { considered, covered });
			else await incomplete("events", reason, { considered, covered });
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
			let sourceFailure: CollectionFailure | null = null;
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
					sourceFailure ??= { origin: "source", cause: "source_request_failed", considered, covered: 0 };
					continue;
				}
				if (
					!sameNavigation(page.requestedUrl, page.currentUrl) ||
					page.currentUrl !== url ||
					!hasExpectedOwner(page.html, username)
				) {
					sourceFailure ??= { origin: "source", cause: "wrong_page_or_owner", considered, covered: 0 };
					continue;
				}
				const graph = parseContributionHtml(page.html);
				if (!graph.complete) sourceFailure ??= { origin: "source", cause: "year_view_unavailable", considered, covered: 0 };
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
						const prior = days.get(day.date); // Keep the first (rolling) view's relative color level.
						if (prior?.count !== day.count)
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
				sourceFailure !== null ||
				snapshot === null ||
				rejected > 0 ||
				covered !== days.size + (snapshot === null ? 0 : 1)
			) {
				await incomplete(
					"contributions",
					sourceFailure !== null
						? { ...sourceFailure, considered, covered }
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
			const issueResult = await collectHistoryType("issue");
			if (issueResult.failure !== null) {
				await incomplete("history", issueResult.failure);
				return;
			}
			const prResult = await collectHistoryType("pr");
			const considered = issueResult.considered + prResult.considered;
			const covered = issueResult.covered + prResult.covered;
			if (prResult.failure !== null) {
				await incomplete(
					"history",
					{ ...prResult.failure, considered, covered },
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
		const query = encodeURIComponent(`author:${username} ${type === "pr" ? "type:pr" : "type:issue"}`);
		// The API caps this search window, not the underlying authored history.
		const window = HISTORY_PAGE_SIZE * HISTORY_PAGE_LIMIT;
		const evidence = new InventoryEvidence(
			`${API}/search/issues?q=${query}&sort=created&order=desc&per_page=${HISTORY_PAGE_SIZE}&page=1`,
			{ pages: HISTORY_PAGE_LIMIT, window },
		);
		let covered = 0;
		let capped = false;
		const counts = () => ({ considered: evidence.expectedTotal ?? evidence.identities.size, covered });
		for (let request = evidence.next; request !== null; request = evidence.next) {
			if (request.page > 1) await services.sleep(6500);
			let response: Awaited<ReturnType<BrowserServices["fetchPublicJson"]>>;
			try { response = await fetchJson(request.url, counts()); }
			catch (error) {
				if (!(error instanceof CollectionError)) throw error;
				return { failure: error.failure, capped, ...counts() };
			}
			const body = asRecord(response.data);
			if (body?.incomplete_results === true) {
				evidence.fail("search_incomplete_results");
				break;
			}
			if (
				body === null ||
				!Array.isArray(body.items) ||
				body.incomplete_results !== false ||
				typeof body.total_count !== "number" ||
				!Number.isInteger(body.total_count) ||
				body.total_count < 0
			) {
				evidence.fail("malformed_search_response");
				break;
			}
			evidence.addTotals({ exactTotals: [body.total_count], totalConflict: false });
			capped ||= body.total_count > window;
			const items = body.items.map(raw => parseLegacyHistoryPageItem(raw, type));
			const rows = items.flatMap(parsed => parsed.row === null ? [] : [parsed.row]);
			// The walk ends on GitHub's Link end, and decide() then requires every
			// identity in the stable window. Short pages and our page budget prove nothing.
			const added = evidence.observePage({ ids: rows.map(row => row.id), rowsComplete: items.every(parsed => parsed.complete),
				rejectedRows: items.length - rows.length,
				...inspectApiWindow(response.link, request.url, body.items.length) });
			for (const item of rows) {
				if (added.delete(item.id) && await emitEntity("history", item)) covered += 1;
			}
		}
		const cause = evidence.decide(covered);
		return { failure: cause === null ? null : { origin: "source", cause, ...counts() }, capped, ...counts() };
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

/** REST supplies enumeration evidence; browser rows remain the emitted payload. */
async function enumerateStarredRest(
	fetchPublicJson: BrowserServices["fetchPublicJson"],
	username: string,
): Promise<InventoryEvidence> {
	const rest = new InventoryEvidence(`${API}/users/${username}/starred?per_page=100&page=1`, { pages: INVENTORY_PAGE_LIMIT });
	for (let request = rest.next; request !== null; request = rest.next) {
		const response = await fetchPublicJson(request.url);
		if (!Array.isArray(response.data)) {
			rest.fail("invalid_starred_rest_response");
			break;
		}
		const ids = response.data.flatMap(raw => {
			const repo = asRecord(raw);
			const name = repo?.full_name;
			return typeof name === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(name) &&
				repo?.html_url === `${GITHUB}/${name}` ? [`${GITHUB}/${name}`] : [];
		});
		rest.observePage({ ids, rowsComplete: true, rejectedRows: response.data.length - ids.length,
			...inspectApiWindow(response.link, request.url, response.data.length) });
	}
	return rest;
}
