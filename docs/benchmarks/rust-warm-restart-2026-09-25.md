# Cached Codex restart validation — 2026-09-25

The original full scan completed at 23:26:06 Asia/Shanghai in 573.348 seconds, with no failed agents. Subsequent startups displayed full-history scanning even when their batches only checked cached source fingerprints.

The scanner now applies the 32-item / 16 MiB batch limits to sources requiring parsing. Unchanged cached sources can pass through the same batch without consuming that budget. Existing-history updates use the `checking` progress phase; cold scans and parser-version rebuilds retain `scanning`.

Validation used isolated APFS clones of the local cache, selected only Codex, and read original source files without modifying them. Each cache contained 4,012 Codex sessions. A temporary SQLite trigger recorded distinct sessions whose messages were rewritten. Startup duration includes process startup and checking for source updates.

| Run | Duration | Rewritten sessions | Full-history notice | Sampled peak RSS |
| --- | ---: | ---: | --- | ---: |
| Before, catch up pending changes | 24.994 s | 78 | Yes | 148.4 MiB |
| Before, restart with no changes | 6.891 s | 0 | Yes | 84.2 MiB |
| After, catch up pending changes | 12.718 s | 78 | No; checking updates | 148.0 MiB |
| After, restart with no changes | 1.733 s | 0 | No | 68.6 MiB |

These are sequential local acceptance measurements with live sources, not an isolated throughput benchmark. No parser-version increment or user-cache deletion is required for this fix. The temporary cache copies were removed after validation.

Validation: 201 Rust tests passed (3 existing ignored), 22 cache/lifecycle contracts passed, 26 scan-format tests passed, strict Clippy, Web lint and release build passed. Regression coverage includes cold pagination, durable resume, a warm 65-source check completing in one batch, and detecting a modification plus deletion after restart.
