// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/** Advisory comparison of bounded raw RECORD observations across capture runs. */

export interface RawObservationRecord {
	data: unknown;
	id?: string;
	identity?: unknown;
	stream: string;
	/** The wire RECORD `key` exactly as emitted (string or string[]), before the
	 *  decoder flattened it into `id`. Preferred over `id`, which cannot tell
	 *  the key ["x"] from the scalar string '["x"]'. */
	wireKey?: unknown;
}

export interface RawObservationStreamMetadata {
	name: string;
	primaryKey?: readonly string[];
	safeFieldPaths: readonly string[];
	excludedFields?: readonly string[];
	/** Set when `safeFieldPaths` stopped at a collection bound, so deeper
	 *  declared fields fall into the generic bucket. */
	schemaPathsBounded?: boolean;
}

export interface RawObservationRun {
	records: readonly RawObservationRecord[];
	run: number;
	scopeKey: string;
}

export interface ChangedFieldCount {
	field: string;
	identities: number;
}

export interface RawObservationStreamSummary {
	comparedIdentities: number;
	sampleLimit: number;
	sampledIdentities: number;
	truncated: boolean;
	projectedChangedFields: ChangedFieldCount[];
	projectedUnnamedFieldIdentities: number;
	rawChangedFields: ChangedFieldCount[];
	rawUnnamedFieldIdentities: number;
	status:
		| "insufficient-repeat-observations"
		| "differences-observed"
		| "no-differences-observed-in-this-capture";
	stream: string;
}

export interface RawObservationSummary {
	identityLimit: number;
	missingIdentityRecords: number;
	oversizedIdentityRecords: number;
	unknownStreamSampleLimit: number;
	streams: RawObservationStreamSummary[];
	truncated: boolean;
	limitations: string[];
}

interface StoredObservation {
	data: unknown;
	lastComparedRun: number | undefined;
	run: number;
	scopeKey: string;
}

interface MutableStreamSummary {
	comparedIdentities: number;
	projectedFields: Map<string, number>;
	projectedUnnamedFieldIdentities: number;
	rawFields: Map<string, number>;
	rawUnnamedFieldIdentities: number;
}

const UNNAMED_STREAM = "(undeclared stream)";
const MAX_IDENTITY_KEY_LENGTH = 4096;

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonEqual(left: unknown, right: unknown): boolean {
	if (Object.is(left, right)) {
		return true;
	}
	if (Array.isArray(left) && Array.isArray(right)) {
		return (
			left.length === right.length &&
			left.every((item, index) => jsonEqual(item, right[index]))
		);
	}
	if (!isObject(left) || !isObject(right)) {
		return false;
	}
	for (const key in left) {
		if (
			Object.hasOwn(left, key) &&
			(!Object.hasOwn(right, key) || !jsonEqual(left[key], right[key]))
		) {
			return false;
		}
	}
	for (const key in right) {
		if (Object.hasOwn(right, key) && !Object.hasOwn(left, key)) {
			return false;
		}
	}
	return true;
}

interface ChangedFields {
	fields: Set<string>;
	unnamed: boolean;
}

function addChangedField(
	path: string,
	safeFields: ReadonlySet<string>,
	changed: ChangedFields,
): void {
	if (safeFields.has(path)) {
		changed.fields.add(path);
	} else {
		changed.unnamed = true;
	}
}

/** Collect safe names directly; unknown keys only set a fixed bucket flag. */
function collectChangedFields(
	left: unknown,
	right: unknown,
	safeFields: ReadonlySet<string>,
	excludedTopLevel: ReadonlySet<string>,
	changed: ChangedFields,
	prefix = "",
): void {
	if (Object.is(left, right)) {
		return;
	}
	if (Array.isArray(left) && Array.isArray(right)) {
		if (!jsonEqual(left, right)) {
			if (prefix) addChangedField(prefix, safeFields, changed);
			else changed.unnamed = true;
		}
		return;
	}
	if (!isObject(left) || !isObject(right)) {
		if (prefix) addChangedField(prefix, safeFields, changed);
		else changed.unnamed = true;
		return;
	}
	for (const key in left) {
		if (!Object.hasOwn(left, key)) {
			continue;
		}
		if (!prefix && excludedTopLevel.has(key)) {
			continue;
		}
		const path = prefix ? `${prefix}.${key}` : key;
		if (!Object.hasOwn(right, key)) {
			addChangedField(path, safeFields, changed);
		} else {
			collectChangedFields(
				left[key],
				right[key],
				safeFields,
				excludedTopLevel,
				changed,
				path,
			);
		}
	}
	for (const key in right) {
		if (
			Object.hasOwn(right, key) &&
			!Object.hasOwn(left, key) &&
			(prefix || !excludedTopLevel.has(key))
		) {
			const path = prefix ? `${prefix}.${key}` : key;
			addChangedField(path, safeFields, changed);
		}
	}
}

