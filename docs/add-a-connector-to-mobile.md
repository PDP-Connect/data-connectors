# Add a connector to mobile

You have a working browser connector and want it in the mobile app build. You will finish with a connector that `npm run mobile:bundle` builds and that passes the PageShim harness. First check the connector against the [browser connector guidelines](../CONNECTOR-GUIDELINES.md); the mobile app gives the connector only part of the desktop `page`.

## Steps

1. Declare the connector's bindings and features under `runtime_requirements.bindings` in `connectors/<connector>/manifest.json`, as [the next section](#declare-runtime-binding-features) shows. The mobile build takes a connector only when all of these hold.
   1. The `browser` binding is required.
   2. The `network` binding is required, or the `browser` features include `page_script_evaluation`.
   3. Each required binding lists at least one feature.
   4. The mobile app provides every binding and feature the manifest declares.
2. Add a `mobile.pageshim` entry to the manifest. A connector without one stays out of the mobile build. The generic entry reads the scope prefix, sign-in URL, sign-in message, probe export and collect export from it; `connectors/character_ai/manifest.json` is a working example. Write an entry file in `scripts/pageshim/entries/` and name it in `mobile.pageshim.entry` only when the connector needs something the generic entry does not do, such as a different output shape or a host method the facade does not offer. The entry receives the manifest's streams as `PAGESHIM_CONNECTOR_STREAMS` and must serve every one.
3. Add a fixture in `scripts/pageshim/fixtures/` with the expected scope summaries. `scripts/pageshim/fixtures/character_ai.mjs` is a working example; its pages and API responses are synthetic. Never put real account data in a fixture.
4. Run `npm run mobile:bundle -- <connector>` from the repository root. The command builds the bundle, runs the PageShim harness against those exact bytes, writes the bundle to `.tmp/mobile-connectors/<connector>.js`, and prints the file path, size in bytes and SHA-256. You are done when it prints those three values. If it says the connector does not declare only PageShim-supported runtime bindings, go back to step 1.
5. Open the PR. When it merges, the publish workflow (`.github/workflows/publish-polyfill-connectors.yml`) attaches the bundle to the connector's artifact, if the connector is published and its version is new. [publishing.md](publishing.md) describes publication.

The harness runs the bundle against fixture responses. It does not show that the site behaves the same on a real device.

## Declare runtime binding features

A binding is a broad service that the connector needs from its host, such as `browser`, `network`, `filesystem` or `desktop_session`. A feature is one capability inside a binding. `runtime_requirements.bindings.<binding>.features` lists the features the connector uses. This example is the declaration in `connectors/character_ai/manifest.json`, shortened.

```json
"runtime_requirements": {
  "bindings": {
    "network": { "required": true, "features": ["same_origin_page_fetch"] },
    "browser": { "required": true, "features": ["page_script_evaluation", "page_navigation"] }
  }
}
```

| Feature | What the host does | Mobile app |
| --- | --- | --- |
| `page_navigation` | Navigate the active page to a URL. | yes |
| `page_script_evaluation` | Run script in the active page. | yes |
| `page_content_read` | Read the rendered page content. | yes |
| `page_condition_wait` | Wait until a condition in the active page becomes true. | yes |
| `same_origin_page_fetch` | Fetch same-origin resources from inside the active page. | yes |
| `host_http_request` | Make an HTTP request from the host, outside the page. | yes |
| `host_download_capture` | Capture a file the active page downloads. | only through an adapter for one connector |
| `host_archive_extraction` | Extract a downloaded archive in the host. | only through an adapter for one connector |
| `host_archive_entry_chunk_read` | Read an extracted archive entry in chunks. | only through an adapter for one connector |
| `page_input` | Click and type in the active page. | no |
| `cookie_read` | Read the active page's cookie jar. | no |
| `page_response_observation` | Observe the page's network responses, with their bodies. | no, support is planned |
| `host_cookie_jar_request` | Make an HTTP request from the host with the active page's cookies. | no |

[What runs on desktop and on mobile](../CONNECTOR-GUIDELINES.md#what-runs-on-desktop-and-on-mobile) says what to use instead of each missing feature. `scripts/pageshim/capabilities.mjs` is the current support list, and `schemas/connector-manifest.schema.json` defines the feature names.
