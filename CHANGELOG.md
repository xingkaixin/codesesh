# Changelog

## [0.1.5] - 2026-04-16

- fix(cli): read version dynamically from `package.json` instead of hardcoded value
- fix(web): rebuild web dist to resolve stale version showing `v0.1.3` in the UI

## [0.1.4] - 2026-04-16

- fix(core): initialize agent state when using cached scan results

## [0.1.3] - 2026-04-16

- fix(agents): filter out empty Cursor sessions (composers with no actual messages)
- feat(agents): add token usage tracking for Claude Code, Codex, and Kimi
- fix(agents): improve timestamp fallback for Codex and Kimi
- feat(web): enhance CLI output preview with styled agent status
- feat(web): inject app version from package.json at build time

## [0.1.1] - 2026-04-15

- Fix web UI returning 404 (web dist was resolved from the wrong path)
- Rename package from `agent-lens` to `codesesh`

## [0.1.0] - 2025-04-15

- Discover and aggregate sessions from Claude Code, Cursor, Kimi, Codex, and OpenCode
- Auto-detect local agent data directories with zero configuration
- Web UI for browsing all sessions with filtering by agent, directory, and date
- Full session replay with messages, tool calls, token usage, and cost
- Scan cache for instant subsequent startups
