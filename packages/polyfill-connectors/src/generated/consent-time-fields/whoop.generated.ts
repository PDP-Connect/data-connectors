// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// GENERATED FILE — do not hand-edit. Produced by
// scripts/generate-consent-time-fields.ts from connectors/whoop/manifest.json
// alone. A built whoop artifact resolves the consent-time-field table to
// this file, so editing another connector's consent fields never changes it.
// Regenerate with `node --experimental-strip-types
// scripts/generate-consent-time-fields.ts` from packages/polyfill-connectors.

import type { ConsentTimeField } from "../../time-range.ts";

export const CONSENT_BOUND_CONNECTOR: string | null = "whoop";

export const CONSENT_TIME_FIELDS: Readonly<
	Record<string, Readonly<Record<string, ConsentTimeField | null>>>
> = {
	whoop: {
		body: null,
		cycles: null,
		profile: null,
		recoveries: { field: "created_at", format: "date-time" },
		sleeps: { field: "start_at", format: "date-time" },
		workouts: { field: "start_at", format: "date-time" },
	},
};

export const CHECKPOINT_PARENTS: Readonly<
	Record<string, Readonly<Record<string, readonly string[]>>>
> = {
	whoop: {},
};
