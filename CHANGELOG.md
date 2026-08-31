# Changelog

## [1.0.5] - 2026-08-31

This release adds copying sessions as Markdown from action menus and Umami analytics on the landing page, avoids full search-index rebuilds during refresh, loads cold session details in background workers, correlates and protects local diagnostic logs, and improves live session and project state consistency across reloads.

### Features

- Added copying sessions as formatted Markdown from the session actions menu and sidebar. (#547)
- Added Umami analytics integration to the product landing page. (#546)

### Performance

- Incremental scan refreshes now update only changed documents rather than rebuilding the full text search index, keeping publication progress counts accurate. (#566)
- Moved cold session detail loading into dedicated background workers to avoid blocking the main thread. (#540)
- Reused session lookups within the search index maintenance scheduler, removing duplicate queries. (#544)

### Diagnostics & Logging

- Hardened local diagnostic logging with bounded memory and disk allocations, process exit flushing, request correlation, and worker context retention with full log draining. (#557)

### Bug Fixes

- Preserved parent session references for Claude Code child sessions. (#565)
- Coordinated live project queries during concurrent updates and bounded recovery to the active time window. (#564)
- Read cached session details from a single snapshot to prevent inconsistent concurrent reads. (#563)
- Preserved visibility for newly created session content under active filter changes. (#562)
- Preserved instance query scopes across search, session filtering, and file activity queries. (#561)
- Preserved pricing snapshot identity across refresh generations. (#560)
- Reconciled final Claude Code request usage and tokens even when no visible content was emitted. (#559)
- Published refresh state only after persistence succeeds, preventing live status from diverging from storage. (#548)
- Aligned calendar day range semantics and boundary calculations across the CLI and Web interface. (#549)
- Preserved live session and project updates during reloads and initial fetch phases. (#541, #550)
- Surfaced incomplete session load states explicitly in the Web UI. (#542)
- Refreshed active dashboard scopes on live events. (#543)
- Decoupled session readiness from statistics calculation so aggregate metrics do not delay session interaction. (#545)

### Refactor

- Split CLI API handlers by resource domain into modular endpoints (session, dashboard, catalog, search, bookmark, and client logs). (#552)
- Unified session source parsing logic in the agent base class, removing duplicate child implementations. (#555)
- Centralized refresh commit planning and state finalization in discovery scanning. (#553)
- Split Web shell rendering responsibilities and scoped models and state by route. (#551, #554)
- Bound API clients to access context and telemetry. (#556)

### Build

- Dropped unused PostCSS dependencies from the Web application. (#558)
- Upgraded production dependencies `@hugeicons/react` to 1.1.10 and `@tanstack/react-query` to 5.102.1. (#538)
- Upgraded development dependency `eslint` to 10.9.0. (#539)

## [1.0.4] - 2026-08-24

This release adds a Japanese landing page, authenticates the loopback API and tightens trusted-proxy deployment, makes scan publication and cache migrations preserve the last known-good state, and reduces indexing and rendering work on large histories. It also narrows the internal core runtime and contract APIs; consumers of `@codesesh/core` should review the compatibility notes below.

### Features

- Added a complete Japanese product landing page and centralized localized landing-page content. (#485)
- Exposed scan-pipeline timings and publication stages so long-running refreshes report meaningful progress. (#507)

### Security

- Authenticated loopback API requests, including packaged-artifact smoke checks. (#437)
- Restricted `--trust-proxy` to a loopback `--host` with an HTTPS `--public-url`, preventing unsafe direct exposure behind a trusted proxy. (#438)
- Sanitized public session heads before they cross the browser-safe contract. (#515)

### Bug Fixes

- Preserved the last committed scan and refresh baseline across unavailable agents, failed change checks, partial backfills, I/O failures and publication failures; refresh checks are now committed only after publication succeeds. (#426, #427, #428, #433, #460, #462, #473, #477, #496, #508, #528, #533)
- Made cache schema changes explicit and failure-safe, removed obsolete SQLite tables without backing them up, unified row deletion and separated transient publication payloads from the durable database. (#467, #492, #495, #497, #517, #535, #536)
- Corrected Codex token accounting, Grok message grouping, Kimi Code head scans and file-operation classification. (#461, #509, #510, #512)
- Reindexed sessions after project identity changes, unified dashboard date parsing and isolated concurrent pricing-miss capture. (#475, #516, #529)
- Kept Web aggregates, projects, aliases and bookmarks consistent after concurrent or trailing updates, reused dashboard query data and surfaced resource and project reload failures. (#434, #435, #436, #493, #531, #532)
- Made the one-shot `--json` path shut down workers and SQLite connections before exiting. (#466)

### Performance

- Reused parsed agent metadata and materialized session data, streamlined search freshness checks, and added a covering SQLite index so unchanged histories no longer reread transcript bodies. (#468, #507)
- Bounded project identity work, SSE connections, project pagination, timeline rendering and large-content rendering, while indexing child lookups and releasing inactive projections. (#439, #440, #443, #444, #445, #446)
- Batched session-detail invalidation and derived session requests directly from the active time window, reducing redundant Web queries and refreshes. (#520, #526)
- Staged publication payloads in SQLite's temporary schema so interrupted publications cannot leave multi-gigabyte durable copies behind. (#467)

### Compatibility

- `--trust-proxy` now requires a loopback `--host` and an HTTPS `--public-url`. (#438)
- The `@codesesh/core` package root is limited to one-shot scanning, and the former catch-all runtime entry point has been replaced by focused runtime subpaths. (#491, #534)
- Session identity is exposed through structured references, `SessionsUpdatedEvent` uses `newSessionRefs`, and file-system sources synchronize through `sessionSourceAccess.synchronize`. (#494, #519, #521)
- `loadCachedSessions` was replaced by `readCachedSessions`, which returns an explicit result that callers must handle. (#496)

### Refactor

- Split agent record conversion, cache schema and search-index responsibilities, scan planning, synchronization finalization, Web session state, timeline behavior and product-demo scenes into focused modules. (#463, #464, #469, #470, #471, #472, #476, #478, #479, #480, #481, #483, #484, #498, #499, #500, #501, #503, #504, #506, #522, #524, #525, #527, #530)
- Centralized the Agent catalog, session reference keys, smart-tag policy and file-source capabilities, and removed production import cycles. (#457, #458, #459, #482, #502, #503, #518)

### Build

- Upgraded production and development dependencies, centralized shared dependency versions, retained the Node 22 type contract and verified the CLI against Node 22.0.0. (#448, #449, #450, #451, #452, #453, #487, #489, #490)

### Documentation

- Corrected documented repository paths and refreshed the live runtime, scan, cache and SQLite architecture documentation. (#455, #456)

## [1.0.3] - 2026-08-16

This release attributes dashboard and project usage to the time of each message instead of the whole session, stops scan, cache and CLI failures from silently degrading published state, and removes repeated parsing, query and render work across agents, the cache and the web UI.

### Bug Fixes

- Attributed usage, tokens and cost to the time of each message rather than the session, so a session spanning several days is no longer charged entirely to one of them. (#424)
- Stopped agent adapters from reporting database read failures as empty session lists, and gave every scan step a single error taxonomy. (#416)
- Committed the database change baseline only after a scan succeeds, so an interrupted scan no longer marks changed sources as already processed. (#398)
- Preserved committed partial scan outcomes and exposed them in scan status. (#382)
- Preserved scan state when a scan worker is unavailable, and retained the cache baseline after failed writes. (#380, #381)
- Recorded full-sync completion on a fresh cache, cleared orphaned cache tables, and surfaced cache marker and persistence failures to the CLI instead of continuing silently. (#396, #399, #404)
- Kept the index batch running past non-fatal jobs, isolated listener fan-out failures, bounded the smart-tag worker lifecycle, and hardened unhandled rejection paths around backfill probes, timer-scheduled refreshes and shutdown. (#397, #402, #403, #405)
- Covered every session signature field so metadata-only changes are detected, and normalized environment data-root overrides while keeping absolute paths verbatim. (#390, #409)
- Rejected unknown agents on state writes. (#406)
- Hardened loopback project identity resolution, normalized Windows scope paths, and handled malformed legacy sessions. (#379)
- Distinguished session from project load failures in the web UI, and hardened retry, menus and dead-end routes. (#393, #412)
- Made message collapsibles keyboard accessible and unified the landing agent panel on session detail. (#395)

### Security

- Logged parsed startup flags instead of raw argv, keeping the one unredacted logging sink from capturing future credential-bearing flags. (#417)

### Performance

- Aggregated dashboard model cost from a per-session rollup table and cached dashboard storage aggregates across requests. (#385, #408)
- Indexed sessions by bare activity time and reused snapshot session trees. (#388, #407)
- Streamed cached message suffixes over persisted cursor hash chains instead of re-reading whole transcripts. (#386)
- Cached Codex thread metadata by file fingerprint and Codex child final messages, and avoided duplicate Kimi detail transcript reads. (#383, #384, #401)
- Tracked transcript part kinds while building instead of rescanning parts. (#420)
- Resolved session-detail identity off the event loop. (#400)
- Reduced live session render work by localizing search input and sidebar selection state and splitting live projections. (#394)
- Repainted the interactive receipt without rebuilding its simulation. (#421)

### Refactor

- Split API handlers into focused modules and extracted the CLI status reporter and index publisher. (#422, #423)
- Unified four drifted agent timestamp parsers into one shared utility. (#410)
- Shared the agent tool argument parser and centralized session slugs. (#389, #391)
- Narrowed the contract change boundaries, named persisted changes, and isolated test fixtures. (#392)
- Pruned dead exports from the core public barrel. (#419)

### Tests

- Closed coverage gaps around the web api client, theme bootstrap and degraded-server retry. (#413)
- Guarded session tree titles against HTML injection. (#411)
- Benchmarked message scan tradeoffs for search. (#387)

### Build

- Patched nanoid, aligned `@types/node` across the workspace, and moved the landing page analytics token into an environment variable. (#418)
- Added a dedicated typecheck task, split bundle tests out of the default suite, cancelled superseded CI runs and cached Playwright. (#414)

### Documentation

- Added the verification commands to `AGENTS.md` and recorded the dependency decisions. (#415, #418)

### Changelog Detail

- #424 fix(analytics): attribute usage by message time @xingkaixin
- #423 refactor(cli): Extract status reporter and index publisher @xingkaixin
- #422 refactor(api): Split handlers into focused modules @xingkaixin
- #421 perf(web): Repaint receipt without rebuilding the sim @xingkaixin
- #420 perf(agents): Track part kinds instead of rescanning @xingkaixin
- #419 chore(core): Prune dead exports from the public barrel @xingkaixin
- #418 chore(deps): dependency and manifest hygiene @xingkaixin
- #417 chore(cli): Log parsed startup flags instead of argv @xingkaixin
- #416 refactor(agents): codify the adapter error taxonomy and stop masking db failures @xingkaixin
- #415 docs: Add verification commands to AGENTS.md @xingkaixin
- #414 chore: tighten the DX feedback loops (typecheck task, bundle-test split, CI concurrency) @xingkaixin
- #413 test: close the coverage gaps around the api client, theme bootstrap, and degraded-server retry @xingkaixin
- #412 fix(web): robustness details across retry, menus, and dead-end routes @xingkaixin
- #411 test(web): Guard tree titles against HTML injection @xingkaixin
- #410 refactor(agents): unify the four drifted timestamp parsers @xingkaixin
- #409 fix(discovery): normalize env data-root overrides @xingkaixin
- #408 perf(cache): aggregate dashboard model cost from a per-session rollup @xingkaixin
- #407 perf(cache): index sessions by bare activity time @xingkaixin
- #406 fix(api): Reject unknown agents on state writes @xingkaixin
- #405 fix(cli): Continue index batch past non-fatal jobs @xingkaixin
- #404 fix(cache): surface cache marker write and read failures @xingkaixin
- #403 fix(cli): Isolate listener fan-out failures @xingkaixin
- #402 fix(discovery): Bound smart-tag worker lifecycle @xingkaixin
- #401 perf(codex): Cache thread meta by file fingerprint @xingkaixin
- #400 fix(api): resolve session-detail identity off the event loop @xingkaixin
- #399 fix(cache): Record full-sync completion on fresh cache @xingkaixin
- #398 fix(agents): commit database change baseline only after the scan succeeds @xingkaixin
- #397 fix(cli): harden unhandled rejection paths @xingkaixin
- #396 fix(cache): Clear orphaned cache tables @xingkaixin
- #395 fix(web): align detail landing interactions @xingkaixin
- #394 refactor(web): reduce live session render work @xingkaixin
- #393 fix(web): distinguish API load failures @xingkaixin
- #392 refactor(contract): narrow change seams @xingkaixin
- #391 refactor(agents): share tool argument parser @xingkaixin
- #390 fix(discovery): cover session signature fields @xingkaixin
- #389 refactor(agents): centralize session slugs @xingkaixin
- #388 fix(api): reuse snapshot session trees @xingkaixin
- #387 perf(search): benchmark message scan tradeoffs @xingkaixin
- #386 fix(discovery): stream cached message suffixes @xingkaixin
- #385 fix(api): cache dashboard storage aggregates @xingkaixin
- #384 fix(codex): cache child final messages @xingkaixin
- #383 Avoid duplicate Kimi detail transcript reads @xingkaixin
- #382 Fix committed partial scan status @xingkaixin
- #381 Fix cache persistence baseline handling @xingkaixin
- #380 fix(scan): preserve state on worker unavailability @xingkaixin
- #379 fix(projects): harden loopback identity resolution @xingkaixin

## [1.0.2] - 2026-08-14

This release adds DeepSeek Harness (DSH) as the tenth supported agent.

### Features

- Discovered and read DeepSeek Harness sessions from `DSH_HOME/sessions` (default `~/.dsh`) on macOS, Linux and Windows, decoding its multi-frame Zstandard logs frame by frame without writing to the artifact; compressed logs need Node `^22.19.0 || >=24.0.0` for the native Zstandard decoder. (#377)
- Registered DSH with its own tool display strategy, preferring the contextual hunks DSH attaches to edit results; it declares no resume command because its launcher takes profile-specific arguments. (#377)

### Documentation

- Listed DSH among the supported agents across the READMEs, architecture docs and the landing page. (#377)

### Changelog Detail

- #377 feat: support DeepSeek Harness session discovery @xingkaixin

## [1.0.1] - 2026-08-13

This release hardens the scan, cache and sync pipelines against partial or failed runs, closes a set of remote-access and browser security gaps, removes startup and rendering bottlenecks on large histories, and redesigns the dashboard charts.

### Features

- Redesigned the dashboard charts around shared tiled canvas primitives: daily usage as a stacked token bar with a cost area, agents as bars, and model cost as a ring; the project ranking card was removed in favor of the projects page. (#303)
- Added cursor-based pagination for session snapshots and progressive page loading in the web UI. (#355)
- Streamed live session detail updates incrementally instead of refreshing whole sessions. (#357)

### Security

- Added Content-Security-Policy and other browser security headers, and moved theme bootstrap out of inline scripts. (#345)
- Required authentication for loopback proxies, enforced loopback request authority, and rejected cross-site writes on both remote and loopback transports. (#279, #293, #308, #315, #344)
- Blocked agent scans from following symlinked session files and linked Cursor workspace directories. (#343)
- Minimized credential and path exposure in CLI output. (#353)
- Hardened CI supply-chain controls and verified the published npm artifact before release. (#288, #347)

### Performance

- Removed startup delays by deferring orphan cache cleanup to index writes. (#371)
- Reused SQLite connections, refresh cache snapshots, the search index worker, and analytics session trees across requests. (#354, #356, #360, #361)
- Derived restored session order from the cache instead of re-sorting, and preserved the Claude Code child index across scans. (#362, #363)
- Bounded recent session search, per-session message FTS lookups, OpenCode related-session queries, the Cursor composer scan cache, and scan status delivery across the live pipeline. (#284, #285, #286, #299, #359)
- Stabilized web render hot paths with memoized transcript work and throttled live aggregate refreshes. (#357, #358)
- Pre-staged large search-index backlogs in durable chunks and reused cached smart tags across full rescans. (#305, #326)

### Bug Fixes

- Decoupled full-history maintenance from publishing so background indexing no longer blocks visible session state. (#374)
- Preserved published state across partial, failed or interrupted scans: durable-only publication, atomic commits, partial snapshot facts, failed scan outcomes, and cache outside the scan window. (#275, #277, #294, #295, #296, #334)
- Retained sessions whose sources fail to parse, and stopped permanent startup rescan and Codex source-failure loops. (#278, #324, #326)
- Made session detail publication atomic and versioned persisted detail and derived projections so stale caches re-heal. (#276, #282, #290, #333)
- Corrected cost and pricing: healed missing pricing across agents, kept worker pricing generations consistent, preserved stale pricing caches, re-parsed cached heads when pricing arrives, attributed surplus Codex usage to models, and used inclusive session cost in search. (#304, #307, #316, #325, #327, #330, #337)
- Fixed agent parsing across Cursor, Codex, Claude Code, Kimi, Kimi-Code, Grok, Pi and OpenCode, including composer session ids, session metadata models, oversized rollout headers, timestamp offsets, descendant detail stats, and sessions or local commands with no visible content. (#281, #329, #335, #336, #339, #372, #373)
- Unified session hierarchy consumers and deduplicated session-tree route keys. (#280, #338)
- Kept live updates inside the active window and released deleted fallback trees. (#298, #339)
- Validated and rejected invalid session query parameters and inverted or malformed date windows. (#297, #321, #340)
- Recovered web app surfaces from failures, surfaced sustained live disconnects and detail stream failures, and preserved sidebar keyboard selection. (#340, #341, #342)
- Fixed dashboard chart interaction: bounded stagger progress, stopped resting canvas loops, deduplicated hover updates, and restored keyboard access. (#311, #312, #313, #314)
- Recovered rejected scan worker queues, kept the backfill queue advancing, persisted backfill checkpoints, bounded shutdown with active SSE clients, and serialized worker log writes. (#309, #310, #318, #328)
- Normalized project identity inputs, preserved database scan windows, and preserved omitted session metadata in the cache. (#317, #331, #332)

### Build

- Enforced the Node 22 runtime surface in types, Astro source quality in `apps/www`, and quality-gate coverage for tooling, root sources and agent adapters. (#289, #292, #319, #367, #369)
- Required a web build before bundle tests and made e2e specs discoverable by default. (#323, #368)
- Bumped `actions/checkout`, `actions/upload-artifact`, `actions/download-artifact`, `pnpm/action-setup` and `softprops/action-gh-release`. (#348, #349, #350, #351, #352)
- Removed unused chart dependencies. (#322)

### Documentation

- Derived the Node baseline from `engines`, enforced repository fact consistency and the required CI checklist, refreshed and gated the agent map, and documented remote access security, the cache connection lifecycle and the scan synchronization seam. (#291, #293, #302, #320, #354, #370)

### Changelog Detail

- #375 refactor(sqlite): remove duplicate message FTS @xingkaixin
- #374 fix: decouple full-history maintenance from publishing @xingkaixin
- #352 build(deps): bump actions/download-artifact from 4.3.0 to 8.0.1 @dependabot
- #351 build(deps): bump actions/checkout from 4.4.0 to 7.0.1 @dependabot
- #350 build(deps): bump actions/upload-artifact from 4.6.2 to 7.0.1 @dependabot
- #349 build(deps): bump pnpm/action-setup from 4.3.0 to 6.0.10 @dependabot
- #348 build(deps): bump softprops/action-gh-release from 2.6.2 to 3.0.2 @dependabot
- #371 Fix startup delays caused by cache cleanup @xingkaixin
- #372 fix(grok): filter sessions without visible messages @xingkaixin
- #373 fix(claude): filter empty local commands @xingkaixin
- #370 docs: enforce Node and CI facts @xingkaixin
- #369 chore(ci): close quality gate blind spots @xingkaixin
- #368 fix(ci): require web build for bundle tests @xingkaixin
- #367 test: cover agent adapters and route recovery @xingkaixin
- #366 refactor: consolidate shared failure and tool logic @xingkaixin
- #365 test(web): characterize tool strategies @xingkaixin
- #364 refactor(cache): unify search index planning @xingkaixin
- #363 perf(claudecode): preserve valid child index @xingkaixin
- #362 perf(cache): derive restored session order @xingkaixin
- #361 perf(analytics): reuse session trees per request @xingkaixin
- #360 perf(cli): reuse search index worker @xingkaixin
- #359 fix(cursor): bound composer scan cache @xingkaixin
- #358 perf(web): stabilize render hot paths @xingkaixin
- #357 perf(web): stream incremental live session updates @xingkaixin
- #356 perf(cli): reuse refresh cache snapshots @xingkaixin
- #355 feat(api): paginate session snapshots @xingkaixin
- #354 refactor(cache): reuse SQLite connections @xingkaixin
- #353 fix(cli): minimize credential and path exposure @xingkaixin
- #347 chore(ci): harden supply chain controls @xingkaixin
- #346 refactor(search): return structured highlights @xingkaixin
- #345 Add CSP and browser security headers @xingkaixin
- #344 fix(server): guard remote writes from cross-site requests @xingkaixin
- #343 Block agent scans from following symlinks @xingkaixin
- #342 fix(web): preserve sidebar keyboard selection @xingkaixin
- #341 Fix web failure recovery paths @xingkaixin
- #340 fix: harden API and bookmark edge cases @xingkaixin
- #339 fix: harden scan and index pipelines @xingkaixin
- #338 fix(session-tree): deduplicate route keys @xingkaixin
- #337 fix: preserve accurate cost sources @xingkaixin
- #336 fix: stabilize Cursor session parsing @xingkaixin
- #335 fix: harden Codex and Claude session parsing @xingkaixin
- #334 fix: preserve sync state after cache read failures @xingkaixin
- #333 fix: make session detail publication atomic @xingkaixin
- #332 fix(core): normalize project identity inputs @xingkaixin
- #331 fix: preserve database scan windows @xingkaixin
- #330 fix(search): preserve ranking and inclusive cost @xingkaixin
- #329 fix(core): correct Kimi session facts @xingkaixin
- #328 fix(cli): recover rejected scan queues @xingkaixin
- #327 fix(core): preserve stale pricing caches @xingkaixin
- #326 fix(cli): stop permanent startup rescan loop for SQLite-backed agents @xingkaixin
- #325 fix(core): attribute surplus codex usage to models in cost breakdown @xingkaixin
- #324 fix(core): stop permanent codex source-failure loop on startup @xingkaixin
- #323 test(e2e): discover new specs by default @xingkaixin
- #322 chore(web): remove unused chart dependencies @xingkaixin
- #321 fix(api): reject invalid date filters @xingkaixin
- #320 docs: refresh and gate agent map @xingkaixin
- #319 chore(quality): cover root source files @xingkaixin
- #318 fix(logging): serialize worker log writes @xingkaixin
- #317 fix(cache): preserve omitted session metadata @xingkaixin
- #316 fix: keep worker pricing generations consistent @xingkaixin
- #315 fix(cli): reject cross-site loopback writes @xingkaixin
- #314 fix(web): deduplicate bar chart hover updates @xingkaixin
- #313 fix(web): stop resting canvas chart loops @xingkaixin
- #312 fix(web): restore chart keyboard access @xingkaixin
- #311 fix(web): bound bar chart stagger progress @xingkaixin
- #310 fix(cli): persist backfill checkpoints @xingkaixin
- #309 fix(cli): bound shutdown with active SSE @xingkaixin
- #308 fix(cli): allow proxy authority on loopback @xingkaixin
- #307 fix(core): heal missing pricing across agents @xingkaixin
- #306 fix(core): isolate pre-staged session heads @xingkaixin
- #304 fix(core): re-parse cached session heads once missing model pricing arrives @xingkaixin
- #305 fix(core): pre-stage large search-index backlogs in durable chunks @xingkaixin
- #303 Redesign the dashboard charts @xingkaixin
- #302 refactor: centralize session source synchronization @xingkaixin
- #301 test(coverage): validate critical owners @xingkaixin
- #300 refactor(bookmarks): store reference facts @xingkaixin
- #299 fix: bound OpenCode related session scans @xingkaixin
- #298 fix: keep live updates inside the active window @xingkaixin
- #297 fix: validate session query parameters @xingkaixin
- #296 fix: preserve failed scan outcomes @xingkaixin
- #295 fix(sync): commit durable publications atomically @xingkaixin
- #294 fix(sync): preserve partial scan history @xingkaixin
- #293 fix(cli): require auth for loopback proxies @xingkaixin
- #292 build(www): enforce Astro source quality @xingkaixin
- #291 docs: enforce repository fact consistency @xingkaixin
- #290 fix(cache): preserve migration invariants @xingkaixin
- #289 build(types): enforce Node 22 runtime surface @xingkaixin
- #288 ci(release): verify the published npm artifact @xingkaixin
- #287 refactor(cli): retain scan worker baselines @xingkaixin
- #286 perf(core): bound recent session search @xingkaixin
- #285 Bound scan status delivery across the live pipeline @xingkaixin
- #284 Bound message FTS lookup per candidate session @xingkaixin
- #283 Refactor backfill lifecycle into explicit attempts @xingkaixin
- #282 fix(core): version persisted derived projections @xingkaixin
- #281 fix(core): align Kimi-Code source activity @xingkaixin
- #280 fix: unify session hierarchy consumers @xingkaixin
- #279 fix(cli): enforce loopback request authority @xingkaixin
- #278 fix: retain sessions when source parsing fails @xingkaixin
- #277 fix: preserve cache outside windowed scans @xingkaixin
- #276 fix(cache): version session detail projections @xingkaixin
- #275 fix(sync): reject non-durable checkpoints @xingkaixin
- #274 fix(core): keep session head stats local @xingkaixin


## [1.0.0] - 2026-08-07

This major release rebuilds the CodeSesh console and product experience, adds Grok session support, and hardens concurrent indexing as the project reaches 1.0.

### Features

- Added Grok session discovery, ACP transcript reconstruction, recorded usage and cost, resume support, and semantic rendering for file, terminal, and web tools. (#265)
- Rebuilt the console around global and project dashboards with comparable and custom date ranges, inclusive session-tree metrics, per-model costs, project rankings, and trends. (#266)
- Added project-first navigation, in-place sub-session timelines, and two-level content and tool filtering in the session reader. (#266)
- Redesigned the bilingual product site with the console's visual system, responsive interactive product demos, and refreshed SEO, AEO, social, and AI-readable metadata. (#267, #269)
- Replaced project-ranking Agent names with compact, accessible Agent logos. (#272)

### Breaking Changes

- Removed `DashboardAggregate.dailyTokenActivity` and `DailyTokenBucket`; token details now live in `DashboardAggregate.dailyActivity` through `DashboardDailyBucket`. Dashboard totals now include descendant sessions, while session counts represent top-level trees without double-counting mounted children. (#266)

### Bug Fixes

- Kept sidebar selection exclusive and synchronized with the active route, preventing keyboard navigation from retaining or reopening stale sessions. (#268)
- Prevented SQLite lock and snapshot failures during concurrent cache writes by avoiding redundant schema writes, acquiring write transactions immediately, and applying the busy timeout first. (#270)
- Corrected the sidebar collapse and expand icon directions. (#270)

### Build

- Updated workspace dependencies and adapted the build, worker, and end-to-end configuration for the current pnpm, Astro, Vite, SQLite, Hono, and Playwright releases. (#271)

### Changelog Detail

- #272 feat(web): show only project agent logos @xingkaixin
- #271 chore(deps): update workspace dependencies @xingkaixin
- #270 fix: eliminate SQLite busy failures and swap sidebar toggle icons @xingkaixin
- #269 feat(www): redesign product landing page @xingkaixin
- #268 fix(web): prevent duplicate session selection @xingkaixin
- #267 feat(www): align landing with interactive console UI @xingkaixin
- #266 feat(web): rebuild the UI against the redesign prototype @xingkaixin
- fix: relocate agent-skills ignore entries to standard section @xingkaixin
- #265 feat(core): support Grok sessions @xingkaixin

## [0.19.0] - 2026-08-02

This release brings nested subagent sessions into one session tree, adds Kimi-Code support, and makes large or interrupted scans resumable while improving long-title navigation and subagent details.

### Features

- Added Kimi-Code session discovery, parsing, tool rendering, and registration. (#259)
- Added nested session trees that preserve parent-child relationships and aggregate subagent token statistics for ZCode, Codex, and Claude Code. (#256, #257, #263)
- Added checkpointed, resumable full-history indexing with batched backfills and durable scan progress. (#260)

### Bug Fixes

- Surfaced final Codex subagent output inside parent session details and kept Claude child transcripts visible as roots when their parent file is missing. (#258, #263)
- Kept out-of-window sessions and available agents stable while scans run, and corrected scan finalization and progress behavior across interrupted refreshes. (#260)
- Made long session titles scroll smoothly and kept parent-session actions available in the sidebar. (#261, #262)

### Performance

- Indexed Codex subagent files once per pass, reparsed only changed sources and affected parents, and committed large search-index updates in resumable chunks. (#260)

### Changelog Detail

- #263 feat(core): support Claude Code subagents @xingkaixin
- #262 fix(web): keep session title scrolling readable @xingkaixin
- #261 feat(web): improve long session title behavior @xingkaixin
- #260 feat: add nested session trees and resumable scans @xingkaixin
- #259 feat(kimi-code): add Kimi-Code session support @xingkaixin
- #258 fix(core): surface Codex subagent output @xingkaixin
- #257 feat(core): fold Codex subagent sessions into parent @xingkaixin
- #256 feat(core): fold ZCode subagent sessions into parent @xingkaixin

## [0.18.0] - 2026-07-30

This release secures remote and local session data, prevents failed or incomplete scans from corrupting published state, and removes major loading and rendering bottlenecks across large session histories.

### Features

- Added encrypted remote access with direct TLS termination and trusted-proxy transport validation. (#240)

### Security

- Closed a Windows static-file path traversal by upgrading the Hono server and pinning the served-root boundary. (#231)
- Blocked off-origin transcript media requests and bounded inline media payloads. (#237)
- Restricted session databases, sidecars, backups, and logs to their owner. (#249)

### Bug Fixes

- Published session updates only after persistence and search indexing succeed, and preserved existing sessions when an Agent scan fails or becomes unavailable. (#230, #238)
- Detected WAL-mode database commits in fingerprints and file watching. (#239)
- Preserved opaque session IDs across routes, API requests, and CLI startup URLs. (#233)
- Defined dashboard windows by calendar days across daylight-saving transitions. (#234)
- Limited file activity by distinct session and kept Markdown search highlights synchronized with the active query. (#235, #236)
- Made pricing refreshes atomic, bounded, cancellable, and consistent within a scan generation. (#250)
- Stabilized session timeline layout and detail queries, coalesced live updates, and batched detail streaming to prevent rendering and loading stalls. (#254)

### Performance

- Allocated colliding sidebar paths in amortized constant time and read Cursor bubbles in one linear scan. (#232, #241)
- Indexed virtual timeline heights in logarithmic time. (#242)
- Loaded route surfaces and syntax highlighting on demand, reducing initial JavaScript from 459 KB to 259 KB gzipped. (#243)
- Read all parts for a session in one query and bounded the Web transcript cache to the active and two most recent details. (#247, #248)

### Refactor

- Centralized project identity kinds, keys, and comparison in the shared contract. (#252)

### Build

- Added a release preflight that verifies the tag and all versioned manifests before publishing. (#244)
- Replaced shell-specific clean commands with a cross-platform script and verified clean rebuilds on every CI operating system. (#246)
- Added structural performance growth-rate gates to CI. (#253)

### Documentation

- Clarified that `--json` exports a session index rather than a full transcript backup. (#245)
- Reframed the PRD as an inception document and linked current architecture sources. (#251)
- Documented the performance assurance layers. (#253)

### Changelog Detail

- #254 fix(web): prevent session timeline rendering and loading stalls @xingkaixin
- #253 chore(perf): gate performance structurally, not by wall-clock @xingkaixin
- #252 refactor: give project identity one owner @xingkaixin
- #251 docs: stop the PRD from describing a deleted architecture @xingkaixin
- #250 fix: make pricing refreshes deterministic @xingkaixin
- #249 fix: keep session storage and logs owner-only @xingkaixin
- #248 perf(web): bound how many transcripts the cache retains @xingkaixin
- #247 perf(core): read a session's parts in one query @xingkaixin
- #246 chore: make pnpm clean work on Windows @xingkaixin
- #245 docs: describe --json as a session index @xingkaixin
- #244 chore: verify release versions before publishing @xingkaixin
- #243 perf: load route surfaces on demand @xingkaixin
- #242 perf(web): index virtual list heights logarithmically @xingkaixin
- #241 perf: read Cursor bubbles once per scan @xingkaixin
- #240 feat: encrypt remote access transport @xingkaixin
- #239 fix: detect WAL-mode database commits @xingkaixin
- #238 fix: never read a failed database scan as an empty agent @xingkaixin
- #237 fix: keep transcript media local @xingkaixin
- #236 fix(web): render search highlights through the markdown tree @xingkaixin
- #235 fix(core): limit file activity search by session, not row @xingkaixin
- #234 fix: define dashboard windows in calendar days @xingkaixin
- #233 fix: carry opaque session ids through routes and the API @xingkaixin
- #232 perf(web): allocate sidebar paths in amortized constant time @xingkaixin
- #231 fix: close the Windows static path traversal @xingkaixin
- #230 fix: gate session publication on successful persistence @xingkaixin

## [0.17.0] - 2026-07-27

This release hardens large-history performance across scanning, APIs, and the session timeline, fixes live-scan and cache correctness issues that could drop or stale sessions, and reworks domain contracts around explicit session references and centralized agent capabilities.

### Performance

- Streamed agent transcripts and single-pass Pi parsing instead of loading whole session files into memory; kept Kimi source enumeration off the transcript path. (#190, #192, #193)
- Cached the session-alias read model and snapshot aggregate API responses; optimized session-detail payloads. (#196, #214, #215)
- Merged per-agent live session shards without full re-sorts; reused CLI refresh workers and returned incremental deltas. (#197, #209)
- Virtualized the Web session timeline for long histories. (#213)

### Bug Fixes

- Assembled multi-chunk JSONL records in linear time. (#191)
- Stopped deleting cached sessions that fall outside the current scan window. (#198)
- Preserved session reference identity across Web navigation; unified live cache invalidation and cross-source search filters. (#200, #201, #202)
- Unified session publication commits and offloaded database refresh scans so the CLI event loop stays responsive. (#203, #208)
- Cached session-index snapshots and reused rendered message markdown while scrolling. (#211, #212)
- Distinguished alias validation errors in the API. (#226)
- Avoided blocking startup on message migration and skipped expensive FTS integrity checks at open. (#227, #228)

### Refactor

- Modeled session references explicitly and normalized message parts and public domain terminology. (#216, #217, #218, #219)
- Centralized agent capabilities, file sources, and session watch plans; shared one source change-detection pass. (#194, #204, #220, #221)
- Materialized session details, narrowed the cache schema boundary, and removed cache shadow writes. (#205, #206, #210)
- Unified the Web session-detail model and shared file tool strategies; migrated Web and product-site icons from Lucide to Hugeicons. (#199, #207, #224)
- Split API handlers and AgentSyncEngine responsibilities; tightened core public exports. (#195, #223, #225)

### Documentation

- Refreshed the scanning and caching architecture documentation. (#222)

### Changelog Detail

- #228 fix(cache): avoid startup FTS integrity checks @xingkaixin
- #227 fix(cache): avoid blocking startup on message migration @xingkaixin
- #226 fix(api): distinguish alias validation errors @xingkaixin
- #225 refactor(core): tighten public exports @xingkaixin
- #224 refactor(web): share file tool strategies @xingkaixin
- #223 refactor(cli): split AgentSyncEngine responsibilities @xingkaixin
- #222 docs: refresh scanning architecture @xingkaixin
- #221 refactor(agents)!: centralize agent capabilities @xingkaixin
- #220 refactor(agents): centralize file sources @xingkaixin
- #219 refactor(domain)!: align public terminology @xingkaixin
- #218 refactor(contract)!: normalize message parts @xingkaixin
- #217 refactor(contract)!: unify session references @xingkaixin
- #216 refactor: model session references explicitly @xingkaixin
- #215 perf: optimize session detail responses @xingkaixin
- #214 perf(api): cache snapshot aggregate responses @xingkaixin
- #213 perf(web): virtualize session timeline @xingkaixin
- #212 fix(web): reuse message markdown while scrolling @xingkaixin
- #211 fix(core): cache session index snapshots @xingkaixin
- #210 refactor(core): remove cache shadow writes @xingkaixin
- #209 perf(cli): reuse refresh workers and return deltas @xingkaixin
- #208 fix(cli): offload database refresh scans @xingkaixin
- #207 refactor(web): unify session detail model @xingkaixin
- #206 refactor(core): materialize session details @xingkaixin
- #205 refactor(core): narrow cache schema boundary @xingkaixin
- #204 refactor(agents): own session watch plans @xingkaixin
- #203 fix(cli): unify session publication commits @xingkaixin
- #202 fix(web): unify live cache invalidation @xingkaixin
- #201 fix(search): unify cross-source filters @xingkaixin
- #200 fix(web): preserve session reference identity @xingkaixin
- #199 refactor(icons): migrate web and www from lucide to hugeicons @xingkaixin
- #198 fix(agents): stop deleting cached sessions outside the scan window @xingkaixin
- #197 perf(live): merge per-agent session shards instead of re-sorting @xingkaixin
- #196 perf(api): cache the session alias read model @xingkaixin
- #195 refactor(api): split handlers into parsing, aliases and analytics @xingkaixin
- #194 refactor(agents): share one source change-detection pass @xingkaixin
- #193 perf(agents): stream transcripts instead of loading whole files @xingkaixin
- #192 perf(pi): parse session files in one streaming pass @xingkaixin
- #191 fix(jsonl): assemble long records in linear time @xingkaixin
- #190 perf(kimi): keep source enumeration off transcripts @xingkaixin

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
