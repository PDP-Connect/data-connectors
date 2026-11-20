# Submission-pilot behavioral fixture

Network-only API submissions require these four upstream findings in addition to
the existing full conformance report. Ordinary conformance and local collection
do not acquire this requirement. From the reviewed checkout, run:

```sh
CONFORMANCE_BASE_REF=<submission-base-commit> npm run conformance -- <directory> --submission-pilot --json
```

Start from the complete [tested example](submission-pilot.example.json), replace
its provider responses and expectations, and commit
`connectors/<directory>/fixtures/submission-pilot.json`. It is reviewed,
synthetic provider input and expected output, not executable assertions. The
shared runner starts the actual `index.ts` with START/DONE protocol messages,
serves only the declared GET responses through `fetch`, and rejects unmatched
requests, sockets and subprocess/browser launches. Each run has a 20-second
deadline and bounded output. No live provider, account or browser is needed.
This is a fixture guard, not an OS sandbox for hostile contributor code.

The v1 pilot supports connectors using global `fetch` and inline text. Other
transports need their own reviewed fixture integration before this pilot can
establish their behavior; do not replace them with invented successful output.

## Contract

The root fields are `schema: "pdpp.submission-fixture/1"`, `environment` and
all four cases: `refresh`, `deletions`, `text`, `counts`. Unknown fields and
missing cases fail. The complete JSON is limited to 2 MiB. `environment` holds
only synthetic credentials and setup values, for example a synthetic API token
and a fixture origin. Node, loader, Vana, PDPP and owner-directory environment
overrides are forbidden. No credential environment is inherited from the author.

Every executable case contains `streams` and `responses`. Responses are objects
with an exact absolute `url` and a JSON `body`; optional `status` is 2xx. Query
parameter order is immaterial, but values must match. Every listed response must
actually be requested. Fixture inventories emit each stream/key only once;
conflicting or duplicate output is a failure. Repeated requests receive the same response. Supply every
page; the connector controls pagination through its normal code.

Additional case fields and shared assertions:

| Case | Fields | Required observation |
| --- | --- | --- |
| `refresh` | `records: [{stream, key, op?}]` | Every required manifest stream has nonempty expected records. Both runs emit exactly those identities. Run two receives run one's actual STATE. Values remain equal; operations match the fixture (`op` defaults to `upsert`). |
| `deletions` | `deleted: [{stream, key}]` | Every named deleted source item reaches a RECORD with `op: "delete"` and the original key. |
| `text` | `values: [{stream, key, field: ["body"], source: "..."}]` | The expected string occurs in provider input. The corpus includes actual forbidden C0/C1 characters and ambiguous literal escapes. The matching output must be a live upsert. Emitted inline text satisfies the transport character contract and decodes exactly through the public canonical codec. |
| `counts` | `stream`, `total: ["total_count"]`, `items: ["results"]`, `records: [{stream, key, op?}]` | Select only that stream. Each response exposes the declared total and item-array paths. The largest total exceeds the nonzero returned inventory. Expected identities and operations cover every valid returned row. Collection succeeds with those rows, incomplete DETAIL_COVERAGE accounting for the advertised total, and no STATE for the stream. |

`field`, `total` and `items` are arrays of object keys or array indices. Derive
expected identities and source text from provider fixtures, never from collected
output. Keep a deletion case separate from the unchanged live-row refresh case,
so a missing delete operation cannot conceal the checkpoint-retention regression.
Counts can change between pages; the fixture must expose an actual shortfall.

An abbreviated response and text expectation look like this; the other cases
must also be supplied in the file:

```json
{
  "streams": ["items"],
  "responses": [{
    "url": "https://fixture.invalid/items",
    "body": {"results": [{"id": "a", "body": "A\u0001B\u0092 literal \\u0001"}]}
  }],
  "values": [{"stream": "items", "key": "a", "field": ["body"], "source": "A\u0001B\u0092 literal \\u0001"}]
}
```

## Inapplicability and reports

The four findings apply only when the manifest declares at least one required network binding (shorthand or named) and no other binding kinds. Export, browser and optional-network-only declarations keep their existing conformance requirements. Within that API pilot, refresh always runs. If the source genuinely has no deletion concept, arbitrary
inline text or inventory total, the corresponding case can instead contain:

```json
{"not_applicable": {"reason": "The provider exposes no source inventory total.", "reference": "https://provider.example/api-reference"}}
```

This author assertion produces a visible ADVISORY, never PASS. The submission
evidence needs an explicit disposition and the reviewer must assess the cited
capability. Missing or malformed cases cannot use that escape implicitly; an
executable failure cannot be waived by a disposition. Do not invent a provider
feature to obtain a green test.

The report names `submission refresh`, `submission deletions`, `submission text`
and `submission counts`. Applicable findings are required at every listing tier
when `--submission-pilot` is selected. `--static --submission-pilot` reports
UNKNOWN without running any case. For this API pilot the CLI requires all four findings on the
clean final submitted commit and base; an older ordinary report is insufficient.
Factory continues to preserve these upstream findings through its existing report
boundary. Its ordinary check report is reusable for submission only when it
contains the complete, current pilot findings.
