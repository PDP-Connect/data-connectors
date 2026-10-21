// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

export type InventoryTerminalProof = "disabled_next" | "exact_count" | null;

export interface CollectionBoundary {
	kind: "located" | "absent" | "ambiguous";
	unclaimedCandidates: number;
}

/** What one page says about the rest of its inventory. Only inspectors build these. */
export type Continuation =
	/** The validated immediate successor of the request that produced the page. */
	| { kind: "next"; url: string }
	/** Positive source-end evidence on this page. */
	| { kind: "end" }
	/** No successor and no positive end evidence. */
	| { kind: "unproven" }
	/** Unreadable, ambiguous or unsupported continuation metadata. */
	| { kind: "unknown"; reason: string }
	/** The page is not the requested page of this inventory; its rows are not evidence. */
	| { kind: "unbound"; reason: string };

export interface PageObservation extends PageEvidence {
	ids: readonly string[];
	rowsComplete: boolean;
	rejectedRows: number;
}

/** What a page's metadata says about the walk, beyond its own rows. */
export interface PageEvidence {
	continuation: Continuation;
	/** The last page number the source advertised on this page. It binds the whole walk. */
	lastPage?: number;
}

/**
 * One inventory walk. It owns the request sequence, every page observation and
 * the end proof; walkers only report what they observed. Evidence is append-only:
 * the first negative observation is the verdict, and no later page, total or
 * enumeration can clear it. After any failure or end the walk issues no request.
 */
export class InventoryEvidence {
	private request: { readonly url: string; readonly page: number } | null;
	private readonly pageLimit: number;
	private readonly window: number;
	private readonly seen = new Set<string>();
	private readonly totals = new Set<number>();
	private pages = 0;
	private failure: string | null = null;
	private endProven = false;
	private lastPage: number | null = null;

	/**
	 * `first` is the first request of the walk. A one-page collection that is
	 * already in hand passes the page it was read from. `window` caps how many
	 * identities the source serves, whatever total it reports.
	 */
	constructor(first: string, limits: { pages?: number; window?: number } = {}) {
		this.request = { url: first, page: 1 };
		this.pageLimit = limits.pages ?? Number.POSITIVE_INFINITY;
		this.window = limits.window ?? Number.POSITIVE_INFINITY;
	}

	/** Missing controls and short pages are not source-end observations. */
	static terminalProof(observed: { disabledNext: boolean; total: number | null; distinct: number }): InventoryTerminalProof {
		if (observed.total !== null && observed.total === observed.distinct) return "exact_count";
		return observed.disabledNext ? "disabled_next" : null;
	}

	/** A profile collection is one page; a located or absent boundary is its end. */
	static boundaryEnd(boundary: CollectionBoundary): Continuation {
		if (boundary.unclaimedCandidates > 0) return { kind: "unknown", reason: "unclaimed_candidates" };
		if (boundary.kind === "ambiguous") return { kind: "unknown", reason: "ambiguous_boundary" };
		return { kind: "end" };
	}

	/** The only request a walker may issue next, or null when the walk is over. */
	get next(): { readonly url: string; readonly page: number } | null {
		return this.failure === null ? this.request : null;
	}

	get identities(): ReadonlySet<string> {
		return this.seen;
	}

	/** The distinct identities the source says this walk must collect. */
	get expectedTotal(): number | null {
		const total = this.totals.values().next().value;
		return total === undefined ? null : Math.min(total, this.window);
	}

	/** Preview without accepting rows from an alternate route we may discard. */
	previewPage(ids: readonly string[]): { distinct: number; noProgress: boolean } {
		const distinct = new Set([...this.seen, ...ids]).size;
		return { distinct, noProgress: this.pages > 0 && distinct === this.seen.size };
	}

	/**
	 * Record the page answering the current request. Returns the identities
	 * this page added, so only those rows are published or counted.
	 */
	observePage(page: PageObservation): Set<string> {
		const added = new Set<string>();
		const request = this.request;
		if (request === null) {
			this.fail("observation_after_end");
			return added;
		}
		this.request = null;
		const { continuation } = page;
		if (continuation.kind === "unbound") {
			this.fail(continuation.reason);
			return added;
		}
		const { noProgress } = this.previewPage(page.ids);
		if (!page.rowsComplete || page.rejectedRows > 0) this.fail("discarded_rows");
		for (const id of page.ids) {
			if (this.seen.has(id)) this.fail("duplicate_rows");
			else added.add(id);
			this.seen.add(id);
		}
		if (noProgress) this.fail("no_progress");
		this.pages += 1;
		if (page.lastPage !== undefined) {
			if (this.lastPage !== null && this.lastPage !== page.lastPage) this.fail("pagination_bound_changed");
			this.lastPage ??= page.lastPage;
		}
		if (continuation.kind === "unknown") this.fail(continuation.reason);
		else if (continuation.kind === "end") {
			// An end proves the walk complete only at the last page any page advertised.
			if (this.lastPage !== null && request.page !== this.lastPage) this.fail("end_before_advertised_last");
			this.endProven = true;
		} else if (continuation.kind === "next") {
			if (this.lastPage !== null && request.page >= this.lastPage) this.fail("continuation_beyond_advertised_last");
			else if (request.page >= this.pageLimit) this.fail("page_limit_reached");
			else this.request = { url: continuation.url, page: request.page + 1 };
		}
		return added;
	}

	/** Exact totals from every route stay binding, including discarded routes. */
	addTotals(evidence: { exactTotals: readonly number[]; totalConflict: boolean }): void {
		for (const total of evidence.exactTotals) this.totals.add(total);
		if (evidence.totalConflict || this.totals.size > 1) this.fail("source_total_changed");
	}

	/** A finished independent walk of the same inventory binds this one. */
	reconcile(enumeration: InventoryEvidence): void {
		const failure = enumeration.decide(enumeration.seen.size);
		if (failure !== null) {
			this.fail(failure);
			return;
		}
		this.addTotals({ exactTotals: [enumeration.seen.size], totalConflict: false });
		if (Array.from(enumeration.seen).some(id => !this.seen.has(id))) this.fail("identity_mismatch");
	}

	/** A response that could not be read as a page of this inventory. */
	fail(reason: string): void {
		this.failure ??= reason;
	}

	/** Only the final distinct inventory can be compared against every route. */
	decide(covered: number): string | null {
		const distinct = this.seen.size;
		if (this.failure !== null) return this.failure;
		const expected = this.expectedTotal;
		if (expected !== null && expected !== distinct) return "total_mismatch";
		if (covered !== distinct) return "coverage_mismatch";
		if (this.request !== null) return "walk_incomplete";
		return this.endProven || expected === distinct ? null : "terminal_unverified";
	}
}
