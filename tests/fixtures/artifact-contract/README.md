# Frozen artifact contract fixtures

Version 1.0.1, canonical profile scholia.canonical-json.v1. These synthetic
fixtures make no hosted-provider or real-PDF page-mapping claims.

canonical/vectors.json contains independently written expected canonical text
and SHA-256 of its UTF-8 bytes. Inputs are JSON strings, so decimal lexemes and
duplicate keys survive loading the outer fixture. Negative cases must fail
strict parsing or raw-input normalization. Parsing alone may accept reserved
keys because normalized receipt configurations use decimal tags.

artifact-bundle.schema.json is an exact copy of the normative schema. bundles/
contains the normative synthetic examples, not standalone byte-complete bundles.
The source, archive and detached bytes are specified in the repository spec's
examples/README.md. Runtime importer fixture families add those bytes separately.

manifest.json covers every fixture except itself by relative path, byte length
and SHA-256. Consumers vendor the entire directory; do not fetch at runtime.

bundles/cases.json distinguishes structural from semantic negative manifests.
Semantic negatives intentionally pass JSON Schema and must be rejected by the
importer semantic/byte validation gate; this fixture package does not certify it.

conformance/cases.json defines the shared byte-complete acceptance matrix.
Each listed root includes a manifest and real synthetic retained bytes. Both
readers run every case, including semantic failures, byte corruption, portable
ZIP-profile rejections, reader limits, and temporary symlink substitutions.
The source fixture is not a parseable research paper and proves no page mapping.
