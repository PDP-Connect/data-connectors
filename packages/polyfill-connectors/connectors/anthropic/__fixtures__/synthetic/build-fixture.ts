// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Regenerates synthetic-export.zip — a hand-authored, CLEARLY SYNTHETIC
 * fixture shaped like the official Claude data export ZIP (see README.md in
 * this directory for what it proves and does not prove).
 *
 * Run: node --import tsx connectors/anthropic/__fixtures__/synthetic/build-fixture.ts
 */

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

interface BuildZipFile {
	content: Buffer;
	name: string;
}

// Minimal ZIP writer (STORE-free, DEFLATE-only), same layout as the shared
// test helper in src/bounded-zip-archive.test.ts — kept local here so this
// fixture-generation script has no dependency on test-only exports.
function buildZip(files: BuildZipFile[]): Buffer {
	const localParts: Buffer[] = [];
	const centralParts: Buffer[] = [];
	let offset = 0;

	for (const file of files) {
		const nameBuf = Buffer.from(file.name, "utf8");
		const contentBuf = file.content;
		const compressed = deflateRawSync(contentBuf);

		const localHeader = Buffer.alloc(30);
		localHeader.writeUInt32LE(0x04_03_4b_50, 0);
		localHeader.writeUInt16LE(20, 4);
		localHeader.writeUInt16LE(0x08_00, 6);
		localHeader.writeUInt16LE(8, 8);
		localHeader.writeUInt16LE(0, 10);
		localHeader.writeUInt16LE(0, 12);
		localHeader.writeUInt32LE(0, 14);
		localHeader.writeUInt32LE(compressed.length, 18);
		localHeader.writeUInt32LE(contentBuf.length, 22);
		localHeader.writeUInt16LE(nameBuf.length, 26);
		localHeader.writeUInt16LE(0, 28);

		const localEntry = Buffer.concat([localHeader, nameBuf, compressed]);
		localParts.push(localEntry);

		const centralHeader = Buffer.alloc(46);
		centralHeader.writeUInt32LE(0x02_01_4b_50, 0);
		centralHeader.writeUInt16LE(20, 4);
		centralHeader.writeUInt16LE(20, 6);
		centralHeader.writeUInt16LE(0x08_00, 8);
		centralHeader.writeUInt16LE(8, 10);
		centralHeader.writeUInt16LE(0, 12);
		centralHeader.writeUInt16LE(0, 14);
		centralHeader.writeUInt32LE(0, 16);
		centralHeader.writeUInt32LE(compressed.length, 20);
		centralHeader.writeUInt32LE(contentBuf.length, 24);
		centralHeader.writeUInt16LE(nameBuf.length, 28);
		centralHeader.writeUInt16LE(0, 30);
		centralHeader.writeUInt16LE(0, 32);
		centralHeader.writeUInt16LE(0, 34);
		centralHeader.writeUInt16LE(0, 36);
		centralHeader.writeUInt32LE(0, 38);
		centralHeader.writeUInt32LE(offset, 42);

		centralParts.push(Buffer.concat([centralHeader, nameBuf]));
		offset += localEntry.length;
	}

	const centralDirStart = offset;
	const centralDir = Buffer.concat(centralParts);
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06_05_4b_50, 0);
	eocd.writeUInt16LE(0, 4);
	eocd.writeUInt16LE(0, 6);
	eocd.writeUInt16LE(files.length, 8);
	eocd.writeUInt16LE(files.length, 10);
	eocd.writeUInt32LE(centralDir.length, 12);
	eocd.writeUInt32LE(centralDirStart, 16);
	eocd.writeUInt16LE(0, 20);

	return Buffer.concat([...localParts, centralDir, eocd]);
}

const conversations = [
	{
		uuid: "syn-conv-0000-0000-0000-000000000001",
		name: "Synthetic trip planning",
		created_at: "2026-01-01T00:00:00.000Z",
		updated_at: "2026-01-02T00:00:00.000Z",
		is_starred: true,
		project_uuid: "syn-proj-0000-0000-0000-000000000001",
		chat_messages: [
			{
				uuid: "syn-msg-0000-0000-0000-000000000002",
				sender: "assistant",
				parent_message_uuid: "syn-msg-0000-0000-0000-000000000001",
				created_at: "2026-01-01T00:01:00.000Z",
				updated_at: "2026-01-01T00:01:00.000Z",
				content: [{ type: "text", text: "Synthetic reply text." }],
				attachments: [],
			},
			{
				uuid: "syn-msg-0000-0000-0000-000000000001",
				sender: "human",
				parent_message_uuid: null,
				created_at: "2026-01-01T00:00:00.000Z",
				updated_at: "2026-01-01T00:00:00.000Z",
				content: [{ type: "text", text: "Synthetic prompt text." }],
				attachments: [],
			},
		],
	},
	{
		uuid: "syn-conv-0000-0000-0000-000000000002",
		name: null,
		summary: "Untitled fallback conversation",
		created_at: "2026-02-01T00:00:00.000Z",
		updated_at: null,
		is_starred: false,
		project_uuid: null,
		chat_messages: [],
	},
];

const project1 = {
	uuid: "syn-proj-0000-0000-0000-000000000001",
	name: "Synthetic project",
	created_at: "2025-05-30T00:00:00.000Z",
	updated_at: "2025-06-01T00:00:00.000Z",
	archived_at: null,
	prompt_template: "You are a synthetic assistant for testing.",
	docs: [
		{
			uuid: "syn-doc-0000-0000-0000-000000000001",
			filename: "synthetic-notes.md",
			content: "Synthetic project document body.",
			created_at: "2025-05-30T00:00:00.000Z",
			updated_at: "2025-05-30T00:00:00.000Z",
		},
	],
};

const project2 = {
	uuid: "syn-proj-0000-0000-0000-000000000002",
	name: "Archived synthetic project",
	created_at: "2024-01-01T00:00:00.000Z",
	updated_at: "2024-06-01T00:00:00.000Z",
	archived_at: "2024-06-01T00:00:00.000Z",
	docs: [],
};

const zip = buildZip([
	{
		content: Buffer.from(JSON.stringify(conversations), "utf8"),
		name: "conversations.json",
	},
	{
		content: Buffer.from(JSON.stringify(project1), "utf8"),
		name: `projects/${project1.uuid}.json`,
	},
	{
		content: Buffer.from(JSON.stringify(project2), "utf8"),
		name: `projects/${project2.uuid}.json`,
	},
]);

const outPath = fileURLToPath(
	new URL("./synthetic-export.zip", import.meta.url),
);
writeFileSync(outPath, zip);
console.log(`wrote ${outPath} (${zip.length} bytes)`);
