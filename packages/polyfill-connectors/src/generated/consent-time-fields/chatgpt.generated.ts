// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// GENERATED FILE — do not hand-edit. Produced by
// scripts/generate-consent-time-fields.ts from connectors/chatgpt/manifest.json
// alone. A built chatgpt artifact resolves the consent-time-field table to
// this file, so editing another connector's consent fields never changes it.
// Regenerate with `node --experimental-strip-types
// scripts/generate-consent-time-fields.ts` from packages/polyfill-connectors.

import type { ConsentTimeField } from "../../time-range.ts";

export const CONSENT_BOUND_CONNECTOR: string | null = "chatgpt";

export const CONSENT_TIME_FIELDS: Readonly<
	Record<string, Readonly<Record<string, ConsentTimeField | null>>>
> = {
	chatgpt: {
		account_plan: null,
		conversations: { field: "update_time", format: "date-time" },
		custom_gpts: { field: "created_at", format: "date-time" },
		custom_instructions: { field: "updated_at", format: "date-time" },
		memories: { field: "created_at", format: "date-time" },
		messages: { field: "create_time", format: "date-time" },
		shared_conversations: { field: "created_at", format: "date-time" },
	},
};

export const CHECKPOINT_PARENTS: Readonly<
	Record<string, Readonly<Record<string, readonly string[]>>>
> = {
	chatgpt: {},
};
