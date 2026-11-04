# Node reference fixtures

`records.json` is a synthetic Claude Code transcript using the record shapes from
`packages/core/src/agents/__tests__/claudecode.test.ts` in Node CodeSesh 1.0.12
(source commit `a545f543a554421b0576058c701ef2ac4190d62e`).
`expected.json` was produced by that build's registered Claude adapter with its
bundled pricing snapshot. It records both the scanned head and loaded detail.

The Rust test compares all adapter metadata, statistics, model usage, and every
message against these values. Deserializing reference messages into the shared
contract maps omitted nullable fields to `None`, matching SQLite's HTTP
materialization. Costs retain the distinction between omitted and zero.
