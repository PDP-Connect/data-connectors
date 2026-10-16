// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Typed field reads from untrusted source data, with three outcomes.
 *
 * A connector maps source fields into record fields. The defect this module
 * prevents is the silent conversion of an unreadable source value into a
 * valid-looking record value: `nonEmpty(x) ?? null`, `count || 0`, `'' `,
 * `[]`. A record built that way passes the output schema, so nothing
 * downstream can tell "the source said there is no value" from "the source
 * sent something the connector could not read".
 *
 * `readField` keeps the difference:
 *
 *   - `read`           the source carried a value and it passed the validator.
 *                      Empty strings, `0`, `false` and `[]` are real values.
 *   - `explicit_empty` the source said "no value": an explicit `null`, a
 *                      validator-declared empty sentinel, or (only when the
 *                      caller opts in with `absent: "empty"`) a missing key.
 *   - `unavailable`    the value is missing, or present with the wrong type
 *                      or shape. The reason says which path failed and why.
 *
 * There is no truthiness anywhere in this module.
 *
 * `buildRow` turns a set of field reads into one record. If any field is
 * `unavailable`, the row is NOT covered: `emitRow` hands it to the runtime as
 * an omission (`emitRecord(..., { omissions })`) and the runtime WITHHOLDS the
 * whole row. No RECORD is sent, not even one with the unreadable field left
 * out: ingest replaces whole records, so a partial row would erase the stored
 * value. The runtime reports the key and the omitted field names with reasons
 * (`SKIP_RESULT{reason: "record_fields_unavailable"}`, never field values),
 * and the stream integrity rule (see `stream-integrity.ts`) withholds the
 * stream's completion claims and deletes for the run. The stored copy of the
 * row stays as it was: the key was enumerated, so the row is not absent.
 */

/** One field's outcome. */
export type FieldRead<T> =
	| { readonly kind: "read"; readonly value: T }
	| { readonly kind: "explicit_empty" }
	| { readonly kind: "unavailable"; readonly reason: string };

/**
 * What a validator concluded about one raw value.
 *
 * `problem` is VALUE-FREE: it names the expected type or shape and the kind
 * of mismatch, never any part of the source value (no string content, enum
 * member, number, URL component or JSON excerpt). It travels to the wire in
 * withheld-row diagnostics, and the row was withheld precisely because its
 * value could not be trusted or stored. Custom validators must keep this
 * contract.
 */
export type FieldCheck<T> =
	| { readonly kind: "value"; readonly value: T }
	| { readonly kind: "empty" }
	| { readonly kind: "malformed"; readonly problem: string };

export interface FieldValidator<T> {
	check(raw: unknown): FieldCheck<T>;
	/** Short description of the accepted shape, used in reasons. */
	readonly expected: string;
}

/** One path into the source: object keys and array indexes. */
export type FieldPath = string | readonly (string | number)[];

/**
 * What a missing key means, declared per field where the field is mapped.
 *
 *   - `"unavailable"` (the default, fail closed): absence is not evidence of
 *     anything, so the row is not covered.
 *   - `"empty"`: the source omits the key to mean "no value" (for example, an
 *     API that drops null fields from its JSON). Reads as `explicit_empty`.
 *   - `{ default: value }`: the source is sparse by convention and omits a
 *     field that holds its default (CloudKit, protobuf-backed JSON, many
 *     GraphQL APIs). Reads as that value. The value must pass the field's
 *     validator.
 *
 * Declare `"empty"` or a default only from the source's documented (or
 * captured) convention for that field, and say so at the call site. Never
 * infer it from a run's data. A present-but-malformed value is always
 * `unavailable`, whatever this says.
 */
export type AbsentMeans<T> = "empty" | "unavailable" | { readonly default: T };

export interface ReadFieldOptions<T = never> {
	readonly absent?: AbsentMeans<T>;
}

/** A field omission, as carried to the runtime and into SKIP_RESULT diagnostics. */
export interface FieldOmission {
	readonly field: string;
	readonly reason: string;
}

type PathOutcome<T> =
	| { readonly kind: "absent" }
	| { readonly kind: "null" }
	| FieldCheck<T>;

