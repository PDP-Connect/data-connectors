# Expensify connector, staged

Pure modules for a future `connectors/expensify` connector: the export
template, the record types and schemas, and the export parser. They live here
until the connector has a collector and a manifest, because every directory
under `connectors/` must carry a `manifest.json`. Registration moves them into
`connectors/expensify/` unchanged.
