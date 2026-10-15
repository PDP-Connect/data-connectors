// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// GENERATED FILE — do not hand-edit. Produced by
// scripts/generate-consent-time-fields.ts from connectors/youtube_takeout/manifest.json
// alone. A built youtube_takeout artifact resolves the consent-time-field table to
// this file, so editing another connector's consent fields never changes it.
// Regenerate with `node --experimental-strip-types
// scripts/generate-consent-time-fields.ts` from packages/polyfill-connectors.

import type { ConsentTimeField } from "../../time-range.ts";

export const CONSENT_BOUND_CONNECTOR: string | null = "youtube_takeout";

export const CONSENT_TIME_FIELDS: Readonly<
	Record<string, Readonly<Record<string, ConsentTimeField | null>>>
> = {
	youtube_takeout: {
		likes: null,
		playlist_items: null,
		playlists: null,
		profile: null,
		subscriptions: null,
		watch_history: { field: "watched_at", format: "date-time" },
		watch_later: null,
	},
};
