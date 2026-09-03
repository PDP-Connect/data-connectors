# DCX-71 declaration delivery report

## Package build and guard

```text
$ npm --prefix packages/polyfill-connectors run build
PASS published entrypoints: 43 package targets resolve to JavaScript and every export declaration resolves from the packed tarball.
```

The guard checks every `exports` condition has a matching emitted `.d.ts` and `.d.ts.map`, and checks that both files are present in `npm pack --dry-run` output.

## Strict packed-consumer spike

```text
$ npm --prefix packages/polyfill-connectors run pack-install-run
PASS TypeScript NodeNext: all 42 export subpaths resolve.
PASS TypeScript bundler: all 42 export subpaths resolve.
PASS pack-install-run: plain npm install and every public consumer entrypoint succeeded.
```

The scratch consumer installs the tarball, creates one side-effect import for each package export, and runs `tsc --noEmit` with `strict: true` under both `moduleResolution: NodeNext` and `moduleResolution: Bundler`.

Verified subpaths: `collectors`, `manifests`, `reason-display-messages`, `browser-handoff`, `browser-launch`, `browser-surface-policy`, `connector-config-option-kind-registry`, `connector-conformance-roster`, `connector-exit`, `connector-options-schema`, `connector-runtime`, `fingerprint-cursor`, `fixture-capture`, `local-source-inventory`, `profile-lock`, `runtime-environment`, `session-establish`, `shutdown-hook`, `streaming-target-registration`, `bounded-zip-archive`, `capture-redaction`, `credential-probe`, `credential-probe-transport`, `manual-upload-validation`, `ntfy`, `oauth2-generic-provider-auth`, `provider-auth-adapter`, `provider-auth-adapters`, `static-secret-credential-capture`, `static-secret-injection`, `static-secret-registry`, `fixture-samples`, `connectors/claude_code`, `connectors/codex`, `connectors/imessage`, `connectors/apple_health`, `connectors/google_maps`, `connectors/google_maps_data_portability`, `connectors/netflix_export`, `connectors/whatsapp`, `connectors/github`, `connectors/github/schemas`.

## Reference-implementation re-vendor spike

`/home/tnunamak/code/data-connect` does not contain `reference-implementation`. To avoid touching any live worktree, I created a scratch archive from the clean `/home/tnunamak/code/data-connect-wt-tests-0903` checkout, replaced only `reference-implementation/vendor/pdpp-polyfill-connectors-0.0.1.tgz` with this package's tarball, and ran the reference implementation's normal `npm run typecheck` command.

```text
total TypeScript diagnostics: 47
@pdpp/polyfill-connectors diagnostics: 0
@pdpp/polyfill-connectors TS7016/TS7006/TS7031 diagnostics: 0
```

The 47 remaining diagnostics are unrelated errors in that archived data-connect revision (for example, `runtime/browser-surface-lease-sweep-timer.ts` and missing vendored connector-protocol exports). The declaration failure from issue #71 is eliminated: no diagnostic references a polyfill-connectors source path or its former implicit-any error codes.
