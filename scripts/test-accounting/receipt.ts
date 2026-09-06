// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

const RESULT_PREFIX = "PDPP_TEST_ACCOUNTING_RESULT ";
const EVENT_PREFIX = "PDPP_TEST_ACCOUNTING_EVENT ";

function fail(message: string): never {
	throw new Error(`test accounting result: ${message}`);
}
function compareStrings(a: string, b: string): number {
	if (a < b) {
		return -1;
	}
	if (a > b) {
		return 1;
	}
	return 0;
}

export function accountingResultLine(result: unknown): string {
	return `${RESULT_PREFIX}${JSON.stringify(result)}`;
}
export function accountingEventLine(event: unknown): string {
	return `${EVENT_PREFIX}${JSON.stringify(event)}`;
}

// Exact destination fixture mappings. Profile declarations are reviewed policy,
// never learned from whichever skips happen to appear in a run.
export type NamedSkipMappingRow = readonly [
	string,
	string,
	string,
	readonly string[],
];
export interface NamedSkipMappingTable {
	profiles: Readonly<Record<string, readonly string[]>>;
	rows: readonly NamedSkipMappingRow[];
}
export function validateNamedSkipMappingTable(
	table: NamedSkipMappingTable,
): NamedSkipMappingTable {
	const names = new Set<string>();
	for (const [name, reason, suite, profiles] of table.rows) {
		if (names.has(name)) fail(`duplicate configured mapping row: ${name}`);
		if (
			!name ||
			!reason.trim() ||
			!profiles.length ||
			new Set(profiles).size !== profiles.length ||
			profiles.some((profile) => !table.profiles[suite]?.includes(profile))
		) {
			fail(`invalid named skip mapping scope: ${name}`);
		}
		names.add(name);
	}
	return table;
}
export const DESTINATION_NAMED_SKIP_MAPPING_TABLE =
	validateNamedSkipMappingTable({
		profiles: { "polyfill-connectors": ["default"] },
		rows: [
			[
				"parseOrdersListDom: local real fixture parses ≥5 orders with ids + dates",
				"local Amazon raw-DOM fixture directory not present",
				"polyfill-connectors",
				["default"],
			],
			[
				"parseOrderDetailDom: local real fixtures yield items and grand_total",
				"local Amazon raw-DOM fixture directory not present",
				"polyfill-connectors",
				["default"],
			],
			[
				"parseDashboardAccountsDom: local real capture parses ≥1 account",
				"local Chase raw-DOM fixture directory not present",
				"polyfill-connectors",
				["default"],
			],
			[
				"parseStatementsListDom: local real capture parses ≥1 statement row",
				"local Chase raw-DOM fixture directory not present",
				"polyfill-connectors",
				["default"],
			],
			[
				"parseCurrentActivityDom: local real capture — dashboard-accounts.html parses ≥1 MDS row",
				"local Chase raw-DOM fixture directory not present",
				"polyfill-connectors",
				["default"],
			],
			[
				"parseModernCheckingEra: local statement text parses ≥1 txn (smoke)",
				"local USAA raw fixture directory not present",
				"polyfill-connectors",
				["default"],
			],
		],
	});