function addCounts(
	target: Map<string, number>,
	values: ReadonlySet<string>,
): void {
	for (const field of values) {
		target.set(field, (target.get(field) ?? 0) + 1);
	}
}

function publicFields(
	counts: ReadonlyMap<string, number>,
): ChangedFieldCount[] {
	return [...counts]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([field, identities]) => ({ field, identities }));
}

function identityForRecord(
	record: RawObservationRecord,
	metadata: RawObservationStreamMetadata | undefined,
	maxLength: number,
): { key?: string; hadCandidate: boolean } {
	const candidates: unknown[] = [];
	if (Object.hasOwn(record, "identity") && record.identity !== undefined) {
		candidates.push(record.identity);
	}
	const data = record.data;
	if (
		metadata?.primaryKey?.length &&
		isObject(data) &&
		metadata.primaryKey.every(
			(field) => Object.hasOwn(data, field) && data[field] !== undefined,
		)
	) {
		candidates.push(metadata.primaryKey.map((field) => [field, data[field]]));
	}
	if (record.wireKey !== undefined) candidates.push(record.wireKey);
	else if (typeof record.id === "string") candidates.push(record.id);
	for (const candidate of candidates) {
		const key = boundedCanonicalJson(candidate, maxLength);
		if (key !== undefined) return { key, hadCandidate: true };
	}
	return { hadCandidate: candidates.length > 0 };
}

/** Canonical identity encoding that stops before retaining oversized keys. */
function boundedCanonicalJson(
	value: unknown,
	maxLength: number,
): string | undefined {
	let size = 0;
	const active = new Set<object>();
	const append = (part: string): string | undefined => {
		size += part.length;
		return size <= maxLength ? part : undefined;
	};
	const encode = (item: unknown, depth: number): string | undefined => {
		if (depth > 32) return undefined;
		if (item === null || typeof item !== "object") {
			if (typeof item === "string" && item.length > maxLength) return undefined;
			return append(JSON.stringify(item) ?? "undefined");
		}
		if (active.has(item)) return undefined;
		active.add(item);
		try {
			const parts: string[] = [];
			if (Array.isArray(item)) {
				if (item.length > maxLength || append("[") === undefined) {
					return undefined;
				}
				for (let index = 0; index < item.length; index += 1) {
					if (index > 0 && append(",") === undefined) return undefined;
					const encoded = encode(item[index], depth + 1);
					if (encoded === undefined) return undefined;
					parts.push(encoded);
				}
				if (append("]") === undefined) return undefined;
				return `[${parts.join(",")}]`;
			}

			const keys = Object.keys(item);
			if (keys.length > maxLength || append("{") === undefined) {
				return undefined;
			}
			keys.sort();
			for (let index = 0; index < keys.length; index += 1) {
				const key = keys[index];
				if (key === undefined) return undefined;
				if (index > 0 && append(",") === undefined) return undefined;
				const encodedKey = append(JSON.stringify(key));
				if (encodedKey === undefined || append(":") === undefined) {
					return undefined;
				}
				const encodedValue = encode(
					(item as Record<string, unknown>)[key],
					depth + 1,
				);
				if (encodedValue === undefined) return undefined;
				parts.push(`${encodedKey}:${encodedValue}`);
			}
			if (append("}") === undefined) return undefined;
			return `{${parts.join(",")}}`;
		} finally {
			active.delete(item);
		}
	};
	return encode(value, 0);
}

/**
 * Compare only same-scope records with the same typed identity from distinct
 * runs. At most `identityLimit` first-run identities are retained; references
 * point into the recorder's existing capture arrays, so this makes no payload
 * copy. Unknown streams and undeclared fields collapse into fixed buckets.
 */
