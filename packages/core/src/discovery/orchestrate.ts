/**
 * Shared scan-orchestration helpers — pure functions reused by both the CLI
 * one-shot scanner (scanner.ts) and the live file-watch refresher (live-scan.ts).
 *
 * Nothing here touches SQLite, worker threads, or event emission. The two
 * orchestrators keep their own branch strategies (one-shot vs live refresh);
 * these helpers only collapse the duplicated identity / meta / signature / diff
 * plumbing that previously had to be kept in sync by hand.
 */
import type { BaseAgent, SessionCacheMeta } from "../agents/index.js";
import { sortSessionsByActivity } from "../contract/session-index.js";
import type {
  ProjectIdentity,
  SessionHead,
  SessionReference,
  SessionStats,
} from "../types/index.js";
import type { PersistedSessionHeadChange } from "./cache/db.js";
import {
  computeIdentityProjection,
  normalizeProjectDirectory,
  realFs,
  type ProjectIdentityProjection,
} from "../projects/index.js";

type ProjectIdentityResolver = (directory: string) => ProjectIdentityProjection;

/** Attach or refresh project identities once per normalized directory. */
export function attachMissingProjectIdentities(
  sessions: SessionHead[],
  resolve: ProjectIdentityResolver = (directory) => computeIdentityProjection(directory, realFs),
): SessionHead[] {
  const projections = new Map<string, ProjectIdentityProjection>();

  return sessions.map((session) => {
    const directory = normalizeProjectDirectory(session.directory);
    let projection = projections.get(directory);
    if (!projection) {
      projection = resolve(directory);
      projections.set(directory, projection);
    }

    const identity = session.project_identity;
    if (
      identity?.kind === projection.identity.kind &&
      identity.key === projection.identity.key &&
      identity.displayName === projection.identity.displayName &&
      session.project_identity_resolver_revision === projection.resolverRevision &&
      session.project_identity_input_signature === projection.inputSignature
    ) {
      return session;
    }

    return {
      ...session,
      project_identity: projection.identity,
      project_identity_resolver_revision: projection.resolverRevision,
      project_identity_input_signature: projection.inputSignature,
    };
  });
}

/** Serialize an agent's session meta map, optionally restricted to a set of ids. */
export function buildAgentCacheMeta(
  agent: BaseAgent,
  sessionIds?: Set<string>,
): Record<string, SessionCacheMeta> {
  const metaMap = agent.getSessionMetaMap?.();
  const meta: Record<string, SessionCacheMeta> = {};
  if (!metaMap) return meta;

  for (const [id, data] of metaMap.entries()) {
    if (sessionIds && !sessionIds.has(id)) continue;
    meta[id] = { id, ...(data as Record<string, unknown>) } as SessionCacheMeta;
  }

  return meta;
}

type SignatureValue = string | number | boolean | null | readonly SignatureValue[];

type SignatureSpec<Value extends object, Field extends keyof Value = keyof Value> = {
  [Key in Field]-?: (value: Value) => readonly SignatureValue[];
};

type ObjectSignatureSpec<Value extends object> = {
  [Key in keyof Value]-?: (value: Value) => SignatureValue;
};

function signatureValues<Value extends object, Field extends keyof Value>(
  value: Value,
  spec: SignatureSpec<Value, Field>,
): SignatureValue[] {
  const values: SignatureValue[] = [];
  for (const key of Object.keys(spec) as Array<Extract<Field, string>>) {
    values.push(...spec[key](value));
  }
  return values;
}

function objectSignatureValues<Value extends object>(
  value: Value | undefined,
  spec: ObjectSignatureSpec<Value>,
): SignatureValue[] {
  const keys = Object.keys(spec) as Array<Extract<keyof Value, string>>;
  if (!value) return keys.map(() => null);
  return keys.map((key) => spec[key](value));
}

const SESSION_REFERENCE_SIGNATURE_SPEC = {
  agentName: (reference) => reference.agentName,
  sessionId: (reference) => reference.sessionId,
} satisfies ObjectSignatureSpec<SessionReference>;

const PROJECT_IDENTITY_SIGNATURE_SPEC = {
  kind: (identity) => identity.kind,
  key: (identity) => identity.key,
  displayName: (identity) => identity.displayName,
} satisfies ObjectSignatureSpec<ProjectIdentity>;

const SESSION_STATS_SIGNATURE_SPEC = {
  message_count: (stats) => stats.message_count,
  total_input_tokens: (stats) => stats.total_input_tokens,
  total_output_tokens: (stats) => stats.total_output_tokens,
  total_cost: (stats) => stats.total_cost,
  cost_source: (stats) => stats.cost_source ?? null,
  total_tokens: (stats) => stats.total_tokens ?? 0,
  total_cache_read_tokens: (stats) => stats.total_cache_read_tokens ?? 0,
  total_cache_create_tokens: (stats) => stats.total_cache_create_tokens ?? 0,
} satisfies ObjectSignatureSpec<SessionStats>;

/** Compatibility projections are derived from `reference`; `display_title` is API decoration. */
type SessionHeadSignatureExcludedField = "id" | "slug" | "display_title";

