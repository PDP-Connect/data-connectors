// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pure parsers for the LinkedIn connector. No Playwright / Node I/O — the
// Voyager fetch loop and browser lifecycle live in index.ts. Kept separate
// so the field-mapping logic (the part most likely to drift when LinkedIn
// reshapes Voyager) is unit-testable without a browser.
//
// Every output field is declared below with its source path(s) in priority
// order and read through field-read.ts. A row is covered only when every
// mapped field is `read` or `empty`; see that file for the contract.
//
// Ground truth: connectors/linkedin/linkedin-playwright.js (legacy). LinkedIn
// has shipped both the legacy REST date shape (`timePeriod.startDate/endDate`)
// and the dash shape (`dateRange.start/end`) across decoration IDs, sometimes
// for the same account, plus the same fields inline on the node.

import {
	addOmittedRow,
	addRow,
	andThen,
	assembleRow,
	at,
	type Checkable,
	count,
	EMPTY,
	emptyStreamRows,
	epochMillis,
	type FieldRead,
	type FieldReads,
	firstOf,
	isCovered,
	isRecord,
	partialDate,
	type RowOutcome,
	type RowSpec,
	read,
	type StreamRows,
	textAt,
	unavailable,
	vectorImageUrl,
} from "./field-read.ts";
import {
	connectionsSchema,
	educationSchema,
	experienceSchema,
	languagesSchema,
	profileSchema,
	skillsSchema,
} from "./schemas.ts";

// ─── Record shapes ──────────────────────────────────────────────────────
// A field typed `T | null` may also be absent: absent means unavailable.

export interface ProfileRecord {
	connection_count?: number | null;
	current_company?: string | null;
	current_position_title?: string | null;
	full_name?: string | null;
	headline?: string | null;
	id: string;
	industry?: string | null;
	location?: string | null;
	profile_picture_url?: string | null;
	public_url?: string | null;
	summary?: string | null;
	[field: string]: unknown;
}

export interface ExperienceRecord {
	company?: string | null;
	description?: string | null;
	employment_type?: string | null;
	end_date?: string | null;
	id: string;
	location?: string | null;
	start_date?: string | null;
	title?: string | null;
	[field: string]: unknown;
}

export interface EducationRecord {
	degree?: string | null;
	end_date?: string | null;
	field_of_study?: string | null;
	grade?: string | null;
	id: string;
	logo_url?: string | null;
	school?: string | null;
	start_date?: string | null;
	[field: string]: unknown;
}

export interface SkillRecord {
	endorsement_count?: number | null;
	id: string;
	name: string;
	[field: string]: unknown;
}

export interface LanguageRecord {
	id: string;
	name: string;
	proficiency?: string | null;
	[field: string]: unknown;
}

export interface ConnectionRecord {
	connected_at?: string | null;
	full_name?: string | null;
	headline?: string | null;
	id: string;
	profile_url?: string | null;
	[field: string]: unknown;
}

// ─── Shared field readers ────────────────────────────────────────────────

type Path = readonly string[];

/** Date sources in priority order: dash `dateRange`, legacy `timePeriod`,
 *  then the oldest shape with the points inline on the node. */
const DATE_SOURCES: Readonly<Record<"start" | "end", readonly Path[]>> = {
	end: [
		["dateRange", "end"],
		["dateRange", "endDate"],
		["timePeriod", "end"],
		["timePeriod", "endDate"],
		["end"],
		["endDate"],
	],
	start: [
		["dateRange", "start"],
		["dateRange", "startDate"],
		["timePeriod", "start"],
		["timePeriod", "startDate"],
		["start"],
		["startDate"],
	],
};

/** D4 partial date. No date anywhere is `empty`; for `end` that means an
 *  ongoing role or course. A malformed point is never read as "ongoing". */
export function dateOf(
	node: unknown,
	edge: "start" | "end",
): FieldRead<string> {
	return firstOf(
		DATE_SOURCES[edge].map((path) => andThen(at(node, path), partialDate)),
		"empty",
	);
}

