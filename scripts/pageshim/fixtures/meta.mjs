// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
// Synthetic only. API reachability and native WebView behavior need a device run.
import { readFileSync } from "node:fs";

const json = (body, status = 200) => ({status, contentType: "application/json", body: JSON.stringify(body)});
const html = (body = "") => ({status: 200, contentType: "text/html", body: `<!doctype html><body>${body}</body>`});
export const owner = {id: "owner-1", username: "synthetic_owner"};

// The posts response shape comes from connectors/meta/fixtures/posts.loaded.json;
// ids, likers and the owner envelope are added per post.
const loaded = JSON.parse(readFileSync(new URL("../../../connectors/meta/fixtures/posts.loaded.json", import.meta.url), "utf8"));
const template = loaded.data.xdt_api__v1__feed__user_timeline_graphql_connection.edges[0].node;
export function syntheticPost(n, likers = 1, likeCount = likers) {
 return {node: {...template, id: `340100000000000000${n}`, code: `fixture-post-${n}`,
  caption: {text: `Synthetic fixture post ${n}`}, taken_at: template.taken_at - n * 86_400,
  image_versions2: {candidates: [{url: `https://www.instagram.com/media/${n}.jpg`}]},
  like_count: likeCount,
  facepile_top_likers: Array.from({length: likers}, (_, i) => ({
   id: `liker-${n}-${i}`, pk: `liker-${n}-${i}`, username: `synthetic_liker_${n}_${i}`, profile_pic_url: ""}))}};
}
export function timelinePage(edges, endCursor) {
 return {data: {user: owner, xdt_api__v1__feed__user_timeline_graphql_connection: {edges,
  page_info: endCursor ? {has_next_page: true, end_cursor: endCursor} : {has_next_page: false, end_cursor: null}}}};
}
/** Bodies by request cursor ("" for the first page). An array answers its
 * entries in turn, then repeats the last. Post 2 has more likes than likers:
 * the facepile is a sample, so post_likes cannot be proven complete. */
export const POSTS_PAGES = {
 "": timelinePage([syntheticPost(1, 2), syntheticPost(2, 1, 5)], "synthetic-cursor-1"),
 "synthetic-cursor-1": timelinePage([syntheticPost(3, 1)], null),
};

/**
 * A small Instagram web app for the www host. It routes on the client: a
 * click on a same-origin link pushes the path and renders it. The owner's
 * profile requests the posts query (a form-encoded POST naming
 * PolarisProfilePostsQuery, with page-minted fields) when it renders, over
 * XMLHttpRequest for the first page and fetch for later pages, and requests
 * the next page with `after` when the window nears the end of the list. A
 * full load of the profile path requests the first page at once, before any
 * script the connector installs.
 *
 * `routing: "client"` is the model above; "reload" lets link clicks load a
 * new document, as a page without client routing would. `refetchFirstPage`
 * makes the app ask for the first page once more after the last one.
 */
