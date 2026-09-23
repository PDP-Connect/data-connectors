// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Minimal structural types for the LinkedIn Voyager JSON responses this
// connector consumes. Voyager is an internal, undocumented API — these types
// describe only the fields the parsers read, not the full response shape.
// Every field is optional because Voyager's decoration payloads vary by
// account type, locale, and profile completeness; parsers must tolerate
// absence rather than assume presence.

/** `dateRange` (dash API) or `timePeriod` (legacy API) partial-date shape. */
export interface VoyagerDatePoint {
	month?: number;
	year?: number;
}

export interface VoyagerDateRange {
	end?: VoyagerDatePoint;
	endDate?: VoyagerDatePoint;
	start?: VoyagerDatePoint;
	startDate?: VoyagerDatePoint;
}

/** A node that carries either `dateRange` (dash) or `timePeriod` (legacy)
 *  directly, or the date fields inline (oldest legacy shape). */
export type VoyagerDateBearing = VoyagerDateRange & {
	dateRange?: VoyagerDateRange;
	timePeriod?: VoyagerDateRange;
};

export interface VoyagerVectorImageArtifact {
	fileIdentifyingUrlPathSegment?: string;
}

export interface VoyagerVectorImage {
	artifacts?: VoyagerVectorImageArtifact[];
	rootUrl?: string;
}

export interface VoyagerPosition extends VoyagerDateBearing {
	companyName?: string;
	description?: string;
	/** Real shape observed 2026-09-22 (dash decoration -93): `{ name }`, e.g.
	 *  `{ name: "Full-time" }`. Position-level only — never observed on the
	 *  parent position-group. */
	employmentType?: { name?: string };
	entityUrn?: string;
	geoLocationName?: string;
	locationName?: string;
	title?: string;
}

export interface VoyagerPositionGroup extends VoyagerDateBearing {
	company?: { name?: string };
	description?: string;
	entityUrn?: string;
	geoLocationName?: string;
	locationName?: string;
	name?: string;
	profilePositionInPositionGroup?: { elements?: VoyagerPosition[] };
	title?: string;
}

export interface VoyagerEducation extends VoyagerDateBearing {
	degreeName?: string;
	entityUrn?: string;
	fieldOfStudy?: string;
	grade?: string;
	school?: {
		logo?: {
			"com.linkedin.common.VectorImage"?: VoyagerVectorImage;
			vectorImage?: VoyagerVectorImage;
		};
		name?: string;
	};
	schoolLogo?: { vectorImage?: VoyagerVectorImage };
	schoolName?: string;
}

export interface VoyagerSkill {
	entityUrn?: string;
	endorsementCount?: number;
	endorsements?: number;
	name?: string;
}

export interface VoyagerSkillCategory {
	elements?: VoyagerSkill[];
	endorsementCount?: number;
	endorsements?: number;
	entityUrn?: string;
	name?: string;
	skills?: VoyagerSkill[];
}

export interface VoyagerLanguage {
	entityUrn?: string;
	name?: string;
	proficiency?: string;
}

/** Real shape observed 2026-09-22 (dash decoration -93):
 *  `{ countryCode, postalCode }` directly, no `basicLocation` wrapper and no
 *  `preferredGeoPlace` — `location` alone carries no human-readable city/
 *  region name on this account. The `basicLocation`/`preferredGeoPlace`
 *  fields below are kept from the legacy connector's inference as a
 *  tolerated fallback (harmless if never matched) rather than removed,
 *  since a different account/decoration could still expose them. */
export interface VoyagerLocation {
	basicLocation?: { countryCode?: string };
	countryCode?: string;
	preferredGeoPlace?: string;
}

export interface VoyagerGeoLocation {
	/** `geo.defaultLocalizedName` is the full "City, Region, Country" string
	 *  (e.g. "Austin, Texas, United States") — the proven-correct source for
	 *  `profile.location`. `defaultLocalizedNameWithoutCountryName` is the
	 *  shorter "City, Region" form, observed but not currently read. */
	geo?: {
		defaultLocalizedName?: string;
		defaultLocalizedNameWithoutCountryName?: string;
	};
}

export interface VoyagerProfileElement {
	firstName?: string;
	geoLocation?: VoyagerGeoLocation;
	headline?: string;
	/** Real shape observed 2026-09-22 (dash decoration -93): an object with a
	 *  `name`, not a bare string. `industryName` never appears on this
	 *  decoration. */
	industry?: { name?: string };
	lastName?: string;
	location?: VoyagerLocation;
	profileEducations?: { elements?: VoyagerEducation[] };
	profileLanguages?: { elements?: VoyagerLanguage[] };
	profilePicture?: {
		displayImageReference?: { vectorImage?: VoyagerVectorImage };
	};
	profilePositionGroups?: { elements?: VoyagerPositionGroup[] };
	profileSkills?: { elements?: VoyagerSkillCategory[] };
	publicIdentifier?: string;
	summary?: string;
}

export interface VoyagerDashProfilesResponse {
	elements?: VoyagerProfileElement[];
}

export interface VoyagerMiniProfile {
	firstName?: string;
	lastName?: string;
	occupation?: string;
	picture?: {
		artifacts?: VoyagerVectorImageArtifact[];
		rootUrl?: string;
		"com.linkedin.common.VectorImage"?: VoyagerVectorImage;
	};
	publicIdentifier?: string;
}

export interface VoyagerMeResponse {
	miniProfile?: VoyagerMiniProfile;
	publicIdentifier?: string;
}

export interface VoyagerConnectionElement {
	connectedMember?: string;
	createdAt?: number;
}

export interface VoyagerConnectionsResponse {
	elements?: VoyagerConnectionElement[];
	paging?: { total?: number };
}

export interface VoyagerResolvedProfile {
	dashEntityUrn?: string;
	entityUrn?: string;
	firstName?: string;
	headline?: string;
	lastName?: string;
	occupation?: string;
	publicIdentifier?: string;
}

export interface VoyagerProfilesByIdResponse {
	elements?: VoyagerResolvedProfile[];
	results?: Record<string, VoyagerResolvedProfile | undefined>;
}

/** Shape returned by the in-page `fetchApi` wrapper: either the parsed JSON
 *  body or a transport-level `_error`. */
export type VoyagerFetchOutcome<T> =
	| (T & { _error?: undefined })
	| { _error: string };