function optionalText(node: unknown, ...paths: Path[]): FieldRead<string> {
	return firstOf(
		paths.map((path) => textAt(node, path)),
		"empty",
	);
}

function imageAt(node: unknown, path: Path): FieldRead<string> {
	return andThen(at(node, path), vectorImageUrl);
}

/** A `{ elements: [...] }` collection. Only an array is readable: a missing,
 *  `null`, or wrong-typed collection never reads as an empty list. */
export function collectionAt(node: unknown, key: string): FieldRead<unknown[]> {
	const elements = at(node, [key, "elements"]);
	if (elements.kind === "read" && Array.isArray(elements.value)) {
		return read(elements.value);
	}
	return unavailable(
		elements.kind === "unavailable" && elements.reason === "absent"
			? "absent"
			: "malformed",
	);
}

/** Row id: the Voyager entity URN, else a positional id. Voyager omits the
 *  URN on some decoration versions; a malformed URN is unreadable. */
function idOf(node: unknown, prefix: string, index: number): FieldRead<string> {
	const urn = at(node, ["entityUrn"]);
	if (urn.kind === "read") {
		if (typeof urn.value !== "string") return unavailable("malformed");
		if (urn.value.length > 0) return read(urn.value);
	}
	if (urn.kind === "unavailable" && urn.reason !== "absent") return urn;
	return read(`${prefix}-${index}`);
}

/** "First Last". Unreadable when either part is; empty when both are. */
function joinName(
	first: FieldRead<string>,
	last: FieldRead<string>,
): FieldRead<string> {
	if (first.kind === "unavailable") return first;
	if (last.kind === "unavailable") return last;
	if (first.kind === "empty" && last.kind === "empty") return EMPTY;
	const firstText = first.kind === "read" ? first.value : "";
	const lastText = last.kind === "read" ? last.value : "";
	return read(`${firstText} ${lastText}`.trim());
}

/** Public profile permalink from the public identifier — the only stable
 *  cross-run id a connector-authored profile URL can be built from. */
export function profileUrlFor(publicIdentifier: string): string {
	return `https://www.linkedin.com/in/${publicIdentifier}/`;
}

function profileUrlRead(identifier: FieldRead<string>): FieldRead<string> {
	return andThen(identifier, (id) =>
		id.length === 0 ? EMPTY : read(profileUrlFor(id)),
	);
}

function rowSpec(
	schema: Checkable & { shape: Readonly<Record<string, Checkable>> },
	required: readonly string[],
	content?: readonly string[],
): RowSpec {
	return {
		schema,
		shape: schema.shape,
		required,
		...(content ? { content } : {}),
	};
}

// ─── profile ─────────────────────────────────────────────────────────────

export type DashProfileSource = "decoration" | "basic" | "unavailable";

export interface ProfileSources {
	/** The dash profile element, or null when no profile was returned. */
	dash: unknown;
	/** Whether `dash` came from a full decoration or the basic fallback. */
	dashSource: DashProfileSource;
	/** The `/voyager/api/me` body. */
	me: unknown;
	publicIdentifier: string;
	/** From the connections walk: `read` only on a verified end. */
	connectionCount: FieldRead<number>;
}

/**
 * Location of the owner. The `location` branch joins `preferredGeoPlace` and
 * `basicLocation.countryCode` when either is readable. The live account
 * (2026-09-22) had neither and resolved through
 * `geoLocation.geo.defaultLocalizedName`. The live `location.countryCode`
 * (no `basicLocation` wrapper) is not mapped.
 */
