// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
// Generated from schemas/connector-catalog.schema.json; run npm run catalog-schema:generate.

export default {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://registry.pdpp.dev/schemas/connector-catalog.schema.json",
  "title": "PDP-Connect connector catalog",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "catalog_version",
    "generated_at",
    "source_commit",
    "connectors"
  ],
  "properties": {
    "catalog_version": {
      "const": "1.0"
    },
    "generated_at": {
      "type": "string",
      "format": "date-time"
    },
    "source_commit": {
      "type": "string",
      "pattern": "^[0-9a-f]{40}$"
    },
    "connectors": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/connector"
      }
    }
  },
  "$defs": {
    "digest": {
      "type": "string",
      "pattern": "^sha256:[0-9a-f]{64}$"
    },
    "version": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "version",
        "digest"
      ],
      "properties": {
        "version": {
          "type": "string",
          "pattern": "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(?:-((?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$"
        },
        "digest": {
          "$ref": "#/$defs/digest"
        }
      }
    },
    "latest": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "version",
        "digest"
      ],
      "properties": {
        "version": {
          "$ref": "#/$defs/version/properties/version"
        },
        "digest": {
          "$ref": "#/$defs/digest"
        },
        "published_at": {
          "type": "string",
          "format": "date-time"
        }
      }
    },
    "bindings": {
      "type": "object",
      "additionalProperties": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "required"
        ],
        "properties": {
          "required": {
            "type": "boolean"
          }
        }
      }
    },
    "connector": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "connector_key",
        "connector_id",
        "display_name",
        "tier",
        "runtime_requirements",
        "setup",
        "latest",
        "versions"
      ],
      "properties": {
        "connector_key": {
          "type": "string",
          "pattern": "^[a-z0-9][a-z0-9-]*$"
        },
        "connector_id": {
          "type": "string",
          "format": "uri"
        },
        "display_name": {
          "type": "string",
          "minLength": 1
        },
        "tier": {
          "enum": [
            "development",
            "preview",
            "supported"
          ]
        },
        "runtime_requirements": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "bindings"
          ],
          "properties": {
            "bindings": {
              "$ref": "#/$defs/bindings"
            }
          }
        },
        "setup": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "modality"
          ],
          "properties": {
            "modality": {
              "enum": [
                null,
                "manual_or_upload",
                "provider_authorization",
                "static_secret"
              ]
            }
          }
        },
        "latest": {
          "$ref": "#/$defs/latest"
        },
        "versions": {
          "type": "array",
          "minItems": 1,
          "items": {
            "$ref": "#/$defs/version"
          }
        }
      }
    }
  }
};
