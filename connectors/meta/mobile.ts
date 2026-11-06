// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { Page } from "playwright";
import type { ExchangeRule } from "../../packages/polyfill-connectors/src/page-exchange-capture.ts";
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
 const named = rows.map(row => ({...row, name: row.name.trim()})).filter(row => row.name);
 return Promise.all(named.map(async row => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${row.kind}|${row.name}`));
  const id = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("").slice(0, 32);
  return {...row, id} as AdRecord;
 }));
}

/** What the profile-info read saw, when it could not return a user. */
export interface MobileProfileRead {
 user: InstagramProfilePageUser | null;
 /** Which step failed and what it saw; null when a user was read. */
 problem: string | null;
}

/** The page's answer to the profile-info request, or the step that failed. */
interface ProfileInfoAnswer {
 status: number;
 contentType: string | null;
 body: unknown;
 failure: "page_origin" | "fetch" | "body_read" | "not_json" | "page_call" | null;
 detail: string | null;
}

/** The in-page read. A complete expression in a string (CONNECTOR-GUIDELINES
 * rule 4). It keeps the real status and content type when the body is not
 * JSON (a login or challenge page), so the caller can say which step failed. */
export function profileInfoScript(username: string): string {
 return `(async () => {
 const answer = (status, contentType, body, failure, detail) => ({status, contentType, body, failure, detail});
 if (location.origin !== "https://www.instagram.com") return answer(0, null, null, "page_origin", String(location.origin));
 let res;
 try {
  res = await fetch("/api/v1/users/web_profile_info/?username=" + encodeURIComponent(${JSON.stringify(username)}), {
   credentials: "include", signal: AbortSignal.timeout(20000),
   headers: {"x-ig-app-id": "936619743392459", "x-requested-with": "XMLHttpRequest"},
  });
 } catch (error) {
  return answer(0, null, null, "fetch", String((error && error.name) || "error"));
 }
 const contentType = res.headers.get("content-type");
 let text;
 try { text = await res.text(); } catch (error) {
  return answer(res.status, contentType, null, "body_read", String((error && error.name) || "error"));
 }
 try { return answer(res.status, contentType, JSON.parse(text), null, null); } catch (error) {
  return answer(res.status, contentType, null, "not_json", text.length + " bytes");
 }
})()`;
}

function describeProfileInfoFailure(answer: ProfileInfoAnswer): string {
 const http = `HTTP ${answer.status} (${answer.contentType ?? "no content type"})`;
 switch (answer.failure) {
  case "page_origin": return `web_profile_info was not requested: the page was on ${answer.detail}, not https://www.instagram.com`;
  case "fetch": return `the web_profile_info request failed in the page (${answer.detail})`;
  case "body_read": return `web_profile_info answered ${http} but its body could not be read (${answer.detail})`;
  case "not_json": return `web_profile_info answered ${http} with a body that is not JSON (${answer.detail})`;
  case "page_call": return `the page call for web_profile_info failed (${answer.detail})`;
  default: return `web_profile_info answered ${http}`;
 }
}

/** The web profile API takes only a username and the public web app id.
 * The caller still requires both returned id and username to match web_info.
 * Missing fields stay missing; this does not manufacture GraphQL counts.
 * When no user is read, `problem` names the step that failed.
 */
export async function fetchMobileProfileUser(
 page: Page, username: string,
 observe: (body: unknown, status: number) => void = () => {},
): Promise<MobileProfileRead> {
 const answer = await (page.evaluate(profileInfoScript(username)) as Promise<ProfileInfoAnswer>)
  .catch((error: unknown): ProfileInfoAnswer => ({
   status: 0, contentType: null, body: null, failure: "page_call",
   detail: (error instanceof Error ? error.message : String(error)).slice(0, 200),
  }));
 observe(answer.body, answer.status);
 if (answer.failure !== null) return {user: null, problem: describeProfileInfoFailure(answer)};
 const body = answer.body as {
  status?: unknown; ok?: unknown; error?: unknown; errorCode?: unknown; error_code?: unknown;
  errors?: unknown; partial?: unknown; is_final?: unknown;
  extensions?: {code?: unknown; partial?: unknown; is_final?: unknown} | null;
  data?: {user?: InstagramProfilePageUser | null} | null;
 } | null;
 if (answer.status < 200 || answer.status >= 300) return {user: null, problem: describeProfileInfoFailure(answer)};
 if (!body || typeof body !== "object" ||
  (body.status !== undefined && body.status !== "ok") || body.ok === false ||
  body.error !== undefined || body.errorCode !== undefined || body.error_code !== undefined ||
  (body.errors != null && (!Array.isArray(body.errors) || body.errors.length > 0)) ||
  body.partial === true || body.is_final === false || body.extensions?.code === "UNAUTHENTICATED" ||
  body.extensions?.partial === true || body.extensions?.is_final === false) {
  return {user: null, problem: `${describeProfileInfoFailure(answer)} with an error or partial envelope`};
 }
 const user = (body.data?.user ?? null) as InstagramProfilePageUser | null;
 return user ? {user, problem: null} : {user: null, problem: `${describeProfileInfoFailure(answer)} with no user`};
}

