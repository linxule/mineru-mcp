# Pinned flat content-list mapping fixtures

These are synthetic fixtures, not captured cloud responses. The PDF contains
three blank physical pages; its third page has 90-degree rotation. The content
JSON intentionally represents synthetic extracted content. No test claims OCR
accuracy or semantic correspondence between those words and the blank PDF.

The selected format profile is `2.5.4-flat-v1`, grounded in official MinerU
commit `61cc6886fe3edda8aa1c5b8bd2b6eaedddb8af99` (`mineru-2.5.4-released`).
`PROVENANCE.json` records exact source URLs, hashes, and relevant line ranges.
Official cloud documentation links content-list output to upstream output
format documentation; the hosted producer version remains unknown.

The mapper selects a supported flat shape from actual JSON, without filename
inference. `page_idx` is zero-based. Page numbers are checked against metadata
inspection of the exact source bytes. A provider binding established by exact
upload or provider checksum is required. Caller assertions remain unverified.

No slice or range offsets, grouped V2 schema, bounding-box rotation, printed
page label, or complete coverage is inferred. Observing pages 1 and 3 does not
prove page 2 missing. Unknown shapes remain preserved artifacts.

Both runtimes consume byte-identical copies of this directory. `manifest.json`
records each fixture hash. Expected outputs include canonical-result hashes,
so Python Unicode and TypeScript UUID/hash behavior are compared directly.
