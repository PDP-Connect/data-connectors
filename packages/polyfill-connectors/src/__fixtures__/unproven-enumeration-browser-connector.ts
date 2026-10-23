// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Test-only entry: a real isolated browser run through `runConnector` that
// emits the supplied messages and then returns normally, so a test sees what
// the runtime keeps of a run whose only failure is a reported stream failure.
import type { EmittedMessage } from "@pdpp/connector-protocol";
import { runConnector } from "../connector-runtime.ts";

const messages = JSON.parse(
	process.env.PDPP_TEST_MESSAGES ?? "[]",
) as EmittedMessage[];

runConnector({
	name: "unproven-enumeration-browser-fixture",
	browser: {},
	collect: (ctx) =>
		messages.reduce(
			(done, message) => done.then(() => ctx.emit(message)),
			Promise.resolve(),
		),
});
