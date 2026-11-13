// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Zod schemas for Mountain Project records, checked before every emit
 * (docs/connector-authoring-guide.md §3). They mirror manifest.json's stream
 * schemas field for field.
 */

import { pdppSafeText } from "@pdpp/connector-protocol/pdpp-safe-text";
import { z } from "zod";
import { makeValidateRecord } from "../../packages/polyfill-connectors/src/schema-registry.ts";

const ROUTE_ID_RE = /^\d{1,12}$/;
const USER_ID_RE = /^\d{1,12}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TICK_ID_RE = /^\d{1,12}:\d{4}-\d{2}-\d{2}:\d{1,6}$/;
const ROUTE_URL_RE =
	/^https:\/\/www\.mountainproject\.com\/route\/\d{1,12}(?:\/[^\s?#]*)?$/;
const PROFILE_URL_RE =
	/^https:\/\/www\.mountainproject\.com\/user\/\d{1,12}\/[^\s/?#]+$/;

const stars = z.number().min(0).max(5).nullable();

const routeFields = {
	route_id: z.string().regex(ROUTE_ID_RE),
	route_name: pdppSafeText.min(1).max(500),
	route_url: z.string().regex(ROUTE_URL_RE),
	rating: pdppSafeText.max(200).nullable(),
	rating_code: z.number().int().nonnegative().nullable(),
	location: z.array(pdppSafeText.min(1).max(500)).max(50),
	avg_stars: stars,
	your_stars: stars,
	route_type: z.array(pdppSafeText.min(1).max(100)).max(20),
	your_rating: pdppSafeText.max(200).nullable(),
	length_ft: z.number().int().nonnegative().nullable(),
};

export const tickSchema = z
	.object({
		id: z.string().regex(TICK_ID_RE),
		date: z.string().regex(DATE_RE),
		...routeFields,
		pitches: z.number().int().nonnegative().nullable(),
		style: pdppSafeText.max(100).nullable(),
		lead_style: pdppSafeText.max(100).nullable(),
		notes: pdppSafeText.max(100_000).nullable(),
	})
	.strict();

export const savedRouteSchema = z
	.object({
		id: z.string().regex(ROUTE_ID_RE),
		...routeFields,
		pitches: z.number().int().nonnegative().nullable(),
	})
	.strict()
	.refine((record) => record.id === record.route_id, {
		message: "id must be the route id",
	});

export const profileSchema = z
	.object({
		id: z.string().regex(USER_ID_RE),
		display_name: pdppSafeText.min(1).max(500),
		profile_url: z.string().regex(PROFILE_URL_RE),
		avatar_url: z.string().url().startsWith("https://").nullable(),
		location: pdppSafeText.max(500).nullable(),
		member_since: z.string().regex(DATE_RE).nullable(),
		tick_count: z.number().int().nonnegative().nullable(),
		todo_count: z.number().int().nonnegative().nullable(),
	})
	.strict();

/** Stream to schema registry: the one source of truth for emitted streams. */
export const SCHEMAS: Record<string, z.ZodTypeAny> = {
	profile: profileSchema,
	ticks: tickSchema,
	saved_routes: savedRouteSchema,
};

export const validateRecord = makeValidateRecord(SCHEMAS);
