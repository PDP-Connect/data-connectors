# Account identity inventory

This table lists every connector manifest in `connectors/` and says whether the
connector already fetches a stable upstream account id (Collection Profile
Section 3.9, `account_identity`). A host uses that id to tell two accounts of
one connector apart.

## Counts (65 connectors)

| Class | Connectors |
| --- | --- |
| Id already fetched, implemented and declared | 12 |
| Id already fetched, not implemented (follow-up) | 6 |
| Identity response fetched, id field not confirmed (follow-up) | 3 |
| No id found in code | 44 |

"Stable id available" is therefore 18 of 65 (12 implemented), with 3 more likely.

## How the table was made

- "yes" means a file and line show the connector reading a field that is the
  source's own user id, or a committed fixture carries it.
- "probably" means the connector fetches an identity response, but the id field
  inside it is not confirmed by code or a fixture.
- "not found" means a search of the connector's source for user, account,
  profile and `me` reads found none. It is **not** proof that the source
  offers no id. The 44 connectors in this class were searched, not read end to
  end; a follow-up for any of them starts by checking what the provider returns.
- Cited line numbers are for this commit.
- The id must be immutable. A login name, handle or email address does not
  qualify when the source has a numeric or UUID id. `github_browser` reads only
  the login (`github_browser/page-evidence.ts:130`), so it is "not found".

## Rules a connector follows (see Section 3.9 and 5.14)

- Declare `"account_identity": "required"` in the manifest only if every
  successful run can report the id. The host fails a successful run that
  declares the field and sends no id.
- Call `requireAccountIdentity(id)` from `packages/polyfill-connectors/src/account-identity.ts`
  once you have the id, before the first record and before any state write. It
  sends one `ACCOUNT_IDENTITY` message and fails the run with
  `account_identity_missing` when the source gave no usable id. It adds no
  prefix, hash or namespace. It is the only account-identity call: a connector
  cannot report one silently.
- A connector whose id costs an extra request makes that request only if the
  request is trivial, and says so in a comment. GitHub is the one case here.

## Table

