// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// GENERATED FILE — do not hand-edit. Produced by
// scripts/generate-consent-time-fields.ts from connectors/reddit/manifest.json
// alone. A built reddit artifact resolves the consent-time-field table to
// this file, so editing another connector's consent fields never changes it.
// Regenerate with `node --experimental-strip-types
// scripts/generate-consent-time-fields.ts` from packages/polyfill-connectors.

import type { ConsentTimeField } from "../../time-range.ts";

export const CONSENT_BOUND_CONNECTOR: string | null = "reddit";

export const CONSENT_TIME_FIELDS: Readonly<
	Record<string, Readonly<Record<string, ConsentTimeField | null>>>
> = {
	reddit: {
		comments: { field: "created_utc", format: "date-time" },
		comments_stats: { field: "created_utc", format: "date-time" },
		downvoted: { field: "created_utc", format: "date-time" },
		downvoted_stats: { field: "created_utc", format: "date-time" },
		hidden: { field: "created_utc", format: "date-time" },
		hidden_stats: { field: "created_utc", format: "date-time" },
		saved: { field: "created_utc", format: "date-time" },
		submitted: { field: "created_utc", format: "date-time" },
		submitted_stats: { field: "created_utc", format: "date-time" },
		upvoted: { field: "created_utc", format: "date-time" },
		upvoted_stats: { field: "created_utc", format: "date-time" },
	},
};

export const CHECKPOINT_PARENTS: Readonly<
	Record<string, Readonly<Record<string, readonly string[]>>>
> = {
	reddit: {},
};