function segmentsOf(path: FieldPath): readonly (string | number)[] {
	return typeof path === "string" ? [path] : path;
}

function describePath(path: FieldPath): string {
	return segmentsOf(path)
		.map((segment) =>
			typeof segment === "number" ? `[${String(segment)}]` : segment,
		)
		.join(".");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolvePath<T>(
	source: unknown,
	path: FieldPath,
	validator: FieldValidator<T>,
): PathOutcome<T> {
	let current: unknown = source;
	const segments = segmentsOf(path);
	for (const [index, segment] of segments.entries()) {
		if (current === null) return { kind: "null" };
		if (current === undefined) return { kind: "absent" };
		const where = describePath(segments.slice(0, index)) || "<root>";
		if (typeof segment === "number") {
			if (!Array.isArray(current))
				return { kind: "malformed", problem: `${where} is not an array` };
			if (segment >= current.length) return { kind: "absent" };
			current = current[segment];
			continue;
		}
		if (!isRecord(current))
			return { kind: "malformed", problem: `${where} is not an object` };
		if (!Object.hasOwn(current, segment)) return { kind: "absent" };
		current = current[segment];
	}
	if (current === undefined) return { kind: "absent" };
	if (current === null) return { kind: "null" };
	return validator.check(current);
}

/**
 * Read one field. `paths` is one path, or a list of fallback paths tried in
 * order: `"title"` is one key, `["dateRange", "start"]` is one nested path,
 * and `[["headline"], ["occupation"]]` is two fallback paths. The first path
 * that yields a valid value wins, so a readable
 * fallback can satisfy a field. When no path yields a value, any malformed
 * path makes the field `unavailable`; otherwise an explicit null makes it
 * `explicit_empty`; otherwise every path was absent and `options.absent`
 * decides.
 */
export function readField<T>(
	source: unknown,
	paths: FieldPath | readonly FieldPath[],
	validator: FieldValidator<T>,
	options: ReadFieldOptions<T> = {},
): FieldRead<T> {
	const candidates: readonly FieldPath[] =
		typeof paths === "string" || !paths.some((path) => Array.isArray(path))
			? [paths as FieldPath]
			: (paths as readonly FieldPath[]);
	const malformed: string[] = [];
	let sawEmpty = false;
	for (const path of candidates) {
		const outcome = resolvePath(source, path, validator);
		if (outcome.kind === "value") return { kind: "read", value: outcome.value };
		if (outcome.kind === "malformed")
			malformed.push(`${describePath(path)}: ${outcome.problem}`);
		else if (outcome.kind === "null" || outcome.kind === "empty")
			sawEmpty = true;
	}
	if (malformed.length > 0)
		return { kind: "unavailable", reason: malformed.join("; ") };
	if (sawEmpty) return { kind: "explicit_empty" };
	const absent = options.absent ?? "unavailable";
	if (absent === "empty") return { kind: "explicit_empty" };
	if (typeof absent === "object") {
		const declared = validator.check(absent.default);
		if (declared.kind !== "value")
			throw new TypeError(
				`readField: declared default for ${candidates.map(describePath).join(" | ")} is not a valid ${validator.expected}`,
			);
		return { kind: "read", value: declared.value };
	}
	return {
		kind: "unavailable",
		reason: `absent: ${candidates.map(describePath).join(" | ")}`,
	};
}

/** A value the connector computed or already proved (an id it validated, a constant). */
export function fieldValue<T>(value: T): FieldRead<T> {
	return { kind: "read", value };
}

/** A field the source proved empty by other means (for example, a verified empty list). */
export function emptyField<T = never>(): FieldRead<T> {
	return { kind: "explicit_empty" };
}

export function unavailableField<T = never>(reason: string): FieldRead<T> {
	return { kind: "unavailable", reason };
}

/** Transform a read value; empty and unavailable pass through unchanged. */
export function mapField<T, U>(
	read: FieldRead<T>,
	transform: (value: T) => FieldRead<U>,
): FieldRead<U> {
	return read.kind === "read" ? transform(read.value) : read;
}

/**
 * First readable alternative across separately read sources (for example, a
 * headline on the profile, else the occupation on `/me`). Same precedence as
 * `readField`'s fallback paths: any value wins; else any unavailable source
 * makes the result unavailable; else empty.
 */
export function firstReadable<T>(
	...reads: readonly FieldRead<T>[]
): FieldRead<T> {
	const reasons: string[] = [];
	let sawEmpty = false;
	for (const read of reads) {
		if (read.kind === "read") return read;
		if (read.kind === "unavailable") reasons.push(read.reason);
		else sawEmpty = true;
	}
	if (reasons.length > 0)
		return { kind: "unavailable", reason: reasons.join("; ") };
	return sawEmpty
		? { kind: "explicit_empty" }
		: { kind: "unavailable", reason: "no source" };
}

// ─── Validators ─────────────────────────────────────────────────────────

const ISO_DATE_RE =
	/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))?$/;

