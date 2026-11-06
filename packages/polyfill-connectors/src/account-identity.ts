// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `ACCOUNT_IDENTITY`: the stable upstream account id (Collection Profile,
 * Sections 3.9 and 5.14). This module is the package's projection of that
 * section:
 *
 * - the message's zod schema (the JSON schema is
 *   `schemas/account-identity.schema.json`; both are checked against
 *   `schemas/fixtures/account-identity-corpus.json`);
 * - the connector-side reporter behind `reportAccountIdentity`, which
 *   writes the message once and refuses a second, different id.
 *
 * The connector passes the id exactly as the source reports it. It adds no
 * prefix, hash or namespace. A run that declares `account_identity` and ends
 * successfully without the message is failed by the host, not here.
 */

import { emitToStdout } from "@pdpp/connector-protocol";
import { z } from "zod";
import { TerminalError } from "./terminal-error.ts";

export const ACCOUNT_IDENTITY_MESSAGE_TYPE = "ACCOUNT_IDENTITY";

/** The manifest member's only value (Section 3.9). */
export const ACCOUNT_IDENTITY_MANIFEST_VALUE = "required";

export const accountIdentityMessageSchema = z.strictObject({
	type: z.literal(ACCOUNT_IDENTITY_MESSAGE_TYPE),
	account_id: z.string().regex(/^\S{1,256}$/u),
});

export type AccountIdentityMessage = z.infer<
	typeof accountIdentityMessageSchema
>;

/**
 * Converts a source-reported id to the wire string, or `undefined` when the
 * source gave no usable id. A finite integer id (a JSON number) becomes its
 * decimal digits; a `bigint` likewise. A string is passed through unchanged.
 * Everything else, including an empty string, is `undefined`. It never
 * guesses: no trimming, no case change, no prefix.
 */
export function accountIdFromSource(value: unknown): string | undefined {
	if (typeof value === "string") {
		return accountIdentityMessageSchema.shape.account_id.safeParse(value)
			.success
			? value
			: undefined;
	}
	if (typeof value === "bigint") {
		return value >= 0n ? value.toString() : undefined;
	}
	if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
		return String(value);
	}
	return undefined;
}

export type AccountIdentityReporter = (accountId: string) => Promise<void>;

/**
 * Builds the reporter behind `ctx.reportAccountIdentity`. The first valid id
 * is written once. The same id again is a no-op, so a connector that learns
 * the id on several paths can report it on each. A different id is a
 * connector defect and fails the run: two ids mean the run read two accounts.
 * An invalid id fails the run without echoing the id.
 */
export function createAccountIdentityReporter(
	write: (message: AccountIdentityMessage) => Promise<void> = (message) =>
		emitToStdout(message),
): AccountIdentityReporter {
	let reported: string | undefined;
	return async (accountId) => {
		const parsed = accountIdentityMessageSchema.safeParse({
			type: ACCOUNT_IDENTITY_MESSAGE_TYPE,
			account_id: accountId,
		});
		if (!parsed.success) {
			throw new TerminalError(
				"The connector reported an account id that is empty, has whitespace, or is longer than 256 characters",
				{ code: "account_identity_invalid" },
			);
		}
		if (reported !== undefined) {
			if (reported === parsed.data.account_id) {
				return;
			}
			throw new TerminalError(
				"The connector reported two different account ids in one run",
				{ code: "account_identity_conflict" },
			);
		}
		reported = parsed.data.account_id;
		await write(parsed.data);
	};
}

/** One reporter per process: a connector process serves one run. */
const processReporter = createAccountIdentityReporter();

/**
 * What a connector calls once it has read the account id from the source.
 * `sourceValue` is the id as the source returned it (a string or an integer).
 * Returns `true` when the id was reported (or already was). Returns `false`
 * and sends nothing when the source gave no usable id: the host then fails the
 * run, which is the honest outcome for a connector that declared
 * `account_identity` and could not learn it. A different valid id in the same
 * run, or an invalid string, throws a `TerminalError`.
 *
 * This module imports no runtime code on purpose: a connector's published
 * artifact then changes only for connectors that call it. `reporter` is for
 * tests.
 */
export async function reportAccountIdentity(
	sourceValue: unknown,
	reporter: AccountIdentityReporter = processReporter,
): Promise<boolean> {
	const accountId = accountIdFromSource(sourceValue);
	if (accountId === undefined) {
		return false;
	}
	await reporter(accountId);
	return true;
}
