# SYNTHETIC fixtures

Every record under `records/*.jsonl` in this directory is **SYNTHETIC**:
hand-authored, shape-real data with no connection to any real Claude Code
account. `provenance.json` labels the set `"class": "synthetic"`.

This directory exists because `fixtures/claude_code/scrubbed/pilot-real-shape/`
is reserved for reviewed, real-derived captures (see
`docs/connector-authoring-guide.md` §9.1) and must not hold synthetic data.
`pilot-real-shape/` stays absent for this connector until a real capture is
taken (`PDPP_CAPTURE_FIXTURES=1`), scrubbed, and reviewed.

`connectors/claude_code/pilot-fixture.test.ts` locks the connector's
emitted-record shape against this SYNTHETIC set as an interim schema-drift
gate. It does not satisfy the "Preview" conformance tier's pilot-fixture
proof requirement (`CONNECTOR-CHECKLIST.md`), which requires a real capture.
