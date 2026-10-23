// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Zod schemas for Muse (Meta) stream records. Shape-check-before-emit per
 * packages/polyfill-connectors/docs/connector-authoring-guide.md §3; mirrors
 * manifest.json field for field.
 *
 * Every time is RFC 3339 with a zone (the source gives epoch milliseconds,
 * epoch seconds or zoned ISO strings; parsers.ts normalizes them to UTC `Z`).
 * Free text is `pdppSafeText`; a value that fails the printable-text check is
 * replaced with null by parsers.ts and counted, never inlined.
 */

import { pdppSafeText } from "@pdpp/connector-protocol/pdpp-safe-text";
import { z } from "zod";
import { makeValidateRecord } from "../../packages/polyfill-connectors/src/schema-registry.ts";

export const TEXT_MAX_UNITS = 2_000_000;
const SHORT_TEXT_MAX = 10_000;

const idSchema = z.string().min(1).max(1024);
const nullableId = idSchema.nullable();
const dateTime = z.string().datetime({ offset: true });
const nullableDateTime = dateTime.nullable();
const shortText = pdppSafeText.max(SHORT_TEXT_MAX).nullable();
const longText = pdppSafeText.max(TEXT_MAX_UNITS).nullable();
// Enumerations the source owns (status, role, kind); bounded, not free text.
const label = z.string().min(1).max(200).nullable();

export const conversationsSchema = z.object({
	id: idSchema,
	title: shortText,
	snippet: shortText,
	created_at: nullableDateTime,
	updated_at: nullableDateTime,
	is_primary: z.boolean().nullable(),
	is_thread: z.boolean().nullable(),
	archived: z.boolean(),
	pinned: z.boolean().nullable(),
	status: label,
});

export const messagesSchema = z.object({
	id: idSchema,
	session_id: idSchema,
	role: label,
	text: longText,
	text_binary_reason: z.string().max(200).nullable(),
	occurred_at: dateTime,
	reply_to_message_id: nullableId,
	source: label,
	visibility: label,
	seq: z.number().int().nullable(),
});

export const activitiesSchema = z.object({
	id: idSchema,
	message_id: nullableId,
	type: z.string().min(1).max(200),
	title: shortText,
	subtitle: shortText,
	status: label,
	status_title: shortText,
	task_label: shortText,
	timestamp: dateTime,
});

export const goalsSchema = z.object({
	id: idSchema,
	source: label,
	slug: shortText,
	title: shortText,
	status: label,
	summary: longText,
	description: longText,
	momentum_status: label,
	emoji: shortText,
	created_at: nullableDateTime,
	updated_at: nullableDateTime,
	last_activity_at: nullableDateTime,
});

export const scheduledTasksSchema = z.object({
	id: idSchema,
	title: shortText,
	schedule_key: shortText,
	mode: label,
	enabled: z.boolean().nullable(),
	is_heartbeat: z.boolean().nullable(),
	next_run_at: nullableDateTime,
	timezone: label,
	cadence_kind: label,
	cadence_time: label,
	cadence_interval_seconds: z.number().int().min(0).nullable(),
	cadence_run_at: nullableDateTime,
});

export const memoryFilesSchema = z.object({
	id: idSchema,
	path: idSchema,
	text: longText,
	text_binary_reason: z.string().max(200).nullable(),
	size: z.number().int().min(0).nullable(),
	modified_at: nullableDateTime,
});

export const filesSchema = z.object({
	id: idSchema,
	path: pdppSafeText.min(1).max(4096),
	name: shortText,
	size: z.number().int().min(0).nullable(),
	modified_at: nullableDateTime,
});

export const connectedAppsSchema = z.object({
	id: idSchema,
	name: shortText,
	state: label,
	management_kind: label,
	needs_reauth: z.boolean().nullable(),
});

export const SCHEMAS: Record<string, z.ZodTypeAny> = {
	conversations: conversationsSchema,
	messages: messagesSchema,
	activities: activitiesSchema,
	goals: goalsSchema,
	scheduled_tasks: scheduledTasksSchema,
	memory_files: memoryFilesSchema,
	files: filesSchema,
	connected_apps: connectedAppsSchema,
};

export const validateRecord = makeValidateRecord(SCHEMAS);
