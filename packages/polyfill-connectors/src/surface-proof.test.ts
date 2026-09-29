// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { chromium } from "playwright";
import { proveEmpty, proveIdentity } from "./surface-proof.ts";
import { runSurfaceProofConformance } from "./test-fixtures/surface-proof-conformance.ts";

runSurfaceProofConformance({ proveEmpty, proveIdentity });

test("a response body that never finishes cannot hold proof open", async () => {
	const server = createServer((request, response) => {
		if (request.url === "/surface") {
			response.writeHead(200, { "content-type": "text/html" });
			response.end("<html><body>Account</body></html>");
			return;
		}
		response.writeHead(200, { "content-type": "application/json" });
		response.flushHeaders();
		response.write('{"data":');
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const browser = await chromium.launch({ headless: true });
	const page = await browser.newPage();
	try {
		const result = await proveEmpty({
			page,
			expectedOwner: "owner-1",
			surface: {
				kind: "network",
				pageUrl: /^http:\/\/127\.0\.0\.1:\d+\/surface$/,
				responseUrl: /^http:\/\/127\.0\.0\.1:\d+\/api$/,
				ownerPath: ["data", "owner", "id"],
				itemsPath: ["data", "items"],
				pagination: { kind: "single-page" },
			},
			navigate: async () => {
				await page.goto(`http://127.0.0.1:${address.port}/surface`);
				await page.evaluate(() => fetch("/api", { method: "POST" }));
			},
		});
		assert.deepEqual(result, { proven: false, reason: "surface_timeout" });
	} finally {
		await page.close();
		await browser.close();
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});
