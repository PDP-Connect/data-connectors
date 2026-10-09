# X (Browser Sign-In)

Reads the signed-in owner's own X data from the x.com web app, in the owner's own browser session: their profile, their posts and replies, the posts they liked and the posts they bookmarked. It runs on desktop and on the mobile PageShim host.

It does not read direct messages, follower or following lists, or anyone else's account. For full history and direct messages, use the account export (`twitter_archive`).

**Status: development.** It completed a real run on a real iPhone 12 in the Vana mobile app on 2026-10-08/09, through the real connect flow with a signed-in owner: profile 1, posts 31, likes 61, bookmarks 4; 109 posts seen, no aborted requests. It has also run against the synthetic fixtures in this directory and in `scripts/pageshim/fixtures/x_browser.mjs`. Desktop with the current code, incremental second runs and Android are not verified; see [Unverified](#unverified). Some of what it relies on was checked by hand; see [Checked by hand on x.com](#checked-by-hand-on-xcom) and [Unverified](#unverified).

## Terms of service and the owner's legal basis

X's Terms of Service prohibit accessing the service by automated means, including scraping, without X's prior written consent. Running this connector is such a use, and X may rate-limit, challenge or restrict an account for it.

The connector exists for one case: the account owner asking for their own personal data. The owner's basis is their right of access and portability over that data: GDPR Articles 15 and 20 in the EU and UK, CCPA/CPRA sections 1798.100 and 1798.130 in California, and equivalent laws elsewhere. X's own archive export serves the same right; this connector is a fresher view of a part of it.

What follows from that:

- It reads only the signed-in account: the profile response is checked against the session's own user id, timeline requests for another user id are ignored, and in reply threads only posts the owner wrote are saved.
- Likes and bookmarks are other people's public posts. They are saved, with author and text, because which posts the owner liked or bookmarked is the owner's own data and is not meaningful without them.
- The owner starts every run. Nothing runs in the background (`refresh_policy.recommended_mode: manual`, `background_safe: false`).
- The owner signs in themselves, in the browser. The connector never fills in, reads or stores a credential.
- It is on the publish allowlist (`scripts/connector-publish-allowlist.mjs`) after a recorded owner run on 2026-10-08/09.

This is not legal advice. Whether to run it is the owner's decision.

## How it collects

It does not build X's GraphQL requests. Their query ids rotate and each request carries a per-request signature header, so a rebuilt request is both fragile and conspicuous. It lets the web app make its own requests and reads the responses:

1. Open `https://x.com/home` (skipped when the page is already there).
2. Install an observer in the page (`page-scripts.ts`). It wraps `XMLHttpRequest.prototype.open` and `send`, and `window.fetch` as a fallback, and buffers the response of every request to `/graphql/<queryId>/<OperationName>`. It matches on the operation name only and changes no request.
3. Move between views by following the app's own links, so the page is not reloaded and the observer survives: the profile link, the profile's Replies tab, the History link, and its Likes tab. On the narrow layout the profile link is read from the account drawer the avatar control opens: the drawer's `/<handle>/following` link names the handle, and its own link to `/<handle>` is followed (this path completed a real run on a real iPhone 12 on 2026-10-08/09; see [Verified on a real iPhone](#verified-on-a-real-iphone)).
4. Scroll the window down in steps. The app then requests the next page of the list itself.
5. Take the buffered responses out of the page between steps and parse them in `parsers.ts`.

| Operation | Read for | Stream |
| --- | --- | --- |
| `UserByScreenName` | the owner's profile | `profile` |
| `UserOriginalsTimeline` | the profile's Posts tab | `posts` |
| `UserRepliesTimeline` | the profile's Replies tab | `posts` |
| `Bookmarks` | History | `bookmarks` |
| `Likes` | History, Likes tab | `likes` |

Reposts are saved (kind `repost`) only where X lists them in those two profile tabs. The profile's Reposts tab is not read in this version.

PageShim does not offer `page_response_observation`, `cookie_read` or `page_input`, so the observer, the cookie check and the link clicks all go through `page_script_evaluation`. The manifest declares `network: same_origin_page_fetch` because what is read are same-origin requests made in the page; the connector's own code makes none.

The page scripts are strings, not functions, and run in the page's main world. On desktop that needs Patchright's fourth `evaluate` argument (`isolatedContext: false`): Patchright otherwise runs scripts in an isolated world, where the observer would wrap an `XMLHttpRequest` the web app never uses.

## Safety budget

Every post the web app loads counts against the owner's own daily reading allowance. Third parties report roughly 1,000 posts a day on free accounts and fewer on new ones; X does not publish the number. The limits are named constants at the top of `index.ts`.

| Limit | Value | Constant |
| --- | --- | --- |
| Posts read in one run, all views | 400 | `MAX_POSTS_PER_RUN` |
| Posts read in one view (Posts, Replies, Bookmarks, Likes) | 100 each | `VIEW_POST_CAPS` |
| Pause after every action (a link, a scroll) | 2 to 5 s, random | `ACTION_DELAY_MIN_MS`, `ACTION_DELAY_MAX_MS` |
| Scroll steps in one view | 60 | `MAX_SCROLL_STEPS_PER_VIEW` |
| Minimum time between runs | 1 day | manifest `minimum_interval_seconds` |

- The count is of posts X sent, including other people's posts in reply threads and posts that could not be read. A view stops after the response that reaches its cap, so it can pass the cap by one response.
- The count cannot include the home timeline, which the app loads before the observer exists. The cap leaves room for it.
- One action at a time. No parallel requests, no retries.
- The first run reads each list from the top to its cap. A later run stops a list at the first post already collected (STATE keeps the newest 50 ids per stream, and nothing else).
- Older history beyond the first run's cap is never read. That is the stream's stated bound, not a gap to be filled later.

The whole run stops at once, keeping what was read, on any of:

- a GraphQL response with a status other than 200 (429 is reported as a rate limit), for any operation, read or not;
- a response body with `errors` and no `data`;
- the page moving to a sign-in or challenge path;
- the `twid` or `ct0` cookie disappearing, or `twid` naming a different account;
- the page reloading (the observer is gone) or no longer answering.

The stream being read reports the cause. Streams not yet opened report `run_stopped_early`. A stream that fell short does not move its cursor, so the next run reads it from the top again.

It is read-only. The only things it does on the page are follow a link whose own address is the view it wants, click the avatar control that opens the narrow layout's account drawer, and scroll. When a link is missing it also reads the layout to write diagnostics. One `layout` line names the viewport, the route, the drawer result, the control count and the number of control lines; then one `lc` line names each control.

Every report line must fit a 150-character budget (`DIAGNOSTIC_LINE_MAX_CHARS`, in `connector-diagnostic.ts`), measured on the whole formatted line the host sees (`[x_browser-diagnostic] ` + event + space + JSON), because the mobile host truncates a message to 160 characters past its own prefix. An `lc` line is therefore a flat JSON object, never a JSON string inside JSON, with short keys:

| Key | Meaning |
| --- | --- |
| `i` | 1-based position in the emitted order |
| `n` | total controls the page offered |
| `s` | `"d"` when the control is inside an open dialog; omitted for the page |
| `t` | tag name |
| `id` | `data-testid` |
| `al` | masked, clipped `aria-label` |
| `r` | `role` |
| `x` | `aria-expanded` |
| `p` | handle-free, id-free path shape |
| `cut` | `1` when `al` was shortened, then `p`, to fit the budget |

Dialog controls are named first, so the open drawer is never hidden by the line cap (`LAYOUT_MAX_CONTROL_LINES`, 60). Null or absent fields are left out, `id` is never dropped from a line that is written, and no text, handle or numeric id is ever named. If a control's shortest line still cannot fit, that control is left out (its `id` is not truncated away) and the first line reports `omitted`; otherwise at the page script's 60-control cap every control gets a line.

The per-stream diagnostics use the same budget with short keys, `coverage` plus a `coverage_counts` second line so no field is lost:

| Line | Key | Meaning |
| --- | --- | --- |
| `coverage` | `s` | stream |
| | `st` | `complete` or `partial` |
| | `r` | failure reason, when partial |
| | `e` | how each view ended: `end` exhausted, `cap` cap reached, `old` first post older than the range, `known` reached a post already collected, `open` unfinished |
| | `w` | whether the stream is read to its cap whatever was already collected |
| `coverage_counts` | `s` | stream |
| | `p` | pages read |
| | `n` | posts the app sent |
| | `k` | records saved |
| | `o` | other authors' posts read but not saved |
| | `u` | posts the parser could not use |
| | `x` | posts with no usable id, author or date |
| `run` | `ps` | posts seen |
| | `stop` | stop reason, when the run stopped |
| | `ab` | aborted requests |
| | `nav` | `via:count` pairs for link, drawer, history, already-there and none clicks |

## Sign-in

Signed in means: the page is on `https://x.com`, off the sign-in and challenge paths, and the `twid` (value `u%3D<numeric id>`) and `ct0` cookies are present. `probeXSession` reads the current page and never navigates.

- Desktop: `ensureXSession` opens `/home` to look. With no session it opens `https://x.com/login` and hands the browser to the owner through `manualBrowserLogin` (a `manual_action` interaction), polling the same probe until the owner has signed in.
- PageShim: the entry opens `/home` once, then the runtime shows `https://x.com/login` and polls the probe.
- A session that ends mid-run stops the run with `sign_in_required`; see above.

## Streams

| Stream | Key | Notes |
| --- | --- | --- |
| `profile` | `id` | One record, read on every run. |
| `posts` | `id` | The owner's posts, replies, quotes. `kind` says which. A time range applies to `created_at`. |
| `likes` | `id` | Posts the owner liked, with author and text. No time range: X does not say when a post was liked. |
| `bookmarks` | `id` | Same record as `likes`. No time range. |

Counts on a post (likes, reposts, views) are as of the run that collected it and are not refreshed. A post the owner later deletes, unlikes or unbookmarks stays collected.

## Mobile (PageShim)

`scripts/pageshim/entries/x_browser.ts`. Scopes are `x.profile`, `x.posts`, `x.likes`, `x.bookmarks`, each `{ records: [...] }`. The entry exists because the connector needs the host's saved STATE, a first navigation before the sign-in check, and its fallen-short streams marked partial.

Build and check: `npm run mobile:bundle -- x_browser`.

## Checked by hand on x.com

Seen in a signed-in desktop Chrome session on 2026-10-08, by hand, not by this code:

- **Scrolling.** `window.scrollBy(0, 2500)` from page script made the app request the next page (`Likes` with a `cursor` variable, HTTP 200) and the document grew, also while the tab was hidden. A step inside what is already rendered makes no request.
- **Which view sends which operation.** The profile sends `UserByScreenName` and `UserOriginalsTimeline`; its Replies tab `UserRepliesTimeline`; History `Bookmarks`; History's Likes tab `Likes`.
- **Request variables.** The three user timelines carry `userId`; `Bookmarks` carries only `count` and `includePromotedContent`. So the other-account check applies to posts and likes, and not to bookmarks, which are the session owner's by construction. `count` was 20.
- **Profile shape.** `profile_bio{description}`, `website{url}`, `relationship_counts{followers, following}`, `tweet_counts{tweets}`, `privacy{protected}`, `verification{verified}`, `location{location}`, `action_counts{favorites_count}`, `avatar{image_url}`, `banner{image_url}`, `core{created_at, name, screen_name}`. The parser reads exactly these keys.
- **Cookies.** `twid` and `ct0` are readable from page script on desktop, among `personalization_id`, `__cuid`, `lang`, `guest_id_ads`, `guest_id_marketing`, `guest_id` and `g_state`.
- **No page state to read the handle from.** `window.__INITIAL_STATE__` is undefined on a signed-in page. The handle comes only from the app's own links: on the wide layout `a[data-testid="AppTabBar_Profile_Link"]`, then `a[aria-label="Profile"]`; on the narrow layout the drawer's `/<handle>/following` link. With neither on the wide layout, a run that needs the handle stops with that reason and opens nothing; the narrow layout completed a real run on a real iPhone 12 on 2026-10-08/09 (see [Verified on a real iPhone](#verified-on-a-real-iphone)). The `twid` cookie gives the numeric id but not the handle, and `/i/user/<id>` is not known to redirect, so neither is used to guess one.

## Verified on a real iPhone

Observed on a real iPhone 12 in the Vana mobile app, through the real connect
flow with a signed-in owner, on 2026-10-08/09:

- A run completed and collected profile 1, posts 31, likes 61 and bookmarks 4,
  with 109 posts seen and no aborted requests.
- The narrow layout has no profile link on the page. The account control
  `[data-testid="DashButton_ProfileIcon_Link"]` opens a dialog whose links carry
  no test id and no label; the handle is read from the drawer's
  `/<handle>/following` link.
- The profile page's tab strip links work, and scrolling pages.
- From the profile page the History link is not found (the top-left control is a
  Back button); the route fallback (`history.pushState` plus `popstate`) reached
  History and Likes.

The mobile host truncates connector log lines at 160 characters.

## Unverified

Except where [Verified on a real iPhone](#verified-on-a-real-iphone) records a
device observation, none of this was checked against x.com, by hand or by this
code.

1. **Android.** An Android emulator WebView was refused at X login with "temporarily limited your login"; no real Android device was tried.
2. **Signed-out behaviour.** That `/home` sends a signed-out session to `/i/flow/login` or `/login` was not observed. The probe treats "no `twid` cookie" or "on a sign-in path" as signed out.
3. **Short lists.** Whether the app asks for a next page when a list is shorter than the window. If it does not, such a list reports `list_end_unconfirmed` instead of complete.
4. **Scrolling in a phone WebView on Android.** The scroll check above and the real iPhone run were on iPhone; Android was not observed.
5. **Overlap between the Posts and Replies tabs.** Both are read; whether Replies alone would cover Posts was not measured.
6. **End of a list.** That the last page is a response with cursors and no posts is assumed.
7. **`TimelinePinEntry`, `TimelineAddToModule`, `TweetWithVisibilityResults`, tombstones.** Handled from known shapes; not seen in the captured responses.
8. **Cookies on a phone.** That `twid` and `ct0` are readable from page script was seen on desktop only.
9. **The sign-in and challenge paths** in `SIGN_IN_PATH_RE` are a best list, not an observed one.
10. **How X signals a rate limit** to the web app (HTTP 429, or 200 with an error body). Both stop the run.
11. **Detection.** Whether X notices wrapped `XMLHttpRequest` and `fetch`, or scripted link clicks, drawer clicks and scrolling.
12. **The allowance figures** are third-party reports.
13. **The desktop runtime.** The sign-in handoff has run only against a fake page, and the main-world evaluation under Patchright has not run at all: the unit tests check only that the argument is passed. Desktop with the current code is not verified.
14. **The mobile host's handling of STATE and of later runs.** A later run sends only what is new, and on the streamed-result host sends an unchanged list as `{ "records": [] }`. The host must add to what it holds, not replace it. No incremental second run has been observed.

## Tests

- `parsers.test.ts`: response bodies to records.
- `page-scripts.test.ts`: the page scripts, run in a `vm` context with a fake `XMLHttpRequest`.
- `index.test.ts`: whole runs against a model of the web app that the real page scripts drive: first run, later runs, every stop condition, the narrow layout and drawer path, the caps, sign-in, the layout diagnostic.
- `scripts/pageshim/pageshim.test.mjs`: the built bundle in Chromium against a synthetic web app.

All fixtures are synthetic; see `fixtures/README.md`.