function locationRead(dash: unknown): FieldRead<string> {
	const parts = [
		textAt(dash, ["location", "preferredGeoPlace"]),
		textAt(dash, ["location", "basicLocation", "countryCode"]),
	];
	const failed = parts.find(
		(part) => part.kind === "unavailable" && part.reason !== "absent",
	);
	let locationBranch: FieldRead<string>;
	if (failed) {
		locationBranch = failed;
	} else if (parts.some((part) => part.kind === "read")) {
		locationBranch = read(
			parts
				.flatMap((part) => (part.kind === "read" ? [part.value] : []))
				.filter((part) => part.length > 0)
				.join(", "),
		);
	} else if (parts.some((part) => part.kind === "empty")) {
		locationBranch = EMPTY;
	} else {
		locationBranch = unavailable("absent");
	}
	return firstOf(
		[
			locationBranch,
			textAt(dash, ["geoLocation", "geo", "defaultLocalizedName"]),
		],
		"unavailable",
	);
}

/**
 * Current company and title. The current group is the first one with no end
 * date; within it, the first position with no end date, else the first
 * position. Every group read on the way must have only covered experience
 * rows, and its end date must be readable: an unreadable group could hide
 * the current role.
 */
function currentPositionReads(dash: unknown): {
	company: FieldRead<string>;
	title: FieldRead<string>;
} {
	const failedBoth = (outcome: FieldRead<never>) => ({
		company: outcome,
		title: outcome,
	});
	const groups = collectionAt(dash, "profilePositionGroups");
	if (groups.kind !== "read") return failedBoth(groups as FieldRead<never>);
	let current: Record<string, unknown> | null = null;
	for (const [groupIndex, group] of groups.value.entries()) {
		if (!isRecord(group)) return failedBoth(unavailable("malformed"));
		// A projection is only as readable as its source rows. A group whose
		// experience rows are not covered (malformed, contentless, or with an
		// unreadable field) cannot prove it is or is not the current role.
		if (!experienceRowsOf(group, groupIndex).every(isCovered)) {
			return failedBoth(unavailable("source_row_uncovered"));
		}
		const end = dateOf(group, "end");
		if (end.kind === "unavailable") return failedBoth(end);
		if (end.kind === "empty") {
			current = group;
			break;
		}
	}
	if (!current) return failedBoth(EMPTY);

	const company = optionalText(current, ["company", "name"], ["name"]);
	const positions = nestedPositions(current);
	if (positions.kind !== "read") {
		return { company, title: positions as FieldRead<never> };
	}
	let chosen: unknown = positions.value[0];
	for (const position of positions.value) {
		if (!isRecord(position))
			return { company, title: unavailable("malformed") };
		const end = dateOf(position, "end");
		if (end.kind === "unavailable") return { company, title: end };
		if (end.kind === "empty") {
			chosen = position;
			break;
		}
	}
	const title =
		chosen === undefined
			? optionalText(current, ["title"])
			: firstOf(
					[textAt(chosen, ["title"]), textAt(current, ["title"])],
					"empty",
				);
	return { company, title };
}

/**
 * Field reads for the owner's profile. Name, headline, and picture fall back
 * to `/me`. Fields only a full decoration carries (summary, industry,
 * location, current position) are unavailable from the basic fallback.
 * These dash-only fields must be present, even as `null`: the decoration
 * omitting them is not proof of an empty value.
 */
