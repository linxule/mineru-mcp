// Vendored verbatim schema from Scholia v1.0.1; no runtime network dependency.
export const bundleSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:scholia:artifact-bundle:1.0.1",
  "title": "Scholia portable artifact bundle 1.0.1",
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "schema": {
      "const": "scholia.artifact-bundle"
    },
    "schema_version": {
      "const": "1.0.1"
    },
    "created_at": {
      "type": "string",
      "format": "date-time"
    },
    "producer": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "name": {
          "type": "string",
          "minLength": 1
        },
        "version": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "name",
        "version"
      ]
    },
    "source": {
      "$ref": "#/$defs/source"
    },
    "corpus_binding": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "work_id": {
          "type": "string",
          "minLength": 1
        },
        "document_sha256": {
          "$ref": "#/$defs/sha256"
        }
      },
      "required": [
        "work_id",
        "document_sha256"
      ]
    },
    "provider": {
      "$ref": "#/$defs/provider"
    },
    "coverage": {
      "$ref": "#/$defs/coverage"
    },
    "archives": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/archive"
      }
    },
    "provider_files": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/providerFile"
      }
    },
    "materializations": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/materialization"
      }
    },
    "validation_limits": {
      "$ref": "#/$defs/limits"
    },
    "warnings": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/warning"
      }
    },
    "legacy_receipts": {
      "type": "array",
      "items": {
        "$ref": "#/$defs/legacy"
      }
    },
    "extensions": {
      "type": "object",
      "propertyNames": {
        "pattern": "^[A-Za-z0-9_.-]+$"
      }
    },
    "predecessor_manifest_sha256": {
      "anyOf": [
        {
          "$ref": "#/$defs/sha256"
        },
        {
          "type": "null"
        }
      ],
      "description": "SHA-256 of exact predecessor bundle.json bytes for monotonic output enrichment, or null for an initial manifest."
    }
  },
  "required": [
    "schema",
    "schema_version",
    "created_at",
    "producer",
    "source",
    "provider",
    "coverage",
    "archives",
    "provider_files",
    "materializations",
    "validation_limits",
    "warnings",
    "legacy_receipts",
    "predecessor_manifest_sha256"
  ],
  "$defs": {
    "sha256": {
      "type": "string",
      "pattern": "^[a-f0-9]{64}$"
    },
    "identifier": {
      "type": "string",
      "pattern": "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$"
    },
    "safePath": {
      "type": "string",
      "minLength": 1,
      "maxLength": 4096,
      "pattern": "^(?!/)(?![A-Za-z]:)(?!.*\\\\)(?!.*[\\u0000-\\u001f\\u007f])(?!(?:.*\\/)?\\.{1,2}(?:\\/|$))(?!.*//).+[^/]$|^[A-Za-z0-9_-]$",
      "description": "Relative POSIX file path. Semantic validation also rejects symlink traversal and normalized filesystem collisions."
    },
    "file": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "path": {
          "$ref": "#/$defs/safePath"
        },
        "sha256": {
          "$ref": "#/$defs/sha256"
        },
        "size_bytes": {
          "type": "integer",
          "minimum": 0
        },
        "media_type": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "path",
        "sha256",
        "size_bytes",
        "media_type"
      ]
    },
    "reference": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "artifact_id": {
          "$ref": "#/$defs/identifier"
        },
        "member_id": {
          "anyOf": [
            {
              "$ref": "#/$defs/identifier"
            },
            {
              "type": "null"
            }
          ]
        },
        "json_pointer": {
          "anyOf": [
            {
              "type": "string"
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "artifact_id",
        "member_id",
        "json_pointer"
      ]
    },
    "range": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "start": {
          "type": "integer",
          "minimum": 1
        },
        "end": {
          "type": "integer",
          "minimum": 1
        }
      },
      "required": [
        "start",
        "end"
      ]
    },
    "rangeEvidence": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "ranges": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/range"
          }
        },
        "basis": {
          "enum": [
            "unknown",
            "provider_reported",
            "validated"
          ]
        },
        "evidence": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/reference"
          }
        }
      },
      "required": [
        "ranges",
        "basis",
        "evidence"
      ]
    },
    "coverage": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "status": {
          "enum": [
            "unknown",
            "partial",
            "complete"
          ]
        },
        "requested": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "scope": {
              "enum": [
                "all",
                "ranges",
                "unknown"
              ]
            },
            "ranges": {
              "type": "array",
              "items": {
                "$ref": "#/$defs/range"
              }
            }
          },
          "required": [
            "scope",
            "ranges"
          ]
        },
        "completed": {
          "$ref": "#/$defs/rangeEvidence"
        },
        "missing": {
          "$ref": "#/$defs/rangeEvidence"
        },
        "unknown": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "ranges": {
              "type": "array",
              "items": {
                "$ref": "#/$defs/range"
              }
            },
            "reason": {
              "anyOf": [
                {
                  "type": "string",
                  "minLength": 1
                },
                {
                  "type": "null"
                }
              ]
            }
          },
          "required": [
            "ranges",
            "reason"
          ]
        },
        "source_complete": {
          "anyOf": [
            {
              "type": "boolean"
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "status",
        "requested",
        "completed",
        "missing",
        "unknown",
        "source_complete"
      ]
    },
    "member": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "member_id": {
          "$ref": "#/$defs/identifier"
        },
        "entry_index": {
          "type": "integer",
          "minimum": 0
        },
        "path": {
          "type": "string",
          "minLength": 1,
          "description": "Exact decoded ZIP member name, preserved for provenance. Shape validation alone does not make this safe: mandatory semantic archive validation in ARTIFACT_CONTRACT.md rejects traversal, controls, duplicates, normalization collisions, links, and inconsistent names before inventory_status can be complete."
        },
        "kind": {
          "enum": [
            "file",
            "directory"
          ]
        },
        "sha256": {
          "anyOf": [
            {
              "$ref": "#/$defs/sha256"
            },
            {
              "type": "null"
            }
          ]
        },
        "size_bytes": {
          "type": "integer",
          "minimum": 0
        },
        "compressed_size_bytes": {
          "type": "integer",
          "minimum": 0
        },
        "role": {
          "$ref": "#/$defs/artifactRole"
        },
        "format_schema": {
          "anyOf": [
            {
              "type": "string",
              "minLength": 1
            },
            {
              "type": "null"
            }
          ]
        },
        "format_version": {
          "anyOf": [
            {
              "type": "string",
              "minLength": 1
            },
            {
              "type": "null"
            }
          ]
        },
        "media_type": {
          "anyOf": [
            {
              "type": "string",
              "minLength": 1
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "member_id",
        "entry_index",
        "path",
        "kind",
        "sha256",
        "size_bytes",
        "compressed_size_bytes",
        "role",
        "format_schema",
        "format_version",
        "media_type"
      ],
      "allOf": [
        {
          "if": {
            "properties": {
              "kind": {
                "const": "file"
              }
            }
          },
          "then": {
            "properties": {
              "sha256": {
                "$ref": "#/$defs/sha256"
              },
              "role": {
                "$ref": "#/$defs/fileRole"
              }
            }
          },
          "else": {
            "properties": {
              "sha256": {
                "type": "null"
              },
              "size_bytes": {
                "const": 0
              },
              "role": {
                "const": "directory"
              }
            }
          }
        }
      ]
    },
    "archive": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "artifact_id": {
          "$ref": "#/$defs/identifier"
        },
        "file": {
          "$ref": "#/$defs/file"
        },
        "inventory_status": {
          "const": "complete",
          "description": "All entries of this retained archive passed safe inventory and hash validation. This does not assert all provider outputs were downloaded or all source pages parsed."
        },
        "members": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/member"
          }
        },
        "file_id": {
          "type": [
            "string",
            "null"
          ],
          "minLength": 1
        }
      },
      "required": [
        "artifact_id",
        "file",
        "inventory_status",
        "members",
        "file_id"
      ]
    },
    "providerFile": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "artifact_id": {
          "$ref": "#/$defs/identifier"
        },
        "file": {
          "$ref": "#/$defs/file"
        },
        "role": {
          "$ref": "#/$defs/fileRole"
        },
        "format_schema": {
          "anyOf": [
            {
              "type": "string",
              "minLength": 1
            },
            {
              "type": "null"
            }
          ]
        },
        "format_version": {
          "anyOf": [
            {
              "type": "string",
              "minLength": 1
            },
            {
              "type": "null"
            }
          ]
        },
        "file_id": {
          "type": [
            "string",
            "null"
          ],
          "minLength": 1
        }
      },
      "required": [
        "artifact_id",
        "file",
        "role",
        "format_schema",
        "format_version",
        "file_id"
      ]
    },
    "derivedFile": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "artifact_id": {
          "$ref": "#/$defs/identifier"
        },
        "file": {
          "$ref": "#/$defs/file"
        },
        "role": {
          "$ref": "#/$defs/fileRole"
        },
        "inputs": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/reference"
          }
        },
        "format_schema": {
          "anyOf": [
            {
              "type": "string",
              "minLength": 1
            },
            {
              "type": "null"
            }
          ]
        },
        "format_version": {
          "anyOf": [
            {
              "type": "string",
              "minLength": 1
            },
            {
              "type": "null"
            }
          ]
        }
      },
      "required": [
        "artifact_id",
        "file",
        "role",
        "inputs",
        "format_schema",
        "format_version"
      ]
    },
    "materialization": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "materializer_name": {
          "type": "string",
          "minLength": 1
        },
        "materializer_version": {
          "type": "string",
          "minLength": 1
        },
        "config": {
          "type": "object"
        },
        "config_hash": {
          "$ref": "#/$defs/sha256"
        },
        "page_provenance": {
          "enum": [
            "unknown",
            "validated"
          ]
        },
        "page_map": {
          "anyOf": [
            {
              "$ref": "#/$defs/reference"
            },
            {
              "type": "null"
            }
          ]
        },
        "outputs": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/derivedFile"
          }
        }
      },
      "required": [
        "materializer_name",
        "materializer_version",
        "config",
        "config_hash",
        "page_provenance",
        "page_map",
        "outputs"
      ]
    },
    "provider": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "name": {
          "const": "mineru"
        },
        "api_generation": {
          "enum": [
            "v1",
            "v4",
            "unknown"
          ]
        },
        "endpoint_origin": {
          "anyOf": [
            {
              "type": "string",
              "pattern": "^https://[A-Za-z0-9.-]+(?::[0-9]+)?$"
            },
            {
              "type": "null"
            }
          ]
        },
        "operation": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "kind": {
              "enum": [
                "job",
                "batch",
                "task",
                "unknown"
              ]
            },
            "operation_id": {
              "anyOf": [
                {
                  "type": "string",
                  "minLength": 1
                },
                {
                  "type": "null"
                }
              ]
            },
            "file_id": {
              "anyOf": [
                {
                  "type": "string",
                  "minLength": 1
                },
                {
                  "type": "null"
                }
              ]
            },
            "client_data_id": {
              "anyOf": [
                {
                  "type": "string",
                  "minLength": 1
                },
                {
                  "type": "null"
                }
              ]
            },
            "terminal_state": {
              "enum": [
                "succeeded",
                "partial",
                "failed",
                "unknown",
                "cancelled"
              ]
            }
          },
          "required": [
            "kind",
            "operation_id",
            "file_id",
            "client_data_id",
            "terminal_state"
          ]
        },
        "request": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "model": {
              "anyOf": [
                {
                  "type": "string",
                  "minLength": 1
                },
                {
                  "type": "null"
                }
              ]
            },
            "tier": {
              "anyOf": [
                {
                  "type": "string",
                  "minLength": 1
                },
                {
                  "type": "null"
                }
              ]
            },
            "parser_version": {
              "anyOf": [
                {
                  "type": "string",
                  "minLength": 1
                },
                {
                  "type": "null"
                }
              ]
            },
            "options": {
              "type": "object"
            }
          },
          "required": [
            "model",
            "tier",
            "parser_version",
            "options"
          ]
        },
        "reported": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "model": {
              "anyOf": [
                {
                  "type": "string",
                  "minLength": 1
                },
                {
                  "type": "null"
                }
              ]
            },
            "model_version": {
              "anyOf": [
                {
                  "type": "string",
                  "minLength": 1
                },
                {
                  "type": "null"
                }
              ]
            },
            "tier": {
              "anyOf": [
                {
                  "type": "string",
                  "minLength": 1
                },
                {
                  "type": "null"
                }
              ]
            },
            "parser_version": {
              "anyOf": [
                {
                  "type": "string",
                  "minLength": 1
                },
                {
                  "type": "null"
                }
              ]
            }
          },
          "required": [
            "model",
            "model_version",
            "tier",
            "parser_version"
          ]
        },
        "source_binding": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "method",
            "evidence"
          ],
          "properties": {
            "method": {
              "enum": [
                "uploaded_exact_bytes",
                "provider_verified_checksum",
                "caller_asserted",
                "unknown"
              ]
            },
            "evidence": {
              "type": [
                "string",
                "null"
              ]
            }
          }
        },
        "outputs_unavailable": {
          "type": "array",
          "items": {
            "$ref": "#/$defs/unavailableOutput"
          },
          "description": "Advertised or explicitly requested outputs that were not retained; empty does not itself prove total provider completeness."
        }
      },
      "required": [
        "name",
        "api_generation",
        "endpoint_origin",
        "operation",
        "request",
        "reported",
        "source_binding",
        "outputs_unavailable"
      ]
    },
    "source": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "sha256": {
          "$ref": "#/$defs/sha256"
        },
        "size_bytes": {
          "type": "integer",
          "minimum": 0
        },
        "media_type": {
          "const": "application/pdf"
        },
        "original_filename": {
          "anyOf": [
            {
              "type": "string",
              "minLength": 1
            },
            {
              "type": "null"
            }
          ]
        },
        "page_count": {
          "anyOf": [
            {
              "type": "integer",
              "minimum": 1
            },
            {
              "type": "null"
            }
          ]
        },
        "file": {
          "anyOf": [
            {
              "$ref": "#/$defs/file"
            },
            {
              "type": "null"
            }
          ]
        },
        "absence_reason": {
          "anyOf": [
            {
              "enum": [
                "already_in_corpus",
                "not_available",
                "not_included"
              ]
            },
            {
              "type": "null"
            }
          ]
        },
        "origin": {
          "anyOf": [
            {
              "type": "null"
            },
            {
              "type": "object",
              "additionalProperties": false,
              "required": [
                "kind",
                "url",
                "fetched_at"
              ],
              "properties": {
                "kind": {
                  "enum": [
                    "upload",
                    "url"
                  ]
                },
                "url": {
                  "anyOf": [
                    {
                      "type": "null"
                    },
                    {
                      "type": "string",
                      "format": "uri",
                      "pattern": "^https?://"
                    }
                  ]
                },
                "fetched_at": {
                  "anyOf": [
                    {
                      "type": "null"
                    },
                    {
                      "type": "string",
                      "format": "date-time"
                    }
                  ]
                }
              },
              "allOf": [
                {
                  "if": {
                    "properties": {
                      "kind": {
                        "const": "upload"
                      }
                    }
                  },
                  "then": {
                    "properties": {
                      "url": {
                        "type": "null"
                      }
                    }
                  }
                }
              ]
            }
          ]
        }
      },
      "required": [
        "sha256",
        "size_bytes",
        "media_type",
        "original_filename",
        "page_count",
        "file",
        "absence_reason",
        "origin"
      ]
    },
    "limits": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "max_archive_bytes": {
          "type": "integer",
          "minimum": 1
        },
        "max_members": {
          "type": "integer",
          "minimum": 1
        },
        "max_member_bytes": {
          "type": "integer",
          "minimum": 1
        },
        "max_total_uncompressed_bytes": {
          "type": "integer",
          "minimum": 1
        },
        "max_compression_ratio": {
          "type": "number",
          "minimum": 1
        },
        "max_manifest_bytes": {
          "type": "integer",
          "minimum": 1
        }
      },
      "required": [
        "max_archive_bytes",
        "max_members",
        "max_member_bytes",
        "max_total_uncompressed_bytes",
        "max_compression_ratio",
        "max_manifest_bytes"
      ]
    },
    "warning": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "code": {
          "$ref": "#/$defs/identifier"
        },
        "message": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "code",
        "message"
      ]
    },
    "legacy": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "schema": {
          "enum": [
            "scholia.mineru.archive-import.v1",
            "scholia.mineru.materialization.v1"
          ]
        },
        "receipt": {
          "$ref": "#/$defs/file"
        }
      },
      "required": [
        "schema",
        "receipt"
      ]
    },
    "fileRole": {
      "enum": [
        "markdown",
        "structured_json",
        "image",
        "table",
        "model_output",
        "unknown",
        "blocks",
        "page_map",
        "other"
      ]
    },
    "artifactRole": {
      "enum": [
        "markdown",
        "structured_json",
        "image",
        "table",
        "model_output",
        "unknown",
        "blocks",
        "page_map",
        "other",
        "directory"
      ]
    },
    "unavailableOutput": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "role",
        "format",
        "file_id",
        "reason"
      ],
      "properties": {
        "role": {
          "$ref": "#/$defs/fileRole"
        },
        "format": {
          "type": [
            "string",
            "null"
          ],
          "minLength": 1
        },
        "file_id": {
          "type": [
            "string",
            "null"
          ],
          "minLength": 1
        },
        "reason": {
          "enum": [
            "download_failed",
            "expired",
            "limit_exceeded",
            "not_returned",
            "unsupported_format",
            "cancelled",
            "unknown"
          ]
        }
      }
    }
  },
  "allOf": [
    {
      "anyOf": [
        {
          "properties": {
            "archives": {
              "minItems": 1
            }
          }
        },
        {
          "properties": {
            "provider_files": {
              "minItems": 1
            }
          }
        }
      ]
    }
  ]
} as const;