export function configuredNamedSkipMappingIdentities(
	suite: string,
	profile: string,
	table: NamedSkipMappingTable = DESTINATION_NAMED_SKIP_MAPPING_TABLE,
): readonly string[] {
	validateNamedSkipMappingTable(table);
	if (!table.profiles[suite]?.includes(profile))
		fail(`unrecognized named skip mapping suite/profile: ${suite}/${profile}`);
	return table.rows
		.filter(
			([, , scope, profiles]) => scope === suite && profiles.includes(profile),
		)
		.map(([name]) => name);
}
const reasonsByName = new Map(
	DESTINATION_NAMED_SKIP_MAPPING_TABLE.rows.map(([name, reason]) => [
		name,
		reason,
	]),
);
export function resolveNamedSkipMapping(
	name: string | undefined,
): { reason: string; identity: string } | undefined {
	if (name === undefined) return;
	const reason = reasonsByName.get(name);
	return reason === undefined ? undefined : { reason, identity: name };
}
// Property 3 — the exact-set runtime join. Given the identities a complete run
// actually CONSUMED (each emitted skip that resolved through a named-mapping
// row) and the CONFIGURED rows for that suite scope, require exact set
// equality. Stale/unmatched configured rows (configured MINUS consumed) fail
// closed; a consumed identity absent from the configured set (which cannot
// happen while resolution routes through the same rows, but is checked for
// defence in depth) also fails. Loop-generated 1-to-N identities pass
// naturally because the join is over emitted identities, never over static
// source occurrences. This is NOT a count of source text — it is identity
// membership, which is the only sound join across a runner that expands loops.
export function assertNamedSkipMappingsFullyConsumed(
	consumed: Iterable<string>,
	configured: readonly string[],
): void {
	const consumedSet = new Set(consumed);
	const configuredSet = new Set(configured);
	const staleRows = configured.filter((identity) => !consumedSet.has(identity));
	if (staleRows.length > 0) {
		fail(
			`stale named skip mapping rows (configured but no emitted skip consumed them): ${staleRows.join("; ")}`,
		);
	}
	const unconfigured = [...consumedSet].filter(
		(identity) => !configuredSet.has(identity),
	);
	if (unconfigured.length > 0) {
		fail(
			`emitted skip consumed a named mapping that is not configured for this suite: ${unconfigured.join("; ")}`,
		);
	}
}

export interface StructuredSummary {
	assertions: number;
	// The named-mapping identities this (per-file) summary CONSUMED — i.e. the
	// emitted skips whose reason came from an exact named mapping row rather than
	// from a self-describing skip value or a `(skipped: ...)` title suffix. The
	// suite finalizer unions these across all files and joins them against the
	// configured rows for the suite scope (property 3). A single file cannot see
	// the whole configured set, so this carries the per-file evidence upward.
	consumed_mapping_identities: string[];
	failed: number;
	passed: number;
	skip_reasons: Record<string, number>;
	skipped: number;
}

interface NodeTestEventDetails {
	name?: string;
	skip?: boolean | string;
	type?: string;
}
interface NodeTestEvent {
	details?: NodeTestEventDetails;
	type: string;
}

const SKIP_REASON_SUFFIX_PATTERN =
	/\(skipped:\s*([^)]+)\)|:\s*skipped\s*\(([^)]+)\)/i;

// Resolve one emitted skip to its declared reason, in the same precedence the
// authority trusts: (1) a string skip value is self-describing; (2) a
// `(skipped: ...)` title suffix is self-describing; (3) otherwise an exact
// named-mapping row supplies the reason and is recorded as CONSUMED so the
// suite finalizer's property-3 join can see it. `consumedIdentity` is set only
// for path (3) — the two self-describing paths consume no configured row.
function resolveEmittedSkipReason(
	skip: boolean | string,
	name: string | undefined,
): { reason: string | undefined; consumedIdentity?: string } {
	if (typeof skip === "string") {
		return { reason: skip.trim() };
	}
	const suffix = name
		?.match(SKIP_REASON_SUFFIX_PATTERN)
		?.slice(1)
		.find(Boolean)
		?.trim();
	if (suffix) {
		return { reason: suffix };
	}
	const mapping = resolveNamedSkipMapping(name);
	return mapping
		? { reason: mapping.reason, consumedIdentity: mapping.identity }
		: { reason: undefined };
}

