// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Zod schemas for Facebook stream records, checked before every emit
 * (connector-authoring-guide.md §3). They mirror manifest.json field for field.
 */

import { pdppSafeText } from "@pdpp/connector-protocol/pdpp-safe-text";
import { z } from "zod";
import { makeValidateRecord } from "../../packages/polyfill-connectors/src/schema-registry.ts";

const NUMERIC_ID_RE = /^\d{1,30}$/;
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const PRIVACY_RE = /^[A-Z_]{2,40}$/;
const STYLE_RE = /^[a-z0-9_]{1,80}$/;
const ACTIVITY_ID_RE = /^[\x21-\x7E]{1,400}$/;
const HTTPS_RE = /^https:\/\//;
const USERNAME_RE = /^[A-Za-z0-9.]{3,80}$/;

const numericId = z
	.string()
	.regex(NUMERIC_ID_RE, "must be a numeric Facebook id");
const isoUtc = z.string().regex(ISO_UTC_RE, "must be an RFC 3339 UTC time");
const httpsUrl = z.url().regex(HTTPS_RE, "must be an https URL");

export const profileSchema = z.object({
	id: numericId,
	name: pdppSafeText.max(500).nullable(),
	username: z.string().regex(USERNAME_RE).nullable(),
	profile_url: httpsUrl,
	bio: pdppSafeText.max(2000).nullable(),
	intro: z.array(pdppSafeText.max(500)).nullable(),
});

export const postsSchema = z.object({
	id: numericId,
	create_time: isoUtc,
	text: pdppSafeText.max(60_000).nullable(),
	title: pdppSafeText.max(1000).nullable(),
	shared_text: pdppSafeText.max(60_000).nullable(),
	attachment_title: pdppSafeText.max(1000).nullable(),
	url: httpsUrl.nullable(),
	attachments: z.array(
		z.object({
			kind: z.string().regex(STYLE_RE).nullable(),
			title: pdppSafeText.max(1000).nullable(),
		}),
	),
	privacy: z.string().regex(PRIVACY_RE).nullable(),
	privacy_label: pdppSafeText.max(200).nullable(),
});

export const friendsSchema = z.object({
	id: numericId,
	name: pdppSafeText.min(1).max(500),
	profile_url: httpsUrl.nullable(),
});

export const groupsSchema = z.object({
	id: numericId,
	name: pdppSafeText.min(1).max(500),
	url: httpsUrl,
	joined_time: isoUtc.nullable(),
});

const activitySchema = (kind: "comment" | "reaction") =>
	z.object({
		id: z.string().regex(ACTIVITY_ID_RE),
		kind: z.literal(kind),
		time: isoUtc,
		title: pdppSafeText.max(2000).nullable(),
		target_url: httpsUrl.nullable(),
		target_text: pdppSafeText.max(20_000).nullable(),
		post_id: numericId.nullable(),
		comment_text: pdppSafeText.max(20_000).nullable(),
	});

export const reactionsSchema = activitySchema("reaction");
export const commentsSchema = activitySchema("comment");

export const SCHEMAS: Record<string, z.ZodTypeAny> = {
	profile: profileSchema,
	posts: postsSchema,
	friends: friendsSchema,
	groups: groupsSchema,
	reactions: reactionsSchema,
	comments: commentsSchema,
};

export const validateRecord = makeValidateRecord(SCHEMAS);