const webApp = ({profileLink, refetchFirstPage, routing, scroll}) => `<!doctype html><html><head><meta charset="utf-8"><style>
body { margin: 0; } .post { height: 900px; border-bottom: 1px solid #ccc; }
</style></head><body>
<nav><a href="/">Home</a>${profileLink ? `<a href="/${owner.username}/">Profile</a>` : ""}</nav>
<main id="list"></main>
<script>
(() => {
 const OWNER = ${JSON.stringify(owner)};
 const list = document.getElementById("list");
 let view = 0;
 let timeline = null;
 const body = (variables) => new URLSearchParams({
  av: "17841400000000000", __user: "0", __a: "1", fb_dtsg: "SYNTHETIC:DTSG", jazoest: "21000",
  lsd: "SYNTHETIC-LSD", fb_api_caller_class: "RelayModern", fb_api_req_friendly_name: "PolarisProfilePostsQuery",
  variables: JSON.stringify(variables), server_timestamps: "true", doc_id: "1000000000000001",
 }).toString();
 const headers = {"content-type": "application/x-www-form-urlencoded", "x-fb-friendly-name": "PolarisProfilePostsQuery"};
 const request = (cursor, done) => {
  const variables = {data: {count: 12, include_relationship_info: true}, username: OWNER.username,
   __relay_internal__pv__PolarisIsLoggedInrelayprovider: true};
  if (cursor) variables.after = cursor;
  if (!cursor) {
   const xhr = new XMLHttpRequest();
   xhr.open("POST", "/graphql/query");
   for (const [key, value] of Object.entries(headers)) xhr.setRequestHeader(key, value);
   xhr.onloadend = () => done(xhr.status, xhr.responseText);
   xhr.send(body(variables));
  } else {
   fetch("/api/graphql", {method: "POST", headers, body: body(variables), credentials: "include"})
    .then((response) => response.text().then((text) => done(response.status, text)), () => done(0, ""));
  }
 };
 const loadPage = () => {
  const current = timeline;
  if (!current || current.loading || current.ended) return;
  current.loading = true;
  request(current.cursor, (status, text) => {
   current.loading = false;
   if (current.view !== view) return;
   let connection = null;
   try { connection = JSON.parse(text).data.xdt_api__v1__feed__user_timeline_graphql_connection; } catch (error) {}
   if (status !== 200 || !connection) { current.ended = true; return; }
   for (const edge of connection.edges) {
    const row = document.createElement("div");
    row.className = "post";
    row.textContent = edge.node.code;
    list.appendChild(row);
   }
   const info = connection.page_info || {};
   current.cursor = info.end_cursor || null;
   if (!info.has_next_page || !current.cursor) {
    current.ended = true;
    ${refetchFirstPage ? `if (current.cursor === null && !current.refetched) { current.refetched = true; request(null, () => {}); }` : ""}
   }
  });
 };
 const render = () => {
  view += 1;
  timeline = null;
  list.innerHTML = "";
  window.scrollTo(0, 0);
  if (location.pathname === "/" + OWNER.username + "/") {
   timeline = {view, cursor: null, loading: false, ended: false};
   loadPage();
  } else {
   // The home feed makes a GraphQL request the connector must ignore.
   fetch("/api/graphql", {method: "POST", headers, credentials: "include",
    body: new URLSearchParams({fb_dtsg: "SYNTHETIC:DTSG", fb_api_req_friendly_name: "PolarisFeedTimelineRootQuery",
     variables: "{}", doc_id: "1000000000000002"}).toString()}).catch(() => {});
  }
 };
 ${routing === "client" ? `document.addEventListener("click", (event) => {
  const link = event.target && event.target.closest ? event.target.closest("a") : null;
  if (!link || link.origin !== location.origin) return;
  event.preventDefault();
  if (link.pathname === location.pathname) return;
  history.pushState({}, "", link.pathname);
  render();
 });
 window.addEventListener("popstate", render);` : ""}
 ${scroll ? `window.addEventListener("scroll", () => {
  const root = document.documentElement;
  if (root.scrollHeight - (window.scrollY + window.innerHeight) < 400) loadPage();
 });` : ""}
 render();
})();
</script></body></html>`;

