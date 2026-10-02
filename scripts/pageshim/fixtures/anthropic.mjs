// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Serves claude.ai and a signed-storage host for the pageshim harness. The
// export archive is connectors/anthropic/__fixtures__/synthetic/
// synthetic-export.zip (old single-archive format). `setArchive` swaps in
// another archive, e.g. one whose layout the connector does not recognize.

import { readFileSync } from "node:fs";
import { deflateRawSync } from "node:zlib";

export const syntheticExport = readFileSync(
	new URL(
		"../../../connectors/anthropic/__fixtures__/synthetic/synthetic-export.zip",
		import.meta.url,
	),
);

export const ORG = "org-syn-0000-0000-0000-000000000001";
export const NONCE = "nonce-syn-0001";
const SIGNED = "https://storage.claude-export.test/export.zip?sig=synthetic";

let loggedIn = true;
let archive = syntheticExport;
/** Mint refusals (404) to give before the signed URL is issued. */
let mintRefusals = 0;
/** Mint error body, e.g. a spent nonce; null issues the signed URL. */
let mintError = null;
let mintErrorStatus = 410;
/** Nonces whose mint Claude refuses as already used. */
let spent = new Set();
/** "old": export_data returns {nonce}. "new": a multi-part manifest. */
let format = "old";
export const counts = { exportRequests: 0, mints: 0 };

export const setLoggedIn = (v) => {
	loggedIn = v;
};
export function reset({
	zip = syntheticExport,
	notReadyPolls = 0,
	mintFailure = null,
	mintFailureStatus = 410,
	spentNonces = [],
	exportFormat = "old",
} = {}) {
	archive = zip;
	mintRefusals = notReadyPolls;
	mintError = mintFailure;
	mintErrorStatus = mintFailureStatus;
	spent = new Set(spentNonces);
	format = exportFormat;
	counts.exportRequests = 0;
	counts.mints = 0;
}

const json = (v, status = 200) => ({
	status,
	contentType: "application/json",
	body: JSON.stringify(v),
});
const html = (body) => ({
	status: 200,
	contentType: "text/html; charset=utf-8",
	body: `<!doctype html><html><body>${body}</body></html>`,
});

export function resolveFixture(raw) {
	const url = new URL(raw);
	const p = url.pathname;
	if (url.hostname === "storage.claude-export.test")
		return { status: 200, contentType: "application/zip", body: archive };
	if (p === "/login") return html('<form><input name="email"></form>');
	if (!p.startsWith("/api/"))
		return html(
			loggedIn
				? '<button data-testid="user-menu-button"><span>Sample User</span><span>Pro plan</span></button>'
				: '<a href="/login">Log in</a>',
		);
	if (!loggedIn) return json({ error: "unauthorized" }, 401);
	if (p === "/api/organizations")
		return json([{ uuid: ORG, capabilities: ["chat"] }]);
	if (p === `/api/organizations/${ORG}/export_data`) {
		counts.exportRequests += 1;
		if (format === "new")
			return json({
				version: "1",
				total_files: 1,
				data_files: [
					{
						batch_index: 0,
						category: "conversations",
						part: 1,
						filename: "conversations-1.zip",
						export_url: SIGNED,
					},
				],
			});
		return json({ nonce: NONCE });
	}
	const mint =
		/^\/api\/organizations\/([^/]+)\/export_signed_url\/([^/]+)$/.exec(p);
	if (mint && spent.has(mint[2])) {
		counts.mints += 1;
		return json({ error: "nonce consumed" }, 404);
	}
	if (p === `/api/organizations/${ORG}/export_signed_url/${NONCE}`) {
		counts.mints += 1;
		if (mintRefusals > 0) {
			mintRefusals -= 1;
			return json({ error: "not found" }, 404);
		}
		if (mintError) return json(mintError, mintErrorStatus);
		return json({ signed_url: SIGNED });
	}
	return json({ error: "not found" }, 404);
}

/** A deflated ZIP of JSON entries, for layouts the fixture archive lacks.
 * `entries` is an object or a list of [name, value] pairs (the list form can
 * repeat a name). A Buffer value is written as the raw deflate data. */
export function zipOf(entries) {
	const locals = [];
	const centrals = [];
	let offset = 0;
	const pairs = Array.isArray(entries) ? entries : Object.entries(entries);
	for (const [name, value] of pairs) {
		const nameBytes = Buffer.from(name);
		const data = Buffer.isBuffer(value)
			? value
			: deflateRawSync(Buffer.from(JSON.stringify(value)));
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(8, 8);
		local.writeUInt32LE(data.length, 18);
		local.writeUInt16LE(nameBytes.length, 26);
		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(8, 10);
		central.writeUInt32LE(data.length, 20);
		central.writeUInt16LE(nameBytes.length, 28);
		central.writeUInt32LE(offset, 42);
		locals.push(local, nameBytes, data);
		centrals.push(central, nameBytes);
		offset += 30 + nameBytes.length + data.length;
	}
	const dir = Buffer.concat(centrals);
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(centrals.length / 2, 8);
	eocd.writeUInt16LE(centrals.length / 2, 10);
	eocd.writeUInt32LE(dir.length, 12);
	eocd.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals, dir, eocd]);
}

export const anthropicFixtures = {
	hosts: /^https:\/\/(claude\.ai|storage\.claude-export\.test)\//,
	resolve: resolveFixture,
	setLoggedIn,
	loginUrl: "https://claude.ai/login",
	homeUrl: "https://claude.ai/new",
};

const STREAMS = [
	"account_profile",
	"conversations",
	"messages",
	"projects",
	"project_documents",
];

/** What pageshim.test.mjs needs to gate anthropic. */
export const pageshimCase = {
	fixtures: anthropicFixtures,
	scopes: STREAMS.map((s) => `claude.${s}`),
	exportSummary: {
		count: 2,
		label: "conversations",
		details: {
			account_profile: 1,
			conversations: 2,
			messages: 2,
			projects: 2,
			project_documents: 1,
		},
	},
	emptyExportSummary: {
		count: 0,
		label: "conversations",
		details: Object.fromEntries(STREAMS.map((s) => [s, 0])),
	},
};
