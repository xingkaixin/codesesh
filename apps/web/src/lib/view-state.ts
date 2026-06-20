/**
 * Route → view-state parsing for the app shell.
 * Pure: turns a pathname + valid agent keys into a discriminated ViewState.
 */
import type { ProjectIdentityKind } from "./api";
import { decodeProjectRouteKey, isProjectIdentityKind } from "./projects";

export type ViewState =
  | { mode: "root"; activeAgentKey: null; activeSessionSlug: null }
  | { mode: "projects"; activeAgentKey: null; activeSessionSlug: null }
  | {
      mode: "project";
      activeAgentKey: null;
      activeSessionSlug: null;
      activeProjectKind: ProjectIdentityKind;
      activeProjectKey: string;
    }
  | { mode: "agent"; activeAgentKey: string; activeSessionSlug: null }
  | { mode: "session"; activeAgentKey: string; activeSessionSlug: string }
  | { mode: "missingAgent"; activeAgentKey: null; activeSessionSlug: null; attemptedKey: string }
  | {
      mode: "missingSession";
      activeAgentKey: string;
      activeSessionSlug: string;
      attemptedSessionSlug: string;
    }
  | { mode: "invalidRoute"; activeAgentKey: null; activeSessionSlug: null };

export function parseViewState(pathname: string, validAgentKeys: Set<string>): ViewState {
  const trimmed = pathname.replace(/^\/+|\/+$/g, "");
  const segments = trimmed
    ? trimmed
        .split("/")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  if (segments.length === 0) {
    return { mode: "root", activeAgentKey: null, activeSessionSlug: null };
  }
  if (segments[0]?.toLowerCase() === "projects") {
    if (segments.length === 1) {
      return { mode: "projects", activeAgentKey: null, activeSessionSlug: null };
    }
    if (segments.length === 3) {
      try {
        const kind = decodeURIComponent(segments[1]!);
        if (!isProjectIdentityKind(kind)) {
          return { mode: "invalidRoute", activeAgentKey: null, activeSessionSlug: null };
        }
        return {
          mode: "project",
          activeAgentKey: null,
          activeSessionSlug: null,
          activeProjectKind: kind,
          activeProjectKey: decodeProjectRouteKey(segments[2]!),
        };
      } catch {
        return { mode: "invalidRoute", activeAgentKey: null, activeSessionSlug: null };
      }
    }
    return { mode: "invalidRoute", activeAgentKey: null, activeSessionSlug: null };
  }
  if (segments.length === 1) {
    const key = segments[0]!.toLowerCase();
    if (validAgentKeys.has(key)) {
      return { mode: "agent", activeAgentKey: key, activeSessionSlug: null };
    }
    return {
      mode: "missingAgent",
      activeAgentKey: null,
      activeSessionSlug: null,
      attemptedKey: key,
    };
  }
  if (segments.length === 2) {
    const key = segments[0]!.toLowerCase();
    const slug = segments[1]!;
    if (validAgentKeys.has(key) && slug) {
      return { mode: "session", activeAgentKey: key, activeSessionSlug: slug };
    }
    if (validAgentKeys.has(key)) {
      return {
        mode: "missingSession",
        activeAgentKey: key,
        activeSessionSlug: slug,
        attemptedSessionSlug: slug,
      };
    }
    return {
      mode: "missingAgent",
      activeAgentKey: null,
      activeSessionSlug: null,
      attemptedKey: key,
    };
  }
  return { mode: "invalidRoute", activeAgentKey: null, activeSessionSlug: null };
}
