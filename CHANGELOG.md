# Changelog

## [0.6.1] - 2026-05-12

### Bug Fixes

- Fixed project detail routing for path-based projects by using a single encoded route key. (#18)

### Changelog Detail

- #18 fix(projects): use single route encoding @xingkaixin

## [0.6.0] - 2026-05-12

### Features

- Added project browse mode with a `/projects` overview, project-scoped dashboards, cross-agent project session navigation, and project identity preservation in routes. (#17)
- Added structured global search with query qualifiers and UI filters for agent, project, smart tag, tool, file activity, and cost ranges. (#16)
- Added a global file activity index that records read, edit, write, and delete events from tool calls, then exposes them through search and API filters. (#15)
- Added SQLite schema migrations and backup support so local cache upgrades can evolve the shared session, search, bookmark, and file activity store. (#9)
- Added a Claude Code copy-resume-command button that builds worktree-aware `claude --resume` commands from the session detail view. (#6)

### Reliability

- Unified agent parse cleanup so internal tool/event noise is normalized consistently across supported adapters. (#13)
- Normalized session persistence around structured session rows, parent session upserts, project identity backfills, and file activity data. (#11)
- Hardened the LiveScan watcher with a more durable refresh pipeline and a non-recursive watch fallback. (#10)

### Performance

- Optimized FTS bulk sync with bulk/incremental modes and more durable trigger handling for large cache updates. (#12)

### Tests

- Added Playwright e2e coverage and SQLite migration smoke tests, including a longer migration timeout for slower environments. (#14)

### Changelog Detail

- #17 feat(projects): add project browse mode @xingkaixin
- #16 Add structured global search @xingkaixin
- #15 Add global file activity index @xingkaixin
- #14 Add e2e and migration smoke tests @xingkaixin
- #13 feat(core): unify agent parse cleanup @xingkaixin
- #12 perf(search): optimize FTS bulk sync @xingkaixin
- #11 feat(cache): normalize session persistence @xingkaixin
- #10 refactor: harden livescan watcher @xingkaixin
- #9 feat: Add SQLite migrations and backups @xingkaixin
- #6 feat(web): add copy-resume-command button to Claude Code sidebar @nengqi

## [0.5.0] - 2026-05-02

- feat(core): add smart tag classification for bugfixes, refactors, features, tests, docs, planning, git, build, and exploration workflows
- feat(core): add pricing data, model aliases, and estimated cost calculation when sessions only record token usage
- feat(codex): parse model usage from token count events
- feat(web): add a project-aware session tree sidebar with bookmark toggles and smart tag filters
- feat(web): add an interactive receipt summary to session details
- feat(web): improve dashboard charts with Recharts and replace the tool output highlighter implementation
- feat(cli): add structured local logs, client-side UI event logging, and a performance benchmark script
- feat(www): add SEO metadata, Open Graph/Twitter cards, sitemap, robots.txt, and a social preview image
- fix(cli): keep the published CLI runtime compatible with Node.js 18 by using `chokidar` v4
- test: add live scan store, Kimi cache refresh, project identity, pricing, and filesystem coverage

## [0.4.1] - 2026-04-24

- fix(cli): include SQLite runtime dependency in the published CLI package
- fix(api): keep the bookmarks endpoint stable when SQLite storage is unavailable

## [0.4.0] - 2026-04-24

- feat(bookmarks): add SQLite-backed session bookmarking with API routes and Web UI controls
- feat(web): add file change tracking to the session detail table of contents
- feat(web): support delete and move operations in the Codex patch viewer
- feat(web): add keyboard navigation and a shortcuts panel
- feat(web): add token and model analytics to the dashboard, including Claude cache token metrics
- feat(www): add a product tour section with marquee screenshots and an expandable lightbox
- feat(ci): normalize line endings to LF in CI

## [0.3.0] - 2026-04-21

- feat(core): migrate session cache from JSON files to a unified SQLite database
- feat(web): add full-text session search powered by SQLite FTS, with highlighted matches in the UI
- feat(cli): keep the live refresh pipeline and search index in sync as sessions change
- docs: add SQLite storage documentation covering schema, indexing, and data flow
- feat(web): improve code formatting consistency across session detail rendering
- docs: clarify that time filters use session activity time instead of creation time

## [0.2.0] - 2026-04-20

- feat(cli): add live session refresh with filesystem watchers and server-sent events
- feat(web): add a dashboard with activity charts, agent distribution, recent activity, and breadcrumb navigation
- feat(web): keep dashboard and session lists aligned with CLI time filters such as `--days`, `--from`, and `--to`
- feat(core): improve Codex parsing and cache refresh with recent-session revalidation
- feat(cli): keep full history in the server store while preserving windowed JSON output semantics
- fix(api): use session activity time for dashboard windowing
- chore: bump packages to `0.2.0`, update pnpm to `10.33.0`, and fix OS-independent test paths

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
