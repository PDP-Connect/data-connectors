// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pure parsers for the LinkedIn connector. No Playwright / Node I/O — the
// Voyager fetch loop and browser lifecycle live in index.ts. Kept separate
// so the field-mapping logic (the part most likely to drift when LinkedIn
// reshapes Voyager) is unit-testable without a browser.
//
// Ground truth: connectors/linkedin/linkedin-playwright.js (legacy). The
// dual timePeriod/dateRange handling below is carried over from
// `extractTimePeriod`/`extractYears` in that file — LinkedIn has shipped
// both the legacy REST shape (`timePeriod.startDate/endDate`) and the dash
// shape (`dateRange.start/end`) across different decoration IDs, sometimes
// for the same account.
//
// Every source field is read with `readField` (field-reader.ts), so a value
// Voyager sent in a shape this connector cannot read makes the row
// uncovered instead of turning into `null`. Voyager drops unset fields from
// its JSON rather than sending `null`, so an absent OPTIONAL field reads as
// empty (`absent: "empty"`); an absent collection, identity, or required
// field stays unavailable.

import {
	buildRow,
	type FieldRead,
	type FieldValidator,
	fieldValue,
	firstReadable,
	mapField,
	type ReadFieldOptions,
	type RowRead,
	readField,
	unavailableField,
	v,
} from "../../packages/polyfill-connectors/src/field-reader.ts";

const OPTIONAL: ReadFieldOptions<never> = { absent: "empty" };
const text = v.string();
const nonEmptyText = v.string({ nonEmpty: true });

// ─── Validators for Voyager shapes ──────────────────────────────────────

function isObject(raw: unknown): raw is Record<string, unknown> {
	return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}

/**
 * D4: a partial date is a string at source precision (`YYYY` or `YYYY-MM`).
 * Voyager date points carry a year and sometimes a month, never a day. A
 * point without a readable year, or with a month outside 1–12, is malformed.
 */
export const voyagerDatePoint: FieldValidator<string> = v.custom(
	"Voyager date point",
	(raw) => {
		if (!isObject(raw)) return { kind: "malformed", problem: "not an object" };
		const year = readField(
			raw,
			"year",
			v.number({ integer: true, min: 1, max: 9999 }),
		);
		if (year.kind !== "read")
			return { kind: "malformed", problem: "no readable year" };
		const month = readField(
			raw,
			"month",
			v.number({ integer: true, min: 1, max: 12 }),
			OPTIONAL,
		);
		if (month.kind === "unavailable")
			return { kind: "malformed", problem: `month: ${month.reason}` };
		const yyyy = String(year.value).padStart(4, "0");
		return {
			kind: "value",
			value:
				month.kind === "read"
					? `${yyyy}-${String(month.value).padStart(2, "0")}`
					: yyyy,
		};
	},
);

/**
 * A Voyager VectorImage: `rootUrl` + the largest artifact's path segment.
 * An empty artifact list is an image with no renditions (empty). Anything
 * else that does not compose into an http(s) URL is malformed.
 */
export const voyagerVectorImageUrl: FieldValidator<string> = v.custom(
	"Voyager VectorImage",
	(raw) => {
		if (!isObject(raw)) return { kind: "malformed", problem: "not an object" };
		const artifacts = readField(raw, "artifacts", v.arrayOf(v.object()));
		if (artifacts.kind !== "read")
			return {
				kind: "malformed",
				problem:
					artifacts.kind === "unavailable"
						? artifacts.reason
						: "artifacts is null",
			};
		const largest = artifacts.value.at(-1);
		if (largest === undefined) return { kind: "empty" };
		const segment = readField(
			largest,
			"fileIdentifyingUrlPathSegment",
			nonEmptyText,
		);
		if (segment.kind !== "read")
			return { kind: "malformed", problem: "artifact has no path segment" };
		const root = readField(raw, "rootUrl", text, OPTIONAL);
		if (root.kind === "unavailable")
			return { kind: "malformed", problem: `rootUrl: ${root.reason}` };
		const composed = `${root.kind === "read" ? root.value : ""}${segment.value}`;
		const url = v.url().check(composed);
		return url.kind === "value"
			? url
			: { kind: "malformed", problem: `composed image URL: ${composed}` };
	},
);

