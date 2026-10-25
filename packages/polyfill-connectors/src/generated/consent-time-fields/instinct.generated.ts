// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// GENERATED FILE — do not hand-edit. Produced by
// scripts/generate-consent-time-fields.ts from connectors/instinct/manifest.json
// alone. A built instinct artifact resolves the consent-time-field table to
// this file, so editing another connector's consent fields never changes it.
// Regenerate with `node --experimental-strip-types
// scripts/generate-consent-time-fields.ts` from packages/polyfill-connectors.

import type { ConsentTimeField } from "../../time-range.ts";

export const CONSENT_BOUND_CONNECTOR: string | null = "instinct";

export const CONSENT_TIME_FIELDS: Readonly<
	Record<string, Readonly<Record<string, ConsentTimeField | null>>>
> = {
	instinct: {
		agent_contact: { field: "observed_at", format: "date-time" },
		chat_events: { field: "created_at", format: "date-time" },
		chats: { field: "observed_at", format: "date-time" },
		connections: { field: "observed_at", format: "date-time" },
		devices: { field: "created_at", format: "date-time" },
		profile: { field: "observed_at", format: "date-time" },
		trusted_people: { field: "created_at", format: "date-time" },
		vault_entries: { field: "observed_at", format: "date-time" },
	},
};