/** `Date.parse` rolls `2026-02-30` over to March; reject days that do not exist. */
function isRealCalendarDay(iso: string): boolean {
	const [year, month, day] = iso.slice(0, 10).split("-").map(Number);
	if (year === undefined || month === undefined || day === undefined)
		return false;
	const date = new Date(Date.UTC(year, month - 1, day));
	return (
		date.getUTCFullYear() === year &&
		date.getUTCMonth() === month - 1 &&
		date.getUTCDate() === day &&
		Number.isFinite(Date.parse(iso))
	);
}

function malformed(problem: string): FieldCheck<never> {
	return { kind: "malformed", problem };
}

function describeRaw(raw: unknown): string {
	if (Array.isArray(raw)) return "array";
	return typeof raw;
}

export interface StringOptions {
	/** Reject `""` (for identifiers). Without it, `""` is a real value. */
	readonly nonEmpty?: boolean;
}

export interface NumberOptions {
	readonly integer?: boolean;
	readonly max?: number;
	readonly min?: number;
}

export const v = {
	string(options: StringOptions = {}): FieldValidator<string> {
		return {
			expected: options.nonEmpty ? "non-empty string" : "string",
			check(raw) {
				if (typeof raw !== "string")
					return malformed(`expected string, got ${describeRaw(raw)}`);
				if (options.nonEmpty && raw.length === 0)
					return malformed("expected non-empty string");
				return { kind: "value", value: raw };
			},
		};
	},
	number(options: NumberOptions = {}): FieldValidator<number> {
		return {
			expected: options.integer ? "integer" : "number",
			check(raw) {
				if (typeof raw !== "number" || !Number.isFinite(raw))
					return malformed(`expected finite number, got ${describeRaw(raw)}`);
				if (options.integer && !Number.isInteger(raw))
					return malformed("expected integer");
				if (options.min !== undefined && raw < options.min)
					return malformed(`below minimum ${String(options.min)}`);
				if (options.max !== undefined && raw > options.max)
					return malformed(`above maximum ${String(options.max)}`);
				return { kind: "value", value: raw };
			},
		};
	},
	boolean(): FieldValidator<boolean> {
		return {
			expected: "boolean",
			check(raw) {
				return typeof raw === "boolean"
					? { kind: "value", value: raw }
					: malformed(`expected boolean, got ${describeRaw(raw)}`);
			},
		};
	},
	/** ISO 8601 date (`YYYY-MM-DD`) or date-time with an offset; returned unchanged. */
	date(): FieldValidator<string> {
		return {
			expected: "ISO 8601 date",
			check(raw) {
				if (typeof raw !== "string")
					return malformed(`expected date string, got ${describeRaw(raw)}`);
				if (!(ISO_DATE_RE.test(raw) && isRealCalendarDay(raw)))
					return malformed("not an ISO 8601 date");
				return { kind: "value", value: raw };
			},
		};
	},
	/**
	 * Epoch milliseconds, returned as an ISO date-time. `emptyAt` lists source
	 * sentinels that mean "not reported" (for example `0`); they read as
	 * `explicit_empty`, never as the epoch.
	 */
	epochMillis(
		options: {
			readonly emptyAt?: readonly number[];
			readonly min?: number;
		} = {},
	): FieldValidator<string> {
		return {
			expected: "epoch milliseconds",
			check(raw) {
				if (typeof raw !== "number" || !Number.isFinite(raw))
					return malformed(
						`expected epoch milliseconds, got ${describeRaw(raw)}`,
					);
				if (options.emptyAt?.includes(raw)) return { kind: "empty" };
				if (options.min !== undefined && raw < options.min)
					return malformed(`below minimum ${String(options.min)}`);
				const date = new Date(raw);
				if (!Number.isFinite(date.getTime()))
					return malformed("epoch milliseconds out of range");
				return { kind: "value", value: date.toISOString() };
			},
		};
	},
	url(
		options: { readonly protocols?: readonly string[] } = {},
	): FieldValidator<string> {
		const protocols = options.protocols ?? ["https:", "http:"];
		return {
			expected: "URL",
			check(raw) {
				if (typeof raw !== "string")
					return malformed(`expected URL string, got ${describeRaw(raw)}`);
				let parsed: URL;
				try {
					parsed = new URL(raw);
				} catch {
					return malformed("not a URL");
				}
				if (!protocols.includes(parsed.protocol))
					return malformed("URL protocol not allowed");
				return { kind: "value", value: raw };
			},
		};
	},
	enumOf<const T extends string>(values: readonly T[]): FieldValidator<T> {
		return {
			expected: `one of ${values.join(", ")}`,
			check(raw) {
				if (typeof raw !== "string")
					return malformed(`expected string, got ${describeRaw(raw)}`);
				const match = values.find((value) => value === raw);
				return match === undefined
					? malformed("not one of the expected values")
					: { kind: "value", value: match };
			},
		};
	},
	/** Every element must pass; one bad element makes the whole array malformed. */
	arrayOf<T>(element: FieldValidator<T>): FieldValidator<T[]> {
		return {
			expected: `array of ${element.expected}`,
			check(raw) {
				if (!Array.isArray(raw))
					return malformed(`expected array, got ${describeRaw(raw)}`);
				const values: T[] = [];
				for (const [index, item] of raw.entries()) {
					const result: FieldCheck<T> =
						item === null || item === undefined
							? malformed("null element")
							: element.check(item);
					if (result.kind === "malformed")
						return malformed(`[${String(index)}]: ${result.problem}`);
					if (result.kind === "empty")
						return malformed(`[${String(index)}]: empty element`);
					values.push(result.value);
				}
				return { kind: "value", value: values };
			},
		};
	},
	/** A plain object, returned as-is for further `readField` calls. */
	object(): FieldValidator<Record<string, unknown>> {
		return {
			expected: "object",
			check(raw) {
				return isRecord(raw)
					? { kind: "value", value: raw }
					: malformed(`expected object, got ${describeRaw(raw)}`);
			},
		};
	},
	/**
	 * Connector-specific shape. `check` must not coerce: return `malformed` for
	 * anything it cannot read, with a value-free `problem` (see `FieldCheck`).
	 */
	custom<T>(
		expected: string,
		check: (raw: unknown) => FieldCheck<T>,
	): FieldValidator<T> {
		return { expected, check };
	},
} as const;

