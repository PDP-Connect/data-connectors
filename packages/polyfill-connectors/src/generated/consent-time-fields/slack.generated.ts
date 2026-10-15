// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// GENERATED FILE — do not hand-edit. Produced by
// scripts/generate-consent-time-fields.ts from connectors/slack/manifest.json
// alone. A built slack artifact resolves the consent-time-field table to
// this file, so editing another connector's consent fields never changes it.
// Regenerate with `node --experimental-strip-types
// scripts/generate-consent-time-fields.ts` from packages/polyfill-connectors.

import type { ConsentTimeField } from "../../time-range.ts";

export const CONSENT_BOUND_CONNECTOR: string | null = "slack";

export const CONSENT_TIME_FIELDS: Readonly<
	Record<string, Readonly<Record<string, ConsentTimeField | null>>>
> = {
	slack: {
		canvases: null,
		channel_memberships: null,
		channel_stats: null,
		channels: null,
		dm_read_states: null,
		files: null,
		message_attachments: null,
		messages: { field: "sent_at", format: "date-time" },
		reactions: null,
		reminders: null,
		stars: null,
		user_groups: null,
		users: null,
		workspace: null,
	},
};

export const CHECKPOINT_PARENTS: Readonly<
	Record<string, Readonly<Record<string, readonly string[]>>>
> = {
	slack: {
		message_attachments: ["messages"],
		reactions: ["messages"],
	},
};