export function createMetaFixtures(options = {}) {
 let loggedIn = true;
 let webReads = 0;
 let followingReads = 0;
 const requests = [];
 const postsRequests = [];
 const pages = options.postsPages ?? POSTS_PAGES;
 const profile = {...owner, full_name: "Synthetic Owner", biography: "", external_url: "",
  profile_pic_url: "https://www.instagram.com/avatar.jpg", is_private: false,
  is_verified: false, is_business_account: false, follower_count: 2,
  following_count: options.total ?? 1, media_count: options.mediaCount ?? 3, ...options.profile};
 const dialog = (kind) => kind === "topics"
  ? '<div role="dialog"><ul role="list" aria-setsize="1"><li role="listitem">Science</li></ul></div>'
  : kind === "advertisers"
  ? '<div role="dialog"><ul role="list" aria-setsize="1"><li role="listitem">Synthetic Shop</li></ul><button aria-label="Close" onclick="this.parentNode.remove()">Close</button></div>'
  : '<div role="dialog"><ul role="list" aria-setsize="1"><li role="listitem">Travel<button>Remove</button></li></ul><button aria-label="Close" onclick="this.parentNode.remove()">Close</button></div>';
 return {
  hosts: /^https:\/\/(?:www|accountscenter)\.instagram\.com\//,
  loginUrl: "https://www.instagram.com/accounts/login/",
  homeUrl: "https://www.instagram.com/",
  setLoggedIn: value => { loggedIn = value; },
  requests,
  /** Every posts query the app sent: its cursor and whether page-minted fields rode along. */
  postsRequests,
  resolve(raw, request = {}) {
   const url = new URL(raw);
   requests.push(url.pathname + url.search);
   if (url.pathname === "/accounts/web_info/") {
    webReads++;
    if (!loggedIn || (options.logoutAtEnd && webReads >= 4)) return html('<form><input type="password"></form>');
    return html('<script type="application/json" data-sjs>' + JSON.stringify(["PolarisViewer", owner.id, {data: owner}]) + '</script>');
   }
   if (url.pathname === "/api/v1/users/web_profile_info/") {
    if (options.profileFailure) return json({message: "unavailable"}, 503);
    return json({status: "ok", data: {user: profile}, ...options.profileEnvelope});
   }
   if (url.pathname.includes("/following/")) {
    followingReads++;
    if (options.followingPages) return json(options.followingPages[followingReads - 1] ?? {status: "fail"});
    return json({status: "ok", owner, users: [{pk: "friend-1", username: "synthetic_friend"}], has_more: false, next_max_id: null});
   }
   if (url.hostname === "www.instagram.com" && /^\/(?:graphql\/query|api\/graphql)\/?$/.test(url.pathname)) {
    if (!loggedIn) return json({errors: [{message: "login_required"}]}, 401);
    const form = new URLSearchParams(request.postData ?? "");
    if (form.get("fb_api_req_friendly_name") !== "PolarisProfilePostsQuery") return json({data: {}});
    let variables = {};
    try { variables = JSON.parse(form.get("variables") ?? "{}"); } catch {}
    const cursor = typeof variables.after === "string" ? variables.after : "";
    const seen = postsRequests.filter(r => r.cursor === cursor).length;
    postsRequests.push({cursor, pageMinted: form.has("fb_dtsg") && form.has("lsd") && form.has("doc_id")});
    const answer = pages[cursor];
    const body = Array.isArray(answer) ? answer[Math.min(seen, answer.length - 1)] : answer;
    if (body === undefined) return json({errors: [{message: "unknown cursor"}]}, 500);
    return typeof body?.status === "number" ? json(body.json, body.status) : json(body);
   }
   if (url.hostname === "accountscenter.instagram.com") {
    if (options.blankAds) return html();
    if (url.pathname === "/ads/ad_topics/") return html(dialog("topics"));
    return html('<button aria-label="advertiser" onclick="document.body.insertAdjacentHTML(\'beforeend\', ' +
      JSON.stringify(dialog("advertisers")).replaceAll('"', '&quot;') + ')">Advertisers</button>' +
      '<button role="tab" onclick="document.getElementById(\'panel\').hidden=false">Manage info</button>' +
      '<div role="tabpanel" id="panel" hidden><a onclick="document.body.insertAdjacentHTML(\'beforeend\', ' +
      JSON.stringify(dialog("categories")).replaceAll('"', '&quot;') + ')">Categories used to reach you</a></div>');
   }
   if (!loggedIn) return html('<form><input type="password"></form>');
   if (url.pathname.startsWith("/accounts/")) return html("");
   return {status: 200, contentType: "text/html", body: webApp({
    profileLink: options.profileLink ?? true, refetchFirstPage: options.refetchFirstPage ?? false, routing: options.routing ?? "client", scroll: options.scroll ?? true})};
  },
 };
}
export const pageshimCase = {
 fixtures: createMetaFixtures(),
 scopes: ["instagram.profile", "instagram.following"],
 exportSummary: {count: 2, label: "records", details: {profile: 1, posts: 0, post_likes: 0, following: 1, ads: 0}},
 emptyExportSummary: {count: 0, label: "records", details: {profile: 0, posts: 0, post_likes: 0, following: 0, ads: 0}},
};
