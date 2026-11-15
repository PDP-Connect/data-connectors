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

/**
 * Normalize English dates without inventing precision or calendar validation.
 * ISO-shaped values pass through, even if their month or day is out of range.
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
		return value;
	}
	if (ISO_MONTH_RE.test(value)) {
		return value;
	}
	const full = MONTH_DAY_YEAR_RE.exec(value);
	if (full) {
		const month = MONTHS[(full[1] ?? "").toLowerCase()];
		const day = Number.parseInt(full[2] ?? "", 10);
		if (month && day >= 1 && day <= 31) {
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
