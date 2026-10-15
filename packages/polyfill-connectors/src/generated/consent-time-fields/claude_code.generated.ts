// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// GENERATED FILE — do not hand-edit. Produced by
// scripts/generate-consent-time-fields.ts from connectors/claude_code/manifest.json
// alone. A built claude_code artifact resolves the consent-time-field table to
// this file, so editing another connector's consent fields never changes it.
// Regenerate with `node --experimental-strip-types
// scripts/generate-consent-time-fields.ts` from packages/polyfill-connectors.

import type { ConsentTimeField } from "../../time-range.ts";

export const CONSENT_BOUND_CONNECTOR: string | null = "claude_code";

export const CONSENT_TIME_FIELDS: Readonly<
	Record<string, Readonly<Record<string, ConsentTimeField | null>>>
> = {
	claude_code: {
		attachments: { field: "timestamp", format: "date-time" },
		backup_inventory: null,
		cache_inventory: null,
		config_inventory: null,
		file_history: null,
		memory_notes: null,
		messages: { field: "timestamp", format: "date-time" },
		sessions: { field: "started_at", format: "date-time" },
		skills: null,
		slash_commands: null,
		usage: null,
	},
};

export const CHECKPOINT_PARENTS: Readonly<
	Record<string, Readonly<Record<string, readonly string[]>>>
> = {
	claude_code: {
		attachments: ["sessions"],
		memory_notes: ["sessions"],
		messages: ["sessions"],
	},
};
