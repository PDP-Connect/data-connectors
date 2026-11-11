# Readwise Kindle highlights

Collects existing Kindle highlights through the Readwise v2 API into the
`kindle_highlights` stream. It lists Kindle books and follows the export cursor
for their highlights. The connector uses stable provider highlight IDs and
emits provider deletion flags as tombstones.

Provide `READWISE_API_TOKEN` through the connector runtime. This connector
reads Readwise data. It does not start Kindle synchronization or import books.
The manifest declares the Development tier.

The connector tests exercise synthetic API responses, pagination, record
validation, snapshot counts and credential isolation. Run them with
`node --import tsx --test connectors/readwise/index.test.ts` from the repo root.

The icon uses the mark from [Readwise’s Safari pinned-tab SVG](https://d34adp677peecb.cloudfront.net/static/images/favicons/safari-pinned-tab.fea64b2bbb1d.svg),
scaled to a 24 by 24 viewBox with the outer frame removed.
