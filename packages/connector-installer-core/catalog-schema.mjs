// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import Ajv2020 from "ajv/dist/2020.js";
import schema from "./catalog-schema-data.mjs";

export function isCatalogTimestamp(value) {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) {
    return false;
  }
  const [year, month, day, hour, minute, second, offsetHour, offsetMinute] = [
    match[1], match[2], match[3], match[4], match[5], match[6], match[8] ?? "0", match[9] ?? "0",
  ].map(Number);
  if (
    year === 0 || month < 1 || month > 12 || day < 1 ||
    day > new Date(Date.UTC(year, month, 0)).getUTCDate() ||
    hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59
  ) {
    return false;
  }
  return Number.isFinite(Date.parse(value));
}

function isUri(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol.length > 1;
  } catch {
    return false;
  }
}

const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addFormat("date-time", { type: "string", validate: isCatalogTimestamp });
ajv.addFormat("uri", { type: "string", validate: isUri });
const validateCatalog = ajv.compile(schema);

export function assertCatalog(catalog) {
  if (!validateCatalog(catalog)) {
    const detail = ajv.errorsText(validateCatalog.errors, { separator: "; " });
    throw new Error(`connector catalog does not match its schema: ${detail}`);
  }
  const connectorKeys = new Set();
  for (const connector of catalog.connectors) {
    if (connectorKeys.has(connector.connector_key)) {
      throw new Error(`connector catalog repeats connector_key '${connector.connector_key}'`);
    }
    connectorKeys.add(connector.connector_key);
    const latestVersion = connector.versions.at(-1);
    if (
      latestVersion.version !== connector.latest.version ||
      latestVersion.digest !== connector.latest.digest
    ) {
      throw new Error(
        `connector catalog latest entry for '${connector.connector_key}' must match the last version`,
      );
    }
  }
  return catalog;
}
