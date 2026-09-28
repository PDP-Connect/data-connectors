# Synthetic split-export fixture

This fixture is **synthetic**. Every value is invented. The entry names, the
category ZIP names, and the JSON key names match a real Claude export
observed on 2026-09-22. No real values are included.

In that layout, Claude delivers a manifest JSON (`manifest.json` here) and
one ZIP per category. Each directory `<category>-000/` holds the entries of
`<category>-000.zip`, with the same entry names:

| ZIP | Entries |
|---|---|
| `light_metadata-000.zip` | `users.json`, `login_history.json` |
| `conversations-000.zip` | `conversations.json` |
| `projects-000.zip` | `projects/<uuid>.json` |
| `memories-000.zip` | `memories/<uuid>.json` |
| `design_chats-000.zip` | `design_chats/<uuid>.json` |

`integration.test.ts` builds the ZIPs from these directories at test time.
The manifest's `export_url` values are placeholders.
