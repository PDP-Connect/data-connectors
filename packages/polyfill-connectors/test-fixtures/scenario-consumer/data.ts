// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { CollectContext } from "../../src/connector-runtime.ts";

export const DEFAULT_BASE_URL = "http://127.0.0.1:41731";
export const ITEMS_STREAM = "items";

export type FixtureChange =
	| { id: string; op: "delete" }
	| { id: string; op: "upsert"; value: string };

export interface FixturePage {
	changes: FixtureChange[];
	next_cursor: string | null;
	since: string | null;
}

export function fixturePage(url: URL): FixturePage {
	const since = url.searchParams.get("since");
	const cursor = url.searchParams.get("cursor");

	if (since === "item-3") {
		return {
			changes: [
				{ id: "item-3", op: "upsert", value: "updated" },
				{ id: "item-1", op: "delete" },
				{ id: "item-4", op: "upsert", value: "delta" },
			],
			next_cursor: null,
			since: "item-4",
		};
	}

	if (cursor === "page-2") {
		return {
			changes: [
				{ id: "item-3", op: "upsert", value: "charlie" },
				{ id: "obsolete-item", op: "delete" },
			],
			next_cursor: null,
			since: "item-3",
		};
	}
	if (since || cursor) {
		throw new Error("local reference site received an unknown cursor");
	}

	return {
		changes: [
			{ id: "item-1", op: "upsert", value: "alpha" },
			{ id: "item-2", op: "upsert", value: "bravo" },
		],
		next_cursor: "page-2",
		since: null,
	};
}

export function itemRequestUrl(
	baseUrl: string,
	options: { cursor?: string; since?: string },
): string {
	const url = new URL("/api/items", baseUrl);
	if (options.since) url.searchParams.set("since", options.since);
	if (options.cursor) url.searchParams.set("cursor", options.cursor);
	return url.toString();
}

function savedCursor(state: Record<string, unknown>): string | undefined {
	const items = state[ITEMS_STREAM];
	if (!items || typeof items !== "object") return undefined;
	const since = (items as Record<string, unknown>).since;
	return typeof since === "string" ? since : undefined;
}

export async function collectFixtureItems(
	context: Pick<CollectContext, "emit" | "emitRecord" | "state">,
	baseUrl: string,
	fetchPage: (url: string) => Promise<FixturePage>,
): Promise<void> {
	const since = savedCursor(context.state);
	let cursor: string | undefined;
	let finalSince: string | undefined;

	await context.emit({
		type: "PROGRESS",
		stream: ITEMS_STREAM,
		message: "collecting local reference items",
	});

	for (let pageNumber = 0; pageNumber < 4; pageNumber += 1) {
		const page = await fetchPage(itemRequestUrl(baseUrl, { cursor, since }));
		for (const change of page.changes) {
			const record =
				change.op === "delete"
					? { id: change.id, op: change.op }
					: { id: change.id, value: change.value };
			await context.emitRecord(ITEMS_STREAM, record);
		}
		if (!page.next_cursor) {
			finalSince = page.since ?? undefined;
			break;
		}
		cursor = page.next_cursor;
	}

	if (!finalSince) {
		throw new Error("local reference site returned no terminal cursor");
	}
	await context.emit({
		type: "STATE",
		stream: ITEMS_STREAM,
		cursor: { since: finalSince },
	});
}

export function validateRecord(
	stream: string,
	data: Record<string, unknown>,
): { ok: true; data: Record<string, unknown> } | { ok: false; issues: { path: string; message: string }[] } {
	if (
		stream === ITEMS_STREAM &&
		typeof data.id === "string" &&
		typeof data.value === "string"
	) {
		return { ok: true, data };
	}
	return {
		ok: false,
		issues: [{ path: "id", message: "expected an item id and value" }],
	};
}

export function isTombstone(_stream: string, data: Record<string, unknown>): boolean {
	return data.op === "delete";
}
