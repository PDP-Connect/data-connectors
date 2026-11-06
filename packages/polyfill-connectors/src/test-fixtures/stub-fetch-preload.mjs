// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Test-only `--import` preload. It answers `fetch` from a route table so a
// connector subprocess can run a full collection with no network. The table
// is a JSON array in the STUB_FETCH_ROUTES env var:
//   [{ "prefix": "https://api.example.com/user", "status": 200,
//      "bodyFile": "/abs/path/to/recorded.json" }]
// The first route whose `prefix` starts the request URL wins. `bodyFile` is a
// recorded response body (a committed fixture). Any other request gets an
// empty JSON object with status 404.

import { readFileSync } from "node:fs";

const routes = JSON.parse(process.env.STUB_FETCH_ROUTES ?? "[]");

globalThis.fetch = async (input) => {
	const url = typeof input === "string" ? input : (input.url ?? String(input));
	const route = routes.find((r) => url.startsWith(r.prefix));
	if (route === undefined) {
		return new Response("{}", { status: 404 });
	}
	const body =
		route.bodyFile === undefined ? "{}" : readFileSync(route.bodyFile, "utf8");
	return new Response(body, {
		headers: { "content-type": "application/json" },
		status: route.status ?? 200,
	});
};
