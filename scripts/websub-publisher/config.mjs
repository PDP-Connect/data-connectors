// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

export const REPOSITORY = "ghcr.io/pdp-connect/connector-catalog";
export const TOPIC_URL = "https://registry.pdpp.dev/catalog/updates.atom";
export const HUB_URL = "https://websubhub.com/hub";
export function httpsURL(value) {
  if (typeof value !== "string" || value.length > 2048) throw new Error("missing URL");
  const u = new URL(value);
  if (u.protocol !== "https:" || u.username || u.password || u.hash || u.search)
    throw new Error("invalid HTTPS URL");
  return u.href;
}
