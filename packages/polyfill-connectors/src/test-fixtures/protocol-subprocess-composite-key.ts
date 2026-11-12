// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { runConnector } from "../connector-runtime.ts";

runConnector({
	name: "protocol-subprocess-composite-key",
	recordKeyFields: { rankings: ["id", "time_range"] },
	async collect({ emitRecord }) {
		await emitRecord("rankings", { id: "artist-1", time_range: "short_term" });
		await emitRecord("rankings", { id: "artist-1", time_range: "long_term" });
	},
});
