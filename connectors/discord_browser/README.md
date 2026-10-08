# Discord browser connector

Exports the signed-in owner's own Discord data from the discord.com web app.
Runs on desktop and on the mobile PageShim host.

| Stream | Request | Contents |
| --- | --- | --- |
| `profile` | `GET /users/@me` | Username, display name, avatar and banner hashes, bio, locale, Nitro level. |
| `servers` | `GET /users/@me/guilds` | Each server's name, icon hash, features, and the owner's permissions in it. |
| `connections` | `GET /users/@me/connections` | Linked third-party accounts: service, account name and id, visibility. |
| `messages` | `GET /guilds/{id}/messages/search?author_id={owner}&sort_by=timestamp&sort_order=desc&offset={n}` | Messages the owner wrote in servers, with the server's id and name. |

Not collected: direct messages, group DMs, the friends list, other people's
messages, attachment contents or links, the owner's email address, phone
number and sign-in security settings, and a linked account's access token.

## Terms of service and legal basis

Discord's terms forbid automating a user account outside its OAuth2 and bot
APIs, and Discord can suspend or terminate an account that does. Discord's
OAuth2 scopes cannot read a user's messages, so there is no permitted API for
this data. **Running this connector puts the owner's Discord account at
risk.** The product owner has accepted that risk for this connector; each
owner who runs it accepts it for their own account.

The owner uses it on their own account, in their own signed-in session, to get
a copy of their own personal data: the rights of access and data portability
(GDPR Articles 15 and 20) and the right to know (CCPA section 1798.110). It
reads nothing that belongs to someone else. Discord's own "Request all of my
Data" export (User Settings, Data & Privacy) is the route its terms allow, and
is the better choice for an owner who can wait for it.

## Sign-in

The owner signs in on discord.com themselves. The connector never types into
the page and never answers a captcha. It treats the session as signed in when
the page is on `discord.com/channels/...` and shows the user area or the
server list. If Discord asks for sign-in during a run, the run ends.

## Token handling

The connector does not read the session token. In the page it wraps
`XMLHttpRequest` and `fetch`, waits for the Discord client to send one API
request of its own that carries `Authorization`, copies that request's headers
into a closure, and puts the page's functions back. Its own requests reuse
those headers, minus the ones that belong to a single request such as
`Content-Type`.

- The header values stay in that closure. No page evaluation returns them, and
  they are never logged, emitted in a record, placed in STATE or written to
  diagnostics. A response body that repeats one is redacted in the page, and
  the JSON keys `token`, `access_token` and `refresh_token` are dropped there.
- The sign-in page is never wrapped.
- If the client sends no request within 30 seconds, the run ends with
  `discord_client_request_not_seen`. There is no fallback that looks for the
  token in the app's internals or storage.
- The page reader accepts only the four paths in the table above and only
  sends GET, so no other endpoint can be reached through it.
- Requests are made from inside the discord.com page, never from the host.

An idle client sends no request, so the connector clicks the in-app Shop link
(`/shop`, then `/store` or `/quest-home` if it is absent, then a history
navigation if none is), then the Friends link to return. It never
opens a direct message, a channel or message requests. On that navigation the
Discord client itself sends a `PATCH /users/@me/settings-proto/1`. That write
is the client's own behaviour, the same as when the owner clicks the link; the
connector sends no write of its own.

## Budget

Constants in `index.ts`:

| Limit | Value |
| --- | --- |
| Requests in flight | 1 |
| Pause between requests | 3 to 5 s, random |
| Message window | newest 90 days |
| Messages saved per run | 1,000 |
| Servers searched per run | 25 |
| Requests per run | 100 |
| Wait honoured on a 429 | once, when 10 s or less |
| Wait honoured on a 202 (search index) | once, when 10 s or less |
| Servers refusing in a row before the run ends | 3 |

- The `messages` STATE holds a queue of server ids and, per server, the newest
  collected message id and where an unfinished walk stopped. Later runs
  continue with the next servers, then stop each server at the first message
  already collected. STATE holds ids and offsets only.
- A 401, a captcha or account-check payload, a 403 on a profile endpoint, a
  second 429, a long or account-wide 429, or a server error ends the run with
  no retry. A 403 or a search index that is still not ready skips that server.
  What was collected is kept, and the rest is reported with the reasons in
  `manifest.json` (`reason_display_messages`).
- The manifest sets manual refresh, `background_safe: false` and a minimum
  interval of one day.

## Verified on 2026-10-08

Checked by hand in one signed-in desktop session, English locale. The
connector's own code has not run against discord.com.

- The client uses XHR for REST under `/api/v9/`; wrapping `open`,
  `setRequestHeader` and `send` captured its headers. It sent `Authorization`,
  `X-Super-Properties`, `X-Installation-ID`, `X-Discord-Locale`,
  `X-Discord-Timezone` and `X-Debug-Options`.
- An idle client sends no REST request. A programmatic click on
  `a[href="/shop"]` made it send about eight within 4 s.
- A same-origin page fetch with the captured headers returned 200 for all four
  requests, 4 to 5 s apart. The fixtures follow the key sets seen.
- A search answer is `{ analytics_id, messages, doing_deep_historical_index,
  total_results, threads, members }`. Each group held one message with
  `hit: true`. A message has no `guild_id`.
- `X-RateLimit-*` response headers are not readable from the page, so the
  connector uses only the status and the body's `retry_after`.
- Signed in, `/channels/@me` stays on that path and
  `section[aria-label="User area"]` is present. `window.localStorage` is
  undefined.

## Unverified

Each of these fails closed: the run ends or the server is skipped with a
reason, and nothing is guessed.

- Signed out, `/channels/@me` is expected to redirect to `/login`.
- The 202, 429 and captcha answers. The handling follows Discord's public API
  documentation.
- Search past the first page: the 25-per-page size, the offset ceiling
  (9,975), and the resume-by-offset walk.
- Whether a search without `include_nsfw` leaves out age-restricted channels.
- The status and code a server returns when its search is refused.
- Whether `/users/@me/guilds` returns every server in one answer for an
  account in more than 200.
- A non-empty `/users/@me/connections` answer. The record follows the
  documented Connection object.
- The mobile WebView: whether discord.com renders the app there at all,
  whether a narrow layout has the Shop link or the user area, and whether the
  history-navigation fallback makes the client send a request. The
  `[data-list-id="guildsnav"]` marker is a guess for layouts and languages
  where the English "User area" label is absent.
- Whether Discord detects the wrapped `XMLHttpRequest` and `fetch` during the
  seconds they are in place.
- On desktop, Patchright's main-world evaluation on discord.com.
- Whether the mobile host merges a scope's records across runs or replaces
  them. An incremental run emits only new messages.
- More than one page of the owner's messages deleted from a server between
  two runs of an unfinished walk can leave a gap in that server.
