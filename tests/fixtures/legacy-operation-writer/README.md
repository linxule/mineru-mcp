# Archived operation writer

`operation_writer.ts` is the byte-for-byte source from
`3885b73:src/bundle/operation_writer.ts` in this repository. Its SHA-256 is
`d066ebe80b567247eacc263505a90879e08a12c7fd6f42d26a50182a8fb18162`.
`operation_writer.mjs` is its TypeScript 7 emitted ES2022 module, SHA-256
`7231b3abf95524ea9bd6887c17ab87582dbc218b86653320eb44bd89d46bc917`.
The range-intent regression redirects only that module's runtime imports to
the current bundle dependencies. It publishes original
unknown-coverage bundles before exercising current exact replay and successor
publication. Tests require neither Git history nor provider access.

Reproduce the archived bytes with
`git show 3885b73:src/bundle/operation_writer.ts`.
Compile with the locked compiler, `--ignoreConfig --noCheck --target ES2022
--module ES2022 --skipLibCheck`, and a fresh output directory. The source's
relative import paths refer to the original checkout layout; test import
redirection is applied in memory, never to the archived files.
