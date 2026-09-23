# SYNTHETIC fixtures — not a live capture

`trips.jsonl` and `receipts.jsonl` in this directory are hand-authored
synthetic-but-shape-real records, not derived from a real Uber account
capture. No `PROFILE READY: uber` live session has happened yet.

They exist only to lock the connector's emitted-record shape against
schema drift (see `connectors/uber/synthetic-fixture.test.ts`). They do
not satisfy the connector cutover proof gate's "parser tests over real
captures independent of the implementation" requirement — that
requires a real, scrubbed, reviewed capture under
`fixtures/uber/scrubbed/pilot-real-shape/`, which stays absent until
one exists.

JSONL has no comment syntax, so the SYNTHETIC label lives here rather
than inline in the `.jsonl` files themselves.