| Connector | Stable id | Field | Source | Status |
| --- | --- | --- | --- | --- |
| `amazon` | not found | none read | none | No code path reads a user or account id. Browser or API reads cover the data streams only. |
| `anthropic` | not found | none read | none | No code path reads a user or account id. Browser or API reads cover the data streams only. |
| `anthropic_live` | not found | none read | none | No code path reads a user or account id. Browser or API reads cover the data streams only. |
| `apple_contacts` | not found | none read | none | Calls the provider's data API with a token; no code path reads a user or account id. A stable id would need a new request, and the cheap candidate (an email address) is not immutable. |
| `apple_health` | not found | none read | none | Reads local files or a local database; there is no upstream account to name. |
| `apple_photos` | not found | none read | none | Reads local files or a local database; there is no upstream account to name. |
| `character_ai` | probably | `GET neo.character.ai/user/` in the readiness probe | connectors/character_ai/index.ts:426, 463 | Follow-up. Identity response fetched; the id field is not confirmed. |
| `chase` | not found | none read | none | No code path reads a user or account id. Browser or API reads cover the data streams only. |
| `chatgpt` | yes | `user.id` of the `/api/auth/session` body (same fetch as the bearer token) | connectors/chatgpt/index.ts:8250 (extraction: `pickSession` in `CHATGPT_AUTH_EXTRACTION_EXPRESSION`) | Implemented; declares `account_identity`. |
| `claude_code` | not found | none read | none | Reads local files or a local database; there is no upstream account to name. |
| `codex` | not found | none read | none | Reads local files or a local database; there is no upstream account to name. |
| `discord_browser` | yes | `/users/@me` `id` (snowflake) | connectors/discord_browser/index.ts:918 | Implemented; declares `account_identity`. |
| `doordash` | not found | none read | none | No code path reads a user or account id. Browser or API reads cover the data streams only. |
| `facebook` | yes | `CurrentUserInitialData.USER_ID` | connectors/facebook/collect.ts:1098 | Implemented; declares `account_identity`. |
| `fitbit` | not found | none read | none | Reads a user-supplied export file; no code path reads an account id from it. |
| `garmin_browser` | yes | `userProfilePk` in the HRV summaries response | connectors/garmin_browser/fake-garmin.ts:140 | Follow-up. The parser lists it under "never read" (parsers.ts:13); reading it is a deliberate change to that rule. |
| `github` | yes | `GET /user` `id` | connectors/github/index.ts:661, 668 (one extra `GET /user` when no `user` stream runs) | Implemented; declares `account_identity`. |
| `github_browser` | not found | none read | none | No code path reads a user or account id. Browser or API reads cover the data streams only. |
| `gmail` | not found | none read | none | Calls the provider's data API with a token; no code path reads a user or account id. A stable id would need a new request, and the cheap candidate (an email address) is not immutable. |
| `google_calendar` | not found | none read | none | Calls the provider's data API with a token; no code path reads a user or account id. A stable id would need a new request, and the cheap candidate (an email address) is not immutable. |
| `google_contacts` | not found | none read | none | Calls the provider's data API with a token; no code path reads a user or account id. A stable id would need a new request, and the cheap candidate (an email address) is not immutable. |
| `google_maps` | not found | none read | none | Calls the provider's data API with a token; no code path reads a user or account id. A stable id would need a new request, and the cheap candidate (an email address) is not immutable. |
| `google_maps_data_portability` | not found | none read | none | Calls the provider's data API with a token; no code path reads a user or account id. A stable id would need a new request, and the cheap candidate (an email address) is not immutable. |
| `google_messages` | not found | none read | none | Reads local files or a local database; there is no upstream account to name. |
| `google_takeout` | not found | none read | none | Reads a user-supplied export file; no code path reads an account id from it. |
| `groupme` | not found | none read | none | Calls the provider's data API with a token; no code path reads a user or account id. A stable id would need a new request, and the cheap candidate (an email address) is not immutable. |
| `heb` | not found | none read | none | No code path reads a user or account id. Browser or API reads cover the data streams only. |
| `ical` | not found | none read | none | Reads local files or a local database; there is no upstream account to name. |
| `icloud_notes` | yes | `dsInfo.dsid` from the validate response | connectors/icloud_notes/index.ts:1232 | Implemented; declares `account_identity`. |
| `imessage` | not found | none read | none | Reads local files or a local database; there is no upstream account to name. |
| `instinct` | not found | none read | none | No code path reads a user or account id. Browser or API reads cover the data streams only. |
| `jellyfin` | yes | server user GUID (`AuthenticateByName` `User.Id`, or `/Users`) | connectors/jellyfin/index.ts:1224 | Implemented; declares `account_identity`. |
| `linkedin` | yes | `/voyager/api/me` `miniProfile.dashEntityUrn` (member URN) | connectors/linkedin/index.ts:713 | Follow-up. Read by the session probe, which discards it; `collect` must receive it. |
| `loom` | not found | none read | none | No code path reads a user or account id. Browser or API reads cover the data streams only. |
| `meta` | probably | `/accounts/web_info/` authenticated identity; `PolarisViewer` viewer id | connectors/meta/index.ts:25, 379 | Follow-up. Identity fetched; which field is the immutable id is not confirmed. |
| `muse` | not found | none read | none | No code path reads a user or account id. Browser or API reads cover the data streams only. |
| `netflix_export` | not found | none read | none | Reads a user-supplied export file; no code path reads an account id from it. |
| `notion` | not found | none read | none | Calls the provider's data API with a token; no code path reads a user or account id. A stable id would need a new request, and the cheap candidate (an email address) is not immutable. |
| `oura` | not found | none read | none | Calls the provider's data API with a token; no code path reads a user or account id. A stable id would need a new request, and the cheap candidate (an email address) is not immutable. |
| `oura_browser` | not found | none read | none | No code path reads a user or account id. Browser or API reads cover the data streams only. |
| `perplexity` | probably | `GET /api/auth/session` answers `{ user: ... }` | connectors/perplexity/index.ts:197, 232 | Follow-up. Identity response fetched; the id field inside `user` is not confirmed. |
| `pocket` | not found | none read | none | Calls the provider's data API with a token; no code path reads a user or account id. A stable id would need a new request, and the cheap candidate (an email address) is not immutable. |
| `reddit` | not found | none read | none | No code path reads a user or account id. Browser or API reads cover the data streams only. |
| `shopify` | yes | `viewer.id` in the Apollo state | connectors/shopify/index.ts:560 | Follow-up. Read inside a readiness check that returns a boolean; needs the value returned. |
| `signal` | not found | none read | none | Reads local files or a local database; there is no upstream account to name. |
| `slack` | not found | none read | none | No code path reads a user or account id. Browser or API reads cover the data streams only. |
| `slack_browser` | yes | `auth.test` answer (user and team ids) | connectors/slack_browser/collector.ts:435 | Follow-up. The user id is per workspace, so the right account id (user, or user plus team) is a product decision. |
| `spotify` | yes | profile `id` (Spotify user id) | connectors/spotify/index.ts:526, 2662 | Follow-up. Fetched only when the `profile` stream runs; a run without it needs a trivial extra `/v1/me`. Needs a look at the profile fetch path. |
| `steam` | yes | SteamID64 (vanity names resolved) | connectors/steam/index.ts:951 | Implemented; declares `account_identity`. |
| `strava` | not found | none read | none | Calls the provider's data API with a token; no code path reads a user or account id. A stable id would need a new request, and the cheap candidate (an email address) is not immutable. |
| `strava_browser` | not found | none read | none | No code path reads a user or account id. Browser or API reads cover the data streams only. |
| `tiktok` | yes | `/passport/account/info/v2/` `user_id_str` | connectors/tiktok/index.ts:1266 | Implemented; declares `account_identity`. |
| `twitter_archive` | not found | none read | none | Reads a user-supplied export file; no code path reads an account id from it. |
| `uber` | not found | none read | none | No code path reads a user or account id. Browser or API reads cover the data streams only. |
| `usaa` | not found | none read | none | No code path reads a user or account id. Browser or API reads cover the data streams only. |
| `venmo` | yes | `/account` user `id` | connectors/venmo/index.ts:1018 | Implemented; declares `account_identity`. |
| `whatsapp` | not found | none read | none | Reads a user-supplied export file; no code path reads an account id from it. |
| `whatsapp_web` | not found | none read | none | No code path reads a user or account id. Browser or API reads cover the data streams only. |
| `wholefoods` | yes | Amazon `customerId` from the account page | connectors/wholefoods/index.ts:236-245 | Follow-up. Fetched for the `profile` stream only, and the record falls back to `"me"` when absent; needs the fallback removed first. |
| `whoop` | yes | bootstrap `user.id` | connectors/whoop/index.ts:344 | Implemented; declares `account_identity`. |
| `whoop_browser` | yes | bootstrap `user.id` (`account.user_id`, `profile.user_id` must agree) | connectors/whoop_browser/index.ts:750 | Implemented; declares `account_identity`. |
| `x_browser` | yes | numeric user id in the `twid` cookie (not a credential) | connectors/x_browser/index.ts:2063 | Implemented; declares `account_identity`. |
| `ynab` | not found | none read | none | Calls the provider's data API with a token; no code path reads a user or account id. A stable id would need a new request, and the cheap candidate (an email address) is not immutable. |
| `youtube` | not found | none read | none | No code path reads a user or account id. Browser or API reads cover the data streams only. |
| `youtube_takeout` | not found | none read | none | Reads a user-supplied export file; no code path reads an account id from it. |

## Follow-ups

1. Wire the 6 "yes" connectors above. Each is one reported value plus a fixture test; the notes say what blocks it.
2. For the 3 "probably" connectors, confirm the id field in the recorded response, then wire it.
3. Decide Slack's account id (user id per workspace) before wiring `slack_browser`; `slack` has no `auth.test` read and needs the same decision.
4. For the "not found" API-token connectors (Gmail, Google Calendar, Notion, YNAB, Oura, Strava and the like), check whether the provider returns an immutable user id on a request the connector already makes. Do not use an email address.
