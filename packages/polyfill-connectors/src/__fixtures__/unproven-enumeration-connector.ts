// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Test-only entry: runs the real runtime and emits the messages the test
// supplies, in order, so a conformance test sees exactly what reaches the wire.
import type { EmittedMessage } from "@pdpp/connector-protocol";
import { runConnector } from "../connector-runtime.ts";

const messages = JSON.parse(
	process.env.PDPP_TEST_MESSAGES ?? "[]",
) as EmittedMessage[];

runConnector({
	name: "unproven-enumeration-fixture",
	collect: (ctx) =>
		messages.reduce(
			(done, message) => done.then(() => ctx.emit(message)),
			Promise.resolve(),
		),
});
