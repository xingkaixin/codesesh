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
- `steps.step_payload` is decoded for user prompts (field 19: direct text field 2
  or item segments in repeated field 3, plus file/directory context URIs in item
  field 2), assistant text (field 20), title updates (field 30), and step
  metadata (field 5). The embedded metadata and `steps.metadata` column carry
  the same decoded fields in the observed CLI and ACP conversations, but their
  bytes can differ.
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
- The matching row in `conversation_summaries` supplies title, workspace file URIs
  (`workspace_uris`), update time, and explicit parent conversation identity when
  available. Entries without a conversation database are not imported. Each
  conversation store uses its own summary database. Candidate local workspace
  paths come from `conversation_summaries.workspace_uris`, or
  `trajectory_metadata_blob.data` repeated field 7 when summary workspaces are
  empty. When multiple local workspaces are present, the adapter selects the
  candidate matching `history.jsonl` for that conversation, then explicit user
  context URIs and tool-call path/command inputs in `steps`, then the parent
  conversation's workspace, falling back to the first local URI.
  When a child has no title update or summary title, the same summary row's
  nonempty `agent_name` supplies its display title before the prompt fallback.
  Names do not identify sessions or establish parent relationships.
- Tool results were checked against local CLI and ACP databases on 2026-11-14.
  Step type 132 carries text in payload `140/2/1`. Legacy `view_file` (step type
  8) carries content in `14/4`, `run_command` (21) carries output in `28/21/1`,
  and `call_mcp_tool` (38) carries its result text in `47/3`. The adapter retains
  these strings without interpreting arbitrary output text as success or failure.
- Explicit errors come from `steps.error_details` fields 2/3, falling back to
  payload field 31 with the same structure. Duplicate message/detail text is
  displayed once. These calls use `error` status; other calls remain `unknown`
  because the complete numeric status mapping is not established. Native step
  type/status remain in tool metadata.
- A `swarm add` result with `status: "added"` and a `conversation_id` supplies
  the existing message-level sub-session link. The summary's explicit parent
  identity still owns the session hierarchy; names and task text are never
  used to infer it.
- Steps without a native creation time use the summary update time, falling back
  to the conversation database modification time. The session summary counts
  unrecognized steps.
- Empty databases are omitted. Unsupported table schemas or malformed Protobuf
  fail the refresh, retaining the last committed cache. Unrecognized but valid
  steps are counted in the visible compatibility notice.
- Read/view, command, write/edit and `swarm` calls have dedicated displays.
  Native results and errors remain visible; requested file content and diffs are
  labeled separately from execution evidence. Full tool input remains available.
  Other tools retain a text result fallback. Resume commands remain unavailable.

SQLite is opened read-only in a transaction. Database/WAL, summary, and
`history.jsonl` changes invalidate source fingerprints; the existing paged scanner
handles updates, deletions, restart reuse and publication. Each conversation is
an independent source.
If a conversation directory disappears, its cached sessions remain available even
when another profile is still present. Removing an individual database from an
available conversation directory confirms that session's deletion.

`prost` owns Protobuf validation and unknown-field skipping. The small local message
structs declare only fields confirmed locally or by the cited readers. Cache creation
and provider message ids have not appeared locally. No generated upstream schema is
claimed.
This avoids implementing a second wire decoder and adds no external runtime or build
service. A generic event/evidence database is outside this integration's scope.
