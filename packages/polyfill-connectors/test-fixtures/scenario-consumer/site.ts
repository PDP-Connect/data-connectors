// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { createServer } from "node:http";
import { DEFAULT_BASE_URL, fixturePage } from "./data.ts";

const baseUrl = process.env.PDPP_SCENARIO_CONSUMER_BASE_URL ?? DEFAULT_BASE_URL;
const base = new URL(baseUrl);
if (base.hostname !== "127.0.0.1") {
	throw new Error("the scenario consumer fixture site must bind to 127.0.0.1");
}

const server = createServer((request, response) => {
	const url = new URL(request.url ?? "/", base);
	if (request.method === "GET" && url.pathname === "/") {
		response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		response.end(
			"<!doctype html><html><head><title>Scenario consumer fixture</title><link rel=\"icon\" href=\"data:,\"></head>" +
				"<body><main><h1>Local reference data</h1><p>Public sample records for offline replay.</p></main></body></html>",
		);
		return;
	}
	if (request.method === "GET" && url.pathname === "/api/items") {
		response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
		response.end(JSON.stringify(fixturePage(url)));
		return;
	}
	response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
	response.end("not found");
});

server.listen(Number(base.port), "127.0.0.1", () => {
	process.stdout.write(`scenario consumer fixture site: ${base.origin}\n`);
});