export function structuredNodeSummary(output: string): StructuredSummary {
	const events: NodeTestEvent[] = output
		.split("\n")
		.filter((line) => line.startsWith(EVENT_PREFIX))
		.map((line) => {
			try {
				return JSON.parse(line.slice(EVENT_PREFIX.length));
			} catch {
				return fail("reporter emitted malformed structured event");
			}
		});
	if (events.length === 0) {
		fail("runner emitted no structured node events");
	}
	const skipReasons: Record<string, number> = {};
	const consumedMappingIdentities: string[] = [];
	let assertions = 0;
	let passed = 0;
	let failed = 0;
	let skipped = 0;
	for (const event of events) {
		if (
			!["test:pass", "test:fail"].includes(event.type) ||
			event.details?.type !== "test"
		) {
			continue;
		}
		assertions += 1;
		const { skip } = event.details;
		if (skip !== false && skip !== undefined && skip !== null) {
			const { reason, consumedIdentity } = resolveEmittedSkipReason(
				skip,
				event.details.name,
			);
			if (!reason) {
				fail(`unexplained skip: ${event.details.name ?? "unnamed test"}`);
			}
			if (consumedIdentity !== undefined) {
				consumedMappingIdentities.push(consumedIdentity);
			}
			skipped += 1;
			skipReasons[reason] = (skipReasons[reason] ?? 0) + 1;
		} else if (event.type === "test:pass") {
			passed += 1;
		} else {
			failed += 1;
		}
	}
	return {
		assertions,
		passed,
		failed,
		skipped,
		skip_reasons: skipReasons,
		consumed_mapping_identities: consumedMappingIdentities,
	};
}

export function structuredPythonSummary(
	output: string,
	status: number,
): StructuredSummary {
	const assertions = [...output.matchAll(/Ran (\d+) tests? in /g)].reduce(
		(sum, match) => sum + Number.parseInt(match[1] ?? "0", 10),
		0,
	);
	if (assertions === 0) {
		fail("python runner emitted no test count");
	}
	const skipReasons: Record<string, number> = {};
	for (const match of output.matchAll(/^.+\.\.\. skipped ['"](.+)['"]$/gm)) {
		const reason = match[1]?.trim() ?? "";
		if (!reason) {
			fail("python runner emitted an unexplained skip");
		}
		skipReasons[reason] = (skipReasons[reason] ?? 0) + 1;
	}
	const reportedSkips = [...output.matchAll(/skipped=(\d+)/g)].reduce(
		(sum, match) => sum + Number.parseInt(match[1] ?? "0", 10),
		0,
	);
	if (
		reportedSkips !==
		Object.values(skipReasons).reduce((sum, count) => sum + count, 0)
	) {
		fail("python runner omitted a skip reason");
	}
	const failed = [
		...output.matchAll(/(?:failures|errors|unexpected successes)=(\d+)/g),
	].reduce((sum, match) => sum + Number.parseInt(match[1] ?? "0", 10), 0);
	if (status !== 0 && failed === 0) {
		fail("python runner failed without structured failure count");
	}
	const passed = assertions - failed - reportedSkips;
	if (passed < 0) {
		fail("python runner emitted inconsistent counts");
	}
	// Python's verbose runner names its skip reason inline (`skipped '...'`), so
	// no exact named-mapping row is consumed — the Python path never routes
	// through resolveNamedSkipMapping.
	return {
		assertions,
		passed,
		failed,
		skipped: reportedSkips,
		skip_reasons: skipReasons,
		consumed_mapping_identities: [],
	};
}

export function readStructuredChildResult(output: string): unknown {
	const lines = output
		.split("\n")
		.filter((line) => line.startsWith(RESULT_PREFIX));
	if (lines.length !== 1) {
		fail("runner must emit exactly one structured result");
	}
	try {
		return JSON.parse(lines[0]?.slice(RESULT_PREFIX.length) ?? "");
	} catch {
		fail("runner emitted malformed structured result");
	}
}

export function repositoryPaths(directory: string, paths: string[]): string[] {
	return paths
		.map((path) => `${directory}/${path}`.replaceAll("\\", "/"))
		.sort(compareStrings);
}
