# Discord browser fixtures

Synthetic. No real account, server, message or credential. Every id is an
invented snowflake whose timestamp bits match the fixture's own dates.

- `user-me.json`: `GET /users/@me`. The key set matches what discord.com
  returned to a signed-in session on 2026-10-08, without `vad_colors`.
- `guilds.json`: `GET /users/@me/guilds`, the partial Guild objects with the
  keys observed that day.
- `connections.json`: `GET /users/@me/connections`. Not observed (the account
  had none); it follows the documented Connection object. One entry carries
  an invented `access_token`, which a record must never contain.
- `search-messages.json`: `GET /guilds/{id}/messages/search`. The envelope
  and message keys match the answer observed that day. Two groups also hold a
  context message from another author, which was not observed and comes from
  Discord's documentation; one hit is by another author. Neither may reach a
  record.
- `search-empty.json`: the same envelope with no results.
- `search-index-not-ready.json`, `rate-limited.json`, `captcha-required.json`,
  `missing-access.json`, `unauthorized.json`: error bodies from Discord's
  public API documentation. None was observed.
