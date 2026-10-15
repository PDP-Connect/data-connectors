#!/usr/bin/env node

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PDPP Notion Connector (v0.1.0)
 *
 * Auth: Notion internal integration token via NOTION_API_TOKEN env var.
 * Create at https://www.notion.so/profile/integrations. The integration must
 * be explicitly shared with each page/database (Notion security model).
 *
 * API: https://api.notion.com/v1/search (POST)
 * Rate limit: 3 req/s average.
 */

import type { EmittedMessage } from "@pdpp/connector-protocol";
import { createConnectorHttpGovernor } from "../../packages/polyfill-connectors/src/connector-http-governor.ts";
import {
	buildDetailCoverageMessage,
	politeDelay,
	runConnector,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import {
	emitRow,
	type RowRead,
} from "../../packages/polyfill-connectors/src/field-reader.ts";
import { notionPacingProfile } from "../../packages/polyfill-connectors/src/provider-profile.ts";
import { databaseRow, lastEditedTimeOf, pageRow } from "./records.ts";
import { validateRecord } from "./schemas.ts";

// Single per-provider send governor + retry layer. `maxAttempts: 1` keeps the
// 429 throw byte-identical (cross-run cooldown via `retryablePattern`).
// §3 ProviderProfile: notion declares its own AUDITED pacing ceiling (500ms ≈
// 2 req/s, ~67% of Notion's documented 3 req/s average; WI-1b). NOT a borrow of
// ChatGPT's 250ms. See src/provider-profile.ts → notionPacingProfile and
// docs/research/per-connector-rate-profiles-2026-06-13.md for the derivation.
const httpGovernor = createConnectorHttpGovernor({
	name: "notion",
	maxAttempts: 1,
	profile: notionPacingProfile(),
});

const API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";
const PAGE_SIZE = 100;
const POLITE_DELAY_MS = 400;

interface ProgressExtra {
	cursor_present?: boolean;
	item_count?: number;
	page_index?: number;
	phase?: string;
	rate_limit_pressure?: number;
	stream?: string;
	total_seen?: number;
}

interface NotionSearchResponse {
	has_more?: boolean;
	next_cursor?: string | null;
	results: unknown;
}

interface NotionSearchFilter {
	property: string;
	value: string;
}

interface NotionSearchBody {
	filter?: NotionSearchFilter;
	page_size: number;
	sort: { direction: string; timestamp: string };
	start_cursor?: string;
}

async function ntn(
	path: string,
	token: string,
	body: NotionSearchBody,
	progress?: (message: string, extra?: ProgressExtra) => Promise<void>,
	extra?: ProgressExtra,
): Promise<NotionSearchResponse> {
	let raw: { body: string; status: number };
	try {
		const r = await httpGovernor.request<
			{ body: string; status: number },
			{ body: string; status: number }
		>(
			async () => {
				const res = await fetch(`${API}${path}`, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${token}`,
						"Notion-Version": NOTION_VERSION,
						"Content-Type": "application/json",
					},
					body: JSON.stringify(body),
				});
				const retryAfter = res.headers.get("retry-after");
				return {
					body: await res.text().catch((): string => ""),
					...(retryAfter === null
						? {}
						: { headers: { "retry-after": retryAfter } }),
					status: res.status,
				} as { body: string; status: number };
			},
			(resp) => ({ status: resp.status, value: resp }),
		);
		raw = r.value;
	} catch (error) {
		if (error instanceof Error && error.message === "notion_rate_limited") {
			await progress?.("Notion search rate limited", {
				...extra,
				phase: "rate_limit",
				rate_limit_pressure: 1,
			});
		}
		throw error;
	}
	if (raw.status === 401) {
		throw new Error("notion_auth_failed");
	}
	if (raw.status < 200 || raw.status >= 300) {
		throw new Error(
			`notion_http_${String(raw.status)}: ${raw.body.slice(0, 200)}`,
		);
	}
	return JSON.parse(raw.body) as NotionSearchResponse;
}

async function searchAll(
	token: string,
	filter: NotionSearchFilter | undefined,
	progress: (message: string, extra?: ProgressExtra) => Promise<void>,
	streamName: string,
): Promise<unknown[]> {
	const results: unknown[] = [];
	let cursor: string | undefined;
	let pageIndex = 0;
	for (;;) {
		const body: NotionSearchBody = {
			sort: { direction: "descending", timestamp: "last_edited_time" },
			page_size: PAGE_SIZE,
		};
		if (filter) {
			body.filter = filter;
		}
		if (cursor) {
			body.start_cursor = cursor;
		}
		const pageExtra = {
			stream: streamName,
			phase: "fetch",
			page_index: pageIndex,
			total_seen: results.length,
			cursor_present: Boolean(cursor),
		};
		await progress("Fetching Notion search page", pageExtra);
		const json = await ntn("/search", token, body, progress, pageExtra);
		// A page without a readable results list is not an empty page.
		if (!Array.isArray(json.results))
			throw new Error("notion_search_results_unreadable");
		results.push(...json.results);
		await progress("Fetched Notion search page", {
			stream: streamName,
			phase: "page",
			page_index: pageIndex,
			item_count: json.results?.length ?? 0,
			total_seen: results.length,
			cursor_present: Boolean(json.has_more && json.next_cursor),
		});
		if (json.has_more !== true) {
			break;
		}
		// `has_more` is the provider's claim that another page exists. A missing
		// cursor contradicts that claim, so stopping here would silently hide the
		// unfetched tail and let runStream advance its edit-time watermark past
		// data this run never enumerated.
		const nextCursor = json.next_cursor;
		if (typeof nextCursor !== "string" || nextCursor.trim().length === 0) {
			throw new Error("notion_pagination_contradiction");
		}
		cursor = nextCursor;
		pageIndex += 1;
		await politeDelay(POLITE_DELAY_MS);
	}
	return results;
}

interface RunStreamArgs {
	emit: (msg: EmittedMessage) => Promise<void>;
	emitRecord: Parameters<typeof emitRow>[0]["emitRecord"];
	filter: NotionSearchFilter;
	progress: (message: string, extra?: ProgressExtra) => Promise<void>;
	state: Record<string, unknown>;
	streamName: string;
	token: string;
	toRow: (o: unknown) => RowRead;
}

async function runStream(args: RunStreamArgs): Promise<void> {
	const {
		streamName,
		filter,
		toRow,
		state,
		token,
		emit,
		emitRecord,
		progress,
	} = args;
	await progress(`Searching ${streamName}`, {
		stream: streamName,
		phase: "start",
	});
	const items = await searchAll(token, filter, progress, streamName);
	const streamState = state[streamName] as
		| { last_edited_time?: string }
		| undefined;
	const prior = streamState?.last_edited_time;
	let latest = prior;
	// Rows this run accounted for: handed to the runtime as covered rows, or
	// suppressed as unchanged. NEVER aliased to `items.length`. A row with an
	// unreadable field is withheld by the runtime (emitRow returns false), and
	// the runtime then withholds this stream's STATE. A row the output schema
	// rejects is one the connector cannot see; the runtime subtracts it from
	// `covered` and withholds STATE too, so there is no validation here.
	let covered = 0;
	for (const item of items) {
		const edited = lastEditedTimeOf(item);
		if (prior && edited.kind === "read" && edited.value <= prior) {
			// Suppressed-unchanged: an earlier run's identical content was stored.
			covered += 1;
			continue;
		}
		if (!(await emitRow({ emitRecord }, streamName, toRow(item)))) continue;
		covered += 1;
		if (edited.kind === "read" && (!latest || edited.value > latest)) {
			latest = edited.value;
		}
	}
	await progress(`Emitted ${streamName}`, {
		stream: streamName,
		phase: "emit",
		item_count: items.length,
		total_seen: items.length,
		cursor_present: Boolean(latest || prior),
	});
	// The search result is the complete enumeration boundary for this stream.
	// Emit measured full-scan evidence even when it is empty; record counts alone
	// cannot distinguish a verified empty workspace from missing coverage proof.
	//
	// `considered` is that boundary (`items.length`, measured at the enumeration
	// site); `covered` is the independently tallied count above, so a page the
	// schema rejected reads a real `partial` instead of being silently absorbed.
	// `buildFullScanCoverageMessage` is deliberately NOT used: it forces
	// `covered === considered`, which cannot express a dropped page.
	//
	// Deletion-safe by construction: Notion reports a deleted page IN-BAND as
	// `archived: true` rather than omitting it, so a deletion stays inside the
	// boundary, is validated like any other row, and counts as covered. The
	// runtime turns it into a tombstone (`isTombstone`, below). An upstream
	// deletion is therefore a covered fact, never a coverage gap — which is what
	// keeps this proof from firing on PDPP's deliberate retention of records the
	// provider has since removed.
	await emit(
		buildDetailCoverageMessage({
			stream: streamName,
			stateStream: streamName,
			requiredKeys: [],
			hydratedKeys: [],
			considered: items.length,
			covered,
		}),
	);
	await emit({
		type: "STATE",
		stream: streamName,
		cursor: { last_edited_time: latest || prior || null },
	});
}

runConnector({
	name: "notion",
	validateRecord,
	retryablePattern: /ECONN|fetch failed|rate_limited/i,
	auth: { kind: "env", required: ["NOTION_API_TOKEN"] },
	// Notion marks deleted items with archived=true rather than omitting them.
	isTombstone: (_stream, d) => d.archived === true,
	async collect({ state, requested, credentials, emit, emitRecord, progress }) {
		const token = credentials.NOTION_API_TOKEN;
		if (!token) {
			throw new Error("notion_auth_failed");
		}

		if (requested.has("pages")) {
			await runStream({
				streamName: "pages",
				filter: { property: "object", value: "page" },
				toRow: pageRow,
				state,
				token,
				emit,
				emitRecord,
				progress,
			});
		}

		if (requested.has("databases")) {
			await runStream({
				streamName: "databases",
				filter: { property: "object", value: "database" },
				toRow: databaseRow,
				state,
				token,
				emit,
				emitRecord,
				progress,
			});
		}
	},
});
