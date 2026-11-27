// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
// Synthetic only. API reachability and native WebView behavior need a device run.
const json = (body, status = 200) => ({status, contentType: "application/json", body: JSON.stringify(body)});
const html = (body = "") => ({status: 200, contentType: "text/html", body: `<!doctype html><body>${body}</body>`});
export const owner = {id: "owner-1", username: "synthetic_owner"};
export function createMetaFixtures(options = {}) {
 let loggedIn = true;
 let webReads = 0;
 let followingReads = 0;
 const requests = [];
 const profile = {...owner, full_name: "Synthetic Owner", biography: "", external_url: "",
  profile_pic_url: "https://www.instagram.com/avatar.jpg", is_private: false,
  is_verified: false, is_business_account: false, follower_count: 2,
  following_count: options.total ?? 1, media_count: 0, ...options.profile};
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
  resolve(raw) {
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
   if (url.hostname === "accountscenter.instagram.com") {
    if (options.blankAds) return html();
    if (url.pathname === "/ads/ad_topics/") return html(dialog("topics"));
    return html('<button aria-label="advertiser" onclick="document.body.insertAdjacentHTML(\'beforeend\', ' +
      JSON.stringify(dialog("advertisers")).replaceAll('"', '&quot;') + ')">Advertisers</button>' +
      '<button role="tab" onclick="document.getElementById(\'panel\').hidden=false">Manage info</button>' +
      '<div role="tabpanel" id="panel" hidden><a onclick="document.body.insertAdjacentHTML(\'beforeend\', ' +
      JSON.stringify(dialog("categories")).replaceAll('"', '&quot;') + ')">Categories used to reach you</a></div>');
   }
   return html(loggedIn ? "" : '<form><input type="password"></form>');
  },
 };
}
export const pageshimCase = {
 fixtures: createMetaFixtures(),
 scopes: ["instagram.profile", "instagram.following"],
 exportSummary: {count: 2, label: "records", details: {profile: 1, posts: 0, post_likes: 0, following: 1, ads: 0}},
 emptyExportSummary: {count: 0, label: "records", details: {profile: 0, posts: 0, post_likes: 0, following: 0, ads: 0}},
};
