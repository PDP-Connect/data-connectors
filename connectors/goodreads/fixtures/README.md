# Goodreads fixtures

Everything here is synthetic. No file was captured from a real account.

- `html/` holds pages written to match the markup of the real Goodreads pages
  (print library list, library sidebar, profile, account settings, sign-in)
  with invented books, authors, a made-up user id (`90000001`) and made-up
  reading-session ids. The parser and collector tests read these.
- `scrubbed/pilot-real-shape/records/` holds one record file per stream, built
  by running the parsers over `html/`. `pilot-fixture.test.ts` validates each
  row against `schemas.ts`.

The library pages cover: a rated and an unrated book; one and two authors, with
and without the Goodreads Author marker; a review with line breaks; private
notes and `None`; two reading sessions, a start-only session, a finish-only
session and an empty unsaved session; full, month and year dates and an
`unknown` publication date; exclusive shelves, a custom exclusive shelf and
tags; a last page and a page past the end.

The sidebar lists exclusive shelves above the grey divider and tags below it.
Goodreads pages a long sidebar; the fixture is short, and the collector reads
the shelf counts from the first sidebar page only.
