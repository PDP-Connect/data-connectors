// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { collectAllStreams, fetchWebInfoUser } from "../../../connectors/meta/index.ts";
import { profileRecord } from "../../../connectors/meta/parsers.ts";
import { validateRecord } from "../../../connectors/meta/schemas.ts";
import { runOnPageShim, type ShimPage } from "../runtime.ts";
import { applyRequestedScopeEntries } from "../requested-scope-entries.ts";

declare const PAGESHIM_CONNECTOR_VERSION: string;
declare const PAGESHIM_CONNECTOR_STREAMS: string[];
const streams = PAGESHIM_CONNECTOR_STREAMS;
(globalThis as Record<string, unknown>).__pageshimMain = (
 page: ShimPage, initialState: Record<string, unknown>, supportsState: boolean,
) => runOnPageShim(page, {
 platform: "instagram", scopes: streams.map(name => `instagram.${name}`),
 version: PAGESHIM_CONNECTOR_VERSION,
 loginUrl: "https://www.instagram.com/accounts/login/",
 loginMessage: "Sign in to Instagram, then return here.",
 validateRecord,
 prepareProbe: async pw => { await pw.goto("https://www.instagram.com/"); },
 probe: async pw => {
  // Observational: the prepared Instagram document is not navigated on retries.
  const user = await fetchWebInfoUser(pw as never, false);
  return Boolean(user && profileRecord(user));
 },
 prepareRequested: requested => {
  let getEntries: (() => unknown) | undefined;
  try { getEntries = (page as ShimPage & {requestedScopeEntries?: () => unknown}).requestedScopeEntries; }
  catch { /* Older hosts do not expose selection metadata. */ }
  applyRequestedScopeEntries(requested, getEntries?.call(page), "instagram");
 },
 collect: ctx => collectAllStreams(ctx as never, undefined, undefined, undefined, undefined, true),
 toScope: (_stream, records) => ({records}),
 emptyScopeFromCheckpoint: true,
 summarize: scopes => {
  const details = Object.fromEntries(streams.map(stream => [stream,
   (scopes[`instagram.${stream}`] as {records?: unknown[]} | undefined)?.records?.length ?? 0]));
  const count = Object.values(details).reduce((a, b) => a + b, 0);
  return {count, label: count === 1 ? "record" : "records", details};
 },
}, initialState, supportsState);
