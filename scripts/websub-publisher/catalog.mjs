// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { REPOSITORY, HttpError } from "./config.mjs";
export function readyRecord(x) {
  if (
    !x ||
    Array.isArray(x) ||
    typeof x !== "object" ||
    Object.keys(x).sort().join(",") !== "digest,generated_at,repository,schema,source_commit" ||
    x.schema !== "pdpp.catalog.ready.v1" ||
    x.repository !== REPOSITORY ||
    typeof x.digest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(x.digest) ||
    typeof x.source_commit !== "string" ||
    !/^[0-9a-f]{40}$/.test(x.source_commit) ||
    typeof x.generated_at !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(x.generated_at) ||
    !Number.isFinite(Date.parse(x.generated_at)) ||
    new Date(x.generated_at).toISOString() !== x.generated_at
  ) {
    throw new HttpError(400, "invalid ready declaration");
  }
  return {
    schema: x.schema,
    repository: x.repository,
    digest: x.digest,
    source_commit: x.source_commit,
    generated_at: x.generated_at,
  };
}
const escape = (s) =>
  String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
export function atom(record, { topic, hub }) {
  const updated = record?.generated_at ?? "1970-01-01T00:00:00.000Z";
  const entry = record
    ? `<entry><id>urn:pdpp:connector-catalog:${record.digest}</id><title>Signed connector catalog</title><updated>${escape(updated)}</updated><content type="text">${escape(JSON.stringify(record))}</content></entry>`
    : "";
  return `<?xml version="1.0" encoding="utf-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom"><id>${escape(topic)}</id><title>PDPP connector catalog</title><author><name>PDP-Connect</name></author><updated>${escape(updated)}</updated><link rel="self" href="${escape(topic)}"/><link rel="hub" href="${escape(hub)}"/>${entry}</feed>`;
}
