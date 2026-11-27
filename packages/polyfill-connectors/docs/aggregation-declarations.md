# Aggregation declarations

A stream declares the aggregates a client can request in `query.aggregations` of its entry in `connectors/<key>/manifest.json`. This page lists the keys and the rules that the checks enforce. The guidance for choosing fields is in [Search and filter declarations](connector-authoring-guide.md#4b-search-and-filter-declarations).

## Manifest keys

| Key | Meaning |
|---|---|
| `count` | Count of records. |
| `sum`, `min`, `max` | Numeric or date fields to aggregate. |
| `count_distinct` | Fields to count distinct values of. |
| `group_by` | Scalar fields to group counts by. |
| `group_by_time` | Date or date-time string fields to bucket counts by time. |

## Declaration rules

1. A stream that declares `group_by` or `group_by_time` also declares `count: true`.
2. Each `group_by_time` field exists in `schema.properties` and is a date or date-time string. The aggregate engine rejects an integer epoch field.
3. A field that looks useful for search, range filters, time buckets or grouped counts, but that the stream does not declare for that use, is listed with a reason in `packages/polyfill-connectors/src/query-affordance-allowlist.ts`. The test fails when an entry is stale, which means the manifest now declares it or the stream or field is gone.

`packages/polyfill-connectors/src/query-affordance-manifest-honesty.test.ts` checks these rules.

A stream declares a single-stream aggregate only. Cross-stream summaries, joins, percentiles and arbitrary expressions have no declaration key.
