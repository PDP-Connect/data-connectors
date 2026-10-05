# Slack (Browser Sign-In)

The browser-session profile of the Slack source. The owner signs in to Slack
in the connector's own browser; collection then calls the Slack Web API from
that signed-in app.slack.com page the way the web client does, with the
session token the client keeps in local storage. Nothing is pasted, and the
token never leaves the page.

`slack` remains the archive profile (slackdump over a pasted token). Both
declare the same source, and every stream this profile declares carries the
archive profile's record contract, so a reader cannot tell which profile
collected a record.

## Streams

| stream | how it is read |
| --- | --- |
| workspace | `auth.test` + `team.info`, one record per signed-in workspace |
| channels | `users.conversations`: every conversation the owner belongs to |
| users | `users.list` |
| messages | `conversations.history` per conversation back to the lookback floor, plus `conversations.replies` for every thread active inside the window |
| message_attachments, reactions, files | derived from each message read |
| user_groups | `usergroups.list` |
| reminders | `reminders.list` |
| stars | `stars.list` |

Not declared: channel_stats, channel_memberships, canvases, dm_read_states.
Each would cost one call per conversation for little the other streams do
not already say.

## Options (environment)

| variable | default | meaning |
| --- | --- | --- |
| `SLACK_LOOKBACK_DAYS` | 7 | how far back each conversation is read; 0 for everything |
| `SLACK_CHANNEL_TYPES` | public,private,im,mpim | which conversation kinds to read |
| `SLACK_CHANNEL_ALLOWLIST` | (all) | channel ids or names to read |
| `SLACK_WORKSPACE` | (all signed in) | one workspace by subdomain, id, name or URL |

## Cursors

Directory streams are full scans gated by a per-record fingerprint, so a
steady-state run emits nothing for them. `messages` keeps the newest ts read
per conversation and the floor it was read down to. A later run reads from a
week before each cursor (late replies and reactions), a first read of a
conversation goes to the floor and then looks a further month below it for
threads still active inside the window, and a run that asks for more history
than the stored floor walks every conversation down again.

## Running locally

```
SLACK_LOOKBACK_DAYS=30 vana connect slack_browser --from <this checkout>
```

or, from `packages/polyfill-connectors`:

```
pnpm exec tsx bin/connector-dev.ts slack_browser
node --test --import tsx ../../connectors/slack_browser/*.test.ts
node --import tsx scripts/conformance.ts slack_browser
```

The first run opens a browser window on the Slack sign-in page. Sign in
there (Google, SSO or password); the connector notices the live session and
continues on its own.
