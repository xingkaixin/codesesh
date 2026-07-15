# Give Search One Consistent Header Context

Written against: `67713bea5f33231fddcd468f7fcb560467f04aa9`

## Evidence chain

- Surface: The app header while global search is open from dashboard, projects, project detail, or session detail.
- Problem: Search content, title, and breadcrumb all say Search, while the small context badge can still say Session, Project, Projects, or Dashboard based on the underlying route.
- Design evidence: `buildRouteHeaderModel` already receives `isSearchMode` and owns the search title and breadcrumb. `App.tsx` independently derives the context badge from `viewState`, bypassing that model and ignoring search mode.
- Owner: `apps/web/src/lib/build-route-header-model.tsx` is the existing owner of header semantics; `App.tsx` should render its result.
- Scope and affected surfaces: Global search header and every non-search route label currently shown in the context badge.
- Uncertainty: None. The badge and the rest of the header currently use different inputs for the same semantic state.

## Design decision

Add `contextLabel` to the route header model and derive it from the same input that determines title and breadcrumbs. Search takes precedence over the underlying route. Preserve the existing non-search copy:

```tsx
function routeContextLabel(input: RouteHeaderInput) {
  if (input.isSearchMode) return "Search";

  switch (input.viewState.mode) {
    case "session":
      return "Session";
    case "root":
      return "Dashboard";
    case "projects":
      return "Projects";
    case "project":
      return "Project";
    default:
      return "Landing";
  }
}
```

`App.tsx` should render `routeHeader.contextLabel` instead of maintaining a parallel conditional. Do not add search state, duplicate labels, or a new visual primitive.

## Reuse

- Reuse `RouteHeaderInput`, `isSearchMode`, and `buildRouteHeaderModel` as the header's semantic owner.
- Reuse every current label and the existing context badge styling in `App.tsx`.
- Reuse the existing search-mode precedence already applied to title and breadcrumbs.
- Exemplar: Search title and breadcrumb are already produced together by `buildRouteHeaderModel`; the badge should follow the same ownership boundary.

## Changes

1. `apps/web/src/lib/build-route-header-model.tsx`
   - Change: Add `contextLabel` to the returned header model and derive it with search-mode precedence plus the current route-label mapping.
   - Preserve: Existing title, subtitle, breadcrumb, project identity, and session alias behavior.
   - Verify: Search mode returns `Search` regardless of the underlying `viewState`; non-search routes retain their current labels.
2. `apps/web/src/App.tsx`
   - Change: Replace the inline nested conditional in the context badge with `routeHeader.contextLabel`.
   - Preserve: Existing badge markup, typography, spacing, and responsive behavior.
   - Verify: Opening and closing search changes only the semantic label and restores the underlying route label afterward.
3. `apps/web/src/lib/build-route-header-model.test.tsx`
   - Change: Add focused model tests for search precedence and representative non-search mappings.
   - Preserve: Test the public model result instead of component implementation details.
   - Verify: Session and project inputs return `Search` while search is active; session, project, projects, and root retain their existing labels when it is inactive.

## Scope

- Inherit: Current search open/close behavior, loading/error content, header layout, and all existing route labels.
- Verify: Search launched from dashboard, projects overview, project detail, and session detail; loading, results, empty, and failure states; closing search.
- Exclude: Header redesign, new copy outside the context badge, sidebar search active-state changes, search routing changes, and animation changes.

## Validation

- Product: Open search from each underlying route and confirm content, title, breadcrumb, and context badge all describe Search; close it and confirm the route label returns.
- Interface: Check desktop and narrow viewport header layouts for unchanged spacing and no badge overflow.
- System: Confirm the model remains a pure function and no new React state or effect is introduced.
- Repository: `pnpm --filter @codesesh/web test` → the new model tests and all existing web tests pass.
- Repository: `pnpm --filter @codesesh/web lint` → no lint errors.
- Repository: `pnpm --filter @codesesh/web build` → the web application builds.
- Repository: `pnpm test:e2e --project web-chromium` → existing search and browsing flows pass.

## Stop conditions

- Stop if another header owner exists for the context badge; consolidate ownership before adding another mapping.
- Stop if product requirements intentionally preserve the underlying route label during search; document that exception and align title and breadcrumb semantics before implementation.
- Stop if the implementation requires new state or changes search routing.

## Design documentation

- After acceptance and validation: No design-document update is required; this consolidates existing header semantics without introducing a new pattern.
