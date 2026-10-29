# Connector catalog WebSub publisher

After the catalog workflow signs, verifies, and tags a catalog, this publisher exposes an Atom topic and notifies a WebSub hub. Subscribers can register with the hub without access to this repository. A notification is a hint; consumers must still verify the catalog signature and use its immutable digest.

## Test

Run from this directory with Node 24:

```sh
npm ci --ignore-scripts
npm test
```

The tests exercise the Worker and SQLite-backed Durable Object in Miniflare, including GitHub OIDC verification, key rotation, automatic alarms, retries, duplicate declarations, and recovery. They do not use a live hub or GitHub Actions token.

## Configure

1. Select a hub that accepts this public topic. Verify its signing algorithms, lease, retry, logging, and availability policies.
2. Copy `wrangler.toml.example` to `wrangler.toml`. Set `TOPIC_URL` to a stable HTTPS URL ending in `/topic`, `HUB_URL` to the chosen hub, and `OIDC_AUDIENCE` to a unique value. Configure the custom route, Durable Object binding, and SQLite migration before deploying the Worker.
3. Set repository variables `CATALOG_PUBLISHER_URL` to the same origin's `/ready` URL and `CATALOG_PUBLISHER_AUDIENCE` to the matching audience. The workflow's `id-token: write` permission supplies the short-lived GitHub Actions identity; no shared publisher token is needed.
4. Run a controlled publication and verify the public feed, hub handshake, notification delivery, and alerts. The endpoint and hub configuration are not deployed by this repository.

When both repository variables are absent, existing catalog publication continues with a notice and sends no notification. Partial or malformed configuration fails the catalog job before it updates the catalog. Once configured, a notification error is retried and then fails the job visibly. Configure alerts for failed jobs and repeated hub delivery errors before relying on notifications.

## Delivery and recovery

The Worker accepts a ready declaration only from a valid GitHub Actions token for this repository's main-branch publishing workflow. It pins the repository and owner IDs and the immutable default subject; a custom subject template or job Environment must be reviewed before changing that policy. It durably records the catalog and schedules immediate hub notification in one transaction. Failed hub requests use exponential backoff; no periodic catalog polling is used. The workflow client makes up to three attempts after transient failures or a lost response. Duplicate declarations are safe.

The registry tag and the publisher's durable record are separate writes. A runner can stop after tagging but before the declaration is accepted. If that happens, recover the exact signed `latest` catalog from the main workflow:

```sh
gh workflow run publish-polyfill-connectors.yml --ref main \
  -f catalog-only=true -f recover-latest=true -f dry-run=false
```

Recovery verifies both signature formats, pulls the selected digest, checks that `latest` has not moved, and submits its original metadata. It does not rebuild or retag the catalog. This check cannot lock external writers out of the registry.

Hub acceptance is not proof of subscriber delivery. Standard WebSub allows a hub to stop retrying, so the final notification can be missed without another event. Subscribers need an explicit reconciliation path or a separately agreed recovery mechanism. The topic contains only the latest catalog; it is not a replay log.

Keep the publisher identity, main workflow, and registry credentials protected: the Worker trusts that workflow's declaration that the digest was signed and tagged. The Worker stores one immutable receipt per distinct digest, so monitor storage growth. Topic or hub changes require an operator migration; do not silently repoint a deployment with pending notifications.
