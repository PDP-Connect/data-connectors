# DCX icon quality report

Audit date: 2026-09-03. Scope: the 45 assets referenced by root `connector-index.json` `brandIcons`.

**Stale as of ICON-ART-0918 (2026-09-18):** 10 of these entries (codex, heb, google_takeout,
oura, pocket, slack, usaa, wholefoods, whoop, ynab) were dropped from `brandIcons` entirely —
no legitimate mark was available in simple-icons, so those manifests shipped no `brand` block
and fell through to the console's monogram instead. `brandIcons` dropped to 35 entries.

**Superseded by ICON-SOURCES-0918 (2026-09-18):** `codex` and `slack` are restored — real
marks exist in `@iconify/json`'s CC0 `logos` collection, vendored and normalized to this
fleet's monochrome convention. `brandIcons` now has 37 entries; `heb`, `google_takeout`,
`oura`, `pocket`, `usaa`, `wholefoods`, `whoop`, `ynab` remain monogram-only (checked against
simple-icons, home-assistant/brands, and `@iconify/json`'s `logos` collection — no legitimate
mark available in any of the three). See `/home/tnunamak/code/pdpp/local/ICON-SOURCES-0918.md`.

The fleet now uses square viewBoxes, no fixed root dimensions, no scripts, external references, images, or text, and explicit root ink. The console renders these marks on each manifest's opaque `background_color`; the white monochrome foreground is therefore legible on dark surfaces without a duplicate dark asset. `dark_icon` remains available for a future surface that does not render the tile.

