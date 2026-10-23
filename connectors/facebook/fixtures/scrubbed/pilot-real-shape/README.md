Synthetic-but-shape-real records for the Facebook connector.

`posts`, `friends`, `reactions` and `comments` are what this connector's own
parsers emit from the factory's synthetic live-shape samples in `__fixtures__/`
(real response structure, invented values). Activity-log ids and the comment
text were set by hand to make a test case. `profile` and `groups` are
hand-written in the parsers' output shape, with `[REDACTED_*]` placeholders:
no server-rendered profile or groups sample was captured. No value here comes
from a real account.

Locks the emitted-record shape against schema drift
(connector-authoring-guide.md §9.1).
