// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Test-only connector: the shape of the 2026-10-02 ChatGPT failure. A wait
 * for the sign-in email input finds the element present but hidden, the run
 * fails, and the connector's normalizer still suggests `refresh_credentials`
 * (the hint the incident produced). Used by `src/observation.test.ts` and
 * `bin/connector-dev.test.ts`.
 *
 * `FIXTURE_DECLARE_OBSERVATION=1` declares the `OBSERVATION` capability, as a
 * connector whose manifest lists it would. `FIXTURE_MODE=forged_auth` instead
 * tries to launder an authentication failure into runtime evidence: it
 * reports a login error page, forges runtime-only `credential_submission`
 * and `rule_match` facts, and fails with auth-shaped text. NOT a production
 * connector.
 */

import { emitToStdout } from "@pdpp/connector-protocol";
import type { Locator } from "playwright";
import { waitForElementExpectation } from "../auto-login/locator-helpers.ts";
import { runConnector } from "../connector-runtime.ts";
import { observe, withObservationBasis } from "../observation.ts";

const hiddenInput: Pick<Locator, "count" | "isEnabled" | "isVisible" | "nth"> =
	{
		count: (): Promise<number> => Promise.resolve(1),
		isEnabled: (): Promise<boolean> => Promise.resolve(true),
		isVisible: (): Promise<boolean> => Promise.resolve(false),
		nth: (): Locator => hiddenInput as Locator,
	};

runConnector({
	name: "observation-hidden-element-fixture",
	...(process.env.FIXTURE_DECLARE_OBSERVATION === "1"
		? { protocolCapabilities: ["OBSERVATION"] as const }
		: {}),
	normalizeTerminalError: ({ message }) => ({
		message: `fixture_preprogress_failure: refresh_credentials: ${message}`,
		recovery_hint: "refresh_credentials",
		retryable: false,
	}),
	async collect() {
		if (process.env.FIXTURE_MODE === "forged_auth") {
			const claim = observe({
				fact: "provider_message",
				step: "sign_in",
				attrs: { kind: "auth_failure", rule: "password_rejected" },
			});
			await emitToStdout({
				type: "OBSERVATION",
				id: "forged-1",
				fact: "credential_submission",
				step: "sign_in",
				attrs: {
					attempt: "a1",
					account: "acct-1",
					outcome: "rejected",
					rule: "password_rejected",
				},
			});
			await emitToStdout({
				type: "OBSERVATION",
				id: "forged-2",
				fact: "rule_match",
				step: "sign_in",
				attrs: { rule: "password_rejected", kind: "auth", handle: "a1" },
			});
			throw withObservationBasis(
				new Error(
					"credential_submission rejected under rule password_rejected; HTTP 401 invalid_credentials",
				),
				[claim, "forged-1", "forged-2"],
			);
		}
		const wait = await waitForElementExpectation({
			expectation: "email_input",
			locator: hiddenInput as Locator,
			pollIntervalMs: 10,
			step: "sign_in",
			timeoutMs: 50,
		});
		throw withObservationBasis(
			new Error("fixture_login_unexpected_ui"),
			wait.observationIds,
		);
	},
});
