// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The one reading contract for every mapped LinkedIn output field.
 *
 * PDPP LinkedIn replaces the legacy collector, so a stream claimed complete
 * authorizes deleting stored rows. A row may count toward that claim only when
 * every mapped field was actually read. "The record parsed and passed the
 * nullable output schema" is not that proof: a malformed source normalizes to
 * `null` and still passes.
 *
 * A field read has exactly one outcome:
 *
 * - `read`: a valid source shape gave a value. An empty string is a value.
 * - `empty`: a valid source shape says there is nothing, by design (`null`,
 *   or an optional key the source omits when unset).
 * - `unavailable`: the source is malformed, a container is missing or of the
 *   wrong type, or the shape cannot be read. The field is left out of the
 *   emitted record (a field-level omission, as in the ChatGPT and Anthropic
 *   connectors) and the row is not covered.
 *
 * Readers never touch a property of a value they have not checked first, so a
 * malformed payload cannot throw.
 */

export type UnavailableReason =
	/** No source in the field's chain carried the key, and the field does not
	 *  treat absence as empty. */
	| "absent"
	/** A value or container has the wrong type or shape. */
	| "malformed"
	/** A value has the right type but the schema rejects it. */
	| "invalid_value"
	/** The whole source object this field comes from was not returned. */
	| "source_unavailable"
	/** A connection's profile could not be resolved this run. */
	| "enrichment_unresolved"
	/** The connections walk did not prove the end of the list. */
	| "walk_unverified";

export type FieldRead<T> =
	| { readonly kind: "read"; readonly value: T }
	| { readonly kind: "empty" }
	| { readonly kind: "unavailable"; readonly reason: UnavailableReason };

export const EMPTY: FieldRead<never> = { kind: "empty" };

export function read<T>(value: T): FieldRead<T> {
	return { kind: "read", value };
}

export function unavailable(reason: UnavailableReason): FieldRead<never> {
	return { kind: "unavailable", reason };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Follow `path` from `root`. A missing key is `absent`, a `null` at any depth
 * is `empty`, and a non-object where an object is needed is `malformed`.
 */
export function at(root: unknown, path: readonly string[]): FieldRead<unknown> {
	let node: unknown = root;
	for (const key of path) {
		if (node === null) return EMPTY;
		if (!isRecord(node)) return unavailable("malformed");
		if (!Object.hasOwn(node, key)) return unavailable("absent");
		node = node[key];
	}
	return node === null ? EMPTY : read(node);
}

/** Apply a leaf reader to a `read` outcome; pass the others through. */
export function andThen<T, U>(
	outcome: FieldRead<T>,
	reader: (value: T) => FieldRead<U>,
): FieldRead<U> {
	return outcome.kind === "read" ? reader(outcome.value) : outcome;
}

/**
 * Resolve a field from its sources in priority order. The first `read` wins,
 * so a readable fallback can satisfy a field whose primary source is
 * malformed. Without a `read`, any malformed source makes the field
 * `unavailable`: the unread value might not be empty. Otherwise an explicit
 * `empty` wins, and a field no source mentions follows `whenAbsent`.
 */
export function firstOf<T>(
	sources: readonly FieldRead<T>[],
	whenAbsent: "empty" | "unavailable",
): FieldRead<T> {
	let failure: FieldRead<T> | null = null;
	let sawEmpty = false;
	for (const source of sources) {
		if (source.kind === "read") return source;
		if (source.kind === "empty") sawEmpty = true;
		else if (source.reason !== "absent") failure ??= source;
	}
	if (failure) return failure;
	if (sawEmpty || whenAbsent === "empty") return EMPTY;
	return unavailable("absent");
}

// ─── Leaf readers ────────────────────────────────────────────────────────

export function text(value: unknown): FieldRead<string> {
	return typeof value === "string" ? read(value) : unavailable("malformed");
}

export function textAt(
	root: unknown,
	path: readonly string[],
): FieldRead<string> {
	return andThen(at(root, path), text);
}

/** An endorsement count: a non-negative safe integer, or its decimal string. */
export function count(value: unknown): FieldRead<number> {
	if (typeof value === "number") {
		return Number.isSafeInteger(value) && value >= 0
			? read(value)
			: unavailable("malformed");
	}
	if (typeof value === "string" && DECIMAL_RE.test(value.trim())) {
		const parsed = Number(value.trim());
		return Number.isSafeInteger(parsed)
			? read(parsed)
			: unavailable("malformed");
	}
	return unavailable("malformed");
}

const DECIMAL_RE = /^\d+$/u;

/**
 * D4 partial date from a Voyager date point: `YYYY` or `YYYY-MM`, never a
 * day. A point needs an integer year in 1..9999. A month, when present, must
 * be an integer in 1..12. A point that exists but has no readable year is
 * malformed, not "no date": an unreadable end date must never read as a
 * current role.
 */
export function partialDate(value: unknown): FieldRead<string> {
	if (!isRecord(value)) return unavailable("malformed");
	const year = value.year;
	if (
		typeof year !== "number" ||
		!Number.isInteger(year) ||
		year < 1 ||
		year > 9999
	) {
		return unavailable("malformed");
	}
	const yyyy = String(year).padStart(4, "0");
	const month = at(value, ["month"]);
	if (month.kind !== "read") return read(yyyy);
	const mm = month.value;
	if (typeof mm !== "number" || !Number.isInteger(mm) || mm < 1 || mm > 12) {
		return unavailable("malformed");
	}
	return read(`${yyyy}-${String(mm).padStart(2, "0")}`);
}

/**
 * A connection's `createdAt` in epoch milliseconds, as ISO-8601. Zero means
 * "not reported" (empty), never the epoch. A value outside the `Date` range
 * is malformed rather than a thrown `RangeError`.
 */
export function epochMillis(value: unknown): FieldRead<string> {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		return unavailable("malformed");
	}
	if (value === 0) return EMPTY;
	const date = new Date(value);
	return Number.isNaN(date.getTime())
		? unavailable("malformed")
		: read(date.toISOString());
}

