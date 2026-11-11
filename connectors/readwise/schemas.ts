// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";
import { makeValidateRecord } from "../../packages/polyfill-connectors/src/schema-registry.ts";

/** Kindle highlight record, with provider identity and book context. */
export const kindleHighlightsSchema = z.object({
	id: z.string().min(1),
	book_id: z.string().min(1),
	title: z.string(),
	author: z.string().nullable(),
	text: z.string(),
	note: z.string().nullable(),
	location: z.number().int().nullable(),
	location_type: z.string().nullable(),
	highlighted_at: z.iso.datetime({ offset: true }).nullable(),
	updated_at: z.iso.datetime({ offset: true }),
	readwise_url: z.string(),
	source: z.literal("kindle"),
	tags: z.array(z.string()),
	deleted: z.boolean(),
});
export const SCHEMAS = { kindle_highlights: kindleHighlightsSchema };
export const validateRecord = makeValidateRecord(SCHEMAS);