| Icon | Status | Source / licence | Dark-surface result |
| --- | --- | --- | --- |
| amazon | Corrected orange-on-orange glyph to white | Retained Amazon glyph; existing repository asset | White on `#FF9900` tile |
| anthropic | Replaced placeholder radial mark | [Simple Icons: Anthropic](https://simpleicons.org/?q=anthropic), CC0-1.0 | White tile glyph |
| apple_contacts | Replaced generic contact card | [Simple Icons: Apple](https://simpleicons.org/?q=apple), CC0-1.0 | White tile glyph |
| apple_health | Replaced generic health heart | Simple Icons: Apple, CC0-1.0 | White tile glyph |
| apple_photos | Replaced generic photo card | Simple Icons: Apple, CC0-1.0 | White tile glyph |
| chase | Replaced generic bank building | [Simple Icons: Chase](https://simpleicons.org/?q=chase), CC0-1.0 | White tile glyph |
| chatgpt | Retained recognisable knot; padded square viewBox | Existing repository asset | Manifest tile provides contrast |
| claude_code | Replaced star/code stand-in | [Simple Icons: Claude](https://simpleicons.org/?q=claude), CC0-1.0 | White tile glyph |
| codex | Retained clean `<>` typographic monogram | Local monogram, Apache-2.0 | White stroke |
| doordash | Replaced same-colour fill with monochrome glyph | [Simple Icons: DoorDash](https://simpleicons.org/?q=doordash), CC0-1.0 | White tile glyph |
| github | Replaced coloured copy with monochrome glyph | [Simple Icons: GitHub](https://simpleicons.org/?q=github), CC0-1.0 | White tile glyph |
| gmail | Replaced generic envelope | [Simple Icons: Gmail](https://simpleicons.org/?q=gmail), CC0-1.0 | White tile glyph |
| google_calendar | Replaced generic calendar | [Simple Icons: Google Calendar](https://simpleicons.org/?q=googlecalendar), CC0-1.0 | White tile glyph |
| google_contacts | Replaced generic contact card | [Simple Icons: Google](https://simpleicons.org/?q=google), CC0-1.0 | White tile glyph |
| google_maps | Replaced generic pin | [Simple Icons: Google Maps](https://simpleicons.org/?q=googlemaps), CC0-1.0 | White tile glyph |
| google_maps_data_portability | Replaced generic pin/export | Simple Icons: Google Maps, CC0-1.0 | White tile glyph |
| google_messages | Replaced generic bubble | [Simple Icons: Google Messages](https://simpleicons.org/?q=googlemessages), CC0-1.0 | White tile glyph |
| google_takeout | Retained recognisable export-box mark | Existing repository asset | Explicit white root fill |
| groupme | Replaced generic people mark | [Simple Icons: GroupMe](https://simpleicons.org/?q=groupme), CC0-1.0 | White tile glyph |
| heb | Replaced ambiguous blocks with `HEB` monogram | Local typographic monogram, Apache-2.0 | White stroke |
| ical | Replaced generic calendar | Simple Icons: Apple, CC0-1.0 | White tile glyph |
| imessage | Replaced generic bubble | Simple Icons: Apple, CC0-1.0 | White tile glyph |
| jellyfin | Replaced generic play diamond | [Simple Icons: Jellyfin](https://simpleicons.org/?q=jellyfin), CC0-1.0 | White tile glyph |
| linkedin | Retained recognisable official mark; padded square viewBox | Existing repository asset | White `in` remains visible |
| loom | Replaced generic concentric circles | [Simple Icons: Loom](https://simpleicons.org/?q=loom), CC0-1.0 | White tile glyph |
| meta | Replaced Instagram-like stand-in | [Simple Icons: Meta](https://simpleicons.org/?q=meta), CC0-1.0 | White tile glyph |
| netflix_export | Replaced generic film strip | [Simple Icons: Netflix](https://simpleicons.org/?q=netflix), CC0-1.0 | White tile glyph |
| notion | Replaced hand-drawn `N` tile | [Simple Icons: Notion](https://simpleicons.org/?q=notion), CC0-1.0 | White tile glyph |
| oura | Retained ring monogram; corrected invisible dark stroke | Local `O` monogram, Apache-2.0 | White stroke |
| pocket | Retained recognisable Pocket mark | Existing repository asset | Explicit white root fill |
| reddit | Replaced hand-drawn alien | [Simple Icons: Reddit](https://simpleicons.org/?q=reddit), CC0-1.0 | White tile glyph |
| shopify | Replaced incorrect non-square mark | [Simple Icons: Shopify](https://simpleicons.org/?q=shopify), CC0-1.0 | White tile glyph |
| signal | Replaced generic checked bubble | [Simple Icons: Signal](https://simpleicons.org/?q=signal), CC0-1.0 | White tile glyph |
| slack | Replaced monochrome imitation | Existing Slack mark, normalized to explicit white fill | White tile glyph |
| spotify | Replaced coloured source; square viewBox | [Simple Icons: Spotify](https://simpleicons.org/?q=spotify), CC0-1.0 | White tile glyph |
| steam | Replaced black-on-dark source | [Simple Icons: Steam](https://simpleicons.org/?q=steam), CC0-1.0 | White tile glyph |
| strava | Replaced generic lightning bolt | [Simple Icons: Strava](https://simpleicons.org/?q=strava), CC0-1.0 | White tile glyph |
| twitter_archive | Replaced drawn X | [Simple Icons: X](https://simpleicons.org/?q=x), CC0-1.0 | White tile glyph |
| uber | Replaced black wordmark source | [Simple Icons: Uber](https://simpleicons.org/?q=uber), CC0-1.0 | White tile glyph |
| usaa | Replaced generic bank building | Local `USAA` typographic monogram, Apache-2.0 | White stroke |
| venmo | Replaced coloured tile copy | [Simple Icons: Venmo](https://simpleicons.org/?q=venmo), CC0-1.0 | White tile glyph |
| whatsapp | Replaced coloured tile copy | [Simple Icons: WhatsApp](https://simpleicons.org/?q=whatsapp), CC0-1.0 | White tile glyph |
| wholefoods | Replaced generic shopping bag | Local `WF` typographic monogram, Apache-2.0 | White stroke |
| whoop | Retained recognisable `W` mark | Existing repository asset | White mark remains visible |
| ynab | Replaced generic pig | Local `YNAB` typographic monogram, Apache-2.0 | White stroke |

The source catalogue is [Simple Icons](https://github.com/simple-icons/simple-icons), whose icon set is licensed CC0-1.0. Brand trademarks remain their owners' property; the local monograms intentionally avoid copying unavailable logo artwork.
