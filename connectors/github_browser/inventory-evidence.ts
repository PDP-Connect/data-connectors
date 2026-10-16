// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/** Evidence survives route replacement and unreadable lists for the whole run. */
export class InventoryEvidence {
	private readonly totals = new Set<number>();
	private conflict = false;

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
	decide(distinct: number, endProven: boolean, failure: string | null): string | null {
		if (this.conflict) return "source_total_changed";
		if (Array.from(this.totals).some(total => total !== distinct))
			return "total_mismatch";
		if (failure !== null) return failure;
		return endProven || this.expectedTotal === distinct ? null : "terminal_unverified";
	}
}
