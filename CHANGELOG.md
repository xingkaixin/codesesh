# Changelog

## [0.16.0] - 2026-07-23

This release adds persistent light, dark, and system themes across the Web app and product site, improves live-session correctness and large-history performance, and strengthens diagnostics, accessibility, and production quality gates.

### Features

- Added light, dark, and system theme controls to the Web app and product site, including persisted preferences, theme-aware agent icons, syntax highlighting, and tool output colors. (#178, #179, #180)
- Persisted versioned app-shell preferences across sessions. (#159)
- Added a Core diagnostics channel and CLI logger bridge so previously silent adapter, cache, JSONL, and SQLite failures are observable. (#160)
- Redesigned the product landing page with clearer sections, improved layout, and stronger accessibility semantics.
- Unified Web interaction motion through shared tokens and transitions. (#170)

### Bug Fixes

- Refresh changed session details during live scans so already-open sessions no longer remain stale. (#184)
- Decoupled head-cache initialization from search-index completeness and stopped rewriting the state schema on every database open. (#161, #165)
- Rebuilt the sidebar session action menu on Base UI and improved scan-status and copy-feedback announcements. (#172, #173)
- Restored the product showcase dialog label and isolated mutable end-to-end fixtures. (#157, #181)

### Performance

- Removed redundant enumeration, filesystem stat, and parsing work from the scan hot path; cached event-path signatures and project identities; and matched aliases without rerunning full search. (#162, #163, #164, #166)
- Virtualized large flat session lists, corrected grouped-session sorting, compressed API responses, and tracked timeline anchors with `IntersectionObserver`. (#167, #168)
- Optimized the product site to achieve perfect Lighthouse scores and isolated production analytics from local and preview builds. (#188)

### Accessibility

- Improved form error associations, skip-link and heading structure, timeline target sizes, number readability, and sidebar interaction semantics. (#171, #174, #175)

### Refactor

- Validated external adapter data at parse boundaries and unified field narrowing with drift reporting. (#176, #177)
- Consolidated Web surface colors into theme tokens, replaced pathname parsing with declarative route matches, and unified remote state with TanStack Query. (#156, #158, #169)

### Tests

- Expanded runtime-plan, semantic tool output, live-refresh, and cross-agent aggregation coverage; improved end-to-end failure diagnostics; and extended coverage gates to all production source. (#182, #183, #185, #186, #187)

### Changelog Detail

- #188 perf(www): achieve perfect Lighthouse scores @xingkaixin
- #187 test(e2e): cover cross-agent aggregation @xingkaixin
- #186 test(e2e): improve failure diagnostics @xingkaixin
- #185 test(cli): cover runtime plan @xingkaixin
- #184 fix(live): refresh changed session details @xingkaixin
- #183 test(web): cover semantic tool outputs @xingkaixin
- #182 test(coverage): gate all production source @xingkaixin
- #181 fix(e2e): isolate mutable fixtures @xingkaixin
- #180 fix: adapt agent icons and tool output colors to dark mode @xingkaixin
- #179 feat(www): add dark mode to landing page @xingkaixin
- #178 feat(web): add dark mode with theme toggle @xingkaixin
- #177 refactor(core): unify field narrowing via narrowField @xingkaixin
- #176 refactor: validate external data at adapter parse boundaries @xingkaixin
- #175 chore(web): widen timeline hit targets to 24px @xingkaixin
- #174 chore(web): fix form error wiring, skip link, heading levels @xingkaixin
- #173 fix(web): rebuild sidebar session menu on Base UI Menu @xingkaixin
- #172 fix(web): announce scan status and copy feedback politely @xingkaixin
- #171 chore(web): enable tabular figures in console mono @xingkaixin
- #170 feat(web): unify motion tokens and interaction transitions @xingkaixin
- #169 refactor(web): consolidate surface colors into tokens @xingkaixin
- #168 perf(web): track timeline anchors with IntersectionObserver @xingkaixin
- #167 perf: sidebar scalability — list virtualization, sort fix, API compression @xingkaixin
- #166 perf(core): cache project identity per process with TTL @xingkaixin
- #165 fix: decouple head cache init from search index completeness @xingkaixin
- #164 perf(cli): match aliases directly instead of full re-search @xingkaixin
- #163 perf: cache event-path session signatures per agent @xingkaixin
- #162 perf: eliminate redundant enumeration, stat and parse in scan hot path @xingkaixin
- #161 fix(core): stop rewriting state schema on every db open @xingkaixin
- #160 feat: add core diagnostics channel for silent failures @xingkaixin
- #159 feat(web): persist app shell UI preferences @xingkaixin
- #158 refactor(web): replace pathname parsing with route matches @xingkaixin
- #157 fix(www): restore showcase dialog label @xingkaixin
- #156 refactor(web): unify remote state with TanStack Query @xingkaixin
- feat(www): redesign landing page sections with improved layout and a11y @xingkaixin

## [0.15.0] - 2026-07-20

This release makes session tool calls easier to read: Codex code-mode exec calls are decoded back into native tool displays, tools render with semantic visualizations, and the timeline colors tools by activity.

### Features

- Decoded Codex code-mode `exec` tool calls back into native tool displays (bash, patch, write_stdin, node_repl, subagent, MCP), added dedicated renderers for `update_plan`, `web__run`, and `view_image`, split multi-call exec programs into ordered tool parts, and refreshed stale cached Codex details on upgrade via a lightweight pending-reindex migration. (#152)
- Added semantic tool visualizations and semantic rendering of Claude messages, while preserving Claude tool images and task tools. (#153)
- Colored the session timeline tools by activity classification. (#154)

### Changelog Detail

- #154 feat: color timeline tools by activity @xingkaixin
- #153 feat: add semantic tool visualizations @xingkaixin
- #152 feat(codex): decode code-mode exec into native tool displays @xingkaixin

## [0.14.0] - 2026-07-18

This release adds persistent session aliases and interactive time-range filtering, while improving navigation, motion, search backfill memory use, and internal module boundaries.

### Features

- Added persistent local session aliases that appear across session lists, bookmarks, activity views, details, and search results. (#132)
- Added Web time-range presets and custom date ranges, with complete-history backfill and range-aware dashboards, projects, agents, sessions, search, and live updates. (#133)
- Refined navigation and transient surface motion with reduced-motion support. (#135)

### Bug Fixes

- Aligned route-derived navigation and search context state, cancelled stale time-window loads, and kept rolling preset windows current. (#136, #137, #138)
- Restored keyboard focus after closing session action menus. (#139)
- Restored dragged receipt motion and streamed search-index backfill to avoid loading the full history into memory. (#141)

### Documentation

- Corrected architecture and tooling documentation drift. (#140)

### Refactor

- Unified file-agent transcript assembly and scan finalization, then consolidated shared cache metadata, agent registry metadata, and session normalization truth sources. (#143, #144, #145)
- Centralized CLI agent synchronization, scan interfaces, and time-window resolution. (#146, #147)
- Consolidated Web session refresh state, extracted app-shell models, and centralized agent identity metadata across Core, CLI, and Web. (#148, #149, #150)

### Tests

- Expanded unit coverage and quality gates across Core, CLI, and Web, including per-module test seams for cache, pricing, state, and utilities. (#134, #142)

### Changelog Detail

- #150 refactor: centralize agent identity metadata @xingkaixin
- #149 refactor(web): extract app shell models @xingkaixin
- #148 refactor(web): consolidate session data refresh @xingkaixin
- #147 refactor(cli): centralize scan interfaces and time windows @xingkaixin
- #146 refactor(cli): centralize agent sync lifecycle @xingkaixin
- #145 refactor: consolidate core and CLI truth sources @xingkaixin
- #144 refactor(core): centralize scan finalization @xingkaixin
- #143 refactor(core): unify file agent transcript assembly @xingkaixin
- #142 test(core): add per-module test seams @xingkaixin
- #141 fix: restore receipt motion and stream search backfill @xingkaixin
- #140 docs: correct architecture and tooling drift @xingkaixin
- #139 fix(web): restore session menu keyboard focus @xingkaixin
- #138 fix(web): keep rolling time windows current @xingkaixin
- #137 fix(web): cancel stale window data loads @xingkaixin
- #136 fix(web): align route-derived navigation state @xingkaixin
- #135 feat(web): refine navigation and transient motion @xingkaixin
- #134 test: improve unit test coverage @xingkaixin
- #133 feat: add session time range filtering @xingkaixin
- #132 feat: add local session aliases @xingkaixin

## [0.13.0] - 2026-07-12

This release adds timeline navigation for long sessions, improves scan and search reliability, and strengthens remote access and build validation.

### Features

- Added a sticky session message timeline with a canvas minimap, viewport tracking, and click-or-drag navigation for long session details. (#101)
- Added authenticated remote session access so sessions can be securely served beyond the local machine. (#114)

### Bug Fixes

- Isolated projects with colliding raw keys by including project kind and key in project identities and filters. Project-filter API queries must now provide both fields. (#102)
- Serialized per-agent scan work, stopped search workers atomically, settled early worker exits, cleaned up cancelled SSE streams, and stopped active scans during shutdown. (#103, #104, #115, #116, #117)
- Prevented stale session-detail responses from committing after route changes or refreshes, and made search failures recoverable. (#105, #119)
- Added keyboard access to dashboard charts and handled clipboard failures on the product site. (#121, #122)
- Streamed large Codex JSONL files during parsing to avoid worker out-of-memory failures on sessions exceeding 400 MB. (#101)
- Polished showcase motion and copy. (#130)

### Performance

- Batched incremental search-index state updates, coalesced pending index jobs, skipped redundant session queries for file-only searches, and bounded receipt simulation work. (#107, #108, #112, #129)

### Build

- Added parallel TypeScript 7 and TypeScript 6 toolchains, and moved Core declaration generation to TypeScript 6. (#100)
- Upgraded dependencies and pnpm to 11.11.0, migrated the dialog implementation from Radix UI to Base UI, and enabled CLI type-checking during build and release. (#111, #113)
- The published CLI now requires Node.js 22 or newer. (#118)

### Refactor

- Added a browser-safe shared HTTP contract for Core, CLI, and Web, and centralized session search semantics and session indexing. (#109, #110, #124)
- Unified detail drawer behavior, removed virtual-list polling, deepened live-scan lifecycle ownership, composed the Web app from route modules, and split search cache modules by concern. (#120, #123, #125, #126, #127)

### Tests

- Fixed package-specific Vitest environments, established website interaction coverage, and gated high-risk coverage scopes in CI. (#106, #122, #128)

### Changelog Detail

- #130 fix(ui): polish showcase motion and copy @xingkaixin
- #129 perf(web): cap receipt simulation work @xingkaixin
- #128 test(ci): gate high-risk coverage scopes @xingkaixin
- #127 refactor(core): split search cache modules @xingkaixin
- #126 refactor(web): compose app from route modules @xingkaixin
- #125 refactor(cli): deepen live scan lifecycles @xingkaixin
- #124 refactor(core): centralize session indexing @xingkaixin
- #123 refactor(web): remove virtual list polling @xingkaixin
- #122 test(e2e): establish website interaction baseline @xingkaixin
- #121 fix(web): add keyboard access to charts @xingkaixin
- #120 refactor(web): unify detail drawer behavior @xingkaixin
- #119 fix(web): make search failures recoverable @xingkaixin
- #118 chore(cli)!: require Node.js 22 @xingkaixin
- #117 fix(cli): stop active scans on shutdown @xingkaixin
- #116 fix(cli): clean up cancelled SSE streams @xingkaixin
- #115 fix(cli): settle early scan worker exits @xingkaixin
- #114 fix: secure remote access @xingkaixin
- #113 chore(deps): upgrade packages and migrate to base-ui @xingkaixin
- #112 perf(search): skip redundant sessions query for file-only search @xingkaixin
- #111 chore: add type-check gate to cli package @xingkaixin
- #110 refactor: deep session search module @xingkaixin
- #109 refactor: browser-safe HTTP contract module @xingkaixin
- #108 perf(search): coalesce pending index jobs @xingkaixin
- #107 perf(search): batch incremental index state @xingkaixin
- #106 fix(test): honor project Vitest environments @xingkaixin
- #105 fix(web): cancel stale session detail requests @xingkaixin
- #104 fix(live-scan): stop search workers atomically @xingkaixin
- #103 fix(live-scan): serialize agent scan operations @xingkaixin
- #102 fix(projects)!: use composite project identities @xingkaixin
- #101 feat(web): session message timeline with minimap navigation @xingkaixin
- #100 chore: dual-install TypeScript 7 and 6 @xingkaixin

## [0.12.0] - 2026-07-03

This release hardens scan refresh performance, local server safety, and live Web updates, while continuing the Web UI module split for maintainability.

### Bug Fixes

- Eliminated scan stalls, redundant rescans, and stale scanning indicators by moving project identity finalization into the refresh worker, memoizing cache schema setup, avoiding repeated FTS integrity checks, and throttling refreshes for rapidly changing sessions. (#98)
- Bounded incremental scans to the active display window and moved full-history reconciliation into a low-priority background pass, reducing startup and refresh cost on large local histories. (#89)
- Bound the CLI HTTP server to `127.0.0.1` by default and added an explicit `--host` option for external access, so unauthenticated local session data is not exposed to the LAN unless requested. (#90)
- Reconnect the Web SSE stream after closed connections or CLI restarts, with backoff, catch-up refresh, and a persistent reconnecting notice. (#93)

### Improvements

- Polished the shortcut help dialog with Radix Dialog focus handling, keyboard and overlay dismissal, reduced-motion-aware animations, and simplified shortcut grouping. (#97)

### Refactor

- Extracted Web data hooks, sidebar, keyboard shortcuts, session detail submodules, format helpers, API helpers, and per-agent tool strategies to reduce the size of `App` and `SessionDetail` and make behavior easier to test. (#74, #75, #76, #77, #78, #79, #80, #81, #83, #84, #85, #86, #87, #91, #92, #94, #95)
- Consolidated `LiveScanStore` refresh state into one map and removed dead cache/search exports. (#82, #96)

### Tests

- Completed dashboard `SessionStats` fixtures and expanded coverage around scan behavior, Web hooks, API helpers, and formatting modules. (#88)

### Changelog Detail

- #98 fix: eliminate scan stalls, redundant rescans, and stale scanning status @xingkaixin
- #97 chore(web): polish shortcut help dialog with Radix and motion @xingkaixin
- #96 refactor(cli): consolidate LiveScanStore refresh state into one map @xingkaixin
- #95 refactor(web): split tool-strategy.ts into per-agent files @xingkaixin
- #94 refactor(web): extract AppSidebar, useKeyboardShortcuts, ShortcutHelpDialog from App.tsx @xingkaixin
- #93 fix(web): reconnect SSE stream after it fully closes @xingkaixin
- #92 refactor(web): extract fetchJson helper in api.ts @xingkaixin
- #91 refactor(web): consolidate format helpers into lib/format @xingkaixin
- #90 fix(cli): bind HTTP server to loopback by default @xingkaixin
- #89 fix: bound incremental scans to the display window @xingkaixin
- #88 test(core): complete dashboard SessionStats fixtures @xingkaixin
- #87 refactor(web): extract session-detail-aux from SessionDetail @xingkaixin
- #86 refactor(web): extract message-list virtualization @xingkaixin
- #85 refactor(web): extract message-rendering from SessionDetail @xingkaixin
- #84 refactor(web): extract session-toc from SessionDetail @xingkaixin
- #83 refactor(web): extract file-change-tracker from SessionDetail @xingkaixin
- #82 refactor(core): collapse dead exports in cache/search.ts @xingkaixin
- #81 refactor(web): extract useInitialLoad and useLiveSync @xingkaixin
- #80 refactor(web): extract base data-layer hooks @xingkaixin
- #79 refactor(web): extract dashboard hooks @xingkaixin
- #78 refactor(web): extract useBookmarks hook @xingkaixin
- #77 refactor(web): extract useSessionSearch hook @xingkaixin
- #76 refactor(web): extract useSessionDetail hook @xingkaixin
- #75 refactor(web): extract useScanStatus hook @xingkaixin
- #74 refactor(web): table-dispatch tool strategy @xingkaixin

## [0.11.0] - 2026-06-23

### Features

- Added ZCode as a supported coding agent, including local session discovery, OpenCode-compatible SQLite parsing, live watch targets, Web UI icon coverage, and ZCode-specific tool displays. (#72)

### Bug Fixes

- Improved Web layout behavior around session details by collapsing side panels on tablet, overlaying the session receipt, measuring virtual rows before paint, and making the app sidebar collapsible. (#72)

### Refactor

- Extracted the shared OpenCode SQLite source so OpenCode-compatible agents can reuse the same parser without duplicating adapter logic. (#72)

### Changelog Detail

- #72 feat(agents): add ZCode session support @xingkaixin

## [0.10.0] - 2026-06-22

This release focuses on internal architecture refactoring across core, CLI, and the Web app, decomposing large modules into focused ones for maintainability.

### Bug Fixes

- Restored recursive file watch support on IBM i so live session refresh works again on that platform. (#70)
- Corrected SEO/AEO metadata inconsistencies on the product landing page. (#57)

### Documentation

- Synced the `llms-full.txt` build requirements to Node 24 and pnpm 11.5.1. (#68)

### Refactor

- Reshaped the agent adapter seam to centralize change detection. (#58)
- Split the cache module by concern and converged shared scan orchestration helpers. (#59, #60)
- Extracted a `SessionWatcher` deep module from `LiveScanStore` and sank dashboard aggregation into core. (#61, #62)
- Decomposed the Web `App` and `SessionDetail` into focused subcomponents and pure logic modules (tool normalization, path extraction, diff, file change, tool strategy). (#63, #64, #65, #66, #67)

### Tests

- Isolated project identity tests from host `/tmp` manifests. (#69)

### Changelog Detail

- #70 fix(watcher): restore ibmi recursive watch support @xingkaixin
- #69 test: isolate project identity from host /tmp manifests @xingkaixin
- #68 fix(www): sync llms-full.txt build requirements to Node 24 / pnpm 11.5.1 @xingkaixin
- #67 refactor(web): extract App subcomponents @xingkaixin
- #66 refactor(web): extract App pure logic into lib modules @xingkaixin
- #65 refactor(web): extract tool-strategy module from SessionDetail @xingkaixin
- #64 refactor(web): extract path-extract, diff, file-change modules @xingkaixin
- #63 refactor(web): extract tool-normalize module from SessionDetail @xingkaixin
- #62 refactor(analytics): sink dashboard aggregation to core @xingkaixin
- #61 refactor(cli): extract SessionWatcher deep module from LiveScanStore @xingkaixin
- #60 refactor(scan): converge shared orchestration helpers @xingkaixin
- #59 refactor(cache): split god module by concern @xingkaixin
- #58 refactor(agent): reshape adapter seam for change detection @xingkaixin
- #57 fix(www): correct landing page SEO/AEO inconsistencies @xingkaixin

## [0.9.1] - 2026-06-17

### Features

- Session detail resume command copying now includes Pi, matching other supported agents. (#55)

### Bug Fixes

- Deduplicate Claude Code per-request usage costs so token and cost totals are not inflated when the same usage block appears more than once. (#54)

### Changelog Detail

- #55 feat(resume): add Pi session command @xingkaixin
- #54 fix(claude): dedupe request usage costs @xingkaixin

## [0.9.0] - 2026-06-16

### Features

- Added Pi as a supported coding agent, including local session discovery, parsing, agent registration, icons, CLI package metadata, README coverage, and product landing page copy. (#49, #52)

### Bug Fixes

- Hide agents with zero sessions in the current statistics window so unused or inactive agents do not clutter dashboard summaries. (#48)
- Show relative file paths for supported agent tool displays when the session working directory is known, reducing noisy absolute paths in session details. (#50)
- Updated the session detail table of contents filter to use tri-state selection, so users can quickly clear all currently selected groups and see partial-selection state. (#51)

### Changelog Detail

- #52 feat(www): add Pi to landing page @xingkaixin
- #51 fix(web): add TOC tool filter tristate @xingkaixin
- #50 fix(agent): show relative tool paths @xingkaixin
- #49 feat(agent): add Pi session support @xingkaixin
- #48 fix(api): hide empty agents @xingkaixin

## [0.8.0] - 2026-06-05

### Features

- Added an opt-in React render profiler for the Web UI, with localStorage controls, per-component render timing, custom session-detail measurements, and optional client event logging for slow commits. (#45)

### Performance

- Deferred the session detail receipt render and memoized sidebar/bookmark handlers to reduce heavy detail-page and session-tree render work. (#45)
- Expanded the performance benchmark script with warm/cold cache modes, direct or click navigation, representative target selection, `--days 0` support, React profile collection, and richer timeout diagnostics. (#45)

### Build

- Upgraded pnpm to 11.5.1, pinned it in `mise.toml`, and let CI/release workflows use the package manager version declared by the repo. (#46)
- Updated runtime and build dependencies across the CLI, core, web app, landing page, and test tooling, including React, React Router, Hono, better-sqlite3, Tailwind, Vite, Astro, Vitest, Playwright, oxlint, and Turbo. (#46)

### Changelog Detail

- #46 build: upgrade dependencies and pnpm @xingkaixin
- #45 feat(perf): add benchmark profiling @xingkaixin

## [0.7.2] - 2026-05-30

### Bug Fixes

- Avoid blocking startup refresh work so the server can become available while background refresh continues. (#42)
- Avoid Codex refresh storms triggered by index metadata updates. (#43)

### Documentation

- Added the animated CodeSesh logo and refreshed README branding.

### Changelog Detail

- #43 fix(codex): avoid refresh storms from index updates @xingkaixin
- #42 fix: avoid blocking startup refresh @xingkaixin

## [0.7.1] - 2026-05-22

### Bug Fixes

- Avoid using the writable cache connection for file activity reads, except when path filtering requires FTS. (#40)

### Changelog Detail

- #40 fix: avoid writable file activity reads @xingkaixin

## [0.7.0] - 2026-05-22

### Features

- Added resume command copying across supported agents, extending the session detail recovery workflow beyond Claude Code. (#19)
- Grouped Codex scratch chats under a stable project identity so temporary Codex sessions stay organized. (#32)
- Improved session cache initialization so the Web UI can start from a coherent cache state more reliably. (#38)

### Bug Fixes

- Fixed cache, live refresh, and cold-start edge cases around project identity, incremental persistence, serving order, and session details. (#20, #22, #31, #34, #37)
- Fixed search and file activity hot paths by removing message-match N+1 work and optimizing file activity lookup. (#23, #24)
- Added dynamic port fallback when the requested HTTP port is unavailable. (#28)
- Improved Codex tool display and normalized namespaced Codex tool labels. (#35, #36)

### Performance

- Optimized dashboard aggregation, session detail rendering, app session derivations, startup scans, follow-up hot paths, and startup refresh scheduling. (#21, #25, #26, #27, #29, #33)
- Added session cache fingerprints to avoid unnecessary cache refresh work. (#30)

### Changelog Detail

- #38 feat: improve session cache initialization @xingkaixin
- #37 fix: handle cold-start session details @xingkaixin
- #36 fix: improve Codex tool display @xingkaixin
- #35 fix(codex): normalize namespaced tool labels @xingkaixin
- #34 fix(cli): normalize project identity on refresh @xingkaixin
- #33 perf: defer startup refresh @xingkaixin
- #32 [codex] Group Codex scratch chats @xingkaixin
- #31 fix(cli): sync session cache before serving @xingkaixin
- #30 perf: track session cache fingerprints @xingkaixin
- #29 perf: improve startup scan performance @xingkaixin
- #28 fix(cli): add dynamic port fallback @xingkaixin
- #27 perf: fix follow-up performance hotspots @xingkaixin
- #26 perf(web): index app session derivations @xingkaixin
- #25 perf(web): optimize session detail rendering @xingkaixin
- #24 fix: optimize file activity search @xingkaixin
- #23 fix(search): remove message match N+1 @xingkaixin
- #22 fix: persist live refresh incrementally @xingkaixin
- #21 perf: optimize dashboard aggregation @xingkaixin
- #20 fix: cache project scope identity @xingkaixin
- #19 feat(web): add agent resume copy commands @xingkaixin

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
