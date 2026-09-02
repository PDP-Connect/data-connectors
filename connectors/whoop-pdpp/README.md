# WHOOP PDPP Collection Profile

This artifact packages the WHOOP browser-session connector from the exact PDPP
commit recorded in `artifact.json`. The generated Collection Profile collects
profile, body, cycle, recovery, sleep, and workout records from the owner's
authenticated WHOOP browser session.

`collection-profile.json`, `dist/collection-profile.mjs`, and
`provenance.json` are generated. Rebuild them deliberately with:

```sh
npm run whoop-pdpp:build -- --pdpp-root /path/to/pdpp
npm run connector-index:generate
```

The host must provide Node 22, `patchright@^1.61.1`, and the PDPP `network` and
`browser` bindings. First connection requires the owner to
sign in through the isolated WHOOP browser profile. Later scheduled runs reuse
that profile and never return or persist the WHOOP session token in connector
records.
