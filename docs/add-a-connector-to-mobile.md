# Add a connector to mobile

You have a working browser connector and want it in the mobile app build. You will finish with a connector that `npm run mobile:bundle` builds and passes the PageShim harness.

## Declare runtime binding features

A binding is a broad service that the connector needs from its host, such as `browser`, `network`, `filesystem` or `desktop_session`. A feature is one specific capability inside a binding. In `connectors/<connector>/manifest.json`, `runtime_requirements.bindings.<binding>.features` lists the features that the connector needs. This example is the declaration of `connectors/character_ai/manifest.json`, shortened.

```json
"runtime_requirements": {
  "bindings": {
    "network": { "required": true, "features": ["same_origin_page_fetch"] },
    "browser": { "required": true, "features": ["page_script_evaluation", "page_navigation"] }
  }
}
```

The feature names are host-neutral capability names.

| Feature | Capability the host provides |
| --- | --- |
| `page_navigation` | Navigate the active page to a URL. |
| `page_script_evaluation` | Run script in the active page context. |
| `page_content_read` | Read rendered page content. |
| `page_condition_wait` | Wait until a condition in the active page becomes true. |
| `same_origin_page_fetch` | Fetch same-origin resources from the active page context. |
| `host_http_request` | Make an HTTP request from the host runtime outside the page context. |
| `host_download_capture` | Capture content downloaded by the active page. |
| `host_archive_extraction` | Extract downloaded archive contents in the host runtime. |
| `host_archive_entry_chunk_read` | Read an extracted archive entry in chunks. |
| `page_input` | Interact with the active page by click and type. |
| `cookie_read` | Read the active page's cookie jar. |
| `page_response_observation` | Observe page network responses, including response body content. |
| `host_cookie_jar_request` | Make an HTTP request from the host runtime using the active page's cookie jar. |

The mobile host (PageShim) does not provide `page_input`, `cookie_read`, `page_response_observation` and `host_cookie_jar_request`. A connector that declares any of them is ineligible for the mobile build. A connector is eligible when PageShim supports every binding it requires and every feature it declares. The support map is `scripts/pageshim/capabilities.mjs`, and the feature list is defined in `schemas/connector-manifest.schema.json`.

1. In `connectors/<connector>/manifest.json`, list every required host binding under `runtime_requirements.bindings` and add its required features. Do not add a mobile-enabled flag. A connector stays out of the mobile build until PageShim supports every required binding and feature.
2. Make every stream in `manifest.streams` available to PageShim. A generic entry reads its scope prefix, login URL, probe export and collect export from `manifest.mobile.pageshim` in the manifest; `connectors/character_ai/manifest.json` is a working example. An entry file in `scripts/pageshim/entries/` receives the streams as `PAGESHIM_CONNECTOR_STREAMS`. Keep one only when the connector needs a host or output exception.
3. Add a scrubbed fixture in `scripts/pageshim/fixtures/` and the expected scope summaries. `scripts/pageshim/fixtures/character_ai.mjs` is a working example. The PageShim gate fails when a bundle refuses or cannot run a manifest stream.
4. Run `npm run mobile:bundle -- <connector>` from the repo root. The command builds the bundle, runs the PageShim harness against those exact bytes, writes the bundle to `.tmp/mobile-connectors/<connector>.js`, and prints the file path, size in bytes and SHA-256. If it prints that the connector does not declare only PageShim-supported runtime bindings, return to step 1.
5. Open the PR. After the merge, the publish workflow (`.github/workflows/publish-polyfill-connectors.yml`) attaches the bundle to the connector's artifact. [publishing.md](publishing.md) describes publication. Before you open the PR, check that step 4 ended with the file path, size and SHA-256.

The harness replays recorded fixtures. It does not prove provider behavior on a device.
