# test-sandbox (vendored)

`test-sandbox` runs one test command in a transient systemd scope under the shared
`agent-tests.slice`, with CPU, memory and task caps, a host-wide slot limit,
loopback-only network by default (`--net host` opts out) and a private `/tmp`.
It prints a JSON receipt on stderr. Where systemd user sessions, bwrap or flock are
missing or unusable (macOS, GitHub runners), it runs the command directly and says so
in the receipt.

Source: `dotfiles/ai/skills/local/test-architecture/scripts/test-sandbox`
Commit: `7ed10f537e7fe5dc370729264ff7bad23a8ae62e`

Do not edit here. Update the canonical copy, re-vendor, then update the `.sha256`.
