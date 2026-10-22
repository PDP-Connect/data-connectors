# Temporary legacy retention (remove with F10)

These frozen `connector-index.json` and `fixture-index.json` snapshots preserve release metadata and fixture proofs from commit `06f79d589104926225c0eeed7388b6a8a03efdc8`. They are historical evidence, not an install index or publishing input. Their original URLs and paths describe that snapshot; they are not relative paths to restore retired artifacts from this directory.

`npm run legacy-retention:check` and `npm run legacy-retention:test`, in the explicit F10 retention lane, pin exactly these two snapshots and the 12 fixture files named by the fixture index. Fixture digests, byte sizes, and scope-to-schema references must agree. Schema bytes are owned only by the permanent `legacy-shapes:check` lane.

Remove this directory, its checker, and fixture-proof coverage with F10. Oura executable artifacts and their behavior tests have a separate F2 retirement gate; removing them must leave this metadata/proof lane running until F10. Keep `legacy-shapes.json`, its schema pins, and every referenced schema, including Oura. No non-Oura executable artifacts or legacy signing workflow are restored here. Published release assets are unchanged.
