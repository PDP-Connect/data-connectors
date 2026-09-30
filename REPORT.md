# ChatGPT mobile preparation

## Progress

- Fetched `origin` and based `waspflow/m5-chatgpt-mobile` on `origin/main` (`37a3ed83e674f977b5eab525262c1ddd7a38e903`).
- Added ChatGPT 0.2.12 to the PageShim target with synthetic fixtures and harness cases.
- Removed the entry’s default 50-detail limit. A host can opt into bounded runs with `PDPP_CHATGPT_MAX_DETAIL_FETCHES_PER_RUN`; the tail-gap bound is also opt-in.
- Passed lane context directly through ChatGPT detail requests so the PageShim bundle does not depend on Node `AsyncLocalStorage`.
- Compared the production 4.0.0 script inside `artifacts/chatgpt-playwright/chatgpt-playwright-4.0.0.tgz` (`./script.js`) with PDPP record schemas. The separately referenced `vana-com/unity-surfaces/apps/mobile/public/connectors/chatgpt-4.0.0.js` clone path is absent from this worktree; the packaged production script was available and inspected without outputting record data.

## Production mobile payload vs PDPP records

Production 4.0.0 declares two scopes: `chatgpt.conversations` and `chatgpt.memories`. The production script returns each as a scope object with a list and `total`; PDPP emits rows in streams. PDPP 0.2.12 also has `messages`, `custom_gpts`, `custom_instructions`, and `shared_conversations`, which have no equivalent production 4.0.0 scope.

### `chatgpt.conversations`

Production scope shape: `{ conversations, total }`. The script’s conversation records have `id`, `title`, `create_time`, `update_time`, `message_count`, `messages`, and `fetched_at`. Each nested message has `id`, `role`, `content`, `content_type`, `create_time`, and `model`.

PDPP emits conversation rows with `id`, `title`, `create_time`, `update_time`, `is_archived`, `is_starred`, `workspace_id`, `current_node`, `message_count_on_current_branch`, and `gizmo_id`. Messages are separate rows with `id`, `conversation_id`, `parent_id`, `children_ids`, `role`, `content`, `content_type`, `model_slug`, `create_time`, `finish_reason`, `citations`, `tool_calls`, `attachment_ids`, and `on_current_branch`.

Exact differences the shared adapter must handle:

- Wrap rows as `{ conversations, total }`; join `messages` rows by `conversation_id` into each conversation’s `messages` array.
- Map `message_count_on_current_branch` to `message_count` and `model_slug` to nested `model`.
- Legacy-only conversation keys: `message_count`, nested `messages`, and `fetched_at`. `fetched_at` is emitted by the script but absent from the production scope schema (`additionalProperties: false`), so the adapter must omit it for schema-valid payloads.
- PDPP-only conversation keys: `is_archived`, `is_starred`, `workspace_id`, `current_node`, `message_count_on_current_branch`, and `gizmo_id`.
- PDPP-only message keys: `conversation_id`, `parent_id`, `children_ids`, `model_slug`, `finish_reason`, `citations`, `tool_calls`, `attachment_ids`, and `on_current_branch`.
- The legacy script exports only non-empty text from user/assistant messages on the current branch when content type is `text` or `multimodal_text`. PDPP records broader roles/content and preserve branch/tool/citation metadata. `message_count` is the length of the legacy script’s filtered `messages` array, so it may differ from the PDPP branch count.

### `chatgpt.memories`

Production scope shape: `{ memories, total }`. Per-memory keys are `id`, `content`, `created_at`, `updated_at`, and `type`, matching the PDPP field names. The adapter must wrap rows and provide `total`.

The production script normalizes absent `id`/`content` to empty strings, fills missing `created_at` with the current time, and defaults `type` to `memory`; `updated_at` can be absent. PDPP allows nullable timestamps and type, and does not require those production defaults. The adapter must satisfy the production schema’s required `created_at` string if it builds this legacy payload.

Sources: `connectors/chatgpt/manifest.json`, `connectors/chatgpt/schemas.ts`, `connectors/chatgpt/parsers.ts`, `connectors/openai/schemas/chatgpt.conversations.json`, `connectors/openai/schemas/chatgpt.memories.json`, and the packaged 4.0.0 `./manifest.json` and `./script.js`.

## Verification

- Regression was red before the cap change: the 51-conversation harness run returned partial detail coverage at the default cap. It passes with all 51 conversations and messages after the default cap was removed.
- Explicit one-detail bounded mode still returns partial coverage with omitted-tail evidence.
- ChatGPT integration: 204 passed.
- Adaptive lane and send governor: 21 passed.
- ChatGPT PageShim cases: 11 passed, including auth, full walk, and bounded walk.
- `npm run check --workspace @pdpp/polyfill-connectors`: passed.
- `npm run check:noAwaitInLoops-conformance --workspace @pdpp/polyfill-connectors`: passed (443 reviewed locations).
- PageShim build completed; the ChatGPT bundle only stubs Node-only modules and does not stub `async_hooks`.

No legacy conversion was implemented. The shared adapter should build the legacy wrappers, nest messages, map `model_slug` and the message count, and omit PDPP-only fields. The 4.0.0 production script does not support the other four PDPP streams.

STATUS: FINAL
