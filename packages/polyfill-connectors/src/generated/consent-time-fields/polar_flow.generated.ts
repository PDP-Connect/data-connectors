// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// GENERATED FILE — do not hand-edit. Produced by
// scripts/generate-consent-time-fields.ts from connectors/polar_flow/manifest.json
// alone. A built polar_flow artifact resolves the consent-time-field table to
// this file, so editing another connector's consent fields never changes it.
// Regenerate with `node --experimental-strip-types
// scripts/generate-consent-time-fields.ts` from packages/polyfill-connectors.

import type { ConsentTimeField } from "../../time-range.ts";

export const CONSENT_BOUND_CONNECTOR: string | null = "polar_flow";

export const CONSENT_TIME_FIELDS: Readonly<
	Record<string, Readonly<Record<string, ConsentTimeField | null>>>
> = {
	polar_flow: {
		daily_activity: { field: "date", format: "date" },
		nightly_recharge: { field: "date", format: "date" },
		profile: null,
		sleep: { field: "date", format: "date" },
		training_sessions: { field: "start_date", format: "date" },
	},
};
