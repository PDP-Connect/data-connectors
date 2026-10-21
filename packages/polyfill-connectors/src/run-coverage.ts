// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

export type RunCoverageStatus =
	| "collected"
	| "partial"
	| "unavailable"
	| "failed";

export interface RunCoverageVerdict {
	collection_scope: string;
	streams: {
		stream: string;
		scoped: boolean;
		stores: { store: string; status: RunCoverageStatus }[];
	}[];
	version: 1;
}

/** Accumulate explicit connector results against the signed manifest inventory. */
export function createRunCoverage(
	inventory: Readonly<Record<string, readonly string[]>>,
	collectionScope: string,
) {
	for (const stores of Object.values(inventory)) {
		if (new Set(stores).size !== stores.length)
			throw new Error("Duplicate coverage store");
	}
	const results = new Map<string, RunCoverageStatus>();
	const severity: Record<RunCoverageStatus, number> = {
		collected: 0,
		partial: 1,
		unavailable: 2,
		failed: 3,
	};
	const skipped = new Set<string>();
	const enforced = new Set<string>();
	const key = (stream: string, store: string) => `${stream}\0${store}`;
	return {
		report(stream: string, store: string, status: RunCoverageStatus): void {
			if (!inventory[stream]?.includes(store)) {
				throw new Error(`Undeclared coverage store ${stream}/${store}`);
			}
			const previous = results.get(key(stream, store));
			if (!previous || severity[status] > severity[previous]) {
				results.set(key(stream, store), status);
			}
		},
		skip(stream: string): void {
			skipped.add(stream);
		},
		scoped(stream: string): void {
			enforced.add(stream);
		},
		done(
			requestedStreams: readonly string[] = Object.keys(inventory),
		): RunCoverageVerdict | undefined {
			if (
				requestedStreams.length === 0 ||
				new Set(requestedStreams).size !== requestedStreams.length ||
				requestedStreams.some((stream) => {
					const stores = inventory[stream];
					return (
						!stores?.length ||
						stores.some((store) => !results.has(key(stream, store)))
					);
				})
			)
				return undefined;
			return {
				version: 1,
				collection_scope: collectionScope,
				streams: requestedStreams.map((stream) => ({
					stream,
					scoped: collectionScope === "unscoped" || enforced.has(stream),
					stores: (inventory[stream] ?? []).map((store) => {
						const reported = results.get(key(stream, store)) ?? "failed";
						return {
							store,
							status:
								reported === "collected" && skipped.has(stream)
									? "partial"
									: reported,
						};
					}),
				})),
			};
		},
	};
}
