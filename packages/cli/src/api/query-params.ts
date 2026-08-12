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

export interface LimitPolicy {
  defaultValue: number;
  maxValue: number;
}

export const SEARCH_LIMIT_POLICY: LimitPolicy = { defaultValue: 50, maxValue: 100 };
export const FILE_ACTIVITY_LIMIT_POLICY: LimitPolicy = { defaultValue: 50, maxValue: 200 };
export const SESSION_PAGE_LIMIT_POLICY: LimitPolicy = { defaultValue: 250, maxValue: 500 };

export type AgentFilterOutcome =
  | { kind: "all" }
  | { kind: "known"; agentName: string }
  | { kind: "unknown" };

export type LimitOutcome =
  | { kind: "default"; value: number }
  | { kind: "valid"; value: number }
  | { kind: "invalid"; error: string };

export type DateParamOutcome =
  | { kind: "default"; value: number | undefined }
  | { kind: "valid"; value: number }
  | { kind: "invalid"; error: string };

export type DateWindowOutcome =
  | { kind: "valid"; from: number | undefined; to: number | undefined }
  | { kind: "invalid"; parameter: "from" | "to"; error: string };

export interface SessionQuery {
  agent: AgentFilterOutcome;
}

export interface LimitedSessionQuery extends SessionQuery {
  limit: LimitOutcome;
}

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
): DateParamOutcome {
  const normalized = optionalQueryValue(value);
  if (normalized == null) return { kind: "default", value: fallback };
  const timestamp = new Date(normalized).getTime();
  return Number.isNaN(timestamp)
    ? { kind: "invalid", error: "must be a valid date" }
    : { kind: "valid", value: timestamp };
}

export function parseDateWindow(
  params: URLSearchParams,
  defaults: SessionListDefaults,
): DateWindowOutcome {
  const from = parseDateParam(params.get("from") ?? undefined, defaults.from);
  if (from.kind === "invalid") return { ...from, parameter: "from" };

  const to = parseDateParam(params.get("to") ?? undefined, defaults.to);
  if (to.kind === "invalid") return { ...to, parameter: "to" };

  if (from.value != null && to.value != null && from.value > to.value) {
    return { kind: "invalid", parameter: "from", error: "must not be after to" };
  }

  return { kind: "valid", from: from.value, to: to.value };
}

export function parseNumberParam(value: string | undefined): number | undefined {
  if (value == null || !value.trim()) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function parseAgentFilter(
  value: string | null,
  knownAgentNames: Iterable<string>,
): AgentFilterOutcome {
  if (value === null) return { kind: "all" };
  const normalized = value.trim().toLowerCase();
  if (!normalized) return { kind: "unknown" };

  for (const agentName of knownAgentNames) {
    if (agentName.toLowerCase() === normalized) return { kind: "known", agentName };
  }
  return { kind: "unknown" };
}

function parseLimit(value: string | null, policy: LimitPolicy): LimitOutcome {
  if (value === null) return { kind: "default", value: policy.defaultValue };
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) {
    return { kind: "invalid", error: "limit must be a positive integer" };
  }

  const digits = normalized.replace(/^0+/, "");
  if (!digits) return { kind: "invalid", error: "limit must be a positive integer" };
  const maxDigits = String(policy.maxValue);
  const exceedsMaximum =
    digits.length > maxDigits.length || (digits.length === maxDigits.length && digits > maxDigits);
  return { kind: "valid", value: exceedsMaximum ? policy.maxValue : Number(digits) };
}

export function parseSessionQuery(
  params: URLSearchParams,
  knownAgentNames: Iterable<string>,
): SessionQuery;
export function parseSessionQuery(
  params: URLSearchParams,
  knownAgentNames: Iterable<string>,
  limitPolicy: LimitPolicy,
): LimitedSessionQuery;
export function parseSessionQuery(
  params: URLSearchParams,
  knownAgentNames: Iterable<string>,
  limitPolicy?: LimitPolicy,
): SessionQuery | LimitedSessionQuery {
  const agent = parseAgentFilter(params.get("agent"), knownAgentNames);
  return limitPolicy ? { agent, limit: parseLimit(params.get("limit"), limitPolicy) } : { agent };
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
  window: SessionListDefaults,
  request: { agent?: string; limit: number },
  projectIdentity?: ProjectIdentityRef,
): SearchOptions {
  const params = searchParams(c);
  return {
    agent: request.agent,
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
    from: window.from,
    to: window.to,
    limit: request.limit,
  };
}

export function filterSessionsByActivityWindow(
  sessions: SessionHead[],
  from: number | undefined,
  to: number | undefined,
): SessionHead[] {
  return filterSessionTreeByActivityWindow(sessions, from, to);
}
