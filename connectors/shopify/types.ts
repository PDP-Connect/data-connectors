// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Parsed shapes for the Shopify (Shop app) connector. Extracted from
// index.ts so parsers.ts and tests can import them without pulling in the
// Playwright-flavored runtime entry.

/**
 * The subset of the Apollo `InMemoryCache.extract()` output this connector
 * reads. Apollo normalizes every GraphQL object into a flat map keyed by
 * `__typename:id`; `Order:<id>` entries and their referenced `Shop`/
 * `ProductVariant`-ish line-item entries are the only shapes this connector
 * cares about. Everything else in the cache (UI state, unrelated queries) is
 * untyped here on purpose — this connector only ever reads the paths below.
 */
export type ApolloCache = Record<string, unknown>;

export type ApolloCacheEntry = Record<string, unknown>;

export interface ApolloRef {
	__ref: string;
}

export function isApolloRef(value: unknown): value is ApolloRef {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { __ref?: unknown }).__ref === "string"
	);
}

/** One order as extracted from the Apollo cache, before record shaping. */
export interface ParsedOrder {
	currency: string | null;
	detailUrl: string;
	id: string;
	itemCount: number | null;
	lineItemTitles: string[];
	merchantName: string | null;
	orderNumber: string | null;
	placedAt: string | null;
	status: string | null;
	totalCents: number | null;
}
