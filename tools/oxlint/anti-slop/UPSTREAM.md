# Anti-slop provenance

- Source repository: https://github.com/dmmulroy/anti-slop
- Source commit: `c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b`
- Source directory: `skills/install-anti-slop/assets/anti-slop/`
- Installed directory: `tools/oxlint/anti-slop/`
- Installed on: 2026-09-11

The files were copied by the bundled `install-anti-slop/scripts/install.mjs`.
Before adding this record, a recursive byte comparison confirmed that every
bundled file matched the source directory at the commit above. The installed
skill's metadata identifies `dmmulroy/anti-slop` as its source; the commit was
verified against the actual assets, not inferred from that metadata.

## Installed entry points

- `index.ts`: generic rules, registered as `anti-slop` in `.oxlintrc.json`.
- `effect/index.ts`: bundled but not registered; this repository has no direct
  `effect` dependency.
- `vendor/eslint-stylistic/`: retained with its original `LICENSE` and
  `UPSTREAM.md`, which document the nested vendor's source and adaptations.

## Local configuration and deviations

There are no changes to the copied plugin source. This provenance file is the
only local documentation addition to the upstream asset tree. The upstream root LICENSE is also retained verbatim. The skill's asset bundle does not include the upstream rule tests.

All 18 generic rules and the native `oxc/no-accumulating-spread` companion rule
are enabled at `error`. `@oxlint/plugins` is pinned to `1.81.0`, matching the
installed and locked Oxlint version. Keep these versions aligned on upgrades.
Lint and format ignore agent assets, local worktrees, and this vendored tree.
Existing application diagnostics are retained for review without suppression
or automatic cleanup.
