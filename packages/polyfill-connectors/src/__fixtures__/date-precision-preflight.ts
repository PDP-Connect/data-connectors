// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { runConnector } from "../connector-runtime.ts";

runConnector({
	name: "date-precision-preflight-fixture",
	unsupportedTimeRangeStreams: ["events"],
	collect: () => Promise.reject(new Error("collection must not start")),
});