/** A Voyager collection: `{ elements: [...] }`. Elements are read per row. */
export function readCollection(
	source: unknown,
	key: string,
): FieldRead<unknown[]> {
	return readField(
		source,
		[key, "elements"],
		v.custom<unknown[]>("array", (raw) =>
			Array.isArray(raw)
				? { kind: "value", value: raw }
				: { kind: "malformed", problem: "elements is not an array" },
		),
	);
}

// ─── Shared field reads ─────────────────────────────────────────────────

const START_PATHS = [
	["dateRange", "start"],
	["dateRange", "startDate"],
	["timePeriod", "start"],
	["timePeriod", "startDate"],
	["startDate"],
] as const;
const END_PATHS = [
	["dateRange", "end"],
	["dateRange", "endDate"],
	["timePeriod", "end"],
	["timePeriod", "endDate"],
	["endDate"],
] as const;

export function startDateOf(node: unknown): FieldRead<string> {
	return readField(node, START_PATHS, voyagerDatePoint, OPTIONAL);
}

/** An empty end date means "current" (Present) at the LinkedIn semantic
 *  layer. D4 forbids inventing a day/time; `end_date: null` on a record
 *  where `start_date` is set is the honest representation of an ongoing role. */
export function endDateOf(node: unknown): FieldRead<string> {
	return readField(node, END_PATHS, voyagerDatePoint, OPTIONAL);
}

/** Voyager entity URNs are the only stable per-entity id Voyager exposes for
 *  nested profile sub-entities. A positional id is used only when Voyager
 *  omits the URN (observed on some decoration versions for position-group
 *  children); a URN of the wrong type is unreadable, not omitted. */
export function subEntityId(
	node: unknown,
	fallbackPrefix: string,
	index: number,
): FieldRead<string> {
	const urn = readField(node, "entityUrn", nonEmptyText, OPTIONAL);
	return urn.kind === "explicit_empty"
		? fieldValue(`${fallbackPrefix}-${String(index)}`)
		: urn;
}

/** Join name parts that were read. Empty parts add no stray space. */
function joinedName(
	first: FieldRead<string>,
	last: FieldRead<string>,
): FieldRead<string> {
	if (first.kind === "unavailable" || last.kind === "unavailable")
		return firstReadable(first, last);
	const parts = [first, last].flatMap((part) =>
		part.kind === "read" && part.value.length > 0 ? [part.value] : [],
	);
	return parts.length === 0
		? { kind: "explicit_empty" }
		: fieldValue(parts.join(" "));
}

/** Public profile permalink from the public identifier — the only stable
 *  cross-run id a connector-authored profile URL can be built from. */
export function profileUrlFor(publicIdentifier: string): string {
	return `https://www.linkedin.com/in/${publicIdentifier}/`;
}

// ─── Profile ────────────────────────────────────────────────────────────

/**
 * Location, in the order the sources are trusted: `basicLocation`'s country
 * with `preferredGeoPlace`, then `geoLocation.geo.defaultLocalizedName`
 * (the source every live account observed so far resolves through), then a
 * bare `preferredGeoPlace`. Each source is read; a malformed one with no
 * readable alternative leaves the field unavailable.
 */
export function locationOf(profile: unknown): FieldRead<string> {
	const country = readField(
		profile,
		["location", "basicLocation", "countryCode"],
		nonEmptyText,
		OPTIONAL,
	);
	const place = readField(
		profile,
		["location", "preferredGeoPlace"],
		nonEmptyText,
		OPTIONAL,
	);
	const withCountry = mapField(country, (code) =>
		place.kind === "read"
			? fieldValue(`${place.value}, ${code}`)
			: place.kind === "unavailable"
				? place
				: fieldValue(code),
	);
	const geo = readField(
		profile,
		["geoLocation", "geo", "defaultLocalizedName"],
		text,
		OPTIONAL,
	);
	return firstReadable(withCountry, geo, place);
}

