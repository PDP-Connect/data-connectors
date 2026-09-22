# Synthetic Anthropic export fixture

`synthetic-export.zip` is a **synthetic, hand-authored** fixture. It is NOT
derived from a real Claude account export and does NOT satisfy the
cut-anthropic proof gate's real-fixture requirement
(`docs/migration/connector-cutover/CONTRACTS.md`, per-connector proof gate
item 2: "Synthetic unit fixtures are allowed only if clearly labelled
synthetic; they do not satisfy the proof gate").

It exists so `parsers.test.ts` can prove the ZIP-read -> parse pipeline end
to end (via `readZipEntriesFromFile`) without a live account or a real
export archive. Its shape (top-level `conversations.json` array,
`projects/<uuid>.json` per-project files, each project's `docs[]` array) is
modeled on the legacy prior art at `connectors/anthropic/claude-export-
ingest.cjs` and its test fixtures
(`connectors/anthropic/__tests__/claude-export-ingest.test.cjs`), not on a
captured real payload.

Regenerate it with:

```
node --import tsx connectors/anthropic/__fixtures__/synthetic/build-fixture.ts
```

Real-fixture proof is PENDING: `$PRIV/exports/anthropic/` does not exist
yet (confirmed via `ls` at task start — Tim's real export has not landed).
Once a real export lands, scrub it per `docs/connector-authoring-guide.md`
§9.1 and commit it under
`fixtures/anthropic/scrubbed/pilot-real-shape/` — NOT this directory.
