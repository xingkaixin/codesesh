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

The upstream root `LICENSE` is retained verbatim; it is not included in the
skill asset bundle. The bundled rule tests are not part of those assets.

Local source changes are limited to:

- `shared/dictionary-types.ts`: recognize concrete object and dictionary value
  contracts; retain broad-value detection through supported aliases; support
  the dictionary rule's `allowUnknown` option.
- `rules/no-unsafe-dictionary-type.ts`: add opt-in `allowUnknown` (default false).
- `rules/require-safety-comment-for-type-assertion.ts`: add opt-in
  `scope: "type-escapes"`; upstream's all-assertions behavior remains the default.
- `rules/require-readable-spacing.ts`: separate imports and module declarations
  without forcing blank lines throughout function bodies; preserve overloads.

`POLICY.md` records the 12 enabled generic rules, six intentionally disabled
rules, the native accumulating-spread companion, and justified local exceptions.
Regression tests live in `scripts/anti-slop.test.mjs` and run the actual CLI.

`@oxlint/plugins` is pinned to `1.81.0`, matching the installed and locked Oxlint
version. Keep these versions aligned on upgrades. Lint and format ignore agent
assets, local worktrees, and this vendored tree. Existing ignore entries are
preserved. No application or test directory was excluded to hide diagnostics.
