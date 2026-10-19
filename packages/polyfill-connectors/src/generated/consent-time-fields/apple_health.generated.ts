// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// GENERATED FILE — do not hand-edit. Produced by
// scripts/generate-consent-time-fields.ts from connectors/apple_health/manifest.json
// alone. A built apple_health artifact resolves the consent-time-field table to
// this file, so editing another connector's consent fields never changes it.
// Regenerate with `node --experimental-strip-types
// scripts/generate-consent-time-fields.ts` from packages/polyfill-connectors.

import type { ConsentTimeField } from "../../time-range.ts";

export const CONSENT_BOUND_CONNECTOR: string | null = "apple_health";

export const CONSENT_TIME_FIELDS: Readonly<
	Record<string, Readonly<Record<string, ConsentTimeField | null>>>
> = {
	apple_health: {
		activity: { field: "start_date", format: "date-time" },
		alcohol_consumption: { field: "start_date", format: "date-time" },
		body_measurements: { field: "start_date", format: "date-time" },
		coverage_diagnostics: null,
		hearing: { field: "start_date", format: "date-time" },
		lab_results: { field: "start_date", format: "date-time" },
		mindfulness: { field: "start_date", format: "date-time" },
		mobility: { field: "start_date", format: "date-time" },
		nutrition: { field: "start_date", format: "date-time" },
		other: { field: "start_date", format: "date-time" },
		reproductive_health: { field: "start_date", format: "date-time" },
		sleep: { field: "start_date", format: "date-time" },
		symptoms: { field: "start_date", format: "date-time" },
		vital_signs: { field: "start_date", format: "date-time" },
		workouts: { field: "start_date", format: "date-time" },
	},
};
