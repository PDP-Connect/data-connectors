// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// GENERATED FILE — do not hand-edit. Produced by
// scripts/generate-consent-time-fields.ts from connectors/groupme/manifest.json
// alone. A built groupme artifact resolves the consent-time-field table to
// this file, so editing another connector's consent fields never changes it.
// Regenerate with `node --experimental-strip-types
// scripts/generate-consent-time-fields.ts` from packages/polyfill-connectors.

import type { ConsentTimeField } from "../../time-range.ts";

export const CONSENT_BOUND_CONNECTOR: string | null = "groupme";

export const CONSENT_TIME_FIELDS: Readonly<
	Record<string, Readonly<Record<string, ConsentTimeField | null>>>
> = {
	groupme: {
		attachments: null,
		direct_chat_messages: { field: "created_at", format: "date-time" },
		direct_messages: { field: "last_message_at", format: "date-time" },
		group_messages: { field: "created_at", format: "date-time" },
		groups: { field: "created_at", format: "date-time" },
	},
};

export const CHECKPOINT_PARENTS: Readonly<
	Record<string, Readonly<Record<string, readonly string[]>>>
> = {
	groupme: {
		attachments: ["group_messages", "direct_chat_messages"],
	},
};
