# Make Project Navigation Reflect the Current Route

Written against: `67713bea5f33231fddcd468f7fcb560467f04aa9`

## Evidence chain

- Surface: Projects overview, project detail, and the desktop sidebar in `apps/web`.
- Problem: Returning from a project detail to `/projects` can leave both the Projects overview entry and the previously opened project styled as active. The SESSIONS section can also remain scoped to that stale project even though the main content is the overview.
- Design evidence: `apps/web/src/App.tsx` derives `selectedProjectNavigationIdentity` from `selectedProjectIdentity` when no project is present in the current route. That value drives both the selected project row and project-scoped sidebar sessions. `selectedProjectIdentity` is navigation memory, not evidence that the current route represents that project.
- Owner: `apps/web/src/App.tsx` owns route interpretation and the props that describe selected project navigation to `AppSidebar`.
- Scope and affected surfaces: Project overview, project detail, sessions opened from a project, browse-mode switching, and the desktop sidebar.
- Uncertainty: None. The conflicting active states follow directly from the current derivation and consumers.

## Design decision

Make project selection presentation a pure derivative of the current route:

```tsx
const selectedProjectNavigationIdentity =
  browseBy !== "projects"
    ? null
    : viewState.mode === "project"
      ? activeProjectIdentity
      : viewState.mode === "session"
        ? openedSessionProjectIdentity
        : null;
```

Keep `selectedProjectIdentity` as navigation memory for `changeBrowseBy`; do not clear it when entering the overview and do not add a second state value. On `/projects`, root, loading, and error routes, no project is active and no project-scoped session list is shown.

## Reuse

- Reuse `viewState`, `activeProjectIdentity`, and `openedSessionProjectIdentity` as the existing route facts.
- Reuse the existing `selectedProjectNavigationId` and `sidebarSessions` data flow after correcting its input.
- Reuse the existing `Select a project` empty state in `AppSidebar`.
- Exemplar: Agent browsing already derives active presentation from the current browse mode and route instead of preserving a stale row selection.

## Changes

1. `apps/web/src/App.tsx`
   - Change: Derive `selectedProjectNavigationIdentity` only from the current project or session route while `browseBy === "projects"`.
   - Preserve: Keep `selectedProjectIdentity` and its role in returning to the last project when the user explicitly changes browse mode.
   - Verify: `/projects` produces a null selected project ID and an empty project-scoped session list; project and project-session routes still select the correct project.
2. `tests/e2e/browsing.spec.ts`
   - Change: Add a regression flow that opens a project, returns through the Projects breadcrumb, and verifies the overview has no stale project selection or project session list.
   - Preserve: Use existing fixtures and navigation helpers; do not introduce a second project-navigation harness.
   - Verify: The URL is `/projects`, the overview remains active, and `Select a project` is visible in the sidebar.

## Scope

- Inherit: Current project routes, breadcrumb behavior, sidebar active styles, session filtering, and browse-mode memory.
- Verify: Projects overview, project detail, a session opened from a project, direct URL entry, browser back/forward, and switching between Agents and Projects.
- Exclude: Mobile navigation redesign, route schema changes, clearing navigation memory, new stored state, and visual restyling of sidebar rows.

## Validation

- Product: Open a project, return to Projects, then switch modes and return; the content, active row, and SESSIONS scope must always describe the same route.
- Interface: Check the desktop sidebar at overview, project, and project-session routes, including direct entry and browser history traversal.
- System: Confirm the corrected derivation does not change API calls or project/session identity normalization.
- Repository: `pnpm --filter @codesesh/web test` → all web unit tests pass.
- Repository: `pnpm --filter @codesesh/web lint` → no lint errors.
- Repository: `pnpm --filter @codesesh/web build` → the web application builds.
- Repository: `pnpm test:e2e --project web-chromium` → the project navigation regression and existing browsing flows pass.

## Stop conditions

- Stop if `selectedProjectIdentity` is found to be required as visible selection on `/projects`; clarify the intended overview interaction before adding special cases.
- Stop if a project session cannot be associated through `openedSessionProjectIdentity`; fix identity ownership rather than restoring a stale fallback.
- Stop if the implementation requires modifying project route semantics or adding stored UI state.

## Design documentation

- After acceptance and validation: No design-document update is required; this restores the existing route-driven navigation contract without changing product behavior.
