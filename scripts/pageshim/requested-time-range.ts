// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import {
	isOutsideTimeRange,
	parseFullDate,
	parseIsoInstant,
} from "../../packages/polyfill-connectors/src/time-range.ts";

type TimeRange = { since?: string; until?: string };
type ScopeEntry = { name: string; time_range?: TimeRange };

/**
 * Copy the host's per-scope ranges into the existing connector request map.
 * `acceptFullDate` is for a connector with a `format: "date"` consent field:
 * a full-date bound is then well-formed too. Whether a bound's type fits a
 * stream's consent field is the runtime's check, which reports
 * scope_not_supported; a malformed bound fails the run here.
 */
export function applyRequestedTimeRanges<T extends { time_range?: TimeRange }>(
	requested: Map<string, T>,
	rawEntries: unknown,
	platform: string,
	options: { acceptFullDate?: boolean } = {},
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
			// RFC 3339 date-time with any time-zone offset (Collection Profile
			// §5.1), checked by the runtime's own parsers; a full-date only when
			// the connector has a date consent field.
			const isDate = (value: unknown) =>
				options.acceptFullDate === true && parseFullDate(value) !== null;
			const validBound = (value: unknown) =>
				parseIsoInstant(value) !== null || isDate(value);
			if (
				(range.since !== undefined && !validBound(range.since)) ||
				(range.until !== undefined && !validBound(range.until)) ||
				(range.since === undefined && range.until === undefined)
			)
				throw new Error(
					options.acceptFullDate === true
						? `PageShim time_range for ${entry.name} must contain valid RFC 3339 full-date bounds, or date-time bounds with a time-zone offset.`
						: `PageShim time_range for ${entry.name} must contain valid RFC 3339 date-time bounds with a time-zone offset.`,
				);
			// Bounds of mixed types are not ordered here; the runtime reports
			// them as scope_not_supported.
			if (
				range.since !== undefined &&
				range.until !== undefined &&
				isDate(range.since) === isDate(range.until) &&
				isOutsideTimeRange(
					{ since: range.since },
					range.until,
					isDate(range.since) ? "date" : "date-time",
				)
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
