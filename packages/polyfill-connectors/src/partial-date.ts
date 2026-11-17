// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

const WHITESPACE_RE = /\s+/g;
const MARKS_RE = /[\u200E\u200F]/g;
const MONTH_DAY_YEAR_RE = /^([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})$/;
const MONTH_YEAR_RE = /^([A-Za-z]+)\.?,?\s+(\d{4})$/;
const YEAR_RE = /^(\d{4})$/;
const ISO_FULL_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_MONTH_RE = /^(\d{4})-(\d{2})$/;

const MONTHS: Record<string, number> = {
	jan: 1,
	january: 1,
	feb: 2,
	february: 2,
	mar: 3,
	march: 3,
	apr: 4,
	april: 4,
	may: 5,
	jun: 6,
	june: 6,
	jul: 7,
	july: 7,
	aug: 8,
	august: 8,
	sep: 9,
	sept: 9,
	september: 9,
	oct: 10,
	october: 10,
	nov: 11,
	november: 11,
	dec: 12,
	december: 12,
};

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** Whether the day exists in that month of that year ("Feb 30" does not). */
function isCalendarDay(year: number, month: number, day: number): boolean {
	if (month < 1 || month > 12 || day < 1) {
		return false;
	}
	const date = new Date(0);
	date.setUTCFullYear(year, month - 1, day);
	return date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/**
 * Normalize English dates without inventing precision: "Aug 27, 2023" ->
 * "2023-08-27", "February 2022" -> "2022-02", "2019" -> "2019". A day or
 * month the calendar lacks ("Feb 30", "2023-13") is no date, so it returns
 * null. Valid ISO-shaped input passes through, so applying it twice is safe.
 */
export function normalizeEnglishPartialDate(
	text: string | null | undefined,
): string | null {
	const value = (text ?? "")
		.replace(MARKS_RE, "")
		.replace(WHITESPACE_RE, " ")
		.trim();
	if (value === "") {
		return null;
	}
	const iso = ISO_FULL_RE.exec(value);
	if (iso) {
		return isCalendarDay(Number(iso[1]), Number(iso[2]), Number(iso[3]))
			? value
			: null;
	}
	const isoMonth = ISO_MONTH_RE.exec(value);
	if (isoMonth) {
		return isCalendarDay(Number(isoMonth[1]), Number(isoMonth[2]), 1)
			? value
			: null;
	}
	const full = MONTH_DAY_YEAR_RE.exec(value);
	if (full) {
		const month = MONTHS[(full[1] ?? "").toLowerCase()];
		const day = Number.parseInt(full[2] ?? "", 10);
		if (month && isCalendarDay(Number(full[3]), month, day)) {
			return `${full[3]}-${pad2(month)}-${pad2(day)}`;
		}
		return null;
	}
	const monthYear = MONTH_YEAR_RE.exec(value);
	if (monthYear) {
		const month = MONTHS[(monthYear[1] ?? "").toLowerCase()];
		return month ? `${monthYear[2]}-${pad2(month)}` : null;
	}
	const year = YEAR_RE.exec(value);
	return year ? (year[1] ?? null) : null;
}
