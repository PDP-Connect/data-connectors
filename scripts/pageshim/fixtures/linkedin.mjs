// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Synthetic owner and Voyager payloads only; no captured personal data.
const collection = (elements) => ({ elements, paging: { start: 0, count: elements.length, total: elements.length } });
const me = {
 plainId: 12,
 miniProfile: {
  entityUrn: "urn:li:fs_miniProfile:12", dashEntityUrn: "urn:li:fsd_profile:12",
  objectUrn: "urn:li:member:12", publicIdentifier: "synthetic-owner",
  firstName: "Synthetic", lastName: "Owner", occupation: "Engineer", picture: null,
 },
};
const profile = {
 entityUrn: "urn:li:fsd_profile:12", publicIdentifier: "synthetic-owner",
 firstName: "Synthetic", lastName: "Owner", headline: "Engineer",
 summary: "Synthetic fixture", industry: { name: "Software" },
 geoLocation: { geo: { defaultLocalizedName: "Fixture City" } },
 profilePicture: { displayImageReference: { vectorImage: null } },
 profilePositionGroups: collection([{
  entityUrn: "urn:li:positionGroup:1", company: { name: "Example" },
  profilePositionInPositionGroup: collection([{ entityUrn: "urn:li:position:1", title: "Engineer" }]),
 }]),
 profileEducations: collection([{ entityUrn: "urn:li:education:1", schoolName: "Example University" }]),
 profileSkills: collection([{ entityUrn: "urn:li:skill:1", name: "Testing", endorsementCount: 1 }]),
 profileLanguages: collection([{ entityUrn: "urn:li:language:1", name: "English", proficiency: "Native" }]),
};
const json = (body, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
export const streams = ["profile", "experience", "education", "skills", "languages", "connections"];
export function createLinkedInFixtures(transform = (_url, body) => body) {
 let loggedIn = true;
 const requests = [];
 return {
  hosts: /^https:\/\/www\.linkedin\.com\//,
  loginUrl: "https://www.linkedin.com/login",
  homeUrl: "https://www.linkedin.com/feed/",
  setLoggedIn(value) { loggedIn = value; },
  requests,
  resolve(raw, request = {}) {
   const url = new URL(raw);
   if (!url.pathname.startsWith("/voyager/")) return {
    status: 200, contentType: "text/html",
    body: '<!doctype html><html><body><script>document.cookie = \'JSESSIONID="synthetic-csrf"; path=/; Secure; SameSite=Lax\';</script>LinkedIn fixture</body></html>',
   };
   requests.push({ path: url.pathname, search: url.search, csrf: request.headers?.["csrf-token"] });
   if (!loggedIn) return json({ message: "Not authenticated" }, 401);
   if (request.headers?.["csrf-token"] !== "synthetic-csrf") return json({ message: "Missing CSRF" }, 403);
   let body;
   if (url.pathname === "/voyager/api/me") body = me;
   else if (url.pathname === "/voyager/api/relationships/connectionsSummary/") body = { entityUrn: "urn:li:fsd_connectionsSummary:12", numConnections: 1 };
   else if (url.pathname === "/voyager/api/relationships/dash/connections") {
    const start = Number(url.searchParams.get("start"));
    body = { elements: start === 0 ? [{ connectedMember: "urn:li:fsd_profile:conn-1", createdAt: 1700000000000 }] : [],
     paging: { start, count: 40, total: 1 } };
   } else if (url.pathname === "/voyager/api/identity/dash/profiles" && url.searchParams.has("ids")) {
    body = { results: { "urn:li:fsd_profile:conn-1": { firstName: "Fixture", lastName: "Connection", headline: "Tester", publicIdentifier: "fixture-connection" } } };
   } else if (url.pathname === "/voyager/api/identity/dash/profiles") body = { elements: [profile] };
   else return json({ message: "Unmatched fixture" }, 404);
   const transformed = transform(url, structuredClone(body), requests);
   if (transformed?.fixtureStatus) return json({}, transformed.fixtureStatus);
   return json(transformed);
  },
 };
}
export const pageshimCase = {
 fixtures: createLinkedInFixtures(),
 scopes: streams.map((stream) => "linkedin." + stream),
 exportSummary: { count: 6, label: "records", details: Object.fromEntries(streams.map((stream) => [stream, 1])) },
 emptyExportSummary: { count: 0, label: "records", details: Object.fromEntries(streams.map((stream) => [stream, 0])) },
};
