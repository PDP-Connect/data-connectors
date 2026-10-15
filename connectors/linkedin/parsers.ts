// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pure parsers for the LinkedIn connector. No Playwright / Node I/O — the
// Voyager fetch loop and browser lifecycle live in index.ts. Kept separate
// so the field-mapping logic (the part most likely to drift when LinkedIn
// reshapes Voyager) is unit-testable without a browser.
//
// Ground truth: connectors/linkedin/linkedin-playwright.js (legacy). The
// dual timePeriod/dateRange handling below is carried over verbatim from
// `extractTimePeriod`/`extractYears` in that file — LinkedIn has shipped
// both the legacy REST shape (`timePeriod.startDate/endDate`) and the dash
// shape (`dateRange.start/end`) across different decoration IDs, sometimes
// for the same account.

import type {
	VoyagerConnectionElement,
	VoyagerDateBearing,
	VoyagerDatePoint,
	VoyagerEducation,
	VoyagerLanguage,
	VoyagerMiniProfile,
	VoyagerPosition,
	VoyagerPositionGroup,
	VoyagerProfileElement,
	VoyagerResolvedProfile,
	VoyagerSkill,
	VoyagerSkillCategory,
	VoyagerVectorImage,
} from "./types.ts";

const ENDORSEMENT_COUNT_RE = /^\d+$/u;

// ─── D4 partial dates ────────────────────────────────────────────────────

/**
 * D4: a partial date is a string at source precision (`YYYY`, `YYYY-MM`, or
 * `YYYY-MM-DD`). LinkedIn's Voyager date points never carry a day, only
 * month + year (or year alone) — so this never produces `YYYY-MM-DD`, but
 * the function is shaped to the general D4 rule rather than hardcoding
 * month-precision.
 */
export function partialDateFromPoint(
	point: VoyagerDatePoint | undefined,
): string | null {
	if (
		!point ||
		typeof point.year !== "number" ||
		!Number.isFinite(point.year)
	) {
		return null;
	}
	const year = String(point.year).padStart(4, "0");
	if (
		typeof point.month === "number" &&
		point.month >= 1 &&
		point.month <= 12
	) {
		return `${year}-${String(point.month).padStart(2, "0")}`;
	}
	return year;
}

/** Resolve a node's date-range regardless of which of the two Voyager shapes
 *  (dash `dateRange` vs legacy `timePeriod`) is present, falling back to date
 *  fields inline on the node itself (oldest legacy shape). Mirrors legacy
 *  `extractTimePeriod`'s `obj.dateRange || obj` fallback chain. */
function resolveDateRange(node: VoyagerDateBearing | undefined): {
	end: VoyagerDatePoint | undefined;
	start: VoyagerDatePoint | undefined;
} {
	if (!node) {
		return { end: undefined, start: undefined };
	}
	const range = node.dateRange ?? node.timePeriod ?? node;
	return {
		end: range.end ?? range.endDate ?? node.endDate,
		start: range.start ?? range.startDate ?? node.startDate,
	};
}

export function startDateOf(
	node: VoyagerDateBearing | undefined,
): string | null {
	return partialDateFromPoint(resolveDateRange(node).start);
}

/** `null` end date means "current" (Present) at the LinkedIn semantic layer.
 *  D4 forbids inventing a day/time, and there is no separate "is current"
 *  boolean in the manifest contract — `end_date: null` on a stream where
 *  `start_date` is set is the honest representation of an ongoing role. */
export function endDateOf(node: VoyagerDateBearing | undefined): string | null {
	return partialDateFromPoint(resolveDateRange(node).end);
}

// ─── Image URLs ─────────────────────────────────────────────────────────

export function vectorImageUrl(
	image: VoyagerVectorImage | undefined,
): string | null {
	const artifacts = Array.isArray(image?.artifacts) ? image.artifacts : [];
	if (artifacts.length === 0) {
		return null;
	}
	const largest = artifacts.at(-1);
	const segment = largest?.fileIdentifyingUrlPathSegment;
	if (typeof segment !== "string" || segment.length === 0) {
		return null;
	}
	const rootUrl = typeof image?.rootUrl === "string" ? image.rootUrl : "";
	return `${rootUrl}${segment}`;
}

