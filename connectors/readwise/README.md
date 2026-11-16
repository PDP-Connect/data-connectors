# Readwise

Collects the sources and highlights stored in Readwise through its v2 Highlight
EXPORT API. The `books` stream includes books, articles and other sources.
The `highlights` stream retains its source ID and title. Both streams use stable
Readwise IDs and support incremental collection. Historical backfills also
request provider deletions so they can advance already synced streams safely.

Provide `READWISE_ACCESS_TOKEN` through the connector runtime. The manifest
declares the Development tier. Text fields and tags use the reversible
`pdpp-safe-escape-v1` encoding for forbidden control characters, lone surrogates and
backslashes that would otherwise be interpreted as escapes. Other text is
preserved.

Run `node --import tsx --test connectors/readwise/{api,index}.test.ts` from the
repository root to check the synthetic API and collection fixtures.

The icon uses the mark from [Readwise’s Safari pinned-tab SVG](https://d34adp677peecb.cloudfront.net/static/images/favicons/safari-pinned-tab.fea64b2bbb1d.svg),
scaled to a 24 by 24 viewBox with the outer frame removed.
