// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure, opt-in validator for "did this list walk reach the end of its scope?".
 *
 * A connector maps what it observed to a `ListRead` and calls `settle`. The
 * result says what the facts can support. Nothing here emits a message,
 * writes STATE, reads a clock or does I/O, and no existing connector calls it.
 * A connector can ignore the result or call `ctx.emit` directly, so this is a
 * local guard, not runtime enforcement.
 *
 * Limit of the evidence: every field of `ListRead` is supplied by the caller.
 * `settle` checks that the facts agree with each other and with the row
 * counts. It cannot check that they are true, and it is not proof of source
 * state or of host durability. A page that says "no next page" does not prove
 * the chain before it (pages A, B, C with B skipped still ends at C), so a
 * chain end also needs a contiguous-traversal record.
 *
 * Anything missing, unknown, mistyped or contradictory yields the first-class
 * outcome `unproven` with a closed reason. Output carries only closed names
 * and counts, never items, keys, cursors, caller strings or error text.
 */

export type CoverageClaim = "full_inventory" | "checkpoint_window";

/** Named source guarantee, declared by the caller. Not independently verified. */
export type Guarantee = "snapshot" | "change_token" | "stable_order";

/** What the request itself covered. */
export type RequestScope = "inventory" | "window" | "bounded";

export type EndFacts =
	| {
			rule: "declared_total";
			declaredTotal: number;
			continuationVisible: false;
	  }
	| {
			rule: "provider_terminal";
			signal: "cursor_null" | "has_more_false" | "last_page_flag";
			schemaKnown: true;
			dataReadable: true;
			pageRowsSeen: number;
			pageRowsParsed: number;
	  }
	| {
			rule: "continuation_consumed";
			dataReadable: true;
			continuationSeenBefore: true;
			continuationVisible: false;
			renderedAtEnd: number;
			sourceItemsAtEnd: number | null;
	  }
	| {
			rule: "source_end_marker";
			dataReadable: true;
			markerPresent: true;
			continuationVisible: false;
			renderedAtEnd: number;
			sourceItemsAtEnd: number | null;
	  }
	| { rule: "source_empty"; dataReadable: true; sourceSaidEmpty: true }
	| {
			rule: "window_boundary";
			intervalBounded: true;
			ordering: Guarantee;
			/** Source guarantees nonincreasing window timestamps across all successors.
			 * Uses the same timestamp as the old-page predicate; not verified here.
			 * Snapshot/change-token/stable ordering alone does not imply this.
			 */
			timeOrder: "nonincreasing";
			oldPagesInARow: number;
			required: number;
	  }
	| {
			rule: "bounded_request";
			bound: "time_range" | "resource_filter" | "owner_item_limit";
			reached: true;
	  };

/** The chain obligation: small counts the walker observed, not a ledger. */
export interface Traversal {
	startBoundary: "source_start" | "validated_resume" | "unknown";
	ordering: Guarantee | "none";
	pagesRead: number;
	/** Pages not read but durably accounted for (gap or detail outcome). */
	pagesGapped: number;
	/** Successor pages neither read nor gapped. */
	pagesSkippedUnaccounted: number;
	/** Successors the port computed instead of the source returning them. */
	synthesizedSuccessors: number;
	/** Times the source/filter/order epoch differed between pages. */
	epochChanges: number;
}

/** Cumulative over the whole walk. Duplicates are counted, not hidden. */
export interface ReadAccounting {
	rawItems: number;
	/** Distinct source identities. */
	distinctKeys: number;
	/** `rawItems - distinctKeys`. */
	duplicateItems: number;
	/** Discarded rows that a durable gap accounts for. */
	gappedItems: number;
	/** Discarded or rejected rows with no durable gap, across all pages. */
	unaccountedItems: number;
}

export type ListStop =
	| { kind: "end"; end: EndFacts }
	| {
			kind: "budget";
			limit: "pages" | "items" | "rounds" | "time";
			resumable: boolean;
	  }
	| { kind: "stalled"; reason: "no_progress" | "cursor_cycle" }
	| {
			kind: "unreadable";
			reason: "page" | "response" | "auth" | "parse_mismatch";
	  }
	| { kind: "no_end_signal" };

export interface ListRead<T> {
	items: readonly T[];
	requested: RequestScope;
	traversal: Traversal;
	accounting: ReadAccounting;
	stop: ListStop;
}

