# Scenario CLI JSON results

`scenario-record --json` and `scenario-verify --json <claim-path>` write one JSON result line to stdout. Human-readable output moves to stderr in this mode. The `--json` result is a separate artifact from the scenario, claim, and CLI identity versions:

| Artifact | Version | Purpose |
| --- | --- | --- |
| Scenario file | `pdpp.connector-scenario/1` | Captured input and expected replay result |
| CLI identity marker | `pdpp.connector-scenario-cli/1` | Flags, defaults, exit meanings, and CLI artifacts |
| Verify claim file | `pdpp.connector-claim/1` | Claim written by verify `--json <claim-path>` after replay passes |
| CLI result line | `pdpp.connector-scenario-cli-result/1` | Machine-readable result for this invocation |

The CLI identity marker is [`bin/scenario-cli-contract.json`](../bin/scenario-cli-contract.json). A consumer resolves it next to the invoked `scenario-record.ts` or `scenario-verify.ts`, not relative to the current working directory. If the marker is absent, treat the CLI as unversioned. The result schema is [`bin/scenario-cli-result.schema.json`](../bin/scenario-cli-result.schema.json); it is the shape contract for each stdout line.

## Result shape

Every JSON-mode invocation that reaches CLI handling writes exactly one JSON object followed by a newline. The object has these required fields:

- `schema`: the result version string above.
- `command`: `scenario-record` or `scenario-verify`.
- `status`: `success`, `failure`, or `usage_error`.
- `exit_code`: integer `0`, `1`, or `2`; it equals the process exit code.
- `result`: command-specific fields below.

Record results have `kind: "record"`, `outcome`, `failure_code`, `runs`, `scenario_path`, and `capture_complete`. `runs` is a non-negative integer or `null`; `scenario_path` is a string or `null`; `capture_complete` is a boolean or `null`. Outcomes are `complete`, `incomplete`, `failed`, or `help`. Failure codes are `invalid_arguments`, `recording_failed`, or `null`.

Verify results have `kind: "verify"`, `outcome`, `failure_code`, `runs`, `failure_count`, `claim`, and `claim_artifact_written`. Counts are non-negative integers or `null`; `claim` is `recorded_replay`, `diagnostic_replay`, or `null`; and `claim_artifact_written` is a boolean or `null`. Outcomes are `passed`, `mismatch`, `rejected`, `failed`, or `help`. Failure codes are `invalid_arguments`, `invalid_scenario`, `replay_mismatch`, `verification_failed`, or `null`.

Exit meanings are stable: success and help use exit `0`; recording failure, incomplete capture, invalid scenario, replay mismatch, and verification failure use exit `1`; usage errors use exit `2`. `status` is `success` for exit `0`, `failure` for exit `1`, and `usage_error` for exit `2`. `outcome` and `failure_code` explain the command result. A failed cleanup can set record `status` to `failure` while preserving facts already established, including the scenario path and `capture_complete` value.

JSON mode does not make recording interactive. The recorder uses `--answer` and `--answers` values for prompts. An unanswered prompt fails the capture instead of writing a prompt to stdout. Diagnostics remain on stderr; stderr text, paths, and error details are not a machine API and are not promised to be scrubbed.

The result schema allows additional properties at the envelope and `result` levels. Consumers must ignore unknown fields and use required fields with the types and meanings above. Removing a required field, changing its type or meaning, or changing exit/outcome semantics requires a result-schema version bump; a breaking CLI artifact or flag/default/exit change also requires a CLI identity version bump. The claim-file version and scenario-file version remain independent.

## Flags and defaults

Run either command with `--help` to print its current complete flag list and defaults. Value options accept `--name=value`; repeated value options use the last value. Record `--answer` is repeatable, the last duplicate answer key wins, and `--answers` overrides a matching `--answer` value. There are no short aliases.

| Command | Flag | Default and behavior |
| --- | --- | --- |
| Both | `--help` | Print help and exit `0`; with JSON enabled, help goes to stderr and one result line goes to stdout. |
| Record | `--json` | Off. Enable the versioned stdout result. |
| Record | `--runs 1\|2` | `2`; only `1` or `2` is valid. |
| Record | `--out <path>` | Timestamped `runs/<connector>/` path. |
| Record | `--entrypoint <path>` | Registry entrypoint; local/test override. |
| Record | `--answer <key>=<value>` | No answers; repeatable scripted prompt answer. |
| Record | `--answers <json-file>` | No file; load scripted answers from a JSON object. |
| Record | `--persist-otp` | Off; otherwise OTP answers are redacted in the capture. |
| Record | `--streams <names>` | All registered streams. |
| Record | `--timeout <seconds>` | `300`; positive integer inactivity timeout. |
| Record | `--record-har` | Off; capture browser HTTP traffic and storage state when supported. |
| Verify | `--entrypoint <path>` | Registry entrypoint; local/test override. |
| Verify | `--require-capture-source` | Off; reject source or declaration digest drift when enabled. |
| Verify | `--json <claim-path>` | Off. Write the existing claim file after a passing replay and enable the CLI result line. |
| Verify | `--timeout <seconds>` | `300`; positive integer inactivity timeout. |
| Verify | `--dump-records <dir>` | `PDPP_SCENARIO_DUMP_DIR` or off; this flag takes precedence over the environment variable. |
| Verify | `--dump-all-records` | Off; with dumping enabled, include every record in a mismatching stream. |

Record unknown options and invalid option values are usage errors. An unknown connector also exits `2`; an unknown stream, invalid answer file, incomplete capture, or connector failure exits `1`. Verify usage errors exit `2`; invalid scenarios and replay or verification failures exit `1`. The verify `--json <claim-path>` file is only written on a passing replay. A failed replay leaves an existing claim file unchanged; a claim write failure does not change a passing replay's exit `0`, and the result reports `claim_artifact_written: false`.
