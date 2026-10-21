// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

export type InventoryTerminalProof = "disabled_next" | "exact_count" | null;

export interface CollectionBoundary {
	kind: "located" | "absent" | "ambiguous";
	unclaimedCandidates: number;
}

/** Evidence survives route replacement and unreadable lists for the whole run. */
export class InventoryEvidence {
	private readonly totals = new Set<number>();
	private conflict = false;
	private readonly seen = new Set<string>();
	private pages = 0;
	private rowFailure: string | null = null;
	private boundaryProven = false;
	private terminalProven = false;

	/** Missing controls and short pages are not source-end observations. */
	static terminalReason(proof: InventoryTerminalProof): "terminal_unverified" | "terminal_list" {
		return proof === null ? "terminal_unverified" : "terminal_list";
	}

	/** Only a validated page with positive end evidence may end a walk. */
	addEnd(page: { nextUrl: string | null; reason: string; terminalProof: InventoryTerminalProof }): void {
		this.terminalProven ||= page.nextUrl === null && page.reason === "terminal_list" &&
			InventoryEvidence.terminalReason(page.terminalProof) === "terminal_list";
	}

	get identities(): ReadonlySet<string> {
		return this.seen;
	}

	/** Preview without accepting rows from an alternate route we may discard. */
	previewPage(ids: readonly string[]): { distinct: number; noProgress: boolean } {
		const distinct = new Set([...this.seen, ...ids]).size;
		return { distinct, noProgress: this.pages > 0 && distinct === this.seen.size };
	}

	/** Every selected page contributes sticky negative evidence for this run. */
	addPage(ids: readonly string[], entriesComplete: boolean, rejectedRows: number): void {
		const { noProgress } = this.previewPage(ids);
		if (!entriesComplete || rejectedRows > 0) this.rowFailure ??= "discarded_rows";
		for (const id of ids) {
			if (this.seen.has(id)) this.rowFailure ??= "duplicate_rows";
			this.seen.add(id);
		}
		if (noProgress) this.rowFailure ??= "no_progress";
		this.pages += 1;
	}

	/** Layout observations never certify a collection without candidate accounting. */
	addBoundary(boundary: CollectionBoundary): void {
		if (boundary.unclaimedCandidates > 0) this.rowFailure ??= "unclaimed_candidates";
		if (boundary.kind === "ambiguous") this.rowFailure ??= "ambiguous_boundary";
		this.boundaryProven ||= boundary.kind !== "ambiguous";
	}

	add(evidence: { exactTotals: readonly number[]; totalConflict: boolean }): void {
		for (const total of evidence.exactTotals) this.totals.add(total);
		this.conflict ||= evidence.totalConflict || this.totals.size > 1;
	}

	addEnumeration(total: number, end: { link: string | null | undefined; explicitEmpty: boolean }): boolean {
		// An observed absent Link header or a recognized backward-only window is
		// source-end evidence. Missing metadata and unknown relations are not.
		const links = end.link?.split(",");
		const backwardOnly = links !== undefined && links.length > 0 && links.every(link =>
			/^\s*<https:\/\/api\.github\.com\/[^<>]+>;\s*rel=(?:"(?:prev|first)"|prev|first)\s*$/u.test(link));
		if (!end.explicitEmpty && end.link !== null && !backwardOnly) return false;
		this.add({ exactTotals: [total], totalConflict: false });
		return true;
	}

	get expectedTotal(): number | null {
		return this.totals.values().next().value ?? null;
	}

	/** Only the final distinct inventory can be compared against every route. */
	decide(covered: number, failure: string | null): string | null {
		const distinct = this.seen.size;
		if (this.conflict) return "source_total_changed";
		if (this.rowFailure !== null) return this.rowFailure;
		if (Array.from(this.totals).some(total => total !== distinct))
			return "total_mismatch";
		if (covered !== distinct) return "coverage_mismatch";
		if (failure !== null) return failure;
		return this.terminalProven || this.boundaryProven || this.expectedTotal === distinct ? null : "terminal_unverified";
	}
}