export type Outcome =
	| "complete" // whole inventory proven read
	| "verified_empty" // source positively empty, inventory scope
	| "window_complete" // the claimed window proven read
	| "bounded_complete" // the bounded request proven read
	| "partial" // read stopped early or covers less than the claim
	| "unreadable"
	| "stalled"
	| "unproven"; // facts missing, contradictory or insufficient

export type Reason =
	| "invalid_claim"
	| "invalid_facts"
	| "no_end_signal"
	| "count_mismatch"
	| "parse_mismatch"
	| "rows_unaccounted"
	| "start_unknown"
	| "resume_unguaranteed"
	| "chain_unproven"
	| "epoch_changed"
	| "ordering_unguaranteed"
	| "scope_mismatch"
	| "window_only"
	| "bounded_only"
	| "budget_pages"
	| "budget_items"
	| "budget_rounds"
	| "budget_time"
	| "page"
	| "response"
	| "auth"
	| "no_progress"
	| "cursor_cycle";

export interface Settlement {
	readonly claim: CoverageClaim;
	readonly outcome: Outcome;
	readonly reason?: Reason;
	/** Budget stops only: whether the caller says the walk can continue. */
	readonly resumable?: boolean;
}

type Verdict = Omit<Settlement, "claim">;

const GUARANTEES: readonly string[] = [
	"snapshot",
	"change_token",
	"stable_order",
];
const SCOPES: readonly string[] = ["inventory", "window", "bounded"];
const START_BOUNDARIES: readonly string[] = [
	"source_start",
	"validated_resume",
	"unknown",
];
const RULES: readonly EndFacts["rule"][] = [
	"declared_total",
	"provider_terminal",
	"continuation_consumed",
	"source_end_marker",
	"source_empty",
	"window_boundary",
	"bounded_request",
];

const unproven = (reason: Reason): Verdict => ({ outcome: "unproven", reason });
const partial = (reason: Reason, resumable?: boolean): Verdict =>
	resumable === undefined
		? { outcome: "partial", reason }
		: { outcome: "partial", reason, resumable };

/** A plain data object: `Object.prototype` or `null` as prototype, not an array. */
function isRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const proto: unknown = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

function hasExactKeys(
	value: Record<string, unknown>,
	keys: readonly string[],
): boolean {
	// Own keys only, including non-enumerable and symbol keys, so an inherited
	// required key cannot stand in for a missing own one.
	const actual = Reflect.ownKeys(value);
	return (
		actual.length === keys.length &&
		keys.every((key) => Object.hasOwn(value, key))
	);
}

function isCount(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function oneOf<T extends string>(
	value: unknown,
	allowed: readonly T[],
): value is T {
	return (
		typeof value === "string" && (allowed as readonly string[]).includes(value)
	);
}

interface ParsedRead {
	requested: RequestScope;
	traversal: Traversal;
	accounting: ReadAccounting;
	stop: unknown;
}

function parseTraversal(value: unknown): Traversal | null {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, [
			"startBoundary",
			"ordering",
			"pagesRead",
			"pagesGapped",
			"pagesSkippedUnaccounted",
			"synthesizedSuccessors",
			"epochChanges",
		])
	) {
		return null;
	}
	const { startBoundary, ordering } = value;
	const counts = [
		value.pagesRead,
		value.pagesGapped,
		value.pagesSkippedUnaccounted,
		value.synthesizedSuccessors,
		value.epochChanges,
	];
	if (
		!oneOf(startBoundary, START_BOUNDARIES as Traversal["startBoundary"][]) ||
		!(ordering === "none" || oneOf(ordering, GUARANTEES as Guarantee[])) ||
		!counts.every(isCount)
	) {
		return null;
	}
	const [
		pagesRead,
		pagesGapped,
		pagesSkippedUnaccounted,
		synthesizedSuccessors,
		epochChanges,
	] = counts as [number, number, number, number, number];
	return {
		startBoundary,
		ordering,
		pagesRead,
		pagesGapped,
		pagesSkippedUnaccounted,
		synthesizedSuccessors,
		epochChanges,
	};
}

