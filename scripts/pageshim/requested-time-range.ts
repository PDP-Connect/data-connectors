// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

type TimeRange = { since?: string; until?: string };
type ScopeEntry = { name: string; time_range?: TimeRange };

/** Copy the host's per-scope ranges into the existing connector request map. */
export function applyRequestedTimeRanges<T extends { time_range?: TimeRange }>(
	requested: Map<string, T>,
	rawEntries: unknown,
	platform: string,
): void {
	if (rawEntries === undefined) return;
	if (!Array.isArray(rawEntries))
		throw new Error("PageShim requestedScopeEntries must be an array.");
	const prefix = `${platform}.`;
	const ranges = new Map<string, ScopeEntry>();
	for (const raw of rawEntries) {
		const entry =
			typeof raw === "string"
				? { name: raw }
				: raw &&
						typeof raw === "object" &&
						typeof (raw as { name?: unknown }).name === "string"
					? (raw as ScopeEntry)
					: null;
		if (!entry)
			throw new Error(
				"PageShim requestedScopeEntries entries must be scope names or {name, time_range?} objects.",
			);
		if (!entry.name.startsWith(prefix))
			throw new Error(
				`PageShim requestedScopeEntries has an unsupported scope: ${entry.name}.`,
			);
		const stream = entry.name.slice(prefix.length);
		if (!requested.has(stream))
			throw new Error(
				`PageShim requestedScopeEntries has an unrequested scope: ${entry.name}.`,
			);
		let normalizedRange: TimeRange | undefined;
		if (entry.time_range !== undefined) {
			if (
				!entry.time_range ||
				typeof entry.time_range !== "object" ||
				Array.isArray(entry.time_range)
			)
				throw new Error(
					`PageShim time_range for ${entry.name} must be an object.`,
				);
			const range = entry.time_range;
			const validBound = (value: unknown) => {
				if (
					typeof value !== "string" ||
					!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)
				)
					return false;
				const timestamp = Date.parse(value);
				return (
					Number.isFinite(timestamp) &&
					new Date(timestamp).toISOString().slice(0, 19) === value.slice(0, 19)
				);
			};
			if (
				(range.since !== undefined && !validBound(range.since)) ||
				(range.until !== undefined && !validBound(range.until)) ||
				(range.since === undefined && range.until === undefined)
			)
				throw new Error(
					`PageShim time_range for ${entry.name} must contain valid UTC ISO-8601 bounds.`,
				);
			if (
				range.since !== undefined &&
				range.until !== undefined &&
				Date.parse(range.since) > Date.parse(range.until)
			)
				throw new Error(
					`PageShim time_range for ${entry.name} has since after until.`,
				);
			normalizedRange = {
				...(range.since !== undefined ? { since: range.since } : {}),
				...(range.until !== undefined ? { until: range.until } : {}),
			};
		}
		const previous = ranges.get(stream);
		if (
			previous &&
			(previous.time_range?.since !== normalizedRange?.since ||
				previous.time_range?.until !== normalizedRange?.until)
		)
			throw new Error(
				`PageShim requestedScopeEntries contains conflicting ranges for ${entry.name}.`,
			);
		ranges.set(stream, { name: entry.name, time_range: normalizedRange });
	}
	for (const [stream, request] of requested) {
		const time_range = ranges.get(stream)?.time_range;
		if (time_range) request.time_range = time_range;
	}
}
