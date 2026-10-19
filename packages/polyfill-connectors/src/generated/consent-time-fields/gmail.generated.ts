// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// GENERATED FILE — do not hand-edit. Produced by
// scripts/generate-consent-time-fields.ts from connectors/gmail/manifest.json
// alone. A built gmail artifact resolves the consent-time-field table to
// this file, so editing another connector's consent fields never changes it.
// Regenerate with `node --experimental-strip-types
// scripts/generate-consent-time-fields.ts` from packages/polyfill-connectors.

import type { ConsentTimeField } from "../../time-range.ts";

export const CONSENT_BOUND_CONNECTOR: string | null = "gmail";

export const CONSENT_TIME_FIELDS: Readonly<
	Record<string, Readonly<Record<string, ConsentTimeField | null>>>
> = {
	gmail: {
		attachments: { field: "message_received_at", format: "date-time" },
		labels: null,
		message_bodies: { field: "message_received_at", format: "date-time" },
		messages: { field: "received_at", format: "date-time" },
		threads: { field: "first_message_date", format: "date-time" },
	},
};