/** Profile picture: the dash profile's own image, else `/me`'s mini profile
 *  picture (under the typed `com.linkedin.common.VectorImage` key or bare). */
export function profilePictureUrlOf(
	profile: unknown,
	miniProfile: unknown,
): FieldRead<string> {
	return firstReadable(
		readField(
			profile,
			["profilePicture", "displayImageReference", "vectorImage"],
			voyagerVectorImageUrl,
			OPTIONAL,
		),
		readField(
			miniProfile,
			[["picture", "com.linkedin.common.VectorImage"], ["picture"]],
			voyagerVectorImageUrl,
			OPTIONAL,
		),
	);
}

/**
 * The current role: the first position group with no end date, and in it
 * the first position with no end date (else its first position). If any
 * group's end date is unreadable, which group is current is unknown.
 */
function currentRoleOf(profile: unknown): {
	company: FieldRead<string>;
	title: FieldRead<string>;
} {
	const groups = readCollection(profile, "profilePositionGroups");
	if (groups.kind !== "read") {
		const unknown =
			groups.kind === "unavailable"
				? groups
				: ({ kind: "explicit_empty" } as const);
		return { company: unknown, title: unknown };
	}
	for (const group of groups.value) {
		const end = endDateOf(group);
		if (end.kind === "unavailable") return { company: end, title: end };
		if (end.kind === "read") continue;
		const positions = readCollection(group, "profilePositionInPositionGroup");
		let position: unknown;
		if (positions.kind === "read") {
			for (const candidate of positions.value) {
				const positionEnd = endDateOf(candidate);
				if (positionEnd.kind === "unavailable")
					return { company: positionEnd, title: positionEnd };
				if (positionEnd.kind === "explicit_empty") {
					position = candidate;
					break;
				}
			}
			position ??= positions.value[0];
		} else if (positions.kind === "unavailable")
			return { company: positions, title: positions };
		return {
			company: firstReadable(
				readField(group, [["company", "name"], ["name"]], text, OPTIONAL),
			),
			title: firstReadable(
				position === undefined
					? { kind: "explicit_empty" }
					: readField(position, "title", text, OPTIONAL),
				readField(group, "title", text, OPTIONAL),
			),
		};
	}
	return {
		company: { kind: "explicit_empty" },
		title: { kind: "explicit_empty" },
	};
}

/**
 * Build the profile row. `publicIdentifier` is the id — the only stable
 * cross-run identifier Voyager exposes for the owner's own profile.
 *
 * `connectionCount` is supplied by the caller: Voyager reports it only via
 * the separate connections listing, which index.ts walks.
 */
export function buildProfileRow(
	publicIdentifier: string,
	profile: unknown,
	me: unknown,
	connectionCount: FieldRead<number>,
) {
	const miniProfile = readField(me, "miniProfile", v.object(), OPTIONAL);
	const mini = miniProfile.kind === "read" ? miniProfile.value : undefined;
	const role = currentRoleOf(profile);
	return buildRow({
		connection_count: connectionCount,
		current_company: role.company,
		current_position_title: role.title,
		full_name: joinedName(
			readField(profile, "firstName", text, OPTIONAL),
			readField(profile, "lastName", text, OPTIONAL),
		),
		headline: firstReadable(
			readField(profile, "headline", text, OPTIONAL),
			readField(mini, "occupation", text, OPTIONAL),
		),
		id: fieldValue(publicIdentifier),
		industry: readField(profile, ["industry", "name"], text, OPTIONAL),
		location: locationOf(profile),
		profile_picture_url: firstReadable(
			miniProfile.kind === "unavailable"
				? miniProfile
				: { kind: "explicit_empty" },
			profilePictureUrlOf(profile, mini),
		),
		public_url: fieldValue(profileUrlFor(publicIdentifier)),
		summary: readField(profile, "summary", text, OPTIONAL),
	});
}

