// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { Page } from "playwright";
import type { AdKind, AdRecord, InstagramProfilePageUser } from "./types.ts";

/** Equality for JSON source snapshots: object key order is irrelevant. */
export function jsonEqual(left: unknown, right: unknown): boolean {
 if (Object.is(left, right)) return true;
 if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
 if (Array.isArray(left) !== Array.isArray(right)) return false;
 if (Array.isArray(left) && Array.isArray(right) && left.length !== right.length) return false;
 const keys = Object.keys(left);
 if (keys.length !== Object.keys(right).length) return false;
 return keys.every(key => Object.hasOwn(right, key) &&
  jsonEqual((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
}

/** Same digest and trimming contract as the desktop parser, without Node. */
export async function buildAdRecordsWebCrypto(input: {
 adTopics: string[]; advertisers: string[];
 categories: Array<{description: string | null; name: string}>;
}): Promise<AdRecord[]> {
 const rows: Array<{kind: AdKind; name: string; description: string | null}> = [
  ...input.advertisers.map(name => ({kind: "advertiser" as const, name, description: null})),
  ...input.adTopics.map(name => ({kind: "ad_topic" as const, name, description: null})),
  ...input.categories.map(row => ({kind: "ad_category" as const, ...row})),
 ];
 const out: AdRecord[] = [];
 for (const row of rows) {
  const name = row.name.trim();
  if (!name) continue;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${row.kind}|${name}`));
  const id = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("").slice(0, 32);
  out.push({...row, name, id});
 }
 return out;
}

/** The web profile API takes only a username and the public web app id.
 * The caller still requires both returned id and username to match web_info.
 * Missing fields stay missing; this does not manufacture GraphQL counts.
 */
export async function fetchMobileProfileUser(
 page: Page, username: string,
 observe: (body: unknown, status: number) => void = () => {},
): Promise<InstagramProfilePageUser | null> {
 const response = await page.evaluate(async (name) => {
  if (location.origin !== "https://www.instagram.com") return {status: 0, body: null};
  try {
   const res = await fetch(`/api/v1/users/web_profile_info/?username=${encodeURIComponent(name)}`, {
    credentials: "include", signal: AbortSignal.timeout(20_000),
    headers: {"x-ig-app-id": "936619743392459", "x-requested-with": "XMLHttpRequest"},
   });
   return {status: res.status, body: await res.json()};
  } catch { return {status: 0, body: null}; }
 }, username).catch(() => ({status: 0, body: null}));
 observe(response.body, response.status);
 const body = response.body;
 if (response.status < 200 || response.status >= 300 || !body ||
  (body.status !== undefined && body.status !== "ok") || body.ok === false ||
  body.error !== undefined || body.errorCode !== undefined || body.error_code !== undefined ||
  (body.errors != null && (!Array.isArray(body.errors) || body.errors.length > 0)) ||
  body.partial === true || body.is_final === false || body.extensions?.code === "UNAUTHENTICATED" ||
  body.extensions?.partial === true || body.extensions?.is_final === false) return null;
 return body.data?.user ?? null;
}
