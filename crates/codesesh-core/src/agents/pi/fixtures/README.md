# Node reference fixtures

`records.json` is a synthetic Pi session using the record shapes from
`packages/core/src/agents/__tests__/pi.test.ts` in Node CodeSesh 1.0.12
(source commit `a545f543a554421b0576058c701ef2ac4190d62e`).
`expected.json` was produced by that build's registered Pi adapter. The selected
branch covers recorded usage, tool results, extension messages, compaction,
local bash execution, and session naming; the abandoned branch must be absent.

The Rust test compares adapter metadata, statistics, model usage, and complete
messages. Reference message deserialization maps omitted nullable fields to
`None`, matching SQLite's HTTP materialization, while preserving omitted costs.
