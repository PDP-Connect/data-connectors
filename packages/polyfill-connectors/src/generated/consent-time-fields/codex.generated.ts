// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// GENERATED FILE — do not hand-edit. Produced by
// scripts/generate-consent-time-fields.ts from connectors/codex/manifest.json
// alone. A built codex artifact resolves the consent-time-field table to
// this file, so editing another connector's consent fields never changes it.
// Regenerate with `node --experimental-strip-types
// scripts/generate-consent-time-fields.ts` from packages/polyfill-connectors.

import type { ConsentTimeField } from "../../time-range.ts";

export const CONSENT_BOUND_CONNECTOR: string | null = "codex";

export const CONSENT_TIME_FIELDS: Readonly<
	Record<string, Readonly<Record<string, ConsentTimeField | null>>>
> = {
	codex: {
		cache_inventory: null,
		config_inventory: null,
		function_calls: { field: "timestamp", format: "date-time" },
		history: null,
		messages: { field: "timestamp", format: "date-time" },
		prompts: null,
		rules: null,
		session_index: null,
		sessions: { field: "started_at", format: "date-time" },
		shell_snapshots: null,
		skills: null,
	},
};