// ─── Rows ───────────────────────────────────────────────────────────────

type FieldReads = Readonly<Record<string, FieldRead<unknown>>>;

type RowData<F extends FieldReads> = {
	[K in keyof F]: F[K] extends FieldRead<infer T> ? T | null : never;
};

export type RowRead<F extends FieldReads = FieldReads> =
	| { readonly covered: true; readonly data: RowData<F> }
	| {
			readonly covered: false;
			readonly data: RowData<F>;
			readonly omissions: readonly FieldOmission[];
	  };

export interface BuildRowOptions<F extends FieldReads> {
	/**
	 * At least one of these fields must hold a read value. Without this, a
	 * source object that carries none of the row's content (for example `{}`)
	 * reads as a covered all-null row and could replace a stored row.
	 */
	readonly requireAnyOf?: readonly (keyof F & string)[];
	/**
	 * Reads the row depends on that are not record fields (for example, the
	 * nested collection a row was expanded from, or a joined profile). Any
	 * unavailable one makes the row uncovered; none of them lands in `data`.
	 */
	readonly dependsOn?: Readonly<Record<string, FieldRead<unknown>>>;
}

/**
 * Assemble one record from field reads. `explicit_empty` becomes `null`.
 * Any `unavailable` field makes the row uncovered and lists every such field
 * in `omissions`; its value in `data` is `null` only so diagnostics can show
 * the rest of the row — an uncovered row is never emitted as a RECORD.
 */
