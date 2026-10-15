// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// GENERATED FILE — do not hand-edit. Produced by
// scripts/generate-consent-time-fields.ts from connectors/github/manifest.json
// alone. A built github artifact resolves the consent-time-field table to
// this file, so editing another connector's consent fields never changes it.
// Regenerate with `node --experimental-strip-types
// scripts/generate-consent-time-fields.ts` from packages/polyfill-connectors.

import type { ConsentTimeField } from "../../time-range.ts";

export const CONSENT_BOUND_CONNECTOR: string | null = "github";

export const CONSENT_TIME_FIELDS: Readonly<
	Record<string, Readonly<Record<string, ConsentTimeField | null>>>
> = {
	github: {
		contributions: null,
		events: { field: "created_at", format: "date-time" },
		gists: { field: "created_at", format: "date-time" },
		issues: { field: "created_at", format: "date-time" },
		organizations: null,
		pinned_repositories: null,
		pull_requests: { field: "created_at", format: "date-time" },
		repositories: { field: "created_at", format: "date-time" },
		starred: { field: "starred_at", format: "date-time" },
		user: { field: "created_at", format: "date-time" },
		user_stats: null,
	},
};

export const CHECKPOINT_PARENTS: Readonly<
	Record<string, Readonly<Record<string, readonly string[]>>>
> = {
	github: {},
};