/**
 * URL of a Voyager vector image: `rootUrl` + the largest (last) artifact's
 * path segment. No `artifacts` key means this object is not an image source
 * (absent). An empty list means no image (empty). An artifact without a
 * readable, non-empty segment is malformed.
 */
export function vectorImageUrl(value: unknown): FieldRead<string> {
	if (!isRecord(value)) return unavailable("malformed");
	const artifacts = at(value, ["artifacts"]);
	if (artifacts.kind !== "read") return artifacts;
	if (!Array.isArray(artifacts.value)) return unavailable("malformed");
	if (artifacts.value.length === 0) return EMPTY;
	const segment = textAt(artifacts.value.at(-1), [
		"fileIdentifyingUrlPathSegment",
	]);
	if (segment.kind !== "read" || segment.value.length === 0) {
		return unavailable("malformed");
	}
	const rootUrl = at(value, ["rootUrl"]);
	if (rootUrl.kind === "unavailable" && rootUrl.reason !== "absent") {
		return rootUrl;
	}
	if (rootUrl.kind === "read" && typeof rootUrl.value !== "string") {
		return unavailable("malformed");
	}
	const prefix = rootUrl.kind === "read" ? (rootUrl.value as string) : "";
	return read(`${prefix}${segment.value}`);
}

// ─── Rows ────────────────────────────────────────────────────────────────

export type FieldReads = Readonly<Record<string, FieldRead<unknown>>>;

/** The part of a zod schema a row needs. */
export interface Checkable {
	safeParse(value: unknown): { success: boolean };
}

export interface RowSpec {
	/** The stream's whole output schema, checked once the row is built. */
	readonly schema: Checkable;
	/** Output schema fields, used to reject a read value the schema refuses. */
	readonly shape: Readonly<Record<string, Checkable>>;
	/** Fields without which the row cannot be emitted (its key, and any
	 *  manifest-required field). */
	readonly required: readonly string[];
	/** When set, at least one of these fields must be `read`, or the row has
	 *  no readable content and is not emitted. */
	readonly content?: readonly string[];
}

export type RowOutcome =
	| {
			readonly kind: "emitted";
			readonly record: Record<string, unknown>;
			readonly unavailable: ReadonlyArray<{
				readonly field: string;
				readonly reason: UnavailableReason;
			}>;
	  }
	| { readonly kind: "omitted"; readonly reason: string };

/**
 * Turn per-field reads into a row. A `read` the schema rejects becomes
 * `invalid_value`. `read` fields carry their value, `empty` fields are
 * `null`, and `unavailable` fields are left out. The row is covered only when
 * the outcome lists no unavailable field.
 */
export function assembleRow(spec: RowSpec, reads: FieldReads): RowOutcome {
	const settled: Record<string, FieldRead<unknown>> = {};
	for (const [field, outcome] of Object.entries(reads)) {
		const schema = spec.shape[field];
		settled[field] =
			outcome.kind === "read" &&
			schema &&
			!schema.safeParse(outcome.value).success
				? unavailable("invalid_value")
				: outcome;
	}
	for (const field of spec.required) {
		const outcome = settled[field];
		if (outcome?.kind !== "read") {
			return {
				kind: "omitted",
				reason: `${field}_${outcome?.kind === "unavailable" ? outcome.reason : "empty"}`,
			};
		}
	}
	if (
		spec.content &&
		!spec.content.some((field) => settled[field]?.kind === "read")
	) {
		return { kind: "omitted", reason: "no_readable_content" };
	}
	const record: Record<string, unknown> = {};
	const missing: Array<{ field: string; reason: UnavailableReason }> = [];
	for (const [field, outcome] of Object.entries(settled)) {
		if (outcome.kind === "read") record[field] = outcome.value;
		else if (outcome.kind === "empty") record[field] = null;
		else missing.push({ field, reason: outcome.reason });
	}
	if (!spec.schema.safeParse(record).success) {
		return { kind: "omitted", reason: "invalid_record_shape" };
	}
	return { kind: "emitted", record, unavailable: missing };
}

/**
 * A stream's rows and the evidence for its coverage. `considered` counts every
 * enumerated source row; `covered` counts emitted rows with no unavailable
 * field. Omitted rows and unavailable fields are tallied by reason.
 */
export interface StreamRows<T = Record<string, unknown>> {
	considered: number;
	covered: number;
	omittedRows: Record<string, number>;
	records: T[];
	unavailableFields: Record<string, Record<string, number>>;
}

export function emptyStreamRows<T>(): StreamRows<T> {
	return {
		considered: 0,
		covered: 0,
		omittedRows: {},
		records: [],
		unavailableFields: {},
	};
}

export function addOmittedRow(rows: StreamRows<unknown>, reason: string): void {
	rows.considered += 1;
	rows.omittedRows[reason] = (rows.omittedRows[reason] ?? 0) + 1;
}

export function addRow<T>(rows: StreamRows<T>, outcome: RowOutcome): void {
	if (outcome.kind === "omitted") {
		addOmittedRow(rows, outcome.reason);
		return;
	}
	rows.considered += 1;
	rows.records.push(outcome.record as T);
	if (outcome.unavailable.length === 0) {
		rows.covered += 1;
		return;
	}
	for (const { field, reason } of outcome.unavailable) {
		const byReason = rows.unavailableFields[field] ?? {};
		byReason[reason] = (byReason[reason] ?? 0) + 1;
		rows.unavailableFields[field] = byReason;
	}
}
