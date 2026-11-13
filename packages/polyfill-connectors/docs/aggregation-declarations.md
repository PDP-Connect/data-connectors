# Aggregation declarations

A stream declares the aggregates a client requests in `query.aggregations` of its entry in `connectors/<key>/manifest.json`. The manifests are the inventory; this note holds the rules that the checks enforce. The authoring guidance for choosing fields is in [connector-authoring-guide.md](connector-authoring-guide.md) (the query affordances section).

Keys that manifests use:

| Key | Meaning |
|---|---|
| `count` | Count of records. Must be `true` for any grouping. |
| `sum`, `min`, `max` | Numeric or date fields to aggregate. |
| `count_distinct` | Fields to count distinct values of. |
| `group_by` | Scalar fields to group counts by. |
| `group_by_time` | Date or date-time string fields to bucket counts by time. |

Rules checked by `packages/polyfill-connectors/src/query-affordance-manifest-honesty.test.ts`:

1. A stream that declares `group_by` or `group_by_time` also declares `count: true`.
2. Each `group_by_time` field exists in `schema.properties` and is a date or date-time string. The aggregate engine rejects an integer epoch field.
3. A useful field without a declared affordance is listed, with a reason, in `packages/polyfill-connectors/src/query-affordance-allowlist.ts`. The test fails when an allowlist entry is stale.

A stream declares a single-stream aggregate only. Cross-stream summaries, joins, percentiles and arbitrary expressions have no declaration key.
