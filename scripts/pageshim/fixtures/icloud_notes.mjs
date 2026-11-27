// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { gzipSync, deflateSync, deflateRawSync } from "node:zlib";
const json = (value, status = 200) => ({
	status, contentType: "application/json", body: JSON.stringify(value),
	headers: { "access-control-allow-origin": "https://www.icloud.com", "access-control-allow-credentials": "true" },
});
let loggedIn = true;
export const setLoggedIn = (value) => { loggedIn = value; };
export const bodyText = "Synthetic iCloud note: café and prose text.";
// A note body is a protobuf Document: field 2 holds { 2: version, 3: Note { 2: text } }.
const lengthDelimited = (fieldNumber, value) =>
	Buffer.concat([Buffer.from([(fieldNumber << 3) | 2, value.length]), value]);
const noteBody = lengthDelimited(2, Buffer.concat([
	Buffer.from([0x10, 0x03]),
	lengthDelimited(3, lengthDelimited(2, Buffer.from(bodyText))),
]));
const notes = [gzipSync, deflateSync, deflateRawSync].map((compress, index) => ({
	recordName: "note-" + index, recordType: "Note",
	fields: {
		TitleEncrypted: { value: Buffer.from("Synthetic " + index).toString("base64") },
		TextDataEncrypted: { value: compress(noteBody).toString("base64") },
		Folder: { value: { recordName: "folder-1" } },
	},
}));
export function resolveFixture(raw, request) {
	const url = new URL(raw);
	if (url.hostname === "setup.icloud.com") return json(loggedIn ? {
		dsInfo: { dsid: "12345", fullName: "Synthetic Owner" },
		webservices: { ckdatabasews: { url: "https://p00-ckdatabasews.icloud.com" } },
	} : { error: "unauthorized" }, loggedIn ? 200 : 401);
	if (url.hostname === "p00-ckdatabasews.icloud.com") {
		if (!loggedIn) return json({ error: "unauthorized" }, 401);
		const body = JSON.parse(typeof request?.postData === "function" ? request.postData() : request?.postData ?? "{}");
		const index = body.query?.filterBy?.[0]?.fieldValue?.value;
		return json({ records: index === "parentless" ? [{
			recordName: "folder-1", recordType: "Folder",
			fields: { TitleEncrypted: { value: Buffer.from("Work").toString("base64") } },
		}] : notes });
	}
	return { status: 200, contentType: "text/html", body: "<!doctype html><html><body>Notes</body></html>" };
}
export const icloudNotesFixtures = {
	hosts: /^https:\/\/([a-z0-9-]+\.)?icloud\.com\//,
	resolve: resolveFixture, setLoggedIn,
	loginUrl: "https://www.icloud.com/notes", homeUrl: "https://www.icloud.com/notes",
};
export const pageshimCase = {
	fixtures: icloudNotesFixtures,
	scopes: ["icloud_notes.profile", "icloud_notes.notes", "icloud_notes.folders"],
	exportSummary: { count: 5, label: "items", details: "5 iCloud items" },
	emptyExportSummary: { count: 0, label: "items", details: "0 iCloud items" },
};
