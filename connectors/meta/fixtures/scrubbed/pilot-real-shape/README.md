Provenance (2026-09-22 live run against an authenticated account):

- `profile.jsonl`, `following.jsonl`, `ads.jsonl` — real-derived. Scrubbed
  from an actual live capture (`connector-dev.ts meta`, single owner
  account). Third-party usernames, full names, and signed CDN image URLs
  are replaced with `[REDACTED_NAME]` / `[REDACTED_URL]`; ids, structural
  fields (kind, is_private, is_verified), and non-identifying category
  text are left as observed.
- `posts.jsonl`, `post_likes.jsonl` — synthetic-but-shape-calibrated. The
  live account has zero posts, so there is no real record to scrub for
  these two streams. Field shapes and value ranges are calibrated against
  the real `xdt_api__v1__feed__user_timeline_graphql_connection` envelope
  this connector proved live (see `connectors/meta/index.ts`'s
  `fetchAllPosts` header note and the connector cutover report's Live
  evidence section) — not fabricated from documentation alone — but no
  field value in these two files came from a real post.

Locks the connector's emitted-record shape against schema drift per
`docs/reference/connector-authoring-guide.md` §9.1. Replaces the interim
`connectors/meta/__fixtures__/synthetic/` fixtures now that real capture
exists for 3 of 5 streams.
