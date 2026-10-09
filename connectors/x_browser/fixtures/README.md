# X browser fixtures

Synthetic. No real account, post, handle, name or media address. Hosts are `*.example.invalid`; handles are `sample_owner`, `example_writer`, `sample_gardener` and `example_brand`.

Each file is the body of one GraphQL response the x.com web app requests for the signed-in owner (`GET /i/api/graphql/<queryId>/<Operation>`, over XMLHttpRequest). The envelopes and key names follow what x.com served one account on 2026-10-08; every value is invented. Where a shape was not seen on x.com, the list below says so.

- `user-by-screen-name.json`: `UserByScreenName`, `data.user.result`, with the keys seen on x.com: `profile_bio{description, entities}`, `website{url}`, `relationship_counts{followers, following}`, `tweet_counts{media_tweets, tweets}`, `action_counts{favorites_count}`, `verification{verified}`, `privacy{protected}`. There is no `legacy` object.
- `user-originals-timeline-page-1.json`: `UserOriginalsTimeline`, the profile's Posts tab. A pinned post (`TimelinePinEntry`), a post with a photo, a link and a hashtag, a promoted post, a long post whose full text is in `note_tweet`, a who-to-follow module, a quote, a post inside `TweetWithVisibilityResults`, a tombstone, and the two cursors. The pin instruction, the visibility wrapper and the tombstone are from known shapes, not from the capture.
- `user-replies-timeline-page-1.json`: `UserRepliesTimeline`, the Replies tab. Two conversation modules, each another account's post and the owner's reply, and one of the owner's original posts between them.
- `likes-page-1.json`, `likes-page-2.json`: `Likes`. Two pages, so that two pages exercise pagination. The posts' ids are not in list order: likes are listed in the order they were made.
- `bookmarks-page-1.json`: `Bookmarks`, whose envelope is `data.bookmark_timeline_v2.timeline`, not the user timeline's.
- `error-body.json`: `errors` with no `data`, the body of a refused request.

The last page of each list (cursors only, no posts) is built by the tests and by `scripts/pageshim/fixtures/x_browser.mjs`, which also holds the synthetic web app that requests these bodies.
