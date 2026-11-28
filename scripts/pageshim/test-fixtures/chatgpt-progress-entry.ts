// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import "../entries/chatgpt.ts";
import { process } from "../shims/process.js";

// Use the connector's existing opt-in concurrency probe in the fixture.
// The production entry continues to serve the request and emit all packets.
Object.assign(
	process.env,
	(globalThis as { __pageshimEnv?: Record<string, string> }).__pageshimEnv,
);
