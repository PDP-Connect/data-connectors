// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Collection Profile §5.1 instant comparison for time_range bounds. Values
// and bounds are RFC 3339 date-times with an offset (the T and Z separators
// may be lowercase, as RFC 3339 §5.6 allows); they are compared as
// exact instants, with every fractional digit, across offsets.

const ISO_INSTANT_RE =
	/^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/;

function isValidIsoInstantShape(match: RegExpMatchArray): boolean {
	const [, yearRaw, monthRaw, dayRaw, hourRaw, minuteRaw, secondRaw] = match;
	const year = Number(yearRaw);
	const month = Number(monthRaw);
	const day = Number(dayRaw);
	const hour = Number(hourRaw);
	const minute = Number(minuteRaw);
	const second = Number(secondRaw);
	if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) {
		return false;
	}
	const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
	const daysInMonth = [
		31,
		leapYear ? 29 : 28,
		31,
		30,
		31,
		30,
		31,
		31,
		30,
		31,
		30,
		31,
	][month - 1];
	return daysInMonth !== undefined && day >= 1 && day <= daysInMonth;
}

type IsoInstant = { second: number; fraction: string };

export function parseIsoInstant(value: unknown): IsoInstant | null {
	if (typeof value !== "string") {
		return null;
	}
	const match = value.match(ISO_INSTANT_RE);
	if (!match || !isValidIsoInstantShape(match)) {
		return null;
	}
	// Date.parse discards digits after milliseconds. Parse the whole second,
	// then keep the source fraction for the half-open boundary comparison.
	const fraction = match[7]?.slice(1) ?? "";
	const wholeSecond = match[7] ? value.replace(match[7], "") : value;
	const timestamp = Date.parse(wholeSecond);
	if (Number.isNaN(timestamp)) {
		return null;
	}
	return { second: timestamp, fraction };
}

function compareIsoInstants(left: IsoInstant, right: IsoInstant): number {
	if (left.second !== right.second) return left.second - right.second;
	const length = Math.max(left.fraction.length, right.fraction.length);
	const leftFraction = left.fraction.padEnd(length, "0");
	const rightFraction = right.fraction.padEnd(length, "0");
	return leftFraction < rightFraction
		? -1
		: leftFraction > rightFraction
			? 1
			: 0;
}

/** Returns true if the scope's half-open time_range excludes this record value. */
export function isOutsideTimeRange(
	timeRange: { since?: string; until?: string },
	dateValue: unknown,
): boolean {
	const since =
		timeRange.since === undefined ? null : parseIsoInstant(timeRange.since);
	const until =
		timeRange.until === undefined ? null : parseIsoInstant(timeRange.until);
	if (
		(timeRange.since !== undefined && since === null) ||
		(timeRange.until !== undefined && until === null)
	) {
		return true;
	}

	const timestamp = parseIsoInstant(dateValue);
	return (
		timestamp === null ||
		(since !== null && compareIsoInstants(timestamp, since) < 0) ||
		(until !== null && compareIsoInstants(timestamp, until) >= 0)
	);
}

/**
 * Why a bounded stream cannot apply its time_range (§5.1), or null when it
 * can. A bound of the wrong type is unsupported, not an empty window.
 */
export function timeRangeUnsupportedReason(
	stream: string,
	timeRange: { since?: string; until?: string } | undefined,
	field: string | null,
): string | null {
	if (!timeRange) return null;
	if (field === null) {
		return `time_range cannot be applied to ${stream}: its manifest declares no timestamp consent_time_field`;
	}
	const bad = (["since", "until"] as const).filter(
		(bound) =>
			timeRange[bound] !== undefined &&
			parseIsoInstant(timeRange[bound]) === null,
	);
	return bad.length === 0
		? null
		: `time_range ${bad.join(" and ")} for ${stream} must be a date-time with a time-zone offset, because ${field} is an instant`;
}
