# Antigravity CLI compatibility

The `antigravity-cli` adapter reads `.gemini/antigravity-cli/conversations/*.db`
under the home directory. `AGY_CONVERSATIONS_DIR` overrides the conversation directory;
its parent is used for the optional `conversation_summaries.db`. Antigravity IDE
`.gemini/antigravity/conversations/*.pb` files are a separate unsupported format.

## Evidence and scope

No authoritative public Protobuf schema was available for this CLI store. The
observed field numbers follow the third-party
[antigravity-acp-go reader at e1f1893](https://github.com/meloniteai/antigravity-acp-go/blob/e1f18935cf63bdaccb94eaef8c7ac2a0e01f1f73/protobuf.go),
and were checked against local CLI databases on 2026-10-05. Huihua's Antigravity
adapter also uses this subset. Usage field numbers follow
[ccusage's Antigravity parser at 11fa005](https://github.com/ccusage/ccusage/blob/11fa0056175332e69d7fdce37e66a744b1079b42/rust/adapters/antigravity/src/parser.rs)
and were checked against 14 local CLI databases on 2026-10-12. This is
compatibility evidence, not an official schema guarantee. Fixtures are synthetic
and contain no private transcript.

- `steps.idx` supplies stable message identity and ordering.
- `steps.step_payload` is decoded for user prompts (field 19), assistant text
  (field 20), title updates (field 30), and step metadata (field 5). Field 5 equals
  the `steps.metadata` column in every observed row.
- Step metadata supplies the native creation time (field 1), tool calls (field 4),
  model usage (field 9) and retry attempts (field 28, usage in field 2). Usage maps
  input, cache creation, cache read, total output, reasoning and visible output
  from fields 2, 4, 5, 3, 9 and 10. Input includes cache tokens; session output
  includes reasoning.
- Usage records are deduplicated within a conversation by response (field 11),
  provider message (field 12) and message (field 7) ids, because retry lists
  repeat the final attempt. Zero-token records are ignored.
- `gen_metadata.data` field 1 maps a model id (field 3) to a model name
  (field 19); step usage carries the model id in field 1. Generation usage repeats
  step usage with the same response ids in all observed rows, so it is not counted
  again. Usage without a model id (observed on step type 23 retries) keeps its
  tokens but has no cost estimate.
- Usage from a model response without visible text is attached to the next
  assistant message, normally its first tool call. Usage still pending after the
  last step is kept on a usage-only assistant message. Cost is estimated from
  model prices; Antigravity records no cost.
- The matching row in `conversation_summaries` supplies title, workspace file URIs,
  update time, and explicit parent conversation identity when available. Entries
  without a conversation database are not imported.
- Tool results and numeric tool status meanings are not established. Calls
  therefore use `unknown` status, retaining native step type/status in tool
  metadata.
- Steps without a native creation time use the summary update time, falling back
  to the conversation database modification time. The session summary counts
  unrecognized steps.
- Empty databases are omitted. Unsupported table schemas or malformed Protobuf
  fail the refresh, retaining the last committed cache. Unrecognized but valid
  steps are counted in the visible compatibility notice.
- Resume commands remain unavailable; tools use the existing default renderer.

SQLite is opened read-only in a transaction. Database/WAL changes and summary
changes invalidate source fingerprints; the existing paged scanner handles updates,
deletions, restart reuse and publication. Each conversation is an independent source.

`prost` owns Protobuf validation and unknown-field skipping. The small local message
structs declare only fields confirmed locally or by the cited readers. Cache creation
and provider message ids have not appeared locally. No generated upstream schema is
claimed.
This avoids implementing a second wire decoder and adds no external runtime or build
service. A generic event/evidence database is outside this integration's scope.
