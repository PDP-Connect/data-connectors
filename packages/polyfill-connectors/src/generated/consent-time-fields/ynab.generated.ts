// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// GENERATED FILE — do not hand-edit. Produced by
// scripts/generate-consent-time-fields.ts from connectors/ynab/manifest.json
// alone. A built ynab artifact resolves the consent-time-field table to
// this file, so editing another connector's consent fields never changes it.
// Regenerate with `node --experimental-strip-types
// scripts/generate-consent-time-fields.ts` from packages/polyfill-connectors.

import type { ConsentTimeField } from "../../time-range.ts";

export const CONSENT_BOUND_CONNECTOR: string | null = "ynab";

export const CONSENT_TIME_FIELDS: Readonly<
	Record<string, Readonly<Record<string, ConsentTimeField | null>>>
> = {
	ynab: {
		account_stats: null,
		accounts: null,
		budgets: null,
		categories: null,
		category_groups: null,
		month_categories: null,
		months: null,
		payee_locations: null,
		payees: null,
		scheduled_transactions: null,
		transactions: null,
	},
};
