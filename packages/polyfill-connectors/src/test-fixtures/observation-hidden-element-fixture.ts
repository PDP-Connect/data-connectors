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
 * connector whose manifest lists it would. NOT a production connector.
 */

import type { Locator } from "playwright";
import { waitForElementExpectation } from "../auto-login/locator-helpers.ts";
import { runConnector } from "../connector-runtime.ts";
import { withObservationBasis } from "../observation.ts";

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