// ─── Posts on PageShim: the app's own posts query, through page capture ───
//
// PageShim offers no request/response events, so Mobile cannot watch the
// network the way the Desktop walk does. It reads the profile page's own
// posts query (the same POST to /graphql or /api/graphql, matched on the
// same operation names as Desktop) through the shared in-page capture
// (packages/polyfill-connectors/src/page-exchange-capture.ts). The capture
// changes no request and constructs none. The connector keeps only the
// request's `variables` value; the page-minted `fb_dtsg`/`lsd`/`jazoest`/
// `doc_id` fields are not read out of the request body.
//
// Without page_init_script the capture is installed after a document loads,
// and a full page load drops it. The connector then installs it on the home
// page and opens the profile with the app's own link (client-side
// navigation), which makes the app request the first posts page after the
// capture is in place.
//
// Each script is a complete expression in a string (CONNECTOR-GUIDELINES
// rule 4): a function would be serialized with `toString()`, and the
// PageShim bundler can rewrite function bodies to call helpers the page
// does not have.

/** The capture's name in the page. */
export const POSTS_CAPTURE_NAME = "instagram_posts";
/** Responses buffered in one document before new ones are dropped (and reported). */
export const POSTS_CAPTURE_MAX_BUFFERED = 40;
/** Longest `variables` value kept; a longer one is kept as "" (unmatched). */
const POSTS_MAX_VARIABLES = 8_000;
/** The operation names Desktop's `isPostsTimelineRequest` accepts. */
const POSTS_OPERATION =
 /(?:PolarisProfilePostsQuery|PolarisProfilePostsTabContentQuery_connection|ProfilePostsQuery|UserMediaQuery)/;

/** Same test as Desktop: a POST to the GraphQL endpoint whose body names a posts operation. */
export const POSTS_CAPTURE_RULES: readonly ExchangeRule[] = [{
 url: /^https:\/\/www\.instagram\.com\/(?:[^?#]*\/)?graphql(?:[/?#]|$)/,
 method: "POST",
 body: POSTS_OPERATION,
}];

/**
 * The `variables` value of a posts request body (form or JSON), as text.
 * Returns "" when there is none or it is longer than the walk accepts.
 */
export function postsRequestVariablesText(body: string | null): string {
 if (body === null) return "";
 let variables: string | null = null;
 try { variables = new URLSearchParams(body).get("variables"); } catch { variables = null; }
 if (variables === null) {
  try {
   const parsed = JSON.parse(body) as unknown;
   if (parsed && typeof parsed === "object" && "variables" in parsed) {
    const value = (parsed as {variables: unknown}).variables;
    variables = typeof value === "string" ? value : JSON.stringify(value);
   }
  } catch { variables = null; }
 }
 return typeof variables === "string" && variables.length <= POSTS_MAX_VARIABLES ? variables : "";
}

/**
 * Open the owner's profile with the app's own link, without a page load, so
 * the capture survives. It clicks only an `<a>` whose own href path is
 * `/<username>/`. With `historyFallback`, when no link is present it pushes
 * the path and dispatches `popstate`, which a client-side router may follow
 * (not verified on instagram.com).
 */
export function openProfileScript(username: string, historyFallback: boolean): string {
 return `(() => {
 const wanted = ${JSON.stringify(`/${username.toLowerCase()}/`)};
 const normal = (path) => (String(path).toLowerCase().replace(/\\/?$/, "/"));
 if (normal(location.pathname) === wanted) return { via: "already_there" };
 for (const link of document.querySelectorAll("a[href]")) {
  let target = null;
  try { target = new URL(link.getAttribute("href"), location.href); } catch (error) {}
  if (!target || target.origin !== location.origin || normal(target.pathname) !== wanted) continue;
  link.click();
  return { via: "link" };
 }
 if (!${JSON.stringify(historyFallback)}) return { via: "none" };
 try {
  history.pushState({}, "", wanted);
  window.dispatchEvent(new PopStateEvent("popstate", { state: {} }));
 } catch (error) {
  return { via: "none" };
 }
 return { via: "history" };
})()`;
}

/** Scroll to the end of the list; the app then requests the next page itself. */
export const POSTS_SCROLL_SCRIPT = `(() => {
 window.scrollTo(0, document.body.scrollHeight);
 return { via: "scroll" };
})()`;

/** Whether `path` is the owner's profile route, `/<username>/`. */
export function isOwnerProfilePath(path: string, username: string): boolean {
 return path.toLowerCase().replace(/\/?$/, "/") === `/${username.toLowerCase()}/`;
}
