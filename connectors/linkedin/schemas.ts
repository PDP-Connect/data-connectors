// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Zod schemas for LinkedIn stream records. Shape-check-before-emit per
 * docs/reference/connector-authoring-guide.md §3.
 *
 * These schemas describe records built by `parsers.ts` from the Voyager
 * `dash/profiles` (FullProfileWithEntities decoration), `/me`, and
 * `relationships/dash/connections` responses. Field shapes follow D4
 * (docs/migration/connector-cutover/CONTRACTS.md): partial dates are
 * `YYYY` or `YYYY-MM` strings (LinkedIn never gives day precision on
 * experience/education), never invented; timestamps are ISO-8601.
 *
 * `id` shapes are intentionally loose (`z.string().min(1).max(200)`)
 * because Voyager entity ids mix URNs (`urn:li:fsd_profilePosition:...`)
 * and positional fallback ids (`exp-0-1`) — see `idOf` in
 * parsers.ts. Connections use the member URN directly.
 *
 * Every field is present on an emitted record: a Personal Server upsert
 * replaces the whole record, so a row with an unreadable field is withheld,
 * never emitted partial (see field-read.ts). `null` means the source says the
 * field is empty. profile.connection_count falls back to the walked distinct
 * count when the owner-bound summary is unavailable, with a diagnostic.
 */

import { pdppSafeText } from "@pdpp/connector-protocol/pdpp-safe-text";
import { z } from "zod";
import { makeValidateRecord } from "../../packages/polyfill-connectors/src/schema-registry.ts";

// Module-scoped regex (Biome useTopLevelRegex). D4 partial date: YYYY or
// YYYY-MM only — LinkedIn's Voyager date points never carry day precision.
const PARTIAL_DATE_RE = /^\d{4}(-\d{2})?$/;

const idSchema = z.string().min(1).max(200);
const partialDateNullable = z
	.string()
	.regex(PARTIAL_DATE_RE, "must be YYYY or YYYY-MM")
	.nullable();
const isoDateTimeNullable = z.iso.datetime().nullable();
const urlNullable = z.url().max(4096).nullable();

/**
 * profile stream (manifest required: id). One record: the owner's own
 * profile, keyed by public identifier (the only stable cross-run id
 * Voyager's `/me` and dash-profile decorations both expose consistently).
 */
export const profileSchema = z.object({
	connection_count: z.number().int().min(0).nullable(),
	current_company: pdppSafeText.max(500).nullable(),
	current_position_title: pdppSafeText.max(500).nullable(),
	full_name: pdppSafeText.max(300).nullable(),
	headline: pdppSafeText.max(1000).nullable(),
	id: idSchema,
	industry: pdppSafeText.max(300).nullable(),
	location: pdppSafeText.max(300).nullable(),
	profile_picture_url: urlNullable,
	public_url: urlNullable,
	summary: pdppSafeText.max(65_000).nullable(),
});

/**
 * experience stream (manifest required: id). One record per role —
 * `profilePositionGroups` sub-positions expand 1:1; groups without
 * sub-positions expand to one record. `end_date: null` means current.
 */
export const experienceSchema = z.object({
	company: pdppSafeText.max(500).nullable(),
	description: pdppSafeText.max(65_000).nullable(),
	employment_type: pdppSafeText.max(200).nullable(),
	end_date: partialDateNullable,
	id: idSchema,
	location: pdppSafeText.max(300).nullable(),
	start_date: partialDateNullable,
	title: pdppSafeText.max(500).nullable(),
});

/**
 * education stream (manifest required: id). One record per school.
 */
export const educationSchema = z.object({
	degree: pdppSafeText.max(500).nullable(),
	end_date: partialDateNullable,
	field_of_study: pdppSafeText.max(500).nullable(),
	grade: pdppSafeText.max(200).nullable(),
	id: idSchema,
	logo_url: urlNullable,
	school: pdppSafeText.max(500).nullable(),
	start_date: partialDateNullable,
});

/**
 * skills stream (manifest required: id, name). One record per skill.
 */
export const skillsSchema = z.object({
	endorsement_count: z.number().int().min(0).nullable(),
	id: idSchema,
	name: pdppSafeText.max(300),
});

/**
 * languages stream (D7: new stream). One record per language listed.
 */
export const languagesSchema = z.object({
	id: idSchema,
	name: pdppSafeText.max(200),
	proficiency: pdppSafeText.max(200).nullable(),
});

/**
 * connections stream (D7: new stream). One record per listed connection,
 * keyed by the connected member's URN. Profile enrichment fields are
 * optional for a permanently missing member. Include them only when resolved
 * source data is readable or explicitly empty. Transient failures and
 * malformed or incomplete data withhold the whole row so an upsert cannot
 * erase stored values.
 */
export const connectionsSchema = z.object({
	connected_at: isoDateTimeNullable.optional(),
	full_name: pdppSafeText.max(300).nullable().optional(),
	headline: pdppSafeText.max(1000).nullable().optional(),
	id: z.string().min(1).max(300),
	profile_url: urlNullable.optional(),
});

/**
 * Stream → schema registry. Single source of truth for the streams this
 * connector declares and emits.
 */
export const SCHEMAS: Record<string, z.ZodTypeAny> = {
	connections: connectionsSchema,
	education: educationSchema,
	experience: experienceSchema,
	languages: languagesSchema,
	profile: profileSchema,
	skills: skillsSchema,
};

export const validateRecord = makeValidateRecord(SCHEMAS);
