# Add a connector to mobile

## Runtime binding features

`runtime_requirements.bindings.<binding>.features` lists the host capabilities a connector needs for each binding. The feature names are host-neutral capabilities, not PageShim method names:

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

PageShim does not implement the last four features yet (Collection Profile
Section 3.3.8); they are part of the shared vocabulary so a connector can
declare them, and a host that does not support them is simply ineligible for
that connector, the same as any other unsupported feature.

The enum is defined in `schemas/connector-manifest.schema.json`; the catalog and implementation-index schemas reference that shared definition. A host declares support with a set of feature names for each binding. PageShim's binding-to-feature support map is in `scripts/pageshim/capabilities.mjs`; another host publishes its own map. Eligibility requires every required binding and declared feature to be supported.

1. **Declare the host features the connector needs.** In `manifest.json`, list every required host binding under `runtime_requirements.bindings` and add its required features. Do not add a mobile-enabled flag. A connector stays out of the mobile build until PageShim supports every required binding and feature.
2. **Expose the connector's standard browser hooks and manifest data.** A generic entry reads stream names from `manifest.streams`, and reads its scope prefix, login URL, probe export, and collect export from `manifest.mobile.pageshim`. Keep an entry file only when it must preserve a real host or output exception. Give the connector a scrubbed fixture in `scripts/pageshim/fixtures/` and expected scope summaries.
3. **Run the local build and harness.** Run `npm run mobile:bundle -- <connector>`. This developer convenience builds the bundle, runs the PageShim harness against those exact bytes, then prints the file path, byte size, and SHA-256. The artifact is written under `.tmp/mobile-connectors/`.
4. **Use the current mobile catalog handoff.** Until the signed artifact path is available, copy the verified bundle to `unity-surfaces/apps/mobile/public/connectors/`, add or update its row in `index.json`, and point `scriptUrl` at the bundle. The app fetches the row and script from the same catalog origin.
5. **Let publish CI build mobile-capable connectors.** The #267 packaging path runs for each selected connector. It derives capability from the declared requirements, builds and harnesses eligible bundles, then attaches them to the connector's existing OCI assets layer. The connector's OCI digest and Cosign signature cover the mobile bytes with the desktop release. The mobile catalog can resolve the bundle from that signed artifact instead of copying a standalone JavaScript file.

The binding names describe broad services such as `browser`, `network`, `filesystem`, and `desktop_session`; feature names describe the specific capabilities a connector needs from a host. The current harness is synthetic; it does not prove provider behavior on a device.
