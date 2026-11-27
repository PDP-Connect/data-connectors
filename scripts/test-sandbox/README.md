# test-sandbox (vendored)

`test-sandbox` runs one test command in a transient systemd scope under the shared
`agent-tests.slice`, with CPU, memory and task caps, a host-wide slot limit,
loopback-only network by default (`--net host` opts out) and a private `/tmp`.
It prints a JSON receipt on stderr. Each layer it cannot use is skipped, and the receipt's `enforcement` field
shows what was applied (notes name a missing bwrap only for `--net none` runs): no systemd user session means no cgroup limits, no working bwrap
means no network or /tmp isolation, no flock means no host-wide slots. GitHub's Ubuntu
runners give cgroup limits; they give network isolation only in a job that installs
bubblewrap and lifts the AppArmor user-namespace restriction, which `verify + test` in
polyfill-connectors.yml does. With bash older than 5 (macOS) the command runs directly
and prints one warning line instead of a receipt.

Source: `dotfiles/ai/skills/local/test-architecture/scripts/test-sandbox`
Commit: `ce0d9665ab830e2c7a4872325f98974484d45fa1`

Do not edit here. Update the canonical copy, re-vendor, then update the `.sha256`.
