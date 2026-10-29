// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

export const ISSUER = "https://token.actions.githubusercontent.com";
export const JWKS_URL = `${ISSUER}/.well-known/jwks`;
export const WORKFLOW =
  "PDP-Connect/data-connectors/.github/workflows/publish-polyfill-connectors.yml@refs/heads/main";
export const REPOSITORY = "ghcr.io/pdp-connect/connector-catalog";
export const OWNER_ID = "306241814";
export const REPOSITORY_ID = "1304197983";
export const SUBJECT = `repo:PDP-Connect@${OWNER_ID}/data-connectors@${REPOSITORY_ID}:ref:refs/heads/main`;
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
export function httpsURL(value) {
  if (typeof value !== "string" || value.length > 2048) throw new Error("missing URL");
  const u = new URL(value);
  if (u.protocol !== "https:" || u.username || u.password || u.hash || u.search)
    throw new Error("invalid HTTPS URL");
  return u.href;
}
export function configuration(env) {
  const topic = httpsURL(env.TOPIC_URL),
    hub = httpsURL(env.HUB_URL);
  if (
    new URL(topic).pathname !== "/topic" ||
    topic === hub ||
    typeof env.OIDC_AUDIENCE !== "string" ||
    env.OIDC_AUDIENCE.length < 8 ||
    env.OIDC_AUDIENCE.length > 200 ||
    /SET_|CHANGE|\s/.test(env.OIDC_AUDIENCE) ||
    !env.PUBLISHER
  ) {
    throw new Error("invalid publisher configuration");
  }
  return { topic, hub, audience: env.OIDC_AUDIENCE };
}
