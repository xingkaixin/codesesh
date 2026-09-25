# Database warm restart validation — 2026-09-25

Source databases were copied using SQLite backup into isolated temporary homes. Original databases were not modified. Each adapter ran alone with a fresh cache, then restarted against the same source snapshot.

| Agent | Sessions | Cold startup | Unchanged restart | Rewritten sessions on restart | Sampled restart RSS |
| --- | ---: | ---: | ---: | ---: | ---: |
| DeepChat | 54 | 666 ms | 111 ms | 0 | 22.6 MiB |
| Cherry Studio | 348 | 846 ms | 58 ms | 0 | 23.6 MiB |
| OpenCode | 60 | 3420 ms | 162 ms | 0 | 19.3 MiB |

No unchanged restart reported full-history scanning. Timing includes process startup and status polling; RSS is sampled, not an exact peak.

Changing PRAGMA user_version in each copied source tested database stamp invalidation without changing session content. All sessions were reprocessed, counts remained unchanged, and progress was classified as checking updates rather than full-history scanning. The following restart again rewrote zero sessions. This verifies conservative database invalidation, not message-append semantics; HTTP parity and lifecycle tests cover adapter behavior separately.

Database/WAL stamp changes still invalidate the startup inventory conservatively. This change avoids unchanged restart parsing; it does not guarantee per-session parsing after every database write. Existing caches need one pass to populate the newly persisted database source state.

Validation: 201 Rust tests passed (3 existing ignored), Clippy, formatting, release build, and 28 backend contract tests passed.
