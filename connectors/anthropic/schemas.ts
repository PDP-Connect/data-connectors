// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Zod schemas for Anthropic/Claude stream records. Shape-check-before-emit per
 * docs/connector-authoring-guide.md §3.
 *
 * Ground truth: the connector's acquisition path is the official Claude data
 * export (browser session -> POST export_data -> poll -> download ZIP ->
 * pure ZIP parser), per docs/migration/connector-cutover/capability-map.json
 * (`anthropic` source entry) and connectors/anthropic/claude-export-ingest.cjs
 * (legacy prior art, READ ONLY). These schemas encode the capability map's
 * binding field mapping for `claude.conversations` (-> conversations +
 * messages) and `claude.projects` (-> projects + project_documents).
 *
 * `id` fields are Claude UUIDs in the real export (confirmed by the legacy
 * ingester's `conv?.uuid`/`p?.uuid` extraction and its test fixtures), but
 * kept as bounded opaque strings rather than UUID-regex'd: the export's
 * `uuid` field has not been directly observed against a real account by this
 * lane (real-fixture proof is PENDING — see connector header comment and the
 * cut-anthropic report). Tightening to a UUID regex is a follow-up once a
 * real export lands.
 */

import { pdppSafeText } from "@pdpp/connector-protocol/pdpp-safe-text";
import { z } from "zod";
import { makeValidateRecord } from "../../packages/polyfill-connectors/src/schema-registry.ts";

// Module-scoped regex (Biome useTopLevelRegex). Manifest declares date-time
// format; accept an ISO-8601 datetime prefix.
const ISO_DT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

// Opaque bounded id — tighten to UUID once a real export is observed.
const idSchema = z.string().min(1).max(128);
const isoDateTimeNullable = z
	.string()
	.regex(ISO_DT_RE, "must be an ISO-8601 datetime")
	.nullable();
const blobRefSchema = z
	.object({
		blob_id: z.string().regex(/^sha256:[0-9a-f]{64}$/),
		mime_type: z.literal("application/json"),
		size_bytes: z.number().int().min(1).max(33_554_432),
		sha256: z.string().regex(/^[0-9a-f]{64}$/),
	})
	.strict()
	.refine((ref) => ref.blob_id === `sha256:${ref.sha256}`);

/**
 * conversations stream (manifest required: id). mutable_state, cursor
 * update_time. Capability map: conversations[].{id,title,createdAt,
 * updatedAt,projectId,messageCount} -> {id,title,create_time,update_time,
 * project_id,message_count}. `model` is not in the capability map's field
 * map (the export carries no per-conversation model field) and is left
 * nullable for forward compatibility; the parser never populates it today.
 */
export const conversationsSchema = z.object({
	id: idSchema,
	title: pdppSafeText.max(4000).nullable(),
	create_time: isoDateTimeNullable,
	update_time: isoDateTimeNullable,
	project_id: idSchema.nullable(),
	model: z.string().min(1).max(128).nullable(),
	message_count: z.number().int().min(0).nullable(),
	is_starred: z.boolean().nullable(),
	blob_ref: blobRefSchema,
});

/**
 * messages stream (manifest required: id, conversation_id). append_only,
 * cursor create_time. `content` is the full flattened message body ->
 * pdppSafeText. Capability map: messages[].{id,sender,parentId,createdAt,
 * updatedAt,content,attachments} -> {id,role,parent_id,create_time,
 * update_time,content,attachments}.
 */
export const messagesSchema = z.object({
	id: idSchema,
	conversation_id: idSchema,
	role: z.string().min(1).max(64).nullable(),
	parent_id: idSchema.nullable(),
	content: pdppSafeText.max(10_000_000).nullable(),
	model: z.string().min(1).max(128).nullable(),
	create_time: isoDateTimeNullable,
	update_time: isoDateTimeNullable,
	attachments: z.array(z.record(z.string(), z.unknown())).nullable(),
});

/**
 * projects stream (manifest required: id, name). mutable_state, cursor
 * update_time. Capability map: projects[].{id,title,createdAt,updatedAt,
 * archived,detail.prompt_template} -> {id,name,create_time,update_time,
 * is_archived,prompt_template}. `description` is not in the capability
 * map's field map for this scope; kept nullable for forward compatibility
 * (the manifest already declared it before this lane and nothing in the
 * capability map says to remove it), but the parser leaves it null until a
 * real export confirms a project description field exists.
 */
export const projectsSchema = z.object({
	id: idSchema,
	name: pdppSafeText.max(2000),
	description: pdppSafeText.max(65_000).nullable(),
	create_time: isoDateTimeNullable,
	update_time: isoDateTimeNullable,
	is_archived: z.boolean().nullable(),
	prompt_template: pdppSafeText.max(65_000).nullable(),
	creator: z
		.object({ uuid: z.string().optional(), full_name: z.string().optional() })
		.strict()
		.nullable(),
	is_private: z.boolean().nullable(),
	is_starter_project: z.boolean().nullable(),
	archived_at: z.string().nullable(),
	raw_docs: z.array(
		z
			.object({
				uuid: z.string().optional(),
				filename: z.string().optional(),
				content: z.string().optional(),
				created_at: z.string().optional(),
				updated_at: z.string().optional(),
			})
			.strict(),
	),
	blob_ref: blobRefSchema,
});

/**
 * project_documents stream (new; capability map requires
 * `projects[].detail.docs[] -> project_documents`, split per D3 since each
 * doc has its own identity). Not incremental: the legacy export's `docs[]`
 * shape (per claude-export-ingest.test.cjs's `exportProject.docs`) carries no
 * observed per-doc updatedAt/timestamp field, only `uuid`; the manifest
 * therefore declares this stream non-incremental (full_inventory) rather
 * than claiming a cursor_field that would be dishonest. `filename` and
 * `content` are included because the capability map requires naming any
 * detail sub-field carrying real user content that is not already typed —
 * Claude project docs are known (from the product surface, confirmed by
 * `project_files_list` in CLAUDE_CONNECTOR_PLAN.md's bundle findings) to
 * carry a filename and document body; the parser reads them defensively
 * (null when absent) since the exact export field names are UNCONFIRMED
 * pending a real export (see report PENDING section).
 */
export const projectDocumentsSchema = z.object({
	id: idSchema,
	project_id: idSchema,
	filename: pdppSafeText.max(1024).nullable(),
	content: pdppSafeText.max(10_000_000).nullable(),
	create_time: isoDateTimeNullable,
	update_time: isoDateTimeNullable,
});

export const accountProfileSchema = z.object({
	id: idSchema,
	organization_id: idSchema,
	full_name: pdppSafeText.max(2000).nullable(),
	plan: pdppSafeText.max(2000).nullable(),
	name_source: z.enum(["browser_menu", "users_json", "none"]),
	metadata_status: z.enum([
		"valid",
		"absent",
		"malformed",
		"ambiguous",
		"mismatch",
	]),
});

/**
 * Stream -> schema registry. Single source of truth for the streams this
 * connector declares and emits.
 */
export const SCHEMAS: Record<string, z.ZodTypeAny> = {
	account_profile: accountProfileSchema,
	conversations: conversationsSchema,
	messages: messagesSchema,
	projects: projectsSchema,
	project_documents: projectDocumentsSchema,
};

export const validateRecord = makeValidateRecord(SCHEMAS);