function parseAccounting(value: unknown): ReadAccounting | null {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, [
			"rawItems",
			"distinctKeys",
			"duplicateItems",
			"gappedItems",
			"unaccountedItems",
		])
	) {
		return null;
	}
	const {
		rawItems,
		distinctKeys,
		duplicateItems,
		gappedItems,
		unaccountedItems,
	} = value;
	if (
		!isCount(rawItems) ||
		!isCount(distinctKeys) ||
		!isCount(duplicateItems) ||
		!isCount(gappedItems) ||
		!isCount(unaccountedItems) ||
		distinctKeys + duplicateItems !== rawItems ||
		gappedItems + unaccountedItems > rawItems
	) {
		return null;
	}
	return {
		rawItems,
		distinctKeys,
		duplicateItems,
		gappedItems,
		unaccountedItems,
	};
}

function parseRead(read: unknown): ParsedRead | null {
	if (
		!isRecord(read) ||
		!hasExactKeys(read, [
			"items",
			"requested",
			"traversal",
			"accounting",
			"stop",
		]) ||
		!Array.isArray(read.items) ||
		!oneOf(read.requested, SCOPES as RequestScope[])
	) {
		return null;
	}
	const traversal = parseTraversal(read.traversal);
	const accounting = parseAccounting(read.accounting);
	if (!(traversal && accounting)) {
		return null;
	}
	return { requested: read.requested, traversal, accounting, stop: read.stop };
}

function parseEnd(value: unknown): EndFacts | null {
	if (!(isRecord(value) && oneOf(value.rule, RULES))) {
		return null;
	}
	const v = value;
	switch (value.rule) {
		case "declared_total":
			return hasExactKeys(v, [
				"rule",
				"declaredTotal",
				"continuationVisible",
			]) &&
				isCount(v.declaredTotal) &&
				v.continuationVisible === false
				? {
						rule: "declared_total",
						declaredTotal: v.declaredTotal,
						continuationVisible: false,
					}
				: null;
		case "provider_terminal":
			return hasExactKeys(v, [
				"rule",
				"signal",
				"schemaKnown",
				"dataReadable",
				"pageRowsSeen",
				"pageRowsParsed",
			]) &&
				oneOf(v.signal, [
					"cursor_null",
					"has_more_false",
					"last_page_flag",
				] as const) &&
				v.schemaKnown === true &&
				v.dataReadable === true &&
				isCount(v.pageRowsSeen) &&
				isCount(v.pageRowsParsed)
				? {
						rule: "provider_terminal",
						signal: v.signal,
						schemaKnown: true,
						dataReadable: true,
						pageRowsSeen: v.pageRowsSeen,
						pageRowsParsed: v.pageRowsParsed,
					}
				: null;
		case "continuation_consumed":
			return hasExactKeys(v, [
				"rule",
				"dataReadable",
				"continuationSeenBefore",
				"continuationVisible",
				"renderedAtEnd",
				"sourceItemsAtEnd",
			]) &&
				v.dataReadable === true &&
				v.continuationSeenBefore === true &&
				v.continuationVisible === false &&
				isCount(v.renderedAtEnd) &&
				(v.sourceItemsAtEnd === null || isCount(v.sourceItemsAtEnd))
				? {
						rule: "continuation_consumed",
						dataReadable: true,
						continuationSeenBefore: true,
						continuationVisible: false,
						renderedAtEnd: v.renderedAtEnd,
						sourceItemsAtEnd: v.sourceItemsAtEnd,
					}
				: null;
		case "source_end_marker":
			return hasExactKeys(v, [
				"rule",
				"dataReadable",
				"markerPresent",
				"continuationVisible",
				"renderedAtEnd",
				"sourceItemsAtEnd",
			]) &&
				v.dataReadable === true &&
				v.markerPresent === true &&
				v.continuationVisible === false &&
				isCount(v.renderedAtEnd) &&
				(v.sourceItemsAtEnd === null || isCount(v.sourceItemsAtEnd))
				? {
						rule: "source_end_marker",
						dataReadable: true,
						markerPresent: true,
						continuationVisible: false,
						renderedAtEnd: v.renderedAtEnd,
						sourceItemsAtEnd: v.sourceItemsAtEnd,
					}
				: null;
		case "source_empty":
			return hasExactKeys(v, ["rule", "dataReadable", "sourceSaidEmpty"]) &&
				v.dataReadable === true &&
				v.sourceSaidEmpty === true
				? { rule: "source_empty", dataReadable: true, sourceSaidEmpty: true }
				: null;
		case "window_boundary":
			return hasExactKeys(v, [
				"rule",
				"intervalBounded",
				"ordering",
				"timeOrder",
				"oldPagesInARow",
				"required",
			]) &&
				v.intervalBounded === true &&
				oneOf(v.ordering, GUARANTEES as Guarantee[]) &&
				v.timeOrder === "nonincreasing" &&
				isCount(v.oldPagesInARow) &&
				isCount(v.required) &&
				v.required > 0 &&
				v.oldPagesInARow >= v.required
				? {
						rule: "window_boundary",
						intervalBounded: true,
						ordering: v.ordering,
						timeOrder: "nonincreasing",
						oldPagesInARow: v.oldPagesInARow,
						required: v.required,
					}
				: null;
		case "bounded_request":
			return hasExactKeys(v, ["rule", "bound", "reached"]) &&
				oneOf(v.bound, [
					"time_range",
					"resource_filter",
					"owner_item_limit",
				] as const) &&
				v.reached === true
				? { rule: "bounded_request", bound: v.bound, reached: true }
				: null;
		default:
			return null;
	}
}

