// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import childProcess from "node:child_process";
import dgram from "node:dgram";
// Loaded only in the controlled submission fixture subprocess. This guard is
// not an OS sandbox for hostile code; it prevents accidental live collection.
import { appendFileSync, readFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";

const config = JSON.parse(
	readFileSync(process.env.SUBMISSION_FIXTURE_CONFIG, "utf8"),
);
const record = (value) =>
	appendFileSync(config.observations, `${JSON.stringify(value)}\n`);
const refuse = () => {
	record({ forbidden: true });
	throw new Error("submission fixture forbids sockets and subprocesses");
};
net.Socket.prototype.connect = refuse;
dgram.createSocket = refuse;
for (const name of [
	"spawn",
	"spawnSync",
	"exec",
	"execSync",
	"execFile",
	"execFileSync",
	"fork",
]) {
	childProcess[name] = refuse;
}
syncBuiltinESMExports();

function canonical(value) {
	const url = new URL(value);
	url.searchParams.sort();
	return url.href;
}
let requests = 0;
globalThis.fetch = async (input, init) => {
	if (++requests > 200) return refuse();
	const request =
		input instanceof Request && init === undefined
			? input
			: new Request(input, init);
	const index = config.responses.findIndex(
		(route) =>
			canonical(route.url) === canonical(request.url) &&
			request.method === "GET",
	);
	record({ route: index });
	if (index < 0) throw new Error("unmatched submission fixture request");
	const route = config.responses[index];
	return Response.json(route.body, { status: route.status ?? 200 });
};