export function buildRow<F extends FieldReads>(
	fields: F,
	options: BuildRowOptions<F> = {},
): RowRead<F> {
	const data: Record<string, unknown> = {};
	const omissions: FieldOmission[] = [];
	for (const [field, read] of Object.entries(fields)) {
		if (read.kind === "read") data[field] = read.value;
		else {
			data[field] = null;
			if (read.kind === "unavailable")
				omissions.push({ field, reason: read.reason });
		}
	}
	for (const [name, read] of Object.entries(options.dependsOn ?? {}))
		if (read.kind === "unavailable")
			omissions.push({ field: name, reason: read.reason });
	const required = options.requireAnyOf ?? [];
	// An unavailable required field is already listed; only an all-empty
	// set needs its own omission.
	if (
		required.length > 0 &&
		!required.some((field) => fields[field]?.kind === "read") &&
		!required.some((field) => fields[field]?.kind === "unavailable")
	)
		omissions.push({
			field: required.join("|"),
			reason: "the row has no readable value for any of these fields",
		});
	// The mapped type is exactly the keys of `fields` with each read's value
	// type (or null); the loop above writes every key.
	const typed = data as RowData<F>;
	return omissions.length === 0
		? { covered: true, data: typed }
		: { covered: false, data: typed, omissions };
}

/**
 * Emit a built row through the runtime. A covered row emits as a normal
 * record. An uncovered row goes to the runtime with its omissions, so the
 * runtime refuses it, reports a `SKIP_RESULT`, and withholds the stream's
 * completion claims for this run. Returns whether the row was covered.
 */
export async function emitRow<F extends FieldReads>(
	ctx: {
		emitRecord: (
			stream: string,
			data: Record<string, unknown>,
			options?: { omissions?: readonly FieldOmission[] },
		) => Promise<void>;
	},
	stream: string,
	row: RowRead<F>,
): Promise<boolean> {
	if (row.covered) {
		await ctx.emitRecord(stream, row.data);
		return true;
	}
	await ctx.emitRecord(stream, row.data, { omissions: row.omissions });
	return false;
}

// ─── Enumerations ───────────────────────────────────────────────────────

/**
 * Raw paging evidence for one enumeration, exactly as the source sent it.
 *
 *   - `offset`: `start`, optional `count`, `total`, and any continuation
 *     marker (a next link or cursor) from the enumeration's pages. `start` is
 *     the offset of the FIRST page the walk read.
 *   - `cursor`: every page of a cursor walk, in order, as the source sent
 *     it: the cursor the walk REQUESTED for that page (`null`/absent for the
 *     first page) and the page's own `has_more` and `next_cursor`, plus
 *     `total` when the source reports one.
 */
export type PagingEvidence =
	| {
			readonly kind: "offset";
			readonly start: unknown;
			readonly count?: unknown;
			readonly total: unknown;
			readonly continuation?: unknown;
	  }
	| {
			readonly kind: "cursor";
			readonly pages: readonly CursorPage[];
			readonly total?: unknown;
	  };

/** One page of a cursor walk: what was requested, and the page's own signal. */
export interface CursorPage {
	readonly has_more: unknown;
	readonly next_cursor?: unknown;
	readonly requested_cursor?: unknown;
}

/**
 * A per-source declaration that the source returns the whole collection in
 * one unpaged container (no paging fields exist to check). Declare it only
 * from the source's documented or captured shape, at the call site.
 */
export interface UnpagedContainer {
	readonly kind: "unpaged";
	readonly basis: "source_returns_whole_collection";
}

