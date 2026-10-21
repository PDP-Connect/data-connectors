// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Test-only entry: runs the real runtime and emits the messages the test
// supplies, in order, so a conformance test sees exactly what reaches the wire.
// A `REPORT_STREAM_FAILURE` entry calls `ctx.reportStreamFailure` instead.
import type { EmittedMessage } from "@pdpp/connector-protocol";
import {
	runConnector,
	type StreamFailureOptions,
} from "../connector-runtime.ts";

type FixtureStep =
	| EmittedMessage
	| {
			type: "REPORT_STREAM_FAILURE";
			stream: string;
			message: string;
			options?: StreamFailureOptions;
	  };

const steps = JSON.parse(
	process.env.PDPP_TEST_MESSAGES ?? "[]",
) as FixtureStep[];

runConnector({
	name: "unproven-enumeration-fixture",
	collect: (ctx) =>
		steps.reduce(
			(done, step) =>
				done.then(() =>
					step.type === "REPORT_STREAM_FAILURE"
						? ctx.reportStreamFailure?.(step.stream, step.message, step.options)
						: ctx.emit(step),
				),
			Promise.resolve(),
		),
});
