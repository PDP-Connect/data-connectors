// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// GENERATED FILE — do not hand-edit. Produced by
// scripts/generate-consent-time-fields.ts from connectors/garmin_browser/manifest.json
// alone. A built garmin_browser artifact resolves the consent-time-field table to
// this file, so editing another connector's consent fields never changes it.
// Regenerate with `node --experimental-strip-types
// scripts/generate-consent-time-fields.ts` from packages/polyfill-connectors.

import type { ConsentTimeField } from "../../time-range.ts";

export const CONSENT_BOUND_CONNECTOR: string | null = "garmin_browser";

export const CONSENT_TIME_FIELDS: Readonly<
	Record<string, Readonly<Record<string, ConsentTimeField | null>>>
> = {
	garmin_browser: {
		activities: { field: "start_at", format: "date-time" },
		daily_summaries: { field: "date", format: "date" },
		hrv: { field: "date", format: "date" },
		sleep: { field: "start_at", format: "date-time" },
		training_status: { field: "date", format: "date" },
	},
};