export function profileFieldReads(src: ProfileSources): FieldReads {
	const hasDash = isRecord(src.dash);
	const dashText = (path: Path): FieldRead<string> =>
		hasDash ? textAt(src.dash, path) : unavailable("source_unavailable");
	const decorated = hasDash && src.dashSource === "decoration";
	const decoration = <T>(reader: () => FieldRead<T>): FieldRead<T> =>
		decorated ? reader() : unavailable("source_unavailable");
	const current = decorated
		? currentPositionReads(src.dash)
		: {
				company: unavailable("source_unavailable"),
				title: unavailable("source_unavailable"),
			};

	return {
		connection_count: src.connectionCount,
		current_company: current.company,
		current_position_title: current.title,
		full_name: joinName(
			firstOf(
				[dashText(["firstName"]), textAt(src.me, ["miniProfile", "firstName"])],
				"unavailable",
			),
			firstOf(
				[dashText(["lastName"]), textAt(src.me, ["miniProfile", "lastName"])],
				"unavailable",
			),
		),
		headline: firstOf(
			[dashText(["headline"]), textAt(src.me, ["miniProfile", "occupation"])],
			"unavailable",
		),
		id: read(src.publicIdentifier),
		industry: decoration(() =>
			firstOf([textAt(src.dash, ["industry", "name"])], "unavailable"),
		),
		location: decoration(() => locationRead(src.dash)),
		profile_picture_url: firstOf(
			[
				hasDash
					? imageAt(src.dash, [
							"profilePicture",
							"displayImageReference",
							"vectorImage",
						])
					: unavailable("source_unavailable"),
				imageAt(src.me, [
					"miniProfile",
					"picture",
					"com.linkedin.common.VectorImage",
				]),
				imageAt(src.me, ["miniProfile", "picture"]),
			],
			"empty",
		),
		public_url: read(profileUrlFor(src.publicIdentifier)),
		summary: decoration(() =>
			firstOf([textAt(src.dash, ["summary"])], "unavailable"),
		),
	};
}

const PROFILE_ROW = rowSpec(profileSchema, ["id"]);

/** The profile stream: one row, keyed by public identifier. */
export function buildProfileRows(
	src: ProfileSources,
): StreamRows<ProfileRecord> {
	const rows = emptyStreamRows<ProfileRecord>();
	addRow(rows, assembleRow(PROFILE_ROW, profileFieldReads(src)));
	return rows;
}

// ─── experience ──────────────────────────────────────────────────────────

const EXPERIENCE_CONTENT = [
	"company",
	"description",
	"employment_type",
	"end_date",
	"location",
	"start_date",
	"title",
] as const;
const EXPERIENCE_ROW = rowSpec(experienceSchema, ["id"], EXPERIENCE_CONTENT);

/** A group's nested positions. No nested collection is a group without
 *  sub-positions; a present but unreadable one is malformed. */
function nestedPositions(group: Record<string, unknown>): FieldRead<unknown[]> {
	if (!Object.hasOwn(group, "profilePositionInPositionGroup")) return read([]);
	return collectionAt(group, "profilePositionInPositionGroup");
}

function positionReads(
	position: unknown,
	group: unknown,
	groupIndex: number,
	positionIndex: number,
): FieldReads {
	return {
		// A position without its own company name takes its group's.
		company: firstOf(
			[
				textAt(position, ["companyName"]),
				textAt(group, ["company", "name"]),
				textAt(group, ["name"]),
			],
			"empty",
		),
		description: optionalText(position, ["description"]),
		employment_type: optionalText(position, ["employmentType", "name"]),
		end_date: dateOf(position, "end"),
		id: idOf(position, `exp-${groupIndex}`, positionIndex),
		location: optionalText(position, ["locationName"], ["geoLocationName"]),
		start_date: dateOf(position, "start"),
		title: optionalText(position, ["title"]),
	};
}

function groupReads(group: unknown, groupIndex: number): FieldReads {
	return {
		company: optionalText(group, ["company", "name"], ["name"]),
		description: optionalText(group, ["description"]),
		// A position group carries no employment type; only positions do.
		employment_type: EMPTY,
		end_date: dateOf(group, "end"),
		id: idOf(group, "exp-group", groupIndex),
		location: optionalText(group, ["locationName"], ["geoLocationName"]),
		start_date: dateOf(group, "start"),
		title: optionalText(group, ["title"]),
	};
}

/**
 * D3: `profilePositionGroups` nests sub-positions under a company grouping.
 * A group with sub-positions expands to one experience row per position (a
 * person can hold multiple titles at one company); a group with none expands
 * to one row for the group itself.
 */
