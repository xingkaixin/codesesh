/**
 * Request-parameter parsing for the HTTP API. Everything here turns raw query
 * strings into the option objects the domain layer expects; no domain logic,
 * no storage access.
 */
import type { Context } from "hono";
import type { SessionHead, SmartTag } from "@codesesh/core";
import {
  filterSessionTreeByActivityWindow,
  isProjectIdentityKind,
  type FileActivityKind,
  type ProjectIdentityRef,
  type SearchOptions,
} from "@codesesh/core";
import type { TimeWindow } from "../time-window-resolution.js";

export type SessionListDefaults = TimeWindow;

const SMART_TAGS: readonly string[] = [
  "bugfix",
  "refactoring",
  "feature-dev",
  "testing",
  "docs",
  "git-ops",
  "build-deploy",
  "exploration",
  "planning",
];

const SEARCH_LIMIT_MAX = 100;
const SEARCH_LIMIT_DEFAULT = 50;

export function searchParams(c: Context): URLSearchParams {
  return new URL(c.req.url ?? "http://localhost/", "http://localhost/").searchParams;
}

/** Collects repeated and comma-separated values across several parameter names. */
export function queryValues(params: URLSearchParams, ...names: string[]): string[] {
  return names.flatMap((name) =>
    params
      .getAll(name)
      .flatMap((value) => value.split(","))
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

export function optionalQueryValue(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

export function parseDateParam(
  value: string | undefined,
  fallback: number | undefined,
): number | undefined {
  if (value == null) return fallback;
  const ts = new Date(value).getTime();
  return Number.isNaN(ts) ? fallback : ts;
}

export function parseNumberParam(value: string | undefined): number | undefined {
  if (value == null || !value.trim()) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

export function parseSmartTags(values: string[]): SmartTag[] | undefined {
  const tags = values
    .map((value) => value.toLowerCase())
    .filter((value): value is SmartTag => SMART_TAGS.includes(value));
  return tags.length > 0 ? [...new Set(tags)] : undefined;
}

export function parseFileActivityKind(value: string | undefined): FileActivityKind | undefined {
  if (value === "read" || value === "edit" || value === "write" || value === "delete") {
    return value;
  }
  return undefined;
}

/**
 * Returns the identity when both halves are present and valid, `undefined` when
 * neither is supplied, and `null` when the pair is incomplete or malformed —
 * callers turn that `null` into a 400.
 */
export function parseProjectIdentityFilter(
  kindValue: string | undefined,
  keyValue: string | undefined,
): ProjectIdentityRef | null | undefined {
  const kind = optionalQueryValue(kindValue);
  const key = optionalQueryValue(keyValue);
  if (!kind && !key) return undefined;
  if (!kind || !key || !isProjectIdentityKind(kind)) return null;
  return { kind, key };
}

export function parseSearchOptions(
  c: Context,
  defaults: SessionListDefaults,
  projectIdentity?: ProjectIdentityRef,
): SearchOptions {
  const params = searchParams(c);
  const limitValue = parseNumberParam(params.get("limit") ?? undefined);
  return {
    agent: optionalQueryValue(params.get("agent") ?? undefined),
    project: optionalQueryValue(params.get("project") ?? undefined),
    projectKind: projectIdentity?.kind,
    projectKey: projectIdentity?.key,
    cwd: optionalQueryValue(params.get("cwd") ?? undefined),
    tags: parseSmartTags(queryValues(params, "tag", "tags", "signal")),
    tools: queryValues(params, "tool", "tools").map((tool) => tool.toLowerCase()),
    file: optionalQueryValue(params.get("file") ?? params.get("path") ?? undefined),
    fileKind: parseFileActivityKind(
      optionalQueryValue(params.get("fileKind") ?? params.get("fileActivity") ?? undefined),
    ),
    costMin: parseNumberParam(params.get("costMin") ?? undefined),
    costMax: parseNumberParam(params.get("costMax") ?? undefined),
    from: parseDateParam(params.get("from") ?? undefined, defaults.from),
    to: parseDateParam(params.get("to") ?? undefined, defaults.to),
    limit:
      limitValue && limitValue > 0 ? Math.min(limitValue, SEARCH_LIMIT_MAX) : SEARCH_LIMIT_DEFAULT,
  };
}

export function filterSessionsByActivityWindow(
  sessions: SessionHead[],
  from: number | undefined,
  to: number | undefined,
): SessionHead[] {
  return filterSessionTreeByActivityWindow(sessions, from, to);
}
