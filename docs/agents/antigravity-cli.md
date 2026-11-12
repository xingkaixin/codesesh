# Antigravity CLI compatibility

The `antigravity-cli` adapter reads `.gemini/antigravity-cli/conversations/*.db`
under the home directory. `AGY_CONVERSATIONS_DIR` overrides the conversation directory;
its parent is used for the optional `conversation_summaries.db`. Antigravity IDE
`.gemini/antigravity/conversations/*.pb` files are a separate unsupported format.

Automatic discovery also includes Antigravity ACP profiles hosted by T3 Code:

```text
<T3 home>/userdata/providers/antigravity/<instance>/antigravity-acp/conversations/*.db
```

T3 home defaults to `~/.t3`; `T3CODE_HOME` selects another base directory. For a
T3 server started with `--base-dir`, set `T3CODE_HOME` to that same directory when
running or installing the CodeSesh Worker service. `AGY_CONVERSATIONS_DIR` selects
only its explicit conversation directory and disables automatic T3 profile discovery.
Profiles added after startup are discovered through the shared profile parent.
CLI and isolated ACP conversations share the `antigravity-cli` Agent identity.
CodeSesh reads their native stores without opening T3's application database.

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

ACP workspace and model fallbacks were checked against one local conversation on
2026-11-12. Step model field numbers also match
[T3 Code's native usage reader at ee90bdc](https://github.com/pingdotgg/t3code/blob/ee90bdc9405d8d4b8ff78ce2133ccb04844298ab/apps/server/src/provider/Drivers/antigravityUsageReader.ts).

- `steps.idx` supplies stable message identity and ordering.
- `steps.step_payload` is decoded for user prompts (field 19), assistant text
  (field 20), title updates (field 30), and step metadata (field 5). The embedded
  metadata and `steps.metadata` column carry the same decoded fields in the
  observed CLI and ACP conversations, but their bytes can differ.
- Step metadata supplies the native creation time (field 1), tool calls (field 4),
  model usage (field 9) and retry attempts (field 28, usage in field 2). Usage maps
  input, cache creation, cache read, total output, reasoning and visible output
  from fields 2, 4, 5, 3, 9 and 10. Input includes cache tokens; session output
  includes reasoning.
- Usage records are deduplicated within a conversation by response (field 11),
  provider message (field 12) and message (field 7) ids, because retry lists
  repeat the final attempt. Zero-token records are ignored.
- `gen_metadata.data` field 1 maps a model id (field 3) to a model name
  (field 19); step usage carries the model id in field 1 when available. Primary
  usage without an id falls back to the step's model configuration (metadata field
  24, API name field 12 or name field 8). Retries without their own model id remain
  unknown because they can use a different model. Generation usage repeats step
  usage in the observed conversations, so it is not counted again.
- Usage from a model response without visible text is attached to the next
  assistant message, normally its first tool call. Usage still pending after the
  last step is kept on a usage-only assistant message. Cost is estimated from
  model prices; Antigravity records no cost.
- The matching row in `conversation_summaries` supplies title, workspace file URIs,
  update time, and explicit parent conversation identity when available. Entries
  without a conversation database are not imported. Each conversation store uses
  its own summary database. Without a summary workspace, `trajectory_metadata_blob.data`
  supplies workspace file URIs from repeated field 7; the first local URI is used.
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
If a conversation directory disappears, its cached sessions remain available even
when another profile is still present. Removing an individual database from an
available conversation directory confirms that session's deletion.

`prost` owns Protobuf validation and unknown-field skipping. The small local message
structs declare only fields confirmed locally or by the cited readers. Cache creation
and provider message ids have not appeared locally. No generated upstream schema is
claimed.
This avoids implementing a second wire decoder and adds no external runtime or build
service. A generic event/evidence database is outside this integration's scope.
