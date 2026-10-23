// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// GENERATED FILE — do not hand-edit. Produced by
// scripts/generate-consent-time-fields.ts from connectors/muse/manifest.json
// alone. A built muse artifact resolves the consent-time-field table to
// this file, so editing another connector's consent fields never changes it.
// Regenerate with `node --experimental-strip-types
// scripts/generate-consent-time-fields.ts` from packages/polyfill-connectors.

import type { ConsentTimeField } from "../../time-range.ts";

export const CONSENT_BOUND_CONNECTOR: string | null = "muse";

export const CONSENT_TIME_FIELDS: Readonly<
	Record<string, Readonly<Record<string, ConsentTimeField | null>>>
> = {
	muse: {
		activities: { field: "timestamp", format: "date-time" },
		connected_apps: null,
		conversations: { field: "created_at", format: "date-time" },
		files: { field: "modified_at", format: "date-time" },
		goals: { field: "created_at", format: "date-time" },
		memory_files: { field: "modified_at", format: "date-time" },
		messages: { field: "occurred_at", format: "date-time" },
		scheduled_tasks: null,
	},
};