export function buildExperienceRows(
	groups: readonly unknown[],
): StreamRows<ExperienceRecord> {
	const rows = emptyStreamRows<ExperienceRecord>();
	for (const [groupIndex, group] of groups.entries()) {
		for (const outcome of experienceRowsOf(group, groupIndex)) {
			addRow(rows, outcome);
		}
	}
	return rows;
}

/** The experience row outcomes one source group yields: one per position,
 *  or one for the group itself when it has no positions. */
function experienceRowsOf(group: unknown, groupIndex: number): RowOutcome[] {
	if (!isRecord(group)) return [{ kind: "omitted", reason: "malformed_row" }];
	const positions = nestedPositions(group);
	if (positions.kind !== "read") {
		return [{ kind: "omitted", reason: "unreadable_nested_collection" }];
	}
	if (positions.value.length === 0) {
		return [assembleRow(EXPERIENCE_ROW, groupReads(group, groupIndex))];
	}
	return positions.value.map((position, positionIndex): RowOutcome => {
		if (!isRecord(position))
			return { kind: "omitted", reason: "malformed_row" };
		// Content must come from the position itself: a `{}` position would
		// otherwise inherit its group's company and pass as a real row.
		const own = positionReads(position, null, groupIndex, positionIndex);
		if (!EXPERIENCE_CONTENT.some((field) => own[field]?.kind === "read")) {
			return { kind: "omitted", reason: "no_readable_content" };
		}
		return assembleRow(
			EXPERIENCE_ROW,
			positionReads(position, group, groupIndex, positionIndex),
		);
	});
}

// ─── education ───────────────────────────────────────────────────────────

const EDUCATION_CONTENT = [
	"degree",
	"end_date",
	"field_of_study",
	"grade",
	"logo_url",
	"school",
	"start_date",
] as const;
const EDUCATION_ROW = rowSpec(educationSchema, ["id"], EDUCATION_CONTENT);

function educationReads(education: unknown, index: number): FieldReads {
	return {
		degree: optionalText(education, ["degreeName"]),
		end_date: dateOf(education, "end"),
		field_of_study: optionalText(education, ["fieldOfStudy"]),
		grade: optionalText(education, ["grade"]),
		id: idOf(education, "edu", index),
		// Legacy `logoUrl` order: the dash `school.logo` (bare, then typed
		// key), then the older `schoolLogo`.
		logo_url: firstOf(
			[
				imageAt(education, ["school", "logo", "vectorImage"]),
				imageAt(education, [
					"school",
					"logo",
					"com.linkedin.common.VectorImage",
				]),
				imageAt(education, ["schoolLogo", "vectorImage"]),
			],
			"empty",
		),
		school: optionalText(education, ["schoolName"], ["school", "name"]),
		start_date: dateOf(education, "start"),
	};
}

export function buildEducationRows(
	items: readonly unknown[],
): StreamRows<EducationRecord> {
	const rows = emptyStreamRows<EducationRecord>();
	items.forEach((education, index) => {
		if (!isRecord(education)) {
			addOmittedRow(rows, "malformed_row");
			return;
		}
		addRow(rows, assembleRow(EDUCATION_ROW, educationReads(education, index)));
	});
	return rows;
}

// ─── skills ──────────────────────────────────────────────────────────────

const SKILL_ROW = rowSpec(skillsSchema, ["id", "name"]);

function skillReads(skill: unknown): FieldReads {
	return {
		endorsement_count: firstOf(
			[
				andThen(at(skill, ["endorsementCount"]), count),
				andThen(at(skill, ["endorsements"]), count),
			],
			"empty",
		),
		id: textAt(skill, ["entityUrn"]),
		name: textAt(skill, ["name"]),
	};
}

/**
 * `profileSkills.elements` is either a flat list of skills or a list of
 * categories holding skills under `skills` (or `elements`), depending on
 * decoration version. Both shapes flatten to one row per skill. An empty
 * category contributes no rows.
 */
