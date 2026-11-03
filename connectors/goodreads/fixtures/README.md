# Goodreads fixtures

Everything here is synthetic. No file was captured from a real account.

- `html/` holds pages written to match the markup of the real Goodreads pages
  (print library list, library sidebar, profile, account settings, sign-in)
  with invented books, authors, a made-up user id (`90000001`) and made-up
  reading-session ids. The parser and collector tests read these.
- `api/` holds answers in the shape of Goodreads' GraphQL API (the shelvings,
  shelves and tags lists) for the same invented library, and a book page whose
  `__NEXT_DATA__` carries an unsigned, made-up token. The shelvings agree with
  the print pages on every book's shelf, tags and rating, as the collector
  requires.
- `scrubbed/pilot-real-shape/records/` holds one record file per stream, built
  by running the collector over `html/` and `api/`. `pilot-fixture.test.ts` validates each
  row against `schemas.ts`.

The library pages cover: a rated and an unrated book; one and two authors, with
and without the Goodreads Author marker; a review with line breaks; private
notes and `None`; two reading sessions, a start-only session, a finish-only
session and an empty unsaved session; full, month and year dates and an
`unknown` publication date; exclusive shelves, a custom exclusive shelf and
tags; a last page and a page past the end.

The sidebar lists exclusive shelves above the grey divider and tags below it.
The collector reads only its "All (N)" count; the shelves come from `api/`.