// ─── Ids ────────────────────────────────────────────────────────────────

/** Voyager entity URNs are the only stable per-entity id Voyager exposes for
 *  nested profile sub-entities; a positional/derived id would not survive
 *  reordering. Falls back to a positional id only when Voyager omits the
 *  URN (observed on some decoration versions for position-group children). */
export function subEntityId(
	entityUrn: string | undefined,
	fallbackPrefix: string,
	index: number,
): string {
	return entityUrn && entityUrn.length > 0
		? entityUrn
		: `${fallbackPrefix}-${index}`;
}

// ─── Record shapes ──────────────────────────────────────────────────────

export interface ProfileRecord {
	connection_count: number | null;
	current_company: string | null;
	current_position_title: string | null;
	full_name: string | null;
	headline: string | null;
	id: string;
	industry: string | null;
	location: string | null;
	profile_picture_url: string | null;
	public_url: string | null;
	summary: string | null;
	[field: string]: unknown;
}

export interface ExperienceRecord {
	company: string | null;
	description: string | null;
	employment_type: string | null;
	end_date: string | null;
	id: string;
	location: string | null;
	start_date: string | null;
	title: string | null;
	[field: string]: unknown;
}

export interface EducationRecord {
	degree: string | null;
	end_date: string | null;
	field_of_study: string | null;
	grade: string | null;
	id: string;
	logo_url: string | null;
	school: string | null;
	start_date: string | null;
	[field: string]: unknown;
}

export interface SkillRecord {
	endorsement_count: number | null;
	id: string;
	name: string;
	[field: string]: unknown;
}

export interface LanguageRecord {
	id: string;
	name: string;
	proficiency: string | null;
	[field: string]: unknown;
}

export interface ConnectionRecord {
	connected_at: string | null;
	full_name: string | null;
	headline: string | null;
	id: string;
	profile_url: string | null;
	[field: string]: unknown;
}

export interface OmissionSummary {
	count: number;
	omittedCount: number;
	omittedReasons: Record<string, number>;
	reasons: Record<string, number>;
}

export interface RecordsWithOmissions<T> {
	considered: number;
	covered: number;
	omissions: OmissionSummary;
	records: T[];
}

