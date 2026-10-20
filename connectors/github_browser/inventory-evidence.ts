// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/** Evidence survives route replacement and unreadable lists for the whole run. */
export class InventoryEvidence {
	private readonly totals = new Set<number>();
	private conflict = false;
	private readonly seen = new Set<string>();
	private pages = 0;
	private rowFailure: string | null = null;

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

	add(evidence: { exactTotals: readonly number[]; totalConflict: boolean }): void {
		for (const total of evidence.exactTotals) this.totals.add(total);
		this.conflict ||= evidence.totalConflict || this.totals.size > 1;
	}

	addEnumeration(total: number): void {
		this.add({ exactTotals: [total], totalConflict: false });
	}

	get expectedTotal(): number | null {
		return this.totals.values().next().value ?? null;
	}

	/** Only the final distinct inventory can be compared against every route. */
	decide(covered: number, endProven: boolean, failure: string | null): string | null {
		const distinct = this.seen.size;
		if (this.conflict) return "source_total_changed";
		if (this.rowFailure !== null) return this.rowFailure;
		if (Array.from(this.totals).some(total => total !== distinct))
			return "total_mismatch";
		if (covered !== distinct) return "coverage_mismatch";
		if (failure !== null) return failure;
		return endProven || this.expectedTotal === distinct ? null : "terminal_unverified";
	}
}
