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
	VoyagerProfileElement,
	VoyagerResolvedProfile,
	VoyagerSkill,
	VoyagerSkillCategory,
	VoyagerVectorImage,
} from "./types.ts";

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
	const artifacts = image?.artifacts ?? [];
	if (artifacts.length === 0) {
		return null;
	}
	const largest = artifacts.at(-1);
	const segment = largest?.fileIdentifyingUrlPathSegment;
	if (!segment) {
		return null;
	}
	return `${image?.rootUrl ?? ""}${segment}`;
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
	return nonEmpty(`${first ?? ""} ${last ?? ""}`.trim());
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
	const countryCode = profile.location?.basicLocation?.countryCode;
	if (countryCode) {
		return nonEmpty(
			[profile.location?.preferredGeoPlace, countryCode]
				.filter(Boolean)
				.join(", "),
		);
	}
	return nonEmpty(profile.geoLocation?.geo?.defaultLocalizedName);
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
	const positionGroups = profile.profilePositionGroups?.elements ?? [];
	const current = positionGroups.find((group) => endDateOf(group) === null);
	const currentPosition =
		current?.profilePositionInPositionGroup?.elements?.find(
			(pos) => endDateOf(pos) === null,
		) ?? current?.profilePositionInPositionGroup?.elements?.[0];

	return {
		connection_count: connectionCount,
		current_company: nonEmpty(current?.company?.name ?? current?.name),
		current_position_title: nonEmpty(currentPosition?.title ?? current?.title),
		full_name: joinFullName(profile.firstName, profile.lastName),
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
	const groups = profile.profilePositionGroups?.elements ?? [];
	const records: ExperienceRecord[] = [];

	groups.forEach((group, groupIndex) => {
		const positions = group.profilePositionInPositionGroup?.elements ?? [];
		const groupCompanyName = nonEmpty(group.company?.name ?? group.name);

		if (positions.length > 0) {
			positions.forEach((pos: VoyagerPosition, posIndex) => {
				records.push({
					company: nonEmpty(pos.companyName) ?? groupCompanyName,
					description: nonEmpty(pos.description),
					employment_type: nonEmpty(pos.employmentType?.name),
					end_date: endDateOf(pos),
					id: subEntityId(pos.entityUrn, `exp-${groupIndex}`, posIndex),
					location: nonEmpty(pos.locationName ?? pos.geoLocationName),
					start_date: startDateOf(pos),
					title: nonEmpty(pos.title),
				});
			});
			return;
		}

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
	});

	return records;
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

export function buildEducationRecords(
	profile: VoyagerProfileElement,
): EducationRecord[] {
	const items = profile.profileEducations?.elements ?? [];
	return items.map((edu: VoyagerEducation, index) => ({
		degree: nonEmpty(edu.degreeName),
		end_date: endDateOf(edu),
		field_of_study: nonEmpty(edu.fieldOfStudy),
		grade: nonEmpty(edu.grade),
		id: subEntityId(edu.entityUrn, "edu", index),
		logo_url: educationLogoUrlOf(edu),
		school: nonEmpty(edu.schoolName ?? edu.school?.name),
		start_date: startDateOf(edu),
	}));
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
	const rawSkills = profile.profileSkills?.elements ?? [];
	const records: SkillRecord[] = [];
	let index = 0;

	for (const entry of rawSkills) {
		const category = entry as VoyagerSkillCategory;
		const categorySkills = category.skills ?? category.elements ?? [];
		if (categorySkills.length > 0) {
			for (const sk of categorySkills) {
				const name = nonEmpty(sk.name);
				if (name) {
					records.push({
						endorsement_count: endorsementCountOf(sk),
						id: subEntityId(sk.entityUrn, "skill", index),
						name,
					});
				}
				index += 1;
			}
			continue;
		}
		const name = nonEmpty(category.name);
		if (name) {
			records.push({
				endorsement_count: endorsementCountOf(category),
				id: subEntityId(category.entityUrn, "skill", index),
				name,
			});
		}
		index += 1;
	}

	return records;
}

function endorsementCountOf(
	sk: VoyagerSkill | VoyagerSkillCategory,
): number | null {
	const count = sk.endorsementCount ?? sk.endorsements;
	return typeof count === "number" && Number.isFinite(count) && count >= 0
		? count
		: null;
}

export function buildLanguageRecords(
	profile: VoyagerProfileElement,
): LanguageRecord[] {
	const items = profile.profileLanguages?.elements ?? [];
	return items
		.map((lang: VoyagerLanguage, index) => {
			const name = nonEmpty(lang.name);
			if (!name) {
				return null;
			}
			return {
				id: subEntityId(lang.entityUrn, "lang", index),
				name,
				proficiency: nonEmpty(lang.proficiency),
			};
		})
		.filter((r): r is LanguageRecord => r !== null);
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
	if (!memberUrn) {
		return null;
	}
	const publicId = resolved?.publicIdentifier;
	return {
		connected_at: connectedAtOf(element.createdAt),
		full_name: joinFullName(resolved?.firstName, resolved?.lastName),
		headline: nonEmpty(resolved?.headline ?? resolved?.occupation),
		id: memberUrn,
		profile_url: publicId ? profileUrlFor(publicId) : null,
	};
}
