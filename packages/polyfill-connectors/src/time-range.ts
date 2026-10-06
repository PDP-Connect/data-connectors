// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Collection Profile §5.1 comparison for time_range bounds. The bounds have
// the type of the consent field's declared format. For `date-time`, values
// and bounds are RFC 3339 date-times with an offset (the T and Z separators
// may be lowercase, as RFC 3339 §5.6 allows); they are compared as exact
// instants, with every fractional digit, across offsets. For `date`, values
// and bounds are RFC 3339 full-dates, compared as calendar dates.

/** A stream's consent_time_field and the format its manifest declares. */
export type ConsentTimeField = {
	readonly field: string;
	readonly format: "date" | "date-time";
};

const ISO_INSTANT_RE =
	/^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/;

const FULL_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function isRealDate(yearRaw = "", monthRaw = "", dayRaw = ""): boolean {
	const year = Number(yearRaw);
	const month = Number(monthRaw);
	const day = Number(dayRaw);
	if (month < 1 || month > 12) {
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

function isValidIsoInstantShape(match: RegExpMatchArray): boolean {
	const [, yearRaw, monthRaw, dayRaw, hourRaw, minuteRaw, secondRaw] = match;
	if (
		Number(hourRaw) > 23 ||
		Number(minuteRaw) > 59 ||
		Number(secondRaw) > 59
	) {
		return false;
	}
	return isRealDate(yearRaw, monthRaw, dayRaw);
}

/** An RFC 3339 full-date (`YYYY-MM-DD`, a real calendar day), or null. */
export function parseFullDate(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const match = value.match(FULL_DATE_RE);
	return match && isRealDate(match[1], match[2], match[3]) ? value : null;
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

/**
 * Returns true if the scope's half-open time_range excludes this record value.
 * `format` is the consent field's declared format; a bound or value that is
 * not of that type excludes the record.
 */
export function isOutsideTimeRange(
	timeRange: { since?: string; until?: string },
	dateValue: unknown,
	format: ConsentTimeField["format"] = "date-time",
): boolean {
	if (format === "date") {
		const since =
			timeRange.since === undefined
				? undefined
				: parseFullDate(timeRange.since);
		const until =
			timeRange.until === undefined
				? undefined
				: parseFullDate(timeRange.until);
		const value = parseFullDate(dateValue);
		// Full-dates of the same shape order lexically as calendar days.
		return (
			since === null ||
			until === null ||
			value === null ||
			(since !== undefined && value < since) ||
			(until !== undefined && value >= until)
		);
	}
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
	consent: ConsentTimeField | null,
): string | null {
	if (!timeRange) return null;
	if (consent === null) {
		return `time_range cannot be applied to ${stream}: its manifest declares no supported consent_time_field`;
	}
	const isDate = consent.format === "date";
	const bad = (["since", "until"] as const).filter(
		(bound) =>
			timeRange[bound] !== undefined &&
			(isDate
				? parseFullDate(timeRange[bound])
				: parseIsoInstant(timeRange[bound])) === null,
	);
	if (bad.length === 0) return null;
	return isDate
		? `time_range ${bad.join(" and ")} for ${stream} must be a full-date, because ${consent.field} is a calendar date`
		: `time_range ${bad.join(" and ")} for ${stream} must be a date-time with a time-zone offset, because ${consent.field} is an instant`;
}