/** Per-rule count reconciliation against the cumulative accounting. */
function countProblem(end: EndFacts, a: ReadAccounting): Reason | null {
	switch (end.rule) {
		case "declared_total":
			return end.declaredTotal === a.distinctKeys ? null : "count_mismatch";
		case "provider_terminal":
			if (end.pageRowsParsed !== end.pageRowsSeen) {
				return "parse_mismatch";
			}
			// The last page cannot have held more rows than the whole walk read.
			return end.pageRowsSeen <= a.rawItems ? null : "count_mismatch";
		case "continuation_consumed":
		case "source_end_marker":
			return end.renderedAtEnd === a.distinctKeys &&
				(end.sourceItemsAtEnd === null ||
					end.sourceItemsAtEnd === end.renderedAtEnd)
				? null
				: "count_mismatch";
		case "source_empty":
			return a.rawItems === 0 ? null : "count_mismatch";
		default:
			return null;
	}
}

/** Rows from different source/filter/order epochs are never one inventory. */
function epochProblem(t: Traversal): Reason | null {
	return t.epochChanges > 0 ? "epoch_changed" : null;
}

/**
 * The contiguous-traversal obligation. `declared_total` is exempt from it
 * (its count proof stands alone) but not from `epochProblem`.
 */
function chainProblem(t: Traversal): Reason | null {
	if (t.pagesRead < 1) {
		return "invalid_facts";
	}
	if (t.startBoundary === "unknown") {
		return "start_unknown";
	}
	if (t.startBoundary === "validated_resume" && t.ordering === "none") {
		return "resume_unguaranteed";
	}
	if (t.pagesSkippedUnaccounted > 0 || t.synthesizedSuccessors > 0) {
		return "chain_unproven";
	}
	return epochProblem(t);
}

function settleEnd(
	claim: CoverageClaim,
	p: ParsedRead,
	end: EndFacts,
): Verdict {
	const mismatch = countProblem(end, p.accounting);
	if (mismatch) {
		return unproven(mismatch);
	}

	// What scope does this end rule speak for, and which outcome may it carry?
	let completeAs: Outcome = "complete";
	let rightScope: RequestScope = "inventory";
	if (end.rule === "window_boundary") {
		// parseEnd requires monotonic window timestamps, not just consistency.
		// The named consistency guarantee must still match the walk.
		if (
			p.traversal.ordering === "none" ||
			end.ordering !== p.traversal.ordering
		) {
			return unproven("ordering_unguaranteed");
		}
		// One page cannot attest several consecutive old pages.
		if (end.oldPagesInARow > p.traversal.pagesRead) {
			return unproven("count_mismatch");
		}
		if (claim === "full_inventory") {
			return partial("window_only");
		}
		completeAs = "window_complete";
		rightScope = "window";
	} else if (end.rule === "bounded_request") {
		if (claim === "full_inventory") {
			return partial("bounded_only");
		}
		completeAs = "bounded_complete";
		rightScope = "bounded";
	} else if (end.rule === "source_empty") {
		completeAs = "verified_empty";
	}

	if (p.requested !== rightScope) {
		// A scoped read ended; it is not the end of the inventory.
		if (claim === "full_inventory") {
			return partial(p.requested === "window" ? "window_only" : "bounded_only");
		}
		return unproven("scope_mismatch");
	}
	const broken =
		end.rule === "declared_total"
			? epochProblem(p.traversal)
			: chainProblem(p.traversal);
	if (broken) {
		return unproven(broken);
	}
	if (p.accounting.unaccountedItems > 0) {
		return unproven("rows_unaccounted");
	}
	return { outcome: completeAs };
}

