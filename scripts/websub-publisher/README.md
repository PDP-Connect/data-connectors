# Connector catalog update feed

The public topic is `https://registry.pdpp.dev/catalog/updates.atom`. It advertises
itself and `https://websubhub.com/hub` using WebSub links. `/catalog/` is a feed
path, not a connector or profile identifier namespace. Anyone may subscribe to
the hub; the publisher does not know subscribers or hold their credentials.

The Atom entry is a hint for the signed OCI catalog at
`ghcr.io/pdp-connect/connector-catalog`. It contains a digest, source commit and
generation time. Subscribers must independently verify the OCI signature and
their own freshness policy. A hub signature authenticates a delivery from the
hub; it does not establish catalog provenance.

## Publication

The connector workflow creates and signs the catalog, verifies both signature
formats, then moves `latest`. The Pages workflow runs when that workflow
completes, including a partially failed connector matrix, and on relevant site
changes or a manual dispatch. Both use the same non-canceling concurrency group.
The queue is finite; cancellation, queue overflow or an out-of-band writer still
requires operator attention. The connector job refuses to replace a verified
catalog whose source is not an ancestor of the source it is publishing.

After entering the group, Pages checks out current `main`, resolves `latest`,
verifies both signature formats, pulls that exact digest and checks that `latest`
did not move during the pull. It generates the feed and deploys the whole
`registry-site` tree. A failed check does not deploy a partial site. All writers
must use the same group; this is not a lock against other registry writers.

Hub notification is opt-in: set the repository variable
`CATALOG_WEBSUB_NOTIFY_ENABLED` to `true` after the topic and subscription have
been tested. After the Pages deployment succeeds, the workflow reads the
canonical URL once and checks the response against the deployed feed's hash.
It then sends one publish hint to the hub. There is no timer or catalog polling.
If the read is stale or the hub request fails, the job fails visibly; run
**Deploy Registry Pages** again to reconcile the current signed catalog and
retry. A retry may send the same hint more than once.

One successful read proves only what that request saw. A different CDN edge or
the hub may still see older bytes. WebSub hubs can stop retrying and cannot
guarantee recovery of a final missed hint. Subscribers needing stronger
recovery must provide their own reconciliation. Production activation requires
a live test of this Pages topic, the hub, and at least one subscriber.

## Local checks

```sh
scripts/test-sandbox/test-sandbox -- node --test \
  scripts/websub-publisher/test/static-feed.test.mjs \
  scripts/websub-publisher/test/static-notify.test.mjs \
  scripts/websub-publisher/test/materialize-catalog.test.mjs \
  scripts/websub-publisher/test/pages-workflow.test.mjs
```
