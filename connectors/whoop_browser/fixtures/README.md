# whoop_browser fixtures

Synthetic. No real WHOOP data.

The envelope, the key set of each object and each value's JSON type follow what app.whoop.com's
web app is documented to receive from `https://api.prod.whoop.com` (public captures and parsers of
the web app's traffic, read 1 October 2026); every value is invented. They have not yet been
compared with a live account.

| File | Endpoint |
|---|---|
| `bootstrap.json` | `GET /users-service/v2/bootstrap/?accountType=users&apiVersion=7` |
| `cycles-details.json` | `GET /core-details-bff/v0/cycles/details?apiVersion=7&id=…&startTime=…&endTime=…&limit=…` |

`cycles-details.json` holds three cycles: a scored one with a recovery, a sleep, a nap and a run;
one with no recovery and no sleep; and the cycle still under way, whose end is open and whose
recovery and sleep are not yet scored.