type SessionHeadSignatureField = Exclude<keyof SessionHead, SessionHeadSignatureExcludedField>;

function modelUsageSignature(modelUsage: SessionHead["model_usage"]): SignatureValue {
  if (!modelUsage) return null;
  return Object.entries(modelUsage)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([model, tokens]) => [model, tokens]);
}

const SESSION_HEAD_SIGNATURE_SPEC = {
  reference: (session) =>
    objectSignatureValues(session.reference, SESSION_REFERENCE_SIGNATURE_SPEC),
  title: (session) => [session.title],
  directory: (session) => [session.directory],
  parent_reference: (session) =>
    objectSignatureValues(session.parent_reference, SESSION_REFERENCE_SIGNATURE_SPEC),
  project_identity: (session) =>
    objectSignatureValues(session.project_identity, PROJECT_IDENTITY_SIGNATURE_SPEC),
  project_identity_resolver_revision: (session) => [
    session.project_identity_resolver_revision ?? null,
  ],
  project_identity_input_signature: (session) => [session.project_identity_input_signature ?? null],
  time_created: (session) => [session.time_created],
  time_updated: (session) => [session.time_updated ?? session.time_created],
  stats: (session) => objectSignatureValues(session.stats, SESSION_STATS_SIGNATURE_SPEC),
  model_usage: (session) => [modelUsageSignature(session.model_usage)],
  smart_tags: (session) => [session.smart_tags ? [...session.smart_tags].sort() : null],
  smart_tags_source_updated_at: (session) => [session.smart_tags_source_updated_at ?? null],
  smart_tags_classifier_revision: (session) => [session.smart_tags_classifier_revision ?? null],
} satisfies SignatureSpec<SessionHead, SessionHeadSignatureField>;

/** Stable signature for canonical session fields used by both scan orchestrators. */
export function sessionSignature(session: SessionHead): string {
  return JSON.stringify(signatureValues(session, SESSION_HEAD_SIGNATURE_SPEC));
}

/** Sort sessions by activity time, newest first. */
export function sortSessions(sessions: SessionHead[]): SessionHead[] {
  return sortSessionsByActivity(sessions);
}

export interface SessionDiffResult {
  changes: PersistedSessionHeadChange[];
  removedSessionIds: string[];
  counts: { new: number; updated: number; removed: number };
}

/**
 * Compute the diff between a cached session set and an updated one.
 *
 * `signature` is injected so callers control the equality口径: a session counts
 * as "changed" if it is new, if its id is in `changedIds`, or if its signature
 * differs from the cached copy. The algorithm is pure — event assembly and
 * no-op short-circuiting stay with the caller.
 *
 * `signatureCache` is an optional id→signature memo the caller owns across
 * calls (e.g. across refresh cycles). On the cached side it's consulted before
 * falling back to `signature(cached)`; every updated session's signature is
 * written back into it, so the next call's cached-side lookups for unchanged
 * sessions can skip recomputation entirely. Mutating this caller-supplied map
 * is the only side effect — there's no module-level state. Callers must only
 * pass a cache whose lineage matches `cachedSessions`: if `cachedSessions` can
 * be a baseline the cache was never populated from (e.g. a DB snapshot instead
 * of the previous call's `updatedSessions`), a stale or mismatched hit will
 * silently suppress a real change.
 */
export function computeSessionDiff(
  cachedSessions: SessionHead[],
  updatedSessions: SessionHead[],
  changedIds: string[] = [],
  signature: (session: SessionHead) => string = sessionSignature,
  signatureCache?: Map<string, string>,
): SessionDiffResult {
  const cachedMap = new Map(
    cachedSessions.map((session) => [session.reference.sessionId, session]),
  );
  const updatedIds = new Set(updatedSessions.map((session) => session.reference.sessionId));
  const changedIdSet = new Set(changedIds);
  const changes: PersistedSessionHeadChange[] = [];
  const removedSessionIds: string[] = [];
  let newCount = 0;
  let updatedCount = 0;

  updatedSessions.forEach((session, sortIndex) => {
    const sessionId = session.reference.sessionId;
    const cached = cachedMap.get(sessionId);
    if (!cached) {
      newCount += 1;
      changes.push({ session, sortIndex });
      signatureCache?.set(sessionId, signature(session));
      return;
    }
    const cachedSignature = signatureCache?.get(cached.reference.sessionId) ?? signature(cached);
    const updatedSignature = signature(session);
    signatureCache?.set(sessionId, updatedSignature);
    if (changedIdSet.has(sessionId) || cachedSignature !== updatedSignature) {
      updatedCount += 1;
      changes.push({ session, sortIndex });
    }
  });

  for (const session of cachedSessions) {
    const sessionId = session.reference.sessionId;
    if (!updatedIds.has(sessionId)) {
      removedSessionIds.push(sessionId);
    }
  }

  return {
    changes,
    removedSessionIds,
    counts: { new: newCount, updated: updatedCount, removed: removedSessionIds.length },
  };
}