// ─── Experience ─────────────────────────────────────────────────────────

function experienceRow(
	node: unknown,
	id: FieldRead<string>,
	groupCompany: FieldRead<string>,
	isPosition: boolean,
) {
	return buildRow(
		{
			company: isPosition
				? firstReadable(
						readField(node, "companyName", text, OPTIONAL),
						groupCompany,
					)
				: groupCompany,
			description: readField(node, "description", text, OPTIONAL),
			employment_type: isPosition
				? readField(node, ["employmentType", "name"], text, OPTIONAL)
				: { kind: "explicit_empty" },
			end_date: endDateOf(node),
			id,
			location: readField(
				node,
				[["locationName"], ["geoLocationName"]],
				text,
				OPTIONAL,
			),
			start_date: startDateOf(node),
			title: readField(node, "title", text, OPTIONAL),
		},
		{ requireAnyOf: ["title", "company"] },
	);
}

/**
 * D3: `profilePositionGroups` nests sub-positions under a company grouping.
 * A group with sub-positions expands to one row per position (a person can
 * hold multiple titles at one company); a group with none expands to one
 * row for the group itself.
 */
export function buildExperienceRows(groups: readonly unknown[]) {
	const rows: RowRead[] = [];
	for (const [groupIndex, group] of groups.entries()) {
		const groupCompany = readField(
			group,
			[["company", "name"], ["name"]],
			text,
			OPTIONAL,
		);
		const positions = readField(
			group,
			["profilePositionInPositionGroup", "elements"],
			v.custom<unknown[]>("array", (raw) =>
				Array.isArray(raw)
					? { kind: "value", value: raw }
					: { kind: "malformed", problem: "elements is not an array" },
			),
			OPTIONAL,
		);
		if (positions.kind === "unavailable") {
			// The group's positions cannot be read, so its rows cannot be known.
			rows.push(
				buildRow(
					{ id: subEntityId(group, "exp-group", groupIndex) },
					{ dependsOn: { positions } },
				),
			);
			continue;
		}
		if (positions.kind === "read" && positions.value.length > 0) {
			for (const [posIndex, position] of positions.value.entries())
				rows.push(
					experienceRow(
						position,
						subEntityId(position, `exp-${String(groupIndex)}`, posIndex),
						groupCompany,
						true,
					),
				);
			continue;
		}
		rows.push(
			experienceRow(
				group,
				subEntityId(group, "exp-group", groupIndex),
				groupCompany,
				false,
			),
		);
	}
	return rows;
}

// ─── Education ──────────────────────────────────────────────────────────

/** School logo: `school.logo.vectorImage`, the typed
 *  `school.logo["com.linkedin.common.VectorImage"]` key, or the older
 *  `schoolLogo.vectorImage` shape. */
const LOGO_PATHS = [
	["school", "logo", "vectorImage"],
	["school", "logo", "com.linkedin.common.VectorImage"],
	["schoolLogo", "vectorImage"],
] as const;

export function buildEducationRows(items: readonly unknown[]) {
	return items.map((edu, index) =>
		buildRow(
			{
				degree: readField(edu, "degreeName", text, OPTIONAL),
				end_date: endDateOf(edu),
				field_of_study: readField(edu, "fieldOfStudy", text, OPTIONAL),
				grade: readField(edu, "grade", text, OPTIONAL),
				id: subEntityId(edu, "edu", index),
				logo_url: readField(edu, LOGO_PATHS, voyagerVectorImageUrl, OPTIONAL),
				school: readField(
					edu,
					[["schoolName"], ["school", "name"]],
					text,
					OPTIONAL,
				),
				start_date: startDateOf(edu),
			},
			{ requireAnyOf: ["school"] },
		),
	);
}