export function buildSkillRows(
	entries: readonly unknown[],
): StreamRows<SkillRecord> {
	const rows = emptyStreamRows<SkillRecord>();
	for (const entry of entries) {
		if (!isRecord(entry)) {
			addOmittedRow(rows, "malformed_row");
			continue;
		}
		const childKey = Object.hasOwn(entry, "skills")
			? "skills"
			: Object.hasOwn(entry, "elements")
				? "elements"
				: null;
		if (childKey === null) {
			addRow(rows, assembleRow(SKILL_ROW, skillReads(entry)));
			continue;
		}
		const children = at(entry, [childKey]);
		if (children.kind !== "read" || !Array.isArray(children.value)) {
			addOmittedRow(rows, "unreadable_nested_collection");
			continue;
		}
		for (const skill of children.value) {
			if (!isRecord(skill)) {
				addOmittedRow(rows, "malformed_row");
				continue;
			}
			addRow(rows, assembleRow(SKILL_ROW, skillReads(skill)));
		}
	}
	return rows;
}

// ─── languages ───────────────────────────────────────────────────────────

const LANGUAGE_ROW = rowSpec(languagesSchema, ["id", "name"]);

export function buildLanguageRows(
	items: readonly unknown[],
): StreamRows<LanguageRecord> {
	const rows = emptyStreamRows<LanguageRecord>();
	for (const language of items) {
		if (!isRecord(language)) {
			addOmittedRow(rows, "malformed_row");
			continue;
		}
		addRow(
			rows,
			assembleRow(LANGUAGE_ROW, {
				id: textAt(language, ["entityUrn"]),
				name: textAt(language, ["name"]),
				proficiency: optionalText(language, ["proficiency"]),
			}),
		);
	}
	return rows;
}

// ─── connections ─────────────────────────────────────────────────────────

const CONNECTION_ROW = rowSpec(connectionsSchema, ["id"]);

/** The fields a resolved member profile supplies to a connection row. */
export function connectionEnrichmentReads(profile: unknown): FieldReads {
	return {
		full_name: joinName(
			optionalText(profile, ["firstName"]),
			optionalText(profile, ["lastName"]),
		),
		headline: optionalText(profile, ["headline"], ["occupation"]),
		profile_url: profileUrlRead(optionalText(profile, ["publicIdentifier"])),
	};
}

/** True when every enrichment field of a resolved profile is readable. */
export function connectionEnrichmentIsReadable(profile: unknown): boolean {
	return Object.values(connectionEnrichmentReads(profile)).every(
		(outcome) => outcome.kind !== "unavailable",
	);
}

/**
 * One connection row. `resolved` is the member's profile from the batch
 * resolution, or undefined when it could not be resolved: its enrichment
 * fields are then unavailable, so the row is withheld (see `addRow`).
 */
export function connectionReads(
	element: unknown,
	resolved: unknown,
): FieldReads {
	const enrichment =
		resolved === undefined
			? {
					full_name: unavailable("enrichment_unresolved"),
					headline: unavailable("enrichment_unresolved"),
					profile_url: unavailable("enrichment_unresolved"),
				}
			: connectionEnrichmentReads(resolved);
	return {
		connected_at: firstOf(
			[andThen(at(element, ["createdAt"]), epochMillis)],
			"empty",
		),
		id: textAt(element, ["connectedMember"]),
		...enrichment,
	};
}

export function buildConnectionRows(
	elements: readonly unknown[],
	resolvedProfileOf: (memberUrn: string) => unknown,
): StreamRows<ConnectionRecord> {
	const rows = emptyStreamRows<ConnectionRecord>();
	for (const element of elements) {
		const member = textAt(element, ["connectedMember"]);
		addRow(
			rows,
			assembleRow(
				CONNECTION_ROW,
				connectionReads(
					element,
					member.kind === "read" ? resolvedProfileOf(member.value) : undefined,
				),
			),
		);
	}
	return rows;
}
