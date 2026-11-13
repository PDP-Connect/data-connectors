# Add a connector to mobile

You have a working browser connector and want it in the mobile app build. You will finish with a connector that `npm run mobile:bundle` builds and passes the PageShim harness.

## Declare runtime binding features

`runtime_requirements.bindings.<binding>.features` lists the host capabilities a connector needs for each binding. The feature names are host-neutral capability names:

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
| `page_input` | Interact with the active page: click and type. |
| `cookie_read` | Read the active page's cookie jar. |
| `page_response_observation` | Observe page network responses, including response body content. |
| `host_cookie_jar_request` | Make an HTTP request from the host runtime using the active page's cookie jar. |

The mobile host (PageShim) does not provide `page_input`, `cookie_read`, `page_response_observation` and `host_cookie_jar_request`. A connector that declares any of them is ineligible for the mobile build.

The feature enum is defined in `schemas/connector-manifest.schema.json`; the catalog and implementation-index schemas reference that definition. The binding-to-feature support map of PageShim is in `scripts/pageshim/capabilities.mjs`; another host publishes its own map. A connector is eligible when the host supports every required binding and every declared feature. The binding names describe broad services (`browser`, `network`, `filesystem`, `desktop_session`); the feature names describe the specific capabilities a connector needs from a host.

1. In `connectors/<connector>/manifest.json`, list every required host binding under `runtime_requirements.bindings` and add its required features. Do not add a mobile-enabled flag. A connector stays out of the mobile build until PageShim supports every required binding and feature.
2. Make every stream in `manifest.streams` available to PageShim. A generic entry reads its scope prefix, login URL, probe export and collect export from `manifest.mobile.pageshim` in the manifest. An entry file in `scripts/pageshim/entries/` receives the streams as `PAGESHIM_CONNECTOR_STREAMS`; keep one only when the connector needs a host or output exception. Add a scrubbed fixture in `scripts/pageshim/fixtures/` and the expected scope summaries. The PageShim gate fails when a bundle refuses or cannot run a manifest stream.
3. Run `npm run mobile:bundle -- <connector>` from the repo root. The command builds the bundle, runs the PageShim harness against those exact bytes, writes the bundle to `.tmp/mobile-connectors/<connector>.js`, and prints the file path, size in bytes and SHA-256. If it prints that the connector does not declare only PageShim-supported runtime bindings, return to step 1.
4. Open the PR. The publish workflow (`.github/workflows/publish-polyfill-connectors.yml`) builds the bundle of each eligible connector with `scripts/pageshim/attach-to-artifact.mjs` and attaches it to the connector's OCI assets layer, so the connector's digest and signature cover the mobile bytes with the desktop release.

The harness replays recorded fixtures. It does not prove provider behavior on a device.