function addOmission(
	summary: OmissionSummary,
	reason: string,
	omitted = true,
): void {
	summary.count += 1;
	summary.reasons[reason] = (summary.reasons[reason] ?? 0) + 1;
	if (omitted) {
		summary.omittedCount += 1;
		summary.omittedReasons[reason] = (summary.omittedReasons[reason] ?? 0) + 1;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalStringFieldsAreReadable(
	row: Record<string, unknown>,
	fields: readonly string[],
): boolean {
	return fields.every(
		(field) =>
			!Object.hasOwn(row, field) ||
			row[field] === null ||
			typeof row[field] === "string",
	);
}

function datePointIsReadable(value: unknown): boolean {
	if (value === null) return true;
	if (!isRecord(value)) return false;
	return ["month", "year"].every(
		(field) =>
			!Object.hasOwn(value, field) ||
			(typeof value[field] === "number" && Number.isFinite(value[field])),
	);
}

function dateRangeIsReadable(value: unknown): boolean {
	if (value === null) return true;
	if (!isRecord(value)) return false;
	return ["start", "end", "startDate", "endDate"].every(
		(field) => !Object.hasOwn(value, field) || datePointIsReadable(value[field]),
	);
}

function dateFieldsAreReadable(row: Record<string, unknown>): boolean {
	return (
		["dateRange", "timePeriod"].every(
			(field) => !Object.hasOwn(row, field) || dateRangeIsReadable(row[field]),
		) &&
		["startDate", "endDate"].every(
			(field) => !Object.hasOwn(row, field) || datePointIsReadable(row[field]),
		)
	);
}

function optionalNameObjectIsReadable(value: unknown): boolean {
	return (
		value === null ||
		(isRecord(value) &&
			Object.hasOwn(value, "name") &&
			optionalStringFieldsAreReadable(value, ["name"]))
	);
}

const POSITION_GROUP_FIELDS = [
	"company",
	"dateRange",
	"description",
	"endDate",
	"entityUrn",
	"geoLocationName",
	"locationName",
	"name",
	"profilePositionInPositionGroup",
	"startDate",
	"title",
] as const;

const POSITION_GROUP_STRING_FIELDS = [
	"description",
	"entityUrn",
	"geoLocationName",
	"locationName",
	"name",
	"title",
] as const;

const POSITION_FIELDS = [
	"companyName",
	"dateRange",
	"description",
	"employmentType",
	"endDate",
	"entityUrn",
	"geoLocationName",
	"locationName",
	"startDate",
	"title",
] as const;

const POSITION_STRING_FIELDS = [
	"companyName",
	"description",
	"entityUrn",
	"geoLocationName",
	"locationName",
	"title",
] as const;

function isReadablePosition(value: unknown): value is VoyagerPosition {
	return (
		isRecord(value) &&
		hasKnownSourceField(value, POSITION_FIELDS) &&
		optionalStringFieldsAreReadable(value, POSITION_STRING_FIELDS) &&
		dateFieldsAreReadable(value) &&
		(!Object.hasOwn(value, "employmentType") ||
			optionalNameObjectIsReadable(value.employmentType))
	);
}

function isReadablePositionGroupBase(value: unknown): value is VoyagerPositionGroup {
	if (!isRecord(value)) return false;
	const hasGroupValue = POSITION_GROUP_STRING_FIELDS.some((field) =>
		Object.hasOwn(value, field),
	);
	const hasCompanyValue =
		Object.hasOwn(value, "company") &&
		(value.company === null ||
			(isRecord(value.company) && Object.hasOwn(value.company, "name")));
	const hasDateValue = ["dateRange", "timePeriod", "startDate", "endDate"].some(
		(field) => Object.hasOwn(value, field),
	);
	const nested = value.profilePositionInPositionGroup;
	const hasPositionValue =
		isRecord(nested) && Array.isArray(nested.elements) && nested.elements.length > 0;
	return (
		(hasGroupValue || hasCompanyValue || hasDateValue || hasPositionValue) &&
		hasKnownSourceField(value, POSITION_GROUP_FIELDS) &&
		optionalStringFieldsAreReadable(value, POSITION_GROUP_STRING_FIELDS) &&
		dateFieldsAreReadable(value) &&
		(!Object.hasOwn(value, "company") ||
			optionalNameObjectIsReadable(value.company))
	);
}

/** True only when every field used to derive a position-group record can be
 *  read without coercion. Shared by profile coverage and experience parsing. */
export function isReadablePositionGroup(
	value: unknown,
): value is VoyagerPositionGroup {
	if (!isReadablePositionGroupBase(value)) return false;
	if (!Object.hasOwn(value, "profilePositionInPositionGroup")) return true;
	const nested = value.profilePositionInPositionGroup;
	return (
		isRecord(nested) &&
		Array.isArray(nested.elements) &&
		nested.elements.every(isReadablePosition)
	);
}

function locationBranchIsReadable(
	profile: Record<string, unknown>,
	key: "location" | "geoLocation",
): boolean {
	if (!Object.hasOwn(profile, key)) return true;
	const branch = profile[key];
	if (branch === null) return true;
	if (!isRecord(branch)) return false;
	if (key === "location") {
		if (!optionalStringFieldsAreReadable(branch, ["preferredGeoPlace"])) {
			return false;
		}
		if (!Object.hasOwn(branch, "basicLocation")) return true;
		const basicLocation = branch.basicLocation;
		return (
			basicLocation === null ||
			(isRecord(basicLocation) &&
				Object.hasOwn(basicLocation, "countryCode") &&
				optionalStringFieldsAreReadable(basicLocation, ["countryCode"]))
		);
	}
	if (!Object.hasOwn(branch, "geo")) return true;
	const geo = branch.geo;
	return (
		geo === null ||
		(isRecord(geo) &&
			Object.hasOwn(geo, "defaultLocalizedName") &&
			optionalStringFieldsAreReadable(geo, ["defaultLocalizedName"]))
	);
}

/** Matches the location branches consumed by locationNameOf(). */
export function isReadableProfileLocation(value: unknown): boolean {
	if (!isRecord(value)) return false;
	const hasSource = Object.hasOwn(value, "location") || Object.hasOwn(value, "geoLocation");
	const location = value.location;
	const geoLocation = value.geoLocation;
	const hasLocationValue =
		location === null ||
		(isRecord(location) &&
			(Object.hasOwn(location, "preferredGeoPlace") ||
				location.basicLocation === null ||
				(isRecord(location.basicLocation) &&
					Object.hasOwn(location.basicLocation, "countryCode"))));
	const hasGeoLocationValue =
		geoLocation === null ||
		(isRecord(geoLocation) &&
			(geoLocation.geo === null ||
				(isRecord(geoLocation.geo) &&
					Object.hasOwn(geoLocation.geo, "defaultLocalizedName"))));
	return (
		hasSource &&
		((Object.hasOwn(value, "location") && hasLocationValue) ||
			(Object.hasOwn(value, "geoLocation") && hasGeoLocationValue)) &&
		locationBranchIsReadable(value, "location") &&
		locationBranchIsReadable(value, "geoLocation")
	);
}

function nonEmpty(s: string | undefined | null): string | null {
	if (typeof s !== "string") {
		return null;
	}
	const trimmed = s.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function joinFullName(
	first: string | undefined,
	last: string | undefined,
): string | null {
	const hasFirst = typeof first === "string";
	const hasLast = typeof last === "string";
	if (!hasFirst && !hasLast) return null;
	return `${hasFirst ? first : ""} ${hasLast ? last : ""}`.trim();
}

/** Public profile permalink from the public identifier — the only stable
 *  cross-run id a connector-authored profile URL can be built from. */
export function profileUrlFor(publicIdentifier: string): string {
	return `https://www.linkedin.com/in/${publicIdentifier}/`;
}

/**
 * A live-account capture (2026-09-22) never populated
 * `location.basicLocation`/`preferredGeoPlace` — real accounts observed so
 * far always resolve via the `geoLocation.geo.defaultLocalizedName`
 * fallback below, which is the proven-correct source. The
 * `basicLocation`/`preferredGeoPlace` branch is kept as a tolerant
 * fallback (matches legacy inference) rather than removed, since it's
 * cheap to keep and a different account/decoration could still expose it.
 */
export function locationNameOf(profile: VoyagerProfileElement): string | null {
	const location = isRecord(profile.location) ? profile.location : null;
	const basicLocation = isRecord(location?.basicLocation)
		? location.basicLocation
		: null;
	const countryCode = basicLocation?.countryCode;
	const preferredGeoPlace = location?.preferredGeoPlace;
	if (typeof countryCode === "string" && countryCode.length > 0) {
		return nonEmpty(
			[typeof preferredGeoPlace === "string" ? preferredGeoPlace : null, countryCode]
				.filter(Boolean)
				.join(", "),
		);
	}
	const geoLocation = isRecord(profile.geoLocation) ? profile.geoLocation : null;
	const geo = isRecord(geoLocation?.geo) ? geoLocation.geo : null;
	return nonEmpty(
		typeof geo?.defaultLocalizedName === "string"
			? geo.defaultLocalizedName
			: null,
	);
}

/**
 * Profile picture URL, mirroring legacy `linkedin-playwright.js`'s
 * `profilePictureUrl` IIFE: prefer the dash profile's own
 * `profilePicture.displayImageReference.vectorImage`, fall back to `/me`'s
 * `miniProfile.picture` (which appears either under the typed
 * `com.linkedin.common.VectorImage` key or bare, depending on decoration
 * version — both handled by `vectorImageUrl` reading `artifacts`/`rootUrl`
 * directly off whichever object is passed in).
 */
export function profilePictureUrlOf(
	profile: VoyagerProfileElement,
	miniProfile: VoyagerMiniProfile | undefined,
): string | null {
	const dashUrl = vectorImageUrl(
		profile.profilePicture?.displayImageReference?.vectorImage,
	);
	if (dashUrl) {
		return dashUrl;
	}
	const miniPic = miniProfile?.picture;
	return vectorImageUrl(
		miniPic?.["com.linkedin.common.VectorImage"] ?? miniPic,
	);
}

/**
 * Build the profile record. `publicIdentifier` is the id — it is the only
 * stable cross-run identifier Voyager exposes for the owner's own profile
 * (an internal numeric/URN id is not surfaced consistently across the `/me`
 * and dash-profile decorations observed in legacy prior art).
 *
 * `connectionCount` is supplied by the caller (index.ts), not derived here:
 * Voyager reports it only via the separate `relationships/dash/connections`
 * `paging.total` field the legacy connector reads after its own connections
 * fetch completes (`profileResult.connections = totalAvailable || ...`), not
 * anywhere on the profile/`/me` payloads this function receives. `null`
 * when the caller didn't request/couldn't fetch connections this run —
 * never guessed from an unrelated field.
 */
export function buildProfileRecord(
	publicIdentifier: string,
	profile: VoyagerProfileElement,
	fallbackHeadline: string | undefined,
	miniProfile: VoyagerMiniProfile | undefined,
	connectionCount: number | null,
): ProfileRecord {
	const positionGroups = Array.isArray(profile.profilePositionGroups?.elements)
		? profile.profilePositionGroups.elements
		: [];
	const current = positionGroups.find(
		(group) => isReadablePositionGroup(group) && endDateOf(group) === null,
	);
	const rawPositions = current?.profilePositionInPositionGroup?.elements;
	const positions = Array.isArray(rawPositions)
		? rawPositions.filter(isReadablePosition)
		: [];
	const currentPosition =
		positions.find((pos) => endDateOf(pos) === null) ?? positions[0];

	return {
		connection_count: connectionCount,
		current_company:
			nonEmpty(current?.company?.name) ?? nonEmpty(current?.name),
		current_position_title:
			nonEmpty(currentPosition?.title) ?? nonEmpty(current?.title),
		full_name: joinFullName(
			nonEmpty(profile.firstName) ?? miniProfile?.firstName,
			nonEmpty(profile.lastName) ?? miniProfile?.lastName,
		),
		headline: nonEmpty(profile.headline) ?? nonEmpty(fallbackHeadline),
		id: publicIdentifier,
		industry: nonEmpty(profile.industry?.name),
		location: locationNameOf(profile),
		profile_picture_url: profilePictureUrlOf(profile, miniProfile),
		public_url: profileUrlFor(publicIdentifier),
		summary: nonEmpty(profile.summary),
	};
}

/**
 * D3: `profilePositionGroups` nests sub-positions under a company grouping.
 * A group with sub-positions expands to one experience record per position
 * (a person can hold multiple titles at one company); a group with none
 * expands to one record for the group itself (the common case).
 */
export function buildExperienceRecords(
	profile: VoyagerProfileElement,
): ExperienceRecord[] {
	return buildExperienceRecordsWithOmissions(profile).records;
}

function hasKnownSourceField(
	row: Record<string, unknown>,
	fields: readonly string[],
): boolean {
	return fields.some((field) => Object.hasOwn(row, field));
}

export function buildExperienceRecordsWithOmissions(
	profile: VoyagerProfileElement,
): RecordsWithOmissions<ExperienceRecord> {
	const groups = profile.profilePositionGroups?.elements ?? [];
	const records: ExperienceRecord[] = [];
	const omissions: OmissionSummary = {
		count: 0,
		omittedCount: 0,
		omittedReasons: {},
		reasons: {},
	};
	let considered = 0;
	let covered = 0;

	for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
		const rawGroup: unknown = groups[groupIndex];
		if (!isRecord(rawGroup)) {
			considered += 1;
			addOmission(omissions, "malformed_row");
			continue;
		}
		const hasNestedCollection = Object.hasOwn(
			rawGroup,
			"profilePositionInPositionGroup",
		);
		const rawNested = hasNestedCollection
			? rawGroup.profilePositionInPositionGroup
			: undefined;
		if (!isReadablePositionGroupBase(rawGroup)) {
			considered += 1;
			addOmission(
				omissions,
				hasNestedCollection &&
					(!isRecord(rawNested) || !Array.isArray(rawNested.elements))
					? "unreadable_nested_collection"
					: "malformed_row",
			);
			continue;
		}
		const group = rawGroup as VoyagerPositionGroup;

		let rawPositions: unknown[] = [];
		if (Object.hasOwn(rawGroup, "profilePositionInPositionGroup")) {
			const nested = rawGroup.profilePositionInPositionGroup;
			if (!isRecord(nested) || !Array.isArray(nested.elements)) {
				considered += 1;
				addOmission(omissions, "unreadable_nested_collection");
				continue;
			}
			rawPositions = nested.elements;
		}
		const groupCompanyName = nonEmpty(group.company?.name ?? group.name);

		if (rawPositions.length > 0) {
			considered += rawPositions.length;
			for (let positionIndex = 0; positionIndex < rawPositions.length; positionIndex += 1) {
				const rawPosition = rawPositions[positionIndex];
				if (!isReadablePosition(rawPosition)) {
					addOmission(omissions, "malformed_row");
					continue;
				}
				const pos = rawPosition;
				records.push({
					company: nonEmpty(pos.companyName) ?? groupCompanyName,
					description: nonEmpty(pos.description),
					employment_type: nonEmpty(pos.employmentType?.name),
					end_date: endDateOf(pos),
					id: subEntityId(pos.entityUrn, `exp-${groupIndex}`, positionIndex),
					location: nonEmpty(pos.locationName ?? pos.geoLocationName),
					start_date: startDateOf(pos),
					title: nonEmpty(pos.title),
				});
				covered += 1;
			}
			continue;
		}

		considered += 1;
		records.push({
			company: groupCompanyName,
			description: nonEmpty(group.description),
			employment_type: null,
			end_date: endDateOf(group),
			id: subEntityId(group.entityUrn, "exp-group", groupIndex),
			location: nonEmpty(group.locationName ?? group.geoLocationName),
			start_date: startDateOf(group),
			title: nonEmpty(group.title),
		});
		covered += 1;
	}

	return { considered, covered, omissions, records };
}

/** School logo URL, mirroring legacy `linkedin-playwright.js`'s `logoUrl`
 *  IIFE: try `school.logo.vectorImage`, then the typed
 *  `school.logo["com.linkedin.common.VectorImage"]` key, then the older
 *  `schoolLogo.vectorImage` shape. */
function educationLogoUrlOf(edu: VoyagerEducation): string | null {
	const image =
		edu.school?.logo?.vectorImage ??
		edu.school?.logo?.["com.linkedin.common.VectorImage"] ??
		edu.schoolLogo?.vectorImage;
	return vectorImageUrl(image);
}

const EDUCATION_FIELDS = [
	"dateRange",
	"degreeName",
	"endDate",
	"entityUrn",
	"fieldOfStudy",
	"grade",
	"school",
	"schoolLogo",
	"schoolName",
	"startDate",
] as const;

const EDUCATION_STRING_FIELDS = [
	"degreeName",
	"entityUrn",
	"fieldOfStudy",
	"grade",
	"schoolName",
] as const;

function isReadableEducation(value: unknown): value is VoyagerEducation {
	if (
		!isRecord(value) ||
		!hasKnownSourceField(value, EDUCATION_FIELDS) ||
		!optionalStringFieldsAreReadable(value, EDUCATION_STRING_FIELDS) ||
		!dateFieldsAreReadable(value)
	) {
		return false;
	}
	if (!Object.hasOwn(value, "school")) return true;
	const school = value.school;
	return (
		school === null ||
		(isRecord(school) &&
			optionalStringFieldsAreReadable(school, ["name"]))
	);
}

export function buildEducationRecords(
	profile: VoyagerProfileElement,
): EducationRecord[] {
	return buildEducationRecordsWithOmissions(profile).records;
}

export function buildEducationRecordsWithOmissions(
	profile: VoyagerProfileElement,
): RecordsWithOmissions<EducationRecord> {
	const items = profile.profileEducations?.elements ?? [];
	const records: EducationRecord[] = [];
	const omissions: OmissionSummary = {
		count: 0,
		omittedCount: 0,
		omittedReasons: {},
		reasons: {},
	};
	let considered = 0;
	let covered = 0;
	for (let index = 0; index < items.length; index += 1) {
		considered += 1;
		const rawEducation: unknown = items[index];
		if (!isReadableEducation(rawEducation)) {
			addOmission(omissions, "malformed_row");
			continue;
		}
		const edu = rawEducation;
		records.push({
			degree: nonEmpty(edu.degreeName),
			end_date: endDateOf(edu),
			field_of_study: nonEmpty(edu.fieldOfStudy),
			grade: nonEmpty(edu.grade),
			id: subEntityId(edu.entityUrn, "edu", index),
			logo_url: educationLogoUrlOf(edu),
			school: nonEmpty(edu.schoolName) ?? nonEmpty(edu.school?.name),
			start_date: startDateOf(edu),
		});
		covered += 1;
	}
	return { considered, covered, omissions, records };
}

/**
 * `profileSkills.elements` can be either a flat list of skills or a list of
 * categories each containing skills, depending on decoration version —
 * mirrors legacy `linkedin-playwright.js`'s dual handling. Both shapes are
 * flattened to one record per skill.
 */
export function buildSkillRecords(
	profile: VoyagerProfileElement,
): SkillRecord[] {
	return buildSkillRecordsWithOmissions(profile).records;
}

export function buildSkillRecordsWithOmissions(
	profile: VoyagerProfileElement,
): RecordsWithOmissions<SkillRecord> {
	const rawSkills = profile.profileSkills?.elements ?? [];
	const records: SkillRecord[] = [];
	const omissions: OmissionSummary = {
		count: 0,
		omittedCount: 0,
		omittedReasons: {},
		reasons: {},
	};
	let considered = 0;
	let covered = 0;

	for (const entry of rawSkills as readonly unknown[]) {
		if (!isRecord(entry)) {
			considered += 1;
			addOmission(omissions, "malformed_row");
			continue;
		}
		const category = entry as VoyagerSkillCategory;
		const hasSkills = Object.hasOwn(category, "skills");
		const hasElements = Object.hasOwn(category, "elements");
		if (hasSkills || hasElements) {
			const childRows = hasSkills ? category.skills : category.elements;
			if (!Array.isArray(childRows)) {
				considered += 1;
				addOmission(omissions, "unreadable_nested_collection");
				continue;
			}
			if (childRows.length === 0) continue;
			for (const rawSkill of childRows) {
				considered += 1;
				if (!isRecord(rawSkill)) {
					addOmission(omissions, "malformed_row");
					continue;
				}
				const sk = rawSkill as VoyagerSkill;
				if (typeof sk.name !== "string") {
					addOmission(omissions, "missing_name");
				} else if (sk.entityUrn) {
					if (sk.name.trim().length === 0) {
						addOmission(omissions, "blank_name_preserved", false);
					}
					if (
						(sk.endorsementCount ?? sk.endorsements) !== undefined &&
						endorsementCountOf(sk) === null
					) {
						addOmission(omissions, "invalid_endorsement_count", false);
					} else {
						covered += 1;
					}
					records.push({
						endorsement_count: endorsementCountOf(sk),
						id: sk.entityUrn,
						name: sk.name,
					});
				} else {
					addOmission(omissions, "missing_entity_urn");
				}
			}
			continue;
		}
		considered += 1;
		if (typeof category.name !== "string") {
			addOmission(omissions, "missing_name");
		} else if (category.entityUrn) {
			if (category.name.trim().length === 0) {
				addOmission(omissions, "blank_name_preserved", false);
			}
			if (
				(category.endorsementCount ?? category.endorsements) !== undefined &&
				endorsementCountOf(category) === null
			) {
				addOmission(omissions, "invalid_endorsement_count", false);
			} else {
				covered += 1;
			}
			records.push({
				endorsement_count: endorsementCountOf(category),
				id: category.entityUrn,
				name: category.name,
			});
		} else {
			addOmission(omissions, "missing_entity_urn");
		}
	}

	return { considered, covered, omissions, records };
}

function endorsementCountOf(
	sk: VoyagerSkill | VoyagerSkillCategory,
): number | null {
	const count = sk.endorsementCount ?? sk.endorsements;
	if (typeof count === "number") {
		return Number.isSafeInteger(count) && count >= 0 ? count : null;
	}
	if (typeof count === "string" && ENDORSEMENT_COUNT_RE.test(count.trim())) {
		const parsed = Number(count.trim());
		return Number.isSafeInteger(parsed) ? parsed : null;
	}
	return null;
}

export function buildLanguageRecords(
	profile: VoyagerProfileElement,
): LanguageRecord[] {
	return buildLanguageRecordsWithOmissions(profile).records;
}

export function buildLanguageRecordsWithOmissions(
	profile: VoyagerProfileElement,
): RecordsWithOmissions<LanguageRecord> {
	const items = profile.profileLanguages?.elements ?? [];
	const records: LanguageRecord[] = [];
	const omissions: OmissionSummary = {
		count: 0,
		omittedCount: 0,
		omittedReasons: {},
		reasons: {},
	};
	let covered = 0;
	for (const rawLanguage of items as readonly unknown[]) {
		if (!isRecord(rawLanguage)) {
			addOmission(omissions, "malformed_row");
			continue;
		}
		const lang = rawLanguage as VoyagerLanguage;
		if (typeof lang.name !== "string") {
			addOmission(omissions, "missing_name");
		} else if (lang.entityUrn) {
			const validProficiency =
				lang.proficiency === undefined || typeof lang.proficiency === "string";
			if (validProficiency) {
				covered += 1;
			} else {
				addOmission(omissions, "invalid_proficiency", false);
			}
			if (lang.name.trim().length === 0) {
				addOmission(omissions, "blank_name_preserved", false);
			}
			records.push({
				id: lang.entityUrn,
				name: lang.name,
				proficiency:
					typeof lang.proficiency === "string" ? lang.proficiency : null,
			});
		} else {
			addOmission(omissions, "missing_entity_urn");
		}
	}
	return { considered: items.length, covered, omissions, records };
}

/** LinkedIn's connection `createdAt` is epoch milliseconds; 0/absent means
 *  "not reported", never "epoch". D4: timestamps are ISO-8601. */
export function connectedAtOf(createdAt: number | undefined): string | null {
	if (
		typeof createdAt !== "number" ||
		!Number.isFinite(createdAt) ||
		createdAt <= 0
	) {
		return null;
	}
	return new Date(createdAt).toISOString();
}

export function buildConnectionRecord(
	element: VoyagerConnectionElement,
	resolved: VoyagerResolvedProfile | undefined,
): ConnectionRecord | null {
	const memberUrn = element.connectedMember;
	if (typeof memberUrn !== "string" || memberUrn.trim().length === 0) {
		return null;
	}
	const publicId = resolved?.publicIdentifier;
	return {
		connected_at: connectedAtOf(element.createdAt),
		full_name: joinFullName(resolved?.firstName, resolved?.lastName),
		headline:
			typeof resolved?.headline === "string"
				? resolved.headline
				: nonEmpty(resolved?.occupation),
		id: memberUrn,
		profile_url: publicId ? profileUrlFor(publicId) : null,
	};
}