/** Whether a list of items is the source's whole inventory. */
export type Enumeration<T> =
	| {
			readonly kind: "complete";
			readonly items: readonly T[];
			readonly basis: "declared_unpaged" | "paging_verified";
	  }
	| {
			readonly kind: "incomplete";
			readonly items: readonly T[];
			readonly reason: string;
	  };

function isCount(raw: unknown): raw is number {
	return typeof raw === "number" && Number.isInteger(raw) && raw >= 0;
}

/** A continuation marker is absent only when it is missing, null or "". */
function continues(marker: unknown): boolean {
	return marker !== undefined && marker !== null && marker !== "";
}

/**
 * Decide whether `items` is a complete inventory. An array alone is never
 * proof: a page can be the first of several, or empty while the source
 * reports rows. COMPLETE needs one of:
 *
 *   - offset paging that is coherent: `start` is 0, `total` is a count equal
 *     to the number of items, `count` (if sent) is a count, and there is no
 *     continuation;
 *   - a cursor walk whose last page says explicitly that nothing follows
 *     (`has_more === false`, no `next_cursor`), whose `total`, if sent,
 *     equals the number of items, and which is proven whole by either
 *     (a) a contiguous chain: the first page was requested with no cursor,
 *     each later page was requested with the previous page's `next_cursor`,
 *     and every page but the last said `has_more: true`; or (b) a `total`
 *     equal to the number of items. A last-page signal alone is never proof:
 *     a resumed walk's final page carries the same signal;
 *   - a declared unpaged container.
 *
 * Anything else is INCOMPLETE with a value-free reason. A full-inventory
 * stream must not claim completion (or delete what it did not see) from an
 * INCOMPLETE enumeration; see `fullInventoryCoverage` in the runtime.
 */
export function enumerated<T>(
	items: readonly T[],
	evidence?: PagingEvidence | UnpagedContainer,
): Enumeration<T> {
	const incomplete = (reason: string): Enumeration<T> => ({
		kind: "incomplete",
		items,
		reason,
	});
	if (evidence === undefined)
		return incomplete("no paging evidence and no declared unpaged container");
	if (evidence.kind === "unpaged")
		return { kind: "complete", items, basis: "declared_unpaged" };
	if (evidence.kind === "cursor") {
		const pages = Array.isArray(evidence.pages) ? evidence.pages : [];
		const last = pages.at(-1);
		if (last === undefined) return incomplete("no pages of the walk");
		if (last.has_more !== false)
			return incomplete("the last page does not say has_more is false");
		if (continues(last.next_cursor))
			return incomplete("the last page still carries a next cursor");
		const hasTotal = evidence.total !== undefined && evidence.total !== null;
		if (hasTotal) {
			if (!isCount(evidence.total)) return incomplete("total is not a count");
			if (evidence.total !== items.length)
				return incomplete("total does not equal the items read");
			return { kind: "complete", items, basis: "paging_verified" };
		}
		if (continues(pages[0]?.requested_cursor))
			return incomplete("the walk did not start at the first page");
		for (const [index, page] of pages.entries()) {
			if (index === 0) continue;
			const previous = pages[index - 1];
			if (previous?.has_more !== true)
				return incomplete("a page before the last did not say has_more");
			if (
				!continues(previous.next_cursor) ||
				page.requested_cursor !== previous.next_cursor
			)
				return incomplete("the walk's cursors are not a contiguous chain");
		}
		return { kind: "complete", items, basis: "paging_verified" };
	}
	if (!isCount(evidence.start)) return incomplete("start is not a count");
	if (evidence.start !== 0)
		return incomplete("the enumeration does not start at offset 0");
	if (!isCount(evidence.total)) return incomplete("total is not a count");
	if (evidence.count !== undefined && !isCount(evidence.count))
		return incomplete("count is not a count");
	if (continues(evidence.continuation))
		return incomplete("the source reports a continuation");
	if (evidence.total !== items.length)
		return incomplete("total does not equal the items read");
	return { kind: "complete", items, basis: "paging_verified" };
}
