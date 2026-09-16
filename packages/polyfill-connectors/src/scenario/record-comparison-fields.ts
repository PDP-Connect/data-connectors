// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Which record fields participate in the scenario oracle's record comparison.
 *
 * WHY THIS EXISTS. `scenario-record` stores a sha256 of each emitted record's
 * canonical JSON, and `scenario-verify` recomputes it on replay: a refactor
 * that changes a record fails loudly. Some connectors write a COLLECTION-TIME
 * value into the record's hashed `data` — `fetched_at: nowIso()` is the common
 * shape — so the same record hashes differently on every run and the oracle can
 * never pass. Observed live: the same reddit record captured twice ten seconds
 * apart, with no replay involved, produced two different hashes.
 *
 * WHY NOT A NAME RULE. Excluding `*_at`/`*_date` by pattern is wrong here.
 * Across this connector fleet `created_at`, `sent_at`, `watched_at` and
 * `order_date` are PROVIDER data — exactly what the oracle exists to catch
 * changes in. Any pattern broad enough to catch `fetched_at` eventually eats
 * one of those, silently, and a silently-weakened oracle is worse than a
 * failing one.
 *
 * WHY THIS SOURCE. The exclusion is AUTHOR-DECLARED PER FIELD, on the stream's
 * own manifest entry — the same shape mature snapshot/approval oracles use
 * (Jest property matchers, Insta redactions, Pact `matchingRules`), and the
 * same declaration the resource server's history compactor already reads to
 * decide whether a re-ingest changed anything. Both callers ask one question —
 * "did this record actually change?" — so they read one answer rather than
 * drifting apart.
 *
 * FAIL-SAFE DIRECTION. A stream with no declaration, or an unreadable manifest
 * set, excludes NOTHING and is hashed whole. A missing declaration therefore
 * costs a loud failure, never a silent pass.
 *
 * WHAT THIS COSTS. An excluded field is no longer verified: a `fetched_at` that
 * came back malformed would not be caught here. That is the same trade every
 * surveyed oracle makes, and it is narrower than the alternative of not
 * verifying these connectors at all.
 *
 * NAMING. The declaration is currently `compaction_fingerprint`, named for its
 * first consumer. This module is its second. If a third appears, rename the
 * manifest key to something consumer-neutral — deliberately not done here,
 * because renaming a shipped manifest field for a single new reader costs more
 * than it buys.
 */

import { readPolyfillManifests } from "../manifest-registry.ts";

interface ManifestStreamLike {
	readonly compaction_fingerprint?: { readonly exclude_keys?: unknown };
	readonly name?: unknown;
}

interface ManifestLike {
	readonly connector_id?: unknown;
	readonly connector_key?: unknown;
	readonly streams?: readonly ManifestStreamLike[];
}

/** Connector identity as written in the manifest. Both `connector_key` and
 *  `connector_id` are present in the shipped manifests; read each in turn
 *  rather than assuming one, and compare on a normalized form (see
 *  `normalizeConnectorKey`). */
function manifestConnectorKey(manifest: ManifestLike): string | undefined {
	for (const candidate of [manifest.connector_key, manifest.connector_id]) {
		if (typeof candidate === "string" && candidate.length > 0) {
			return candidate;
		}
	}
	return undefined;
}

/** Manifest keys and runtime connector ids disagree on separator for some
 *  connectors (`claude_code` vs `claude-code`), so compare on a normalized
 *  form rather than requiring callers to know which they hold. */
function normalizeConnectorKey(key: string): string {
	return key.replace(/[-_]/g, "").toLowerCase();
}

export type ExcludedFieldsByStream = ReadonlyMap<string, readonly string[]>;

/**
 * Declared comparison exclusions for every stream of `connectorKey`, keyed by
 * stream name. Streams with no declaration are absent from the map (hash the
 * whole record). Returns an empty map when the manifest set cannot be read —
 * see FAIL-SAFE DIRECTION above.
 */
export function readExcludedComparisonFields(
	connectorKey: string,
): ExcludedFieldsByStream {
	const wanted = normalizeConnectorKey(connectorKey);
	const byStream = new Map<string, readonly string[]>();
	let entries: readonly { manifest: unknown }[];
	try {
		entries = readPolyfillManifests();
	} catch {
		return byStream;
	}
	for (const entry of entries) {
		const manifest = entry.manifest as ManifestLike;
		const key = manifestConnectorKey(manifest);
		if (key === undefined || normalizeConnectorKey(key) !== wanted) {
			continue;
		}
		for (const stream of manifest.streams ?? []) {
			const name = stream.name;
			const excluded = stream.compaction_fingerprint?.exclude_keys;
			if (typeof name !== "string" || !Array.isArray(excluded)) {
				continue;
			}
			const fields = excluded.filter((f): f is string => typeof f === "string");
			if (fields.length > 0) {
				byStream.set(name, fields);
			}
		}
	}
	return byStream;
}

/**
 * `data` with each declared field removed, ready to hash. Only top-level keys
 * are excluded, matching the compactor's own `exclude_keys` semantics — a
 * nested volatile value is not expressible today and would need the
 * declaration to grow a path syntax first.
 *
 * A non-object `data` (or an empty exclusion list) is returned unchanged, so
 * the common case allocates nothing.
 */
export function projectRecordForComparison(
	data: unknown,
	excludedFields: readonly string[],
): unknown {
	if (
		excludedFields.length === 0 ||
		typeof data !== "object" ||
		data === null ||
		Array.isArray(data)
	) {
		return data;
	}
	const source = data as Record<string, unknown>;
	if (!excludedFields.some((field) => field in source)) {
		return data;
	}
	const projected: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(source)) {
		if (!excludedFields.includes(key)) {
			projected[key] = value;
		}
	}
	return projected;
}
