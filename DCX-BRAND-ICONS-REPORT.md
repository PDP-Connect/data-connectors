# Connector brand icons

## Contract

`brand` is an optional top-level manifest field. A manifest with a legitimately available brand
mark declares one `brand` object immediately after `display_name`:

```json
"brand": {
  "icon": "icons/github.svg",
  "background_color": "#181717"
}
```

`brand.icon` is required *if* `brand` is present, and is a POSIX-relative path below the manifest
directory. `brand.dark_icon` is optional and uses the same path rule. `brand.background_color` is
optional and is an opaque six-digit hex color for an icon tile. The SVG assets are package-local at
`packages/polyfill-connectors/manifests/icons/`; they ship with the manifest registry. The root
manifest schema defines the same field shape for authoring tools.

A manifest with no legitimately available brand mark declares **no `brand` object at all** —
this is not an error state. As of the ICON-ART-0918 pass, 10 connectors had no `brand` block
because no real mark was available from simple-icons (verified against v16.31.0's full export
list; several were removed after brand-owner trademark objections or product retirement), and
per this project's own posture a hand-drawn placeholder is worse than no logo at all.

The ICON-SOURCES-0918 pass checked two further vendored, offline, build-time-only sources
(home-assistant/brands and `@iconify/json`'s `logos` collection) and recovered 2 of the 10:
`codex` and `slack` now ship real marks sourced from `logos` (CC0), normalized to this fleet's
monochrome convention. The remaining 8 — `heb`, `google_takeout`, `oura`, `pocket`, `usaa`,
`wholefoods`, `whoop`, `ynab` — still have no `brand` block and fall through to the console's
deterministic monogram; none of the three sources checked has a legitimate mark for them
(`oura`/`whoop` exist in home-assistant/brands but as PNG only, incompatible with this
manifest schema's SVG-only `brand.icon` path pattern). See `NOTICE`,
`/home/tnunamak/code/pdpp/local/ICON-ART-0918.md` for the original per-connector verdict, and
`/home/tnunamak/code/pdpp/local/ICON-SOURCES-0918.md` for the full source research, coverage
numbers, and the recommended resolver chain for connectors added in the future.

`connector-index.json` derives, rather than duplicates, this declaration in `brandIcons[connector_id]`. In the current polyfill manifest format, `connector_id` is the stable registry URI:

```json
"https://registry.pdpp.dev/connectors/github": {
  "url": "https://raw.githubusercontent.com/PDP-Connect/data-connectors/SOURCE_COMMIT/packages/polyfill-connectors/manifests/icons/github.svg",
  "backgroundColor": "#181717"
}
```

When declared, `dark_icon` becomes `darkUrl`. URLs are pinned to the source commit that supplied the assets, so a released index cannot silently change when `main` moves. The index gives browser consumers a fetchable icon URL without a checkout of connector source.

## Console consumption

`ConnectorIcon` should accept the manifest's `connector_id` and the loaded connector index, then look up `index.brandIcons[connectorId]`. Render `darkUrl` on a dark surface when present; otherwise render `url`. Apply `backgroundColor` only to the tile background. Treat the SVG image as decorative (`alt=""` or `aria-hidden`) because the adjacent connector name provides the accessible label. Use the existing letter monogram whenever `index.brandIcons[connectorId]` has no entry — whether because the index is unavailable, a legacy connector predates the index, or (as of ICON-ART-0918) a connector has no legitimately available brand mark and intentionally ships no `brand` block. Do not maintain a second platform-logo map or copy SVG markup into the console.

Use this component on source cards, source-detail setup, and consent cards so all console surfaces share the manifest-derived identity.
