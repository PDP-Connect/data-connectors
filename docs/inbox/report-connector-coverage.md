# Connector reachability exemptions

The rows below document exemptions that have been checked. This is not a
complete inventory of connectors or a claim that an exempt connector works.
Evidence of collection still comes from the connector's real-account tests.

| Connector | Classification | Reachability exemption |
| --- | --- | --- |
| LinkedIn | Browser-authenticated collector | The collection paths require a signed-in browser session; an unauthenticated probe cannot exercise them. |
| Signal | Local file collector | The connector reads a local database through a subprocess and has no network endpoint to probe. |