export function analyzeRawObservations(
	runs: readonly RawObservationRun[],
	metadata: readonly RawObservationStreamMetadata[],
	identityLimit = 250,
): RawObservationSummary {
	const declaredByName = new Map(
		metadata.map((stream) => [stream.name, stream]),
	);
	const sortedMetadata = [...metadata].sort((a, b) =>
		a.name.localeCompare(b.name),
	);
	const unknownStreamSampleLimit =
		identityLimit > 1 ? Math.max(1, Math.floor(identityLimit / 5)) : 0;
	const declaredBudget = Math.max(0, identityLimit - unknownStreamSampleLimit);
	const baseLimit =
		sortedMetadata.length > 0
			? Math.floor(declaredBudget / sortedMetadata.length)
			: 0;
	let remainder =
		sortedMetadata.length > 0 ? declaredBudget % sortedMetadata.length : 0;
	const sampleLimits = new Map<string, number>();
	for (const stream of sortedMetadata) {
		sampleLimits.set(stream.name, baseLimit + (remainder-- > 0 ? 1 : 0));
	}
	const firstByStream = new Map<string, Map<string, StoredObservation>>();
	const summaries = new Map<string, MutableStreamSummary>();
	const sampledByStream = new Map<string, number>();
	const truncatedStreams = new Set<string>();
	let safeMetadataUnavailable = false;
	const schemaPathsBounded = metadata.some(
		(stream) => stream.schemaPathsBounded,
	);
	let missingIdentityRecords = 0;
	let oversizedIdentityRecords = 0;
	const scopeMismatch = new Set(runs.map((run) => run.scopeKey)).size > 1;
	let sawUnknownStream = false;
	let unknownSampledIdentities = 0;

	for (const run of runs) {
		for (const record of run.records) {
			const declared = declaredByName.get(record.stream);
			if (!declared || declared.safeFieldPaths.length === 0) {
				safeMetadataUnavailable = true;
			}
			const displayStream = declared?.name ?? UNNAMED_STREAM;
			if (!declared) sawUnknownStream = true;
			const streamKey = declared
				? `declared:${declared.name}`
				: `unknown:${record.stream}`;
			const sampleLimit = declared
				? (sampleLimits.get(declared.name) ?? 0)
				: unknownStreamSampleLimit;
			let firstRecords = firstByStream.get(streamKey);
			if (!firstRecords) {
				firstRecords = new Map();
			}
			const identityResult = identityForRecord(
				record,
				declared,
				MAX_IDENTITY_KEY_LENGTH,
			);
			if (identityResult.key === undefined) {
				if (identityResult.hadCandidate) {
					oversizedIdentityRecords += 1;
				} else {
					missingIdentityRecords += 1;
				}
				continue;
			}
			const identityKey = identityResult.key;
			const previous = firstRecords.get(identityKey);
			if (!previous) {
				const sampled = declared
					? (sampledByStream.get(streamKey) ?? 0)
					: unknownSampledIdentities;
				if (sampled >= sampleLimit) {
					truncatedStreams.add(displayStream);
					continue;
				}
				firstRecords.set(identityKey, {
					data: record.data,
					lastComparedRun: undefined,
					run: run.run,
					scopeKey: run.scopeKey,
				});
				firstByStream.set(streamKey, firstRecords);
				if (declared) {
					sampledByStream.set(streamKey, sampled + 1);
				} else {
					unknownSampledIdentities += 1;
				}
				continue;
			}
			if (previous.run === run.run) {
				continue;
			}
			if (previous.scopeKey !== run.scopeKey) {
				continue;
			}
			if (previous.lastComparedRun === run.run) {
				continue;
			}
			previous.lastComparedRun = run.run;

			let summary = summaries.get(displayStream);
			if (!summary) {
				summary = {
					comparedIdentities: 0,
					projectedFields: new Map(),
					projectedUnnamedFieldIdentities: 0,
					rawFields: new Map(),
					rawUnnamedFieldIdentities: 0,
				};
				summaries.set(displayStream, summary);
			}
			summary.comparedIdentities += 1;
			const safeFields = new Set(declared?.safeFieldPaths ?? []);
			const excluded = new Set(declared?.excludedFields ?? []);
			const rawChanged: ChangedFields = { fields: new Set(), unnamed: false };
			const projectedChanged: ChangedFields = {
				fields: new Set(),
				unnamed: false,
			};
			collectChangedFields(
				previous.data,
				record.data,
				safeFields,
				new Set(),
				rawChanged,
			);
			collectChangedFields(
				previous.data,
				record.data,
				safeFields,
				excluded,
				projectedChanged,
			);
			addCounts(summary.rawFields, rawChanged.fields);
			addCounts(summary.projectedFields, projectedChanged.fields);
			if (rawChanged.unnamed) summary.rawUnnamedFieldIdentities += 1;
			if (projectedChanged.unnamed) {
				summary.projectedUnnamedFieldIdentities += 1;
			}
		}
	}

	const outputMetadata = [
		...sortedMetadata,
		...(sawUnknownStream ? [{ name: UNNAMED_STREAM, safeFieldPaths: [] }] : []),
	];
	const truncated = truncatedStreams.size > 0;
	const streams = outputMetadata.map((metadataEntry) => {
		const summary = summaries.get(metadataEntry.name);
		const streamKey =
			metadataEntry.name === UNNAMED_STREAM
				? undefined
				: `declared:${metadataEntry.name}`;
		const comparedIdentities = summary?.comparedIdentities ?? 0;
		const sampleLimit =
			metadataEntry.name === UNNAMED_STREAM
				? unknownStreamSampleLimit
				: (sampleLimits.get(metadataEntry.name) ?? 0);
		const sampledIdentities = streamKey
			? (sampledByStream.get(streamKey) ?? 0)
			: unknownSampledIdentities;
		const hasDifferences = Boolean(
			summary &&
				(summary.rawFields.size > 0 || summary.rawUnnamedFieldIdentities > 0),
		);
		return {
			comparedIdentities,
			sampleLimit,
			sampledIdentities,
			truncated: truncatedStreams.has(metadataEntry.name),
			projectedChangedFields: publicFields(
				summary?.projectedFields ?? new Map(),
			),
			projectedUnnamedFieldIdentities:
				summary?.projectedUnnamedFieldIdentities ?? 0,
			rawChangedFields: publicFields(summary?.rawFields ?? new Map()),
			rawUnnamedFieldIdentities: summary?.rawUnnamedFieldIdentities ?? 0,
			status:
				comparedIdentities === 0
					? "insufficient-repeat-observations"
					: hasDifferences
						? "differences-observed"
						: "no-differences-observed-in-this-capture",
			stream: metadataEntry.name,
		} satisfies RawObservationStreamSummary;
	});

	return {
		identityLimit,
		missingIdentityRecords,
		oversizedIdentityRecords,
		unknownStreamSampleLimit,
		streams,
		truncated: truncatedStreams.size > 0,
		limitations: [
			"This advisory compares emitted records from this capture only; it does not prove freshness, completeness, author-clock independence, or future provider behavior.",
			"Raw means the wire RECORD.data before comparison exclusions, not the provider's pre-normalization response.",
			"Only the first observation of each identity in a run is retained; later records with the same identity in that run are not compared.",
			`The retained-identity limit of ${identityLimit} does not bound total payload size, scan CPU, or schema size.`,
			...(schemaPathsBounded
				? [
						"Schema field metadata was bounded for one or more streams; fields past the bound are reported in generic buckets.",
					]
				: []),
			...(safeMetadataUnavailable
				? [
						"Manifest/schema metadata was unavailable for one or more observed streams; generic stream or field buckets are used.",
					]
				: []),
			...(scopeMismatch
				? [
						"Some matching identities came from runs whose scope or selection context differed or could not be established (for example, any run that used an OTP prompt); those comparisons were omitted.",
					]
				: []),
			...(truncated
				? [
						`One or more per-stream identity sample limits were reached within the total identity limit of ${identityLimit}; additional identities were skipped.`,
					]
				: []),
			...(missingIdentityRecords > 0
				? [
						`${missingIdentityRecords} record(s) had missing identity data and were skipped because no usable declared primary key or protocol identity was available.`,
					]
				: []),
			...(oversizedIdentityRecords > 0
				? [
						`${oversizedIdentityRecords} record identity value(s) exceeded the bounded serialization limit of ${MAX_IDENTITY_KEY_LENGTH} characters and were skipped.`,
					]
				: []),
		],
	};
}
