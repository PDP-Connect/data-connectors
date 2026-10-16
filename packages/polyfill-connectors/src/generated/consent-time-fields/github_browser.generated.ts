// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// GENERATED FILE — do not hand-edit. Produced by
// scripts/generate-consent-time-fields.ts from connectors/github_browser/manifest.json
// alone. A built github_browser artifact resolves the consent-time-field table to
// this file, so editing another connector's consent fields never changes it.
// Regenerate with `node --experimental-strip-types
// scripts/generate-consent-time-fields.ts` from packages/polyfill-connectors.

import type { ConsentTimeField } from "../../time-range.ts";

export const CONSENT_BOUND_CONNECTOR: string | null = "github_browser";

export const CONSENT_TIME_FIELDS: Readonly<
	Record<string, Readonly<Record<string, ConsentTimeField | null>>>
> = {
	github_browser: {
		contributions: null,
		events: null,
		history: null,
		profile: null,
		repositories: null,
		starred: null,
	},
};

export const CHECKPOINT_PARENTS: Readonly<
	Record<string, Readonly<Record<string, readonly string[]>>>
> = {
	github_browser: {},
};
