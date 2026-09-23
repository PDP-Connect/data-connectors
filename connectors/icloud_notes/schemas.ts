// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Zod schemas for iCloud Notes stream records. Shape-check-before-emit per
 * docs/connector-authoring-guide.md §3: a record that doesn't match the
 * schema becomes SKIP_RESULT instead of RECORD, so the RS never receives
 * data that looks right but isn't.
 *
 * Text-field classification (docs/connector-authoring-guide.md §4a):
 *   - title/snippet/text_content/name -> pdppSafeText (human-readable text,
 *     may contain arbitrary Unicode from the owner's own notes)
 *   - id/folder_id -> CloudKit recordName strings (opaque platform IDs, no
 *     fixed regex shape is documented by Apple, so bounded z.string())
 */

import { pdppSafeText } from "@pdpp/connector-protocol/pdpp-safe-text";
import { z } from "zod";
import { makeValidateRecord } from "../../packages/polyfill-connectors/src/schema-registry.ts";

// CloudKit recordName is an opaque platform identifier (UUID-shaped in
// practice but not documented as such by Apple) — bound length, don't
// over-constrain the shape.
const recordIdSchema = z.string().min(1).max(200);
const isoDateTimeSchema = z.string().datetime({ offset: true }).nullable();
const titleSchema = pdppSafeText.max(2000).nullable();
const snippetSchema = pdppSafeText.max(4000).nullable();
const bodyTextSchema = pdppSafeText.max(10_000_000).nullable();

export const noteSchema = z.object({
	id: recordIdSchema,
	title: titleSchema,
	snippet: snippetSchema,
	folder_id: recordIdSchema.nullable(),
	is_pinned: z.boolean(),
	created_at: isoDateTimeSchema,
	modified_at: isoDateTimeSchema,
	has_attachments: z.boolean(),
	text_content: bodyTextSchema,
});

export const folderSchema = z.object({
	id: recordIdSchema,
	name: pdppSafeText.min(1).max(500),
});

/** Map stream name -> schema. Single source of truth for what streams this
 *  connector produces at shape-check time. */
export const SCHEMAS: Record<string, z.ZodTypeAny> = {
	notes: noteSchema,
	folders: folderSchema,
};

export const validateRecord = makeValidateRecord(SCHEMAS);
