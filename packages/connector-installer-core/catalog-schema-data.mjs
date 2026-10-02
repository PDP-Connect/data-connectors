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
          },
          "features": {
            "type": "array",
            "items": {
              "$ref": "https://github.com/PDP-Connect/data-connectors/schemas/connector-manifest.schema.json#/$defs/bindingFeature"
            },
            "uniqueItems": true
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
export const connectorManifestSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://github.com/PDP-Connect/data-connectors/schemas/connector-manifest.schema.json",
  "title": "Collection Profile manifest runtime requirements",
  "description": "Machine-readable half of docs/spec/collection-profile.md Section 3.3: binding names and binding features. Other manifest fields are outside this schema's scope.",
  "type": "object",
  "properties": {
    "runtime_requirements": {
      "type": "object",
      "required": [
        "bindings"
      ],
      "properties": {
        "bindings": {
          "type": "object",
          "propertyNames": {
            "$ref": "#/$defs/bindingName"
          },
          "additionalProperties": {
            "$ref": "#/$defs/binding"
          }
        }
      }
    }
  },
  "$defs": {
    "bindingName": {
      "type": "string",
      "description": "A registry binding name, or an extension binding namespaced as <domain>/<name>. Unqualified names are reserved for the registry.",
      "anyOf": [
        {
          "$ref": "#/$defs/registryBinding"
        },
        {
          "pattern": "^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+/[a-z0-9]([a-z0-9._-]*[a-z0-9])?$"
        }
      ]
    },
    "registryBinding": {
      "type": "string",
      "description": "Binding registry:\n- browser: A runtime-managed browser surface.\n- desktop_session: The owner's active, logged-in desktop session and its operating-system facilities.\n- filesystem: Access to local files.\n- network: Outbound network access.",
      "enum": [
        "browser",
        "desktop_session",
        "filesystem",
        "network"
      ]
    },
    "binding": {
      "type": "object",
      "required": [
        "required"
      ],
      "properties": {
        "required": {
          "type": "boolean"
        },
        "features": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/bindingFeature"
          },
          "uniqueItems": true
        }
      }
    },
    "bindingFeature": {
      "type": "string",
      "description": "Host capability definitions:\n- page_navigation: Navigate the active page to a URL.\n- page_script_evaluation: Run script in the active page context.\n- page_content_read: Read rendered page content.\n- page_condition_wait: Wait until a condition in the active page becomes true.\n- same_origin_page_fetch: Fetch same-origin resources from the active page context.\n- host_http_request: Make an HTTP request from the host runtime outside the page context.\n- host_download_capture: Capture content downloaded by the active page.\n- host_archive_extraction: Extract downloaded archive contents in the host runtime.\n- host_archive_entry_chunk_read: Read an extracted archive entry in chunks.",
      "enum": [
        "page_navigation",
        "page_script_evaluation",
        "page_content_read",
        "page_condition_wait",
        "same_origin_page_fetch",
        "host_http_request",
        "host_download_capture",
        "host_archive_extraction",
        "host_archive_entry_chunk_read"
      ]
    }
  }
};
