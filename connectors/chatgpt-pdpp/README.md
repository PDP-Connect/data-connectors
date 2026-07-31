# ChatGPT PDPP Collection Profile

This is a pinned, distributable PDPP Collection Profile—not a replacement for
the legacy `chatgpt-playwright` connector. Its source of truth is the ChatGPT
connector and generic PDPP runtime at the commit recorded in `artifact.json`.
The build archives that commit, so dirty and untracked files in `--pdpp-root`
cannot enter the artifact. `provenance.json` hashes every archived upstream
input and every bundled `node_modules` input, grouped by resolved package,
version, package-manifest hash, per-file hashes, and closure hash.

`collection-profile.json`, `dist/collection-profile.mjs`, and
`provenance.json` are generated. Rebuild deliberately with:

```sh
npm run chatgpt-pdpp:build -- --pdpp-root /path/to/pdpp
npm run connector-index:generate
```

The profile requires both PDPP runtime bindings: `network` and `browser`.
The host must provide a Node 22 runtime with `p-queue@^9.3.3` and
`patchright@^1.61.1` resolvable, a Patchright-compatible browser surface,
and an owner-attended browser surface for credential recovery, 2FA, CAPTCHA,
and Cloudflare challenges. Normal automatic runs reuse owner-authenticated
browser session evidence. Do not replace browser-context fetches with plain
HTTP: they deliberately preserve the provider browser/TLS session.
`zod` is vendored into the bundle; its exact shipped closure is recorded in
provenance, so it is not a host dependency.
