// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const finiteNumber = (value: unknown): number | null =>
	typeof value === "number" && Number.isFinite(value) && value >= 0
		? value
		: null;

/**
 * Strava renders calories in the activity detail HTML as a `Calories` label
 * followed by a `strong` value in the adjacent stats column. No other detail
 * text is read or retained.
 */
export function parseActivityCalories(html: string): number | null {
	const label = /<div\b[^>]*class=['"]spans5['"][^>]*>\s*Calories\s*<\/div>\s*<div\b[^>]*class=['"]spans3['"][^>]*>([\s\S]*?)<\/div>/i.exec(
		html,
	);
	if (!label) return null;
	const strong = /<strong\b[^>]*>([^<]*)<\/strong>/i.exec(label[1] ?? "");
	const text = strong?.[1]?.replaceAll(",", "").trim();
	if (!text || !/^\d+(?:\.\d+)?$/.test(text)) return null;
	return finiteNumber(Number(text));
}

/**
 * Strava's activity-stream endpoint returns an object keyed by stream name;
 * `heartrate` is an array of samples. A few responses wrap samples in `data`.
 * The summary fields use the actual samples, not values inferred from UI text.
 */
export function parseHeartRateStream(body: string): {
	average: number | null;
	maximum: number | null;
} | null {
	let payload: unknown;
	try {
		payload = JSON.parse(body);
	} catch {
		return null;
	}
	if (!isRecord(payload)) return null;
	const stream = payload.heartrate;
	const samples = Array.isArray(stream)
		? stream
		: isRecord(stream) && Array.isArray(stream.data)
			? stream.data
			: [];
	const values = samples
		.map((sample) =>
			isRecord(sample) ? finiteNumber(sample.value) : finiteNumber(sample),
		)
		.filter((sample): sample is number => sample !== null);
	if (values.length === 0) return { average: null, maximum: null };
	return {
		average: values.reduce((sum, value) => sum + value, 0) / values.length,
		maximum: Math.max(...values),
	};
}

/** Read the gear identifier already exposed on the activity list model. */
export function activityGearId(model: unknown): string | null {
	if (!isRecord(model)) return null;
	for (const key of ["athlete_gear_id", "bike_id"] as const) {
		const value = model[key];
		if (
			(typeof value === "string" && /^\d{1,30}$/.test(value)) ||
			(typeof value === "number" && Number.isSafeInteger(value) && value > 0)
		) {
			return String(value);
		}
	}
	return null;
}

/** Parse the gear list shape exposed by Strava's signed-in bikes/shoes JSON. */
export function parseGearNames(body: string): Map<string, string> | null {
	let payload: unknown;
	try {
		payload = JSON.parse(body);
	} catch {
		return null;
	}
	if (!Array.isArray(payload)) return null;
	const names = new Map<string, string>();
	for (const item of payload) {
		if (!isRecord(item)) continue;
		const id = item.id;
		const name = item.display_name;
		if (
			((typeof id === "number" && Number.isSafeInteger(id) && id > 0) ||
				(typeof id === "string" && /^\d{1,30}$/.test(id))) &&
			typeof name === "string" &&
			name.trim().length > 0
		) {
			names.set(String(id), name.trim());
		}
	}
	return names;
}
