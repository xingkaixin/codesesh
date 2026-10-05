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
adapter also uses this subset. This is compatibility evidence, not an official
schema guarantee. The SQL fixture is synthetic and contains no private transcript.

- `steps.idx` supplies stable message identity and ordering.
- `steps.step_payload` is decoded for user prompts (field 19), assistant text
  (field 20), title updates (field 30), and tool calls (field 5 / field 4).
- The matching row in `conversation_summaries` supplies title, workspace file URIs,
  update time, and explicit parent conversation identity when available. Entries
  without a conversation database are not imported.
- Model, usage, tool results and numeric tool status meanings are not established.
  Calls therefore use `unknown` status, retaining native step type/status in tool
  metadata. No token or cost estimates are invented.
- Message timestamps currently use the summary update time, falling back to the
  conversation database modification time. They are not native per-step times.
  The session summary explains this limitation and counts unrecognized steps.
- Empty databases are omitted. Unsupported table schemas or malformed Protobuf
  fail the refresh, retaining the last committed cache. Unrecognized but valid
  steps are counted in the visible compatibility notice.
- Resume commands remain unavailable; tools use the existing default renderer.

SQLite is opened read-only in a transaction. Database/WAL changes and summary
changes invalidate source fingerprints; the existing paged scanner handles updates,
deletions, restart reuse and publication. Each conversation is an independent source.

`prost` owns Protobuf validation and unknown-field skipping. The small local message
structs declare only confirmed fields; no generated upstream schema is claimed.
This avoids implementing a second wire decoder and adds no external runtime or build
service. A generic event/evidence database is outside this integration's scope.
