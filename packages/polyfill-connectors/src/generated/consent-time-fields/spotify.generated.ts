// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// GENERATED FILE — do not hand-edit. Produced by
// scripts/generate-consent-time-fields.ts from connectors/spotify/manifest.json
// alone. A built spotify artifact resolves the consent-time-field table to
// this file, so editing another connector's consent fields never changes it.
// Regenerate with `node --experimental-strip-types
// scripts/generate-consent-time-fields.ts` from packages/polyfill-connectors.

import type { ConsentTimeField } from "../../time-range.ts";

export const CONSENT_BOUND_CONNECTOR: string | null = "spotify";

export const CONSENT_TIME_FIELDS: Readonly<
	Record<string, Readonly<Record<string, ConsentTimeField | null>>>
> = {
	spotify: {
		playlist_items: { field: "added_at", format: "date-time" },
		playlists: null,
		profile: null,
		recently_played_contexts: null,
		saved_tracks: { field: "added_at", format: "date-time" },
		top_artists: null,
		top_tracks: null,
	},
};
