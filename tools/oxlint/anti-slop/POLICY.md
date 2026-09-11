# CodeSesh anti-slop policy

Judge a rule by the maintenance problems it prevents. Judge each diagnostic
separately: fix an avoidable loss of information, document a justified exception
at its exact location, or change a rule that cannot express a useful distinction.
The number of existing violations is not a reason to disable a valuable rule.

## Enabled rules

All enabled rules use `error`, including in tests. There is no historical
baseline, directory-wide test exemption, or warning-only adoption period.

| Rule | Maintenance purpose and local decision |
| --- | --- |
| `oxc/no-accumulating-spread`, `no-reduce-accumulator-copy` | Prevent repeatedly copying a growing accumulator. Keep both: they catch different copy forms. |
| `no-chained-type-assertions`, `no-widen-then-assert` | Expose type erasure used to bypass incompatible contracts. Remove redundant casts and complete ordinary fixtures. Allow a local exception for a validated external envelope, bundled tuple data, or a deliberately partial boundary fixture. |
| `no-known-value-widening` | Preserve information already known at the value's owner. Concrete object contracts and dictionaries with concrete value types are accepted. Erasure to `unknown`, `object`, or unsafe dictionary values remains checked, including supported local aliases. Recursive payload cleanup and heterogeneous endpoint fixtures have local exceptions. |
| `no-unsafe-dictionary-type` | Reject dictionary values typed as `any`, `object`, or `{}`, including supported aliases/unions. `allowUnknown: true` accepts raw external JSON dictionaries: values must still be narrowed before use. This option does not exempt known-value erasure under the preceding rule. |
| `no-module-mocking` | Make module replacement a reviewed test design decision. Existing OS home/path fixtures, worker protocol harnesses, injected persistence failures, HTTP client state tests, and call-through performance spies have per-call explanations. A new call still fails lint. Do not add production service layers merely to remove these exceptions. |
| `no-object-parameters` | Require an actual parameter contract for internal operations. Keep three localized exceptions: a WeakMap identity token, arbitrary object sanitization, and native URL brand probing. |
| `no-reflect-get`, `no-reflect-apply` | Prefer visible property/call contracts. Guarded property reads replace ordinary reflective reads. Two read-counting Proxy traps retain `Reflect.get` to preserve receiver semantics. |
| `no-unknown-type-aliases` | Prevent naming an erased contract as though it were a domain type. |
| `require-safety-comment-for-type-assertion` | With `scope: "type-escapes"`, require a nearby `SAFETY:` reason for assertions containing `any`/`never` and for consecutive assertions. Ordinary single domain casts and `as const` do not need repetitive commentary. Upstream's `scope: "all"` remains available. |
| `require-readable-spacing` | Separate imports and top-level function, class, interface and type declarations. Keep local statement groups and adjacent overload signatures together. Check compatibility with oxfmt rather than introducing a second formatting preset. |

## Disabled rules

These six rules are explicitly `off` because their current checks do not express
the project's desired invariant. They are not disabled because cleanup is large.

| Rule | Reason |
| --- | --- |
| `no-array-filter-map` | An extra linear traversal is not itself a maintenance defect. Blanket fusion can obscure intent and change callback order, indexes or sparse-array behavior. Accumulator-copy rules and existing growth-rate checks cover concrete performance risks. |
| `no-conditional-empty-object-spread` | Conditional omission is meaningful for API payloads, options and JSX props. A blanket ban does not distinguish this from accidental structure. |
| `no-shape-in-symbol-names` | Vocabulary restrictions do not establish whether a domain name is accurate; `Map`, `Set`, counts and references can be useful names. |
| `no-unknown-parameters` | JSON, SQLite, worker messages and error boundaries need honest unknown inputs. The AST rule cannot reliably distinguish those from erased internal contracts. |
| `no-unknown-returns` | Boundary readers and recursive tool payload preservation legitimately return unknown values. Renaming or wrapping them to evade the rule would add concepts without strengthening validation. |
| `no-runtime-typeof` | Runtime validation is required for untrusted history files, network payloads and browser capabilities. The rule cannot identify where such validation belongs. |

## Findings addressed during adoption

The initial scan of 736 files produced 10,705 diagnostics, including 8,544
spacing reports. These were rule matches, not independent defects.

- The Claude Code index cache erased its nested map type with `any`. It now
  stores typed maps.
- The Codex expression reader and log sanitizers returned broader types than
  their implementations produced. Their contracts now preserve those values.
- Many tests erased entire Agent instances to reach private caches. Typed field
  access now retains method and cache checks; incomplete legacy cache fixtures
  explain their intentional missing fields locally.
- HTTP handler fixtures repeated `as never` at call sites. The partial Hono
  context adaptation now lives at the fixture boundary and retains typed spies.
- Scan status and session detail fixtures omitted required fields. Ordinary
  fixtures now supply those fields; malformed-input tests explicitly retain
  their invalid values.
- Query cache tests now use a real QueryObserver, and the maintenance scheduler
  accepts the single runner operation it actually uses.
- Existing module mocks and the remaining partial browser/worker fixtures have
  narrow explanations, with no exemption for new neighboring code.

## Exceptions and upgrades

Use `oxlint-disable-next-line anti-slop/<rule> -- <specific reason>` at the
smallest relevant site. For unsafe assertions, also explain the invariant in a
nearby `SAFETY:` comment. An exception must describe the boundary, required
methods, invalid test input, or runtime invariant; “legacy” alone is not enough.
`reportUnusedDisableDirectives: "error"` rejects stale suppressions.

`pnpm exec vitest run scripts/anti-slop.test.mjs` exercises the vendored plugin
through the installed Oxlint CLI. It checks accepted and rejected contracts,
local exception boundaries, stale suppressions, JSDoc/overload attachment, and
fix/format stability. These tests also run in the existing coverage CI job.
The normal workspace lint commands load the same root plugin configuration.

Keep `@oxlint/plugins` aligned with the installed Oxlint version. On upgrade,
compare against the source revision in `UPSTREAM.md`, preserve the decisions
above, rerun rule tests, and reassess diagnostics without adding a baseline.
These AST rules are guardrails, not proof of complete type or complexity safety.
