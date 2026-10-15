// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// GENERATED FILE — do not hand-edit. Produced by
// scripts/generate-consent-time-fields.ts from connectors/google_takeout/manifest.json
// alone. A built google_takeout artifact resolves the consent-time-field table to
// this file, so editing another connector's consent fields never changes it.
// Regenerate with `node --experimental-strip-types
// scripts/generate-consent-time-fields.ts` from packages/polyfill-connectors.

import type { ConsentTimeField } from "../../time-range.ts";

export const CONSENT_BOUND_CONNECTOR: string | null = "google_takeout";

export const CONSENT_TIME_FIELDS: Readonly<
	Record<string, Readonly<Record<string, ConsentTimeField | null>>>
> = {
	google_takeout: {
		location_history: { field: "timestamp", format: "date-time" },
		photos: { field: "event_time", format: "date-time" },
		search_history: { field: "timestamp", format: "date-time" },
		youtube_watch_history: { field: "watched_at", format: "date-time" },
	},
};

export const CHECKPOINT_PARENTS: Readonly<
	Record<string, Readonly<Record<string, readonly string[]>>>
> = {
	google_takeout: {},
};
