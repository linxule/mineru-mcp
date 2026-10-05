# Zero-offset prefix mapping extension

These additive synthetic vectors use `2.5.4-flat-prefix-v2` and adapter
`mineru-content-list-flat` version `2`. Existing `cases.json`, v1 payloads,
expected outputs, `README.md` and `PROVENANCE.json` remain unchanged.

Pinned upstream code builds a new PDF when selecting input pages and then
enumerates the resulting pages. Hosted documentation does not guarantee an
original-document offset. For a contiguous prefix beginning at physical page
1, original and subset-local indices coincide. `PREFIX_PROVENANCE.json` records
exact source URLs, response hashes, retrieval scope and this limited inference.

The receiver must inspect the exact original PDF bytes and establish exact
provider binding. Retained V4 request options `page_ranges` or the internal
`pages` alias must contain a single positive `1` or `1-N` selector, agree with
canonical `coverage.requested`, and remain inside the inspected original PDF.
ASCII JSON whitespace (space, tab, CR, LF) may normalize; comma lists, suffixes, disjoint selections, negative
indices, alternate or nested selectors, falsy selectors and slices cannot map.
Both known aliases may coexist only when they agree. No external validation
flag can authorize an unsupported scope.

A block index must be less than the prefix length. The original provider bytes
and archive member pointers remain exact, and no offset is added. Mapping
still reports unknown coverage: observing a block does not prove completion,
absence, missing blank pages, OCR accuracy or semantic identity.

New prefix imports use local structured derivation version 3. Full-document
version 2 and historical version 1 remain unchanged; successful older range
receipts replay their original unknown mapping and immutable artifact IDs.
