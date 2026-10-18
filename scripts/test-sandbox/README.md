# test-sandbox (vendored)

`test-sandbox` runs one test command in a transient systemd scope under the shared
`agent-tests.slice`, with CPU, memory and task caps, a host-wide slot limit,
loopback-only network by default (`--net host` opts out) and a private `/tmp`.
It prints a JSON receipt on stderr. Where systemd user sessions, bwrap or flock are
missing or unusable (macOS, GitHub runners), it runs the command directly and says so
in the receipt.

Source: `dotfiles/ai/skills/local/test-architecture/scripts/test-sandbox`
Commit: `1a72d0ad479082c6666faa338bb8db869d31d9fa`

Do not edit here. Update the canonical copy, re-vendor, then update the `.sha256`.