// Fixed-schema evaluator shared by the constrained producer and generic reader.
// Only the keywords present in the frozen 1.0.1 schema are supported.
import { isDeepStrictEqual } from 'node:util';
import { ExactDecimal, normalizeHashInput } from '../canonical.js';
export class BundleStructureError extends Error {
  readonly code = 'invalid_bundle';
}
export function validBundleDateTime(value: string): boolean {
  const p = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/i.exec(value);
  if (!p) return false;
  const [year, month, day, hour, minute, second, zoneHour, zoneMinute] = p.slice(1).map(v => Number(v ?? 0));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]
    && hour <= 23 && minute <= 59 && second <= 60 && zoneHour <= 23 && zoneMinute <= 59;
}
export function validBundleURI(value: string): boolean {
  if (/[^\x21-\x7e]|[<>"{}|\\^`]|%(?![0-9a-f]{2})/i.test(value)) return false;
  try {
    const parsed = new URL(value);
    if (['http:', 'https:'].includes(parsed.protocol)) return Boolean(parsed.hostname) && (!parsed.port || Number(parsed.port) > 0);
    return Boolean(parsed.pathname);
  } catch { return false; }
}
export function validateBundleStructure(manifest: unknown): void {
  function check(value: any, rule: any, location = '$'): void {
    const fail = (reason: string): never => { throw new BundleStructureError(`${location}: ${reason}`); };
    if (rule.$ref) {
      const target = rule.$ref.split('/').slice(1).reduce((node: any, key: string) => node[key], bundleSchema);
      if (!target) fail('unresolved schema reference');
      check(value, target, location);
    }
    if ('const' in rule && !isDeepStrictEqual(value, rule.const)) fail('constant mismatch');
    if (rule.enum && !rule.enum.some((entry: any) => isDeepStrictEqual(entry, value))) fail('invalid enum');
    const matches = (sub: any) => { try { check(value, sub, location); return true; } catch { return false; } };
    if (rule.anyOf && !rule.anyOf.some(matches)) fail('no matching shape');
    if (rule.allOf) for (const sub of rule.allOf) check(value, sub, location);
    if (rule.if) { const branch = matches(rule.if) ? rule.then : rule.else; if (branch) check(value, branch, location); }
    const decimal = value instanceof ExactDecimal;
    const numeric = decimal ? Number(value.value) : value;
    const integral = decimal ? typeof normalizeHashInput(value) === 'number' : Number.isSafeInteger(value);
    if (rule.type) {
      const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : decimal ? 'number' : typeof value;
      const types = Array.isArray(rule.type) ? rule.type : [rule.type];
      if (!types.some((t: string) => t === actual || t === 'integer' && integral)) fail('wrong type');
    }
    if ((typeof value === 'number' || decimal) && (!Number.isFinite(numeric) || rule.minimum !== undefined && numeric < rule.minimum)) fail('number outside bounds');
    if (typeof value === 'string') {
      const length = [...value].length;
      if (rule.minLength !== undefined && length < rule.minLength || rule.maxLength !== undefined && length > rule.maxLength) fail('string length');
      if (rule.pattern && !new RegExp(rule.pattern, 'u').test(value)) fail('pattern mismatch');
      if (rule.format === 'uri' && !validBundleURI(value)) fail('invalid URI');
      if (rule.format === 'date-time' && !validBundleDateTime(value)) fail('invalid date-time');
    }
    if (Array.isArray(value)) {
      if (rule.minItems !== undefined && value.length < rule.minItems) fail('too few items');
      if (rule.items) value.forEach((entry, i) => check(entry, rule.items, `${location}[${i}]`));
    } else if (value && typeof value === 'object' && !decimal) {
      for (const key of rule.required ?? []) if (!Object.hasOwn(value, key)) fail(`missing ${key}`);
      for (const [key, entry] of Object.entries(value)) {
        if (rule.propertyNames) check(key, rule.propertyNames, location);
        if (Object.hasOwn(rule.properties ?? {}, key)) check(entry, rule.properties[key], `${location}.${key}`);
        else if (rule.additionalProperties === false) fail(`unexpected ${key}`);
      }
    }
  }
  check(manifest, bundleSchema);
}
