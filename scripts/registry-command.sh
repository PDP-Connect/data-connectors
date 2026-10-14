# Copyright The PDP-Connect Contributors
# SPDX-License-Identifier: Apache-2.0

# Sourced by every publish-workflow step that runs `oras` or `cosign`. Each
# call then goes through scripts/registry-command.mjs, which retries a command
# only when the registry rate-limited it. The functions shadow the commands by
# name, so the steps' command lines stay as written; the wrapper starts the real
# binaries from PATH, which a shell function does not affect.

_registry_command="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/registry-command.mjs"
oras() { node "$_registry_command" oras "$@"; }
cosign() { node "$_registry_command" cosign "$@"; }