function decide(claim: CoverageClaim, read: unknown): Verdict {
	const p = parseRead(read);
	if (!(p && isRecord(p.stop))) {
		return unproven("invalid_facts");
	}
	const stop = p.stop;
	switch (stop.kind) {
		case "end": {
			const end = hasExactKeys(stop, ["kind", "end"])
				? parseEnd(stop.end)
				: null;
			return end ? settleEnd(claim, p, end) : unproven("invalid_facts");
		}
		case "budget": {
			const { limit, resumable } = stop;
			return hasExactKeys(stop, ["kind", "limit", "resumable"]) &&
				oneOf(limit, ["pages", "items", "rounds", "time"] as const) &&
				typeof resumable === "boolean"
				? partial(`budget_${limit}`, resumable)
				: unproven("invalid_facts");
		}
		case "stalled": {
			const { reason } = stop;
			return hasExactKeys(stop, ["kind", "reason"]) &&
				oneOf(reason, ["no_progress", "cursor_cycle"] as const)
				? { outcome: "stalled", reason }
				: unproven("invalid_facts");
		}
		case "unreadable": {
			const { reason } = stop;
			return hasExactKeys(stop, ["kind", "reason"]) &&
				oneOf(reason, ["page", "response", "auth", "parse_mismatch"] as const)
				? { outcome: "unreadable", reason }
				: unproven("invalid_facts");
		}
		case "no_end_signal":
			return hasExactKeys(stop, ["kind"])
				? unproven("no_end_signal")
				: unproven("invalid_facts");
		default:
			return unproven("invalid_facts");
	}
}

/**
 * Pure. Bad, missing or contradictory input gives `unproven`, never a throw
 * and never a value echoed from the input.
 */
export function settle(
	claim: CoverageClaim,
	read: ListRead<unknown>,
): Settlement {
	const rawClaim: unknown = claim;
	const rawRead: unknown = read;
	if (!oneOf(rawClaim, ["full_inventory", "checkpoint_window"] as const)) {
		return Object.freeze({
			claim: "full_inventory",
			...unproven("invalid_claim"),
		});
	}
	let verdict: Verdict;
	try {
		verdict = decide(rawClaim, rawRead);
	} catch {
		verdict = unproven("invalid_facts");
	}
	return Object.freeze({ claim: rawClaim, ...verdict });
}

/** Fixed keys, closed values and counts only. */
export interface PublicDiagnostics extends ReadAccounting {
	claim: CoverageClaim;
	outcome: Outcome;
	reason?: Reason;
	rule?: EndFacts["rule"];
	pagesRead: number;
}

export function publicDiagnostics(
	settlement: Settlement,
	read: ListRead<unknown>,
): PublicDiagnostics {
	const raw: unknown = read;
	const record = isRecord(raw) ? raw : {};
	const count = (value: unknown): number => (isCount(value) ? value : 0);
	const accounting = isRecord(record.accounting) ? record.accounting : {};
	const traversal = isRecord(record.traversal) ? record.traversal : {};
	const stop = isRecord(record.stop) ? record.stop : {};
	const end = isRecord(stop.end) ? stop.end : {};
	const out: PublicDiagnostics = {
		claim: settlement.claim,
		outcome: settlement.outcome,
		rawItems: count(accounting.rawItems),
		distinctKeys: count(accounting.distinctKeys),
		duplicateItems: count(accounting.duplicateItems),
		gappedItems: count(accounting.gappedItems),
		unaccountedItems: count(accounting.unaccountedItems),
		pagesRead: count(traversal.pagesRead),
	};
	if (settlement.reason) {
		out.reason = settlement.reason;
	}
	const rule = end.rule;
	if (oneOf(rule, RULES)) {
		out.rule = rule;
	}
	return out;
}
