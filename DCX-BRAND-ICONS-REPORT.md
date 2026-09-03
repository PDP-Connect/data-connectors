# Connector brand icons

## Contract

Every shipped manifest in `packages/polyfill-connectors/manifests/` declares one `brand` object immediately after `display_name`:

```json
"brand": {
  "icon": "icons/github.svg",
  "background_color": "#181717"
}
```

`brand.icon` is required and is a POSIX-relative path below the manifest directory. `brand.dark_icon` is optional and uses the same path rule. `brand.background_color` is optional and is an opaque six-digit hex color for an icon tile. The SVG assets are package-local at `packages/polyfill-connectors/manifests/icons/`; they ship with the manifest registry. The root manifest schema defines the same field shape for authoring tools.

`connector-index.json` derives, rather than duplicates, this declaration in `brandIcons[connector_id]`. In the current polyfill manifest format, `connector_id` is the stable registry URI:

```json
"https://registry.pdpp.dev/connectors/github": {
  "url": "https://raw.githubusercontent.com/PDP-Connect/data-connectors/SOURCE_COMMIT/packages/polyfill-connectors/manifests/icons/github.svg",
  "backgroundColor": "#181717"
}
```

When declared, `dark_icon` becomes `darkUrl`. URLs are pinned to the source commit that supplied the assets, so a released index cannot silently change when `main` moves. The index gives browser consumers a fetchable icon URL without a checkout of connector source.

## Console consumption

`ConnectorIcon` should accept the manifest's `connector_id` and the loaded connector index, then look up `index.brandIcons[connectorId]`. Render `darkUrl` on a dark surface when present; otherwise render `url`. Apply `backgroundColor` only to the tile background. Treat the SVG image as decorative (`alt=""` or `aria-hidden`) because the adjacent connector name provides the accessible label. Use the existing letter monogram only when the index is unavailable or a legacy connector has no entry; do not maintain a second platform-logo map or copy SVG markup into the console.

Use this component on source cards, source-detail setup, and consent cards so all console surfaces share the manifest-derived identity.
