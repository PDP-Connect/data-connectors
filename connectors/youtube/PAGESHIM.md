# YouTube on PageShim

The explicit entry forwards saved state and the host's state capability to the
shared runtime. The six non-history streams reuse the Desktop collector and its
source-evidence checks: profile, subscriptions, playlists, playlist_items, likes,
and watch_later. Connector-local adapters implement count/click/readiness using
evaluate and use bounded local sleeps; no missing facade member is probed.

Record IDs use WebCrypto SHA-256 with the same 24-hex-character IDs as Desktop.
Timing uses the browser/global performance clock. Desktop response correlation,
history traversal limits, and completeness checks are unchanged.

## History limitation

Mobile currently reads at most 50 already-rendered history rows, only after the
target page's authenticated session and page-wall checks. A selected,
source-proven empty history can acknowledge an empty checkpoint. A nonempty
prefix emits inventory_not_proven_complete with retry_by_runtime and no STATE,
even if a saved cursor claims a prior complete inventory. Full continuation
traversal is not supported by this adapter: the facade lacks response events,
and a direct in-page browse fetch needs equivalent owner-bound response parsing
and row accounting before it can replace Desktop's correlated response/DOM proof.

The existing shared PageShim runtime does not classify
inventory_not_proven_complete as partial. A regression test deliberately exposes
its incorrect Complete status for a nonempty prefix. This is a shared-runtime
integration blocker, not permission to relabel ordinary incomplete inventory as
a genuine stream failure or emit an unsupported checkpoint.

## Device validation still required

Fixtures are synthetic Chromium harness evidence, not a real mobile device run.
Verify mobile WebView DOM/layout parity (especially m.youtube.com redirects),
account-menu click behavior, login/consent walls and session loss, WebCrypto
availability, evaluate size/30-second call limits under slow networks, real
playlist/subscription continuation and exhaustion evidence, and accepted STATE
persistence on supported hosts. Do not claim a full history export from this port.