// ─── Skills ─────────────────────────────────────────────────────────────

const ENDORSEMENTS = v.number({ integer: true, min: 0 });

function skillRow(node: unknown, index: number) {
	return buildRow({
		endorsement_count: readField(
			node,
			[["endorsementCount"], ["endorsements"]],
			ENDORSEMENTS,
			OPTIONAL,
		),
		id: subEntityId(node, "skill", index),
		name: readField(node, "name", nonEmptyText),
	});
}

/**
 * `profileSkills.elements` is either a flat list of skills or a list of
 * categories each holding skills, depending on decoration version. Both
 * shapes flatten to one row per skill. A skill with no readable name is an
 * uncovered row, not a silently dropped one.
 */
export function buildSkillRows(entries: readonly unknown[]) {
	const rows: RowRead[] = [];
	let index = 0;
	for (const entry of entries) {
		const nested = readField(
			entry,
			[["skills"], ["elements"]],
			v.custom<unknown[]>("array", (raw) =>
				Array.isArray(raw)
					? { kind: "value", value: raw }
					: { kind: "malformed", problem: "not an array" },
			),
			OPTIONAL,
		);
		if (nested.kind === "read" && nested.value.length > 0) {
			for (const skill of nested.value) {
				rows.push(skillRow(skill, index));
				index += 1;
			}
			continue;
		}
		if (nested.kind === "unavailable") {
			rows.push(
				buildRow(
					{ id: subEntityId(entry, "skill", index) },
					{ dependsOn: { skills: nested } },
				),
			);
			index += 1;
			continue;
		}
		rows.push(skillRow(entry, index));
		index += 1;
	}
	return rows;
}

// ─── Languages ──────────────────────────────────────────────────────────

export function buildLanguageRows(items: readonly unknown[]) {
	return items.map((lang, index) =>
		buildRow({
			id: subEntityId(lang, "lang", index),
			name: readField(lang, "name", nonEmptyText),
			proficiency: readField(lang, "proficiency", text, OPTIONAL),
		}),
	);
}

// ─── Connections ────────────────────────────────────────────────────────

/** LinkedIn's connection `createdAt` is epoch milliseconds; `0` or absent
 *  means "not reported", never the epoch. D4: timestamps are ISO-8601. */
const CONNECTED_AT = v.epochMillis({ emptyAt: [0], min: 1 });

/**
 * One connection row, keyed by the connected member's URN. Name, headline
 * and profile URL come from the batch profile resolution; a member whose
 * profile could not be resolved this run is an uncovered row, so a stored
 * copy with those fields is not overwritten by nulls.
 */
export function buildConnectionRow(element: unknown, resolved: unknown) {
	const resolvedProfile: FieldRead<Record<string, unknown>> = isObject(resolved)
		? fieldValue(resolved)
		: unavailableField(
				resolved === undefined
					? "member profile not resolved this run"
					: "resolved member profile is not an object",
			);
	const profile =
		resolvedProfile.kind === "read" ? resolvedProfile.value : undefined;
	const publicId = readField(
		profile,
		"publicIdentifier",
		nonEmptyText,
		OPTIONAL,
	);
	return buildRow(
		{
			connected_at: readField(element, "createdAt", CONNECTED_AT, OPTIONAL),
			full_name: joinedName(
				readField(profile, "firstName", text, OPTIONAL),
				readField(profile, "lastName", text, OPTIONAL),
			),
			headline: firstReadable(
				readField(profile, "headline", text, OPTIONAL),
				readField(profile, "occupation", text, OPTIONAL),
			),
			id: readField(element, "connectedMember", nonEmptyText),
			profile_url: mapField(publicId, (id) => fieldValue(profileUrlFor(id))),
		},
		{
			dependsOn: { profile: resolvedProfile },
			requireAnyOf: ["full_name", "profile_url"],
		},
	);
}
