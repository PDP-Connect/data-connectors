// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pure parsers for the Venmo connector. Kept free of fetch / Node I/O so
// they can be unit-tested in isolation (see parsers.test.ts). The HTTP
// client, login handshake, and pagination loops live in index.ts.

import type { RecordData } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import type { VenmoStory, VenmoUser } from "./types.ts";

export const API_BASE = "https://api.venmo.com/v1";

const ZONELESS_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/;

/** Venmo's zone-less API timestamps are treated as UTC; preserve their fractional precision. */
export function normalizeVenmoDate(
	value: string | null | undefined,
): string | null {
	if (value == null) {
		return null;
	}
	return ZONELESS_DATETIME_RE.test(value) ? `${value}Z` : value;
}

/** Venmo's `amount` is a float in major units (dollars); PDPP records integer cents. */
export function dollarsToCents(
	amount: number | null | undefined,
): number | null {
	if (typeof amount !== "number" || !Number.isFinite(amount)) {
		return null;
	}
	return Math.round(amount * 100);
}

export function userRecord(u: VenmoUser): RecordData {
	return {
		id: u.id,
		username: u.username ?? null,
		first_name: u.first_name ?? null,
		last_name: u.last_name ?? null,
		display_name: u.display_name ?? null,
		phone: u.phone ?? null,
		profile_picture_url: u.profile_picture_url ?? null,
		about: u.about ?? null,
		date_joined: normalizeVenmoDate(u.date_joined),
		is_group: u.is_group ?? null,
		is_active: u.is_active ?? null,
	};
}

export function profileRecord(u: VenmoUser): RecordData {
	return {
		id: u.id,
		username: u.username ?? null,
		first_name: u.first_name ?? null,
		last_name: u.last_name ?? null,
		display_name: u.display_name ?? null,
		phone: u.phone ?? null,
		profile_picture_url: u.profile_picture_url ?? null,
		about: u.about ?? null,
		date_joined: normalizeVenmoDate(u.date_joined),
		is_business: u.is_business ?? null,
	};
}

function counterpartyRecord(
	u: VenmoUser | null | undefined,
): RecordData | null {
	if (!u?.id) {
		return null;
	}
	return {
		id: u.id,
		username: u.username ?? null,
		display_name: u.display_name ?? null,
	};
}

/**
 * Transaction ("story") record. `ownerId` is the authenticated profile's own
 * id, used only to derive `is_owner_actor` — never persisted as a foreign
 * concept in the schema beyond that one boolean.
 *
 * Returns `unsupported` for story types this connector does not model (refunds,
 * bank transfers, top-ups, card authorizations/withdrawals, disbursements —
 * see venmo_api/models/transaction.py's TransactionType enum). Those never
 * carry a `payment` object in the documented shape, so they cannot be
 * represented by this schema without inventing fields; skipping them is
 * honest non-support, not data loss of a stream we claim to cover.
 */
export function parseTransactionStory(
	story: VenmoStory,
	ownerId: string,
):
	| { kind: "record"; record: RecordData }
	| { kind: "unsupported" }
	| { kind: "invalid"; reason: "missing_id" | "missing_date_created" } {
	const { payment } = story;
	if (!payment) {
		return { kind: "unsupported" };
	}
	const actionRaw = payment.action;
	if (actionRaw !== "pay" && actionRaw !== "charge") {
		return { kind: "unsupported" };
	}
	if (typeof story.id !== "string" || story.id.length === 0) {
		return { kind: "invalid", reason: "missing_id" };
	}
	const { date_created: dateCreated } = story;
	if (!dateCreated) {
		return { kind: "invalid", reason: "missing_date_created" };
	}
	return {
		kind: "record",
		record: {
			id: story.id,
			payment_id: payment.id ?? null,
			date_created: normalizeVenmoDate(dateCreated),
			date_updated: normalizeVenmoDate(story.date_updated),
			date_completed: normalizeVenmoDate(payment.date_completed),
			payment_type: actionRaw,
			amount_cents: dollarsToCents(payment.amount),
			audience: story.audience ?? null,
			status: payment.status ?? null,
			note: payment.note ?? null,
			device_used: story.app?.name ?? null,
			actor: counterpartyRecord(payment.actor),
			target: counterpartyRecord(payment.target?.user),
			is_owner_actor: payment.actor?.id === ownerId,
		},
	};
}
