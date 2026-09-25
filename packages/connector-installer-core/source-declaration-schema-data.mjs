// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
// Generated from schemas/source-declaration.schema.json; run npm run source-declaration-schema:generate.

export default {
  "$id": "https://pdpp.dev/schemas/source-declaration/0.1.0",
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "additionalProperties": false,
  "properties": {
    "declaration_version": {
      "minLength": 1,
      "type": "string"
    },
    "display": {
      "additionalProperties": false,
      "properties": {
        "name": {
          "minLength": 1,
          "type": "string"
        }
      },
      "required": [
        "name"
      ],
      "type": "object"
    },
    "extensions": {
      "additionalProperties": true,
      "propertyNames": {
        "format": "uri"
      },
      "type": "object"
    },
    "protocol_version": {
      "const": "0.1.0",
      "type": "string"
    },
    "publisher": {
      "additionalProperties": false,
      "properties": {
        "id": {
          "format": "uri",
          "type": "string"
        }
      },
      "required": [
        "id"
      ],
      "type": "object"
    },
    "selection_presets": {
      "items": {
        "additionalProperties": false,
        "properties": {
          "id": {
            "minLength": 1,
            "type": "string"
          },
          "label": {
            "minLength": 1,
            "type": "string"
          },
          "streams": {
            "items": {
              "additionalProperties": false,
              "allOf": [
                {
                  "not": {
                    "required": [
                      "fields",
                      "view"
                    ]
                  }
                }
              ],
              "properties": {
                "fields": {
                  "items": {
                    "minLength": 1,
                    "type": "string"
                  },
                  "minItems": 1,
                  "type": "array",
                  "uniqueItems": true
                },
                "name": {
                  "minLength": 1,
                  "type": "string"
                },
                "view": {
                  "minLength": 1,
                  "type": "string"
                }
              },
              "required": [
                "name"
              ],
              "type": "object"
            },
            "minItems": 1,
            "type": "array"
          }
        },
        "required": [
          "id",
          "label",
          "streams"
        ],
        "type": "object"
      },
      "type": "array",
      "uniqueItems": true
    },
    "source": {
      "additionalProperties": false,
      "properties": {
        "id": {
          "format": "uri",
          "minLength": 1,
          "type": "string"
        },
        "kind": {
          "enum": [
            "connector",
            "provider_native"
          ],
          "type": "string"
        }
      },
      "required": [
        "kind",
        "id"
      ],
      "type": "object"
    },
    "streams": {
      "items": {
        "additionalProperties": false,
        "properties": {
          "consent_time_field": {
            "minLength": 1,
            "type": "string"
          },
          "cursor_field": {
            "minLength": 1,
            "type": "string"
          },
          "description": {
            "minLength": 1,
            "type": "string"
          },
          "display": {
            "additionalProperties": false,
            "properties": {
              "detail": {
                "minLength": 1,
                "type": "string"
              },
              "label": {
                "minLength": 1,
                "type": "string"
              }
            },
            "type": "object"
          },
          "name": {
            "minLength": 1,
            "not": {
              "const": "*"
            },
            "type": "string"
          },
          "primary_key": {
            "items": {
              "minLength": 1,
              "type": "string"
            },
            "minItems": 1,
            "type": "array",
            "uniqueItems": true
          },
          "query": {
            "additionalProperties": false,
            "properties": {
              "aggregations": {
                "additionalProperties": false,
                "properties": {
                  "count": {
                    "const": true
                  },
                  "count_distinct": {
                    "items": {
                      "minLength": 1,
                      "type": "string"
                    },
                    "minItems": 1,
                    "type": "array",
                    "uniqueItems": true
                  },
                  "group_by": {
                    "items": {
                      "minLength": 1,
                      "type": "string"
                    },
                    "minItems": 1,
                    "type": "array",
                    "uniqueItems": true
                  },
                  "group_by_time": {
                    "items": {
                      "minLength": 1,
                      "type": "string"
                    },
                    "minItems": 1,
                    "type": "array",
                    "uniqueItems": true
                  },
                  "max": {
                    "items": {
                      "minLength": 1,
                      "type": "string"
                    },
                    "minItems": 1,
                    "type": "array",
                    "uniqueItems": true
                  },
                  "min": {
                    "items": {
                      "minLength": 1,
                      "type": "string"
                    },
                    "minItems": 1,
                    "type": "array",
                    "uniqueItems": true
                  },
                  "sum": {
                    "items": {
                      "minLength": 1,
                      "type": "string"
                    },
                    "minItems": 1,
                    "type": "array",
                    "uniqueItems": true
                  }
                },
                "type": "object"
              },
              "expand": {
                "items": {
                  "additionalProperties": false,
                  "properties": {
                    "default_limit": {
                      "minimum": 1,
                      "type": "integer"
                    },
                    "max_limit": {
                      "minimum": 1,
                      "type": "integer"
                    },
                    "name": {
                      "minLength": 1,
                      "type": "string"
                    }
                  },
                  "required": [
                    "name"
                  ],
                  "type": "object"
                },
                "minItems": 1,
                "type": "array"
              },
              "range_filters": {
                "additionalProperties": {
                  "items": {
                    "enum": [
                      "gte",
                      "gt",
                      "lte",
                      "lt"
                    ],
                    "type": "string"
                  },
                  "minItems": 1,
                  "type": "array",
                  "uniqueItems": true
                },
                "propertyNames": {
                  "minLength": 1,
                  "type": "string"
                },
                "type": "object"
              },
              "search": {
                "additionalProperties": false,
                "properties": {
                  "lexical_fields": {
                    "items": {
                      "minLength": 1,
                      "type": "string"
                    },
                    "minItems": 1,
                    "type": "array",
                    "uniqueItems": true
                  },
                  "semantic_fields": {
                    "items": {
                      "minLength": 1,
                      "type": "string"
                    },
                    "minItems": 1,
                    "type": "array",
                    "uniqueItems": true
                  }
                },
                "type": "object"
              }
            },
            "type": "object"
          },
          "relationships": {
            "items": {
              "additionalProperties": false,
              "properties": {
                "cardinality": {
                  "enum": [
                    "has_many",
                    "has_one"
                  ],
                  "type": "string"
                },
                "foreign_key": {
                  "minLength": 1,
                  "type": "string"
                },
                "name": {
                  "minLength": 1,
                  "type": "string"
                },
                "stream": {
                  "minLength": 1,
                  "type": "string"
                }
              },
              "required": [
                "name",
                "stream",
                "foreign_key",
                "cardinality"
              ],
              "type": "object"
            },
            "type": "array"
          },
          "schema": {
            "additionalProperties": true,
            "properties": {
              "$schema": {
                "const": "https://json-schema.org/draft/2020-12/schema"
              }
            },
            "type": "object"
          },
          "selection": {
            "additionalProperties": false,
            "properties": {
              "fields": {
                "type": "boolean"
              },
              "resources": {
                "type": "boolean"
              }
            },
            "required": [
              "fields",
              "resources"
            ],
            "type": "object"
          },
          "semantics": {
            "enum": [
              "append_only",
              "mutable_state"
            ],
            "type": "string"
          },
          "views": {
            "items": {
              "additionalProperties": false,
              "properties": {
                "fields": {
                  "items": {
                    "minLength": 1,
                    "type": "string"
                  },
                  "minItems": 1,
                  "type": "array",
                  "uniqueItems": true
                },
                "id": {
                  "minLength": 1,
                  "type": "string"
                },
                "label": {
                  "minLength": 1,
                  "type": "string"
                }
              },
              "required": [
                "id",
                "label",
                "fields"
              ],
              "type": "object"
            },
            "type": "array"
          }
        },
        "required": [
          "name",
          "semantics",
          "schema",
          "primary_key",
          "selection"
        ],
        "type": "object"
      },
      "minItems": 1,
      "type": "array",
      "uniqueItems": true
    }
  },
  "required": [
    "protocol_version",
    "source",
    "declaration_version",
    "publisher",
    "display",
    "streams"
  ],
  "type": "object"
};
