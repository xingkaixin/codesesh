import { statSync } from "node:fs";
import type { SessionSnapshotCompleteness } from "../discovery/cache/sessions.js";
import { pricingResolver } from "../pricing/resolver.js";
import type { SessionHead } from "../types/index.js";
import { getCoreDiagnostics } from "../utils/diagnostics.js";
import type {
  AgentScanOptions,
  CachedMetaLookup,
  SessionCacheMeta,
  SessionSourceAbsenceOutcome,
  SessionSourceDiff,
  SessionSourceFailure,
  SessionSourceOutcome,
  SessionSourceRef,
} from "./base.js";

export interface SessionSourceSynchronizationAdapter {
  readonly name: string;
  listSessionSources(options?: AgentScanOptions): SessionSourceRef[];
  scanSessionSourceOutcome(
    source: SessionSourceRef,
    options?: AgentScanOptions,
  ): SessionSourceOutcome;
  expandChangedSessionIds(changedIds: string[], refs?: SessionSourceRef[]): string[];
  filterCachedSessions(sessions: SessionHead[]): SessionHead[];
  getSessionMetaMap(): Map<string, SessionCacheMeta>;
  setSessionMetaMap(meta: Map<string, SessionCacheMeta>): void;
}

export interface SessionSourceSynchronizationBaseline {
  sessions: SessionHead[];
  meta: CachedMetaLookup;
}

export type SessionSourceSynchronizationRequest =
  | { kind: "inspect"; scanOptions?: AgentScanOptions }
  | { kind: "refresh"; scanOptions?: AgentScanOptions }
  | { kind: "reload"; scanOptions?: AgentScanOptions }
  | {
      kind: "known-changes";
      changedIds: string[];
      refs?: SessionSourceRef[];
      scanOptions?: AgentScanOptions;
    };

export interface SessionSourceSynchronizationOutcome {
  sessions: SessionHead[];
  meta: Record<string, SessionCacheMeta>;
  sources: SessionSourceRef[];
  sourceOutcomes: SessionSourceOutcome[];
  detectedSessionIds: string[];
  changedSessionIds: string[];
  explicitRemovedSessionIds: string[];
  finalizeSessionIds: string[];
  sourceFailures: SessionSourceFailure[];
  completeness: SessionSnapshotCompleteness;
  sourceCount: number;
  removedSourceCount: number;
}

function readCachedMeta(meta: CachedMetaLookup, sessionId: string): SessionCacheMeta | undefined {
  if (meta instanceof Map) return meta.get(sessionId);
  return (meta as Record<string, SessionCacheMeta>)[sessionId];
}

/** Parser/index revisions live inside the fingerprint, so comparison must be exact. */
function fingerprintMatches(ref: SessionSourceRef, cached: SessionCacheMeta | undefined): boolean {
  return (
    typeof cached?.sourceFingerprint === "string" && cached.sourceFingerprint === ref.fingerprint
  );
}

/**
 * A head cached while some of its models lacked pricing carries a zero estimate
 * forever unless re-parsed: the source file never changes again, so the
 * fingerprint alone cannot see a later pricing arrival.
 */
function pricingBecameAvailable(cached: SessionCacheMeta | undefined): boolean {
  const models = cached?.unpricedModels;
  if (!Array.isArray(models)) return false;
  return models.some(
    (model) => typeof model === "string" && pricingResolver.resolve(model) !== null,
  );
}

/** Unknown or out-of-window mtime cannot prove deletion; retain last-known-good facts. */
function wasEnumeratedThisPass(
  cached: SessionCacheMeta | undefined,
  options: AgentScanOptions | undefined,
): boolean {
  if (options?.from == null && options?.to == null) return true;
  const mtimeMs = cached?.sourceMtimeMs;
  return typeof mtimeMs === "number" && matchesScanWindow(mtimeMs, options);
}

export function matchesScanWindow(activityTime: number, options?: AgentScanOptions): boolean {
  if (options?.from != null && activityTime < options.from) return false;
  if (options?.to != null && activityTime > options.to) return false;
  return true;
}

export function isMissingSessionSourceError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function failureClass(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code) return code;
  }
  if (error instanceof Error && error.name) return error.name;
  return typeof error;
}

function failureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 500);
}

export function createSessionSourceFailure(
  source: Pick<SessionSourceRef, "sessionId" | "sourcePath">,
  stage: SessionSourceFailure["stage"],
  error: unknown,
): SessionSourceFailure {
  return {
    sessionId: source.sessionId,
    sourcePath: source.sourcePath,
    stage,
    errorClass: failureClass(error),
    message: failureMessage(error),
  };
}

export function reportSessionSourceOutcome(agentName: string, outcome: SessionSourceOutcome): void {
  if (outcome.status === "parsed") return;
  if (outcome.status === "filtered") {
    getCoreDiagnostics()?.info?.("agent.session_source_outcome", {
      agent: agentName,
      session_id: outcome.source.sessionId,
      source_path: outcome.source.sourcePath,
      outcome: outcome.status,
      reason: outcome.reason,
    });
    return;
  }
  if (outcome.status === "missing") {
    getCoreDiagnostics()?.info?.("agent.session_source_outcome", {
      agent: agentName,
      session_id: outcome.source.sessionId,
      source_path: outcome.source.sourcePath,
      outcome: outcome.status,
    });
    return;
  }
  getCoreDiagnostics()?.warn("agent.session_source_outcome", {
    agent: agentName,
    session_id: outcome.failure.sessionId,
    source_path: outcome.failure.sourcePath,
    outcome: outcome.status,
    stage: outcome.failure.stage,
    error_class: outcome.failure.errorClass,
    message: outcome.failure.message,
  });
}

export function diffSessionSources(
  refs: SessionSourceRef[],
  cachedSessions: SessionHead[],
  cachedMeta: CachedMetaLookup,
  options?: AgentScanOptions,
): SessionSourceDiff {
  const cachedIds = new Set(cachedSessions.map((session) => session.id));
  const enumeratedIds = new Set<string>();
  const changedIds: string[] = [];

  for (const ref of refs) {
    enumeratedIds.add(ref.sessionId);
    const meta = readCachedMeta(cachedMeta, ref.sessionId);
    const unchanged =
      cachedIds.has(ref.sessionId) &&
      meta?.sourcePath === ref.sourcePath &&
      fingerprintMatches(ref, meta) &&
      !pricingBecameAvailable(meta);
    if (!unchanged) changedIds.push(ref.sessionId);
  }

  const removedIds: string[] = [];
  const failedIds: string[] = [];
  const sourceOutcomes: SessionSourceAbsenceOutcome[] = [];
  for (const session of cachedSessions) {
    if (enumeratedIds.has(session.id)) continue;
    const meta = readCachedMeta(cachedMeta, session.id);
    if (!wasEnumeratedThisPass(meta, options)) continue;
    const source = {
      sessionId: session.id,
      sourcePath: typeof meta?.sourcePath === "string" ? meta.sourcePath : "",
      fingerprint: typeof meta?.sourceFingerprint === "string" ? meta.sourceFingerprint : "",
    };
    if (!source.sourcePath) {
      failedIds.push(session.id);
      sourceOutcomes.push({
        status: "failed",
        failure: createSessionSourceFailure(
          source,
          "enumeration",
          new Error("cached source path is missing"),
        ),
      });
      continue;
    }
    try {
      statSync(source.sourcePath);
      failedIds.push(session.id);
      sourceOutcomes.push({
        status: "failed",
        failure: createSessionSourceFailure(
          source,
          "enumeration",
          new Error("cached source was not enumerated"),
        ),
      });
    } catch (error) {
      if (!isMissingSessionSourceError(error)) {
        failedIds.push(session.id);
        sourceOutcomes.push({
          status: "failed",
          failure: createSessionSourceFailure(source, "enumeration", error),
        });
        continue;
      }
      removedIds.push(session.id);
      sourceOutcomes.push({ status: "missing", source });
    }
  }

  return { changedIds, removedIds, failedIds, sourceOutcomes };
}

function cloneMeta(meta: CachedMetaLookup): Map<string, SessionCacheMeta> {
  return meta instanceof Map ? new Map(meta) : new Map(Object.entries(meta));
}

function unique(values: Iterable<string>): string[] {
  return [...new Set(values)];
}

function sourceForMissingId(
  sessionId: string,
  meta: Map<string, SessionCacheMeta>,
): SessionSourceRef {
  const cached = meta.get(sessionId);
  return {
    sessionId,
    sourcePath: typeof cached?.sourcePath === "string" ? cached.sourcePath : "",
    fingerprint: typeof cached?.sourceFingerprint === "string" ? cached.sourceFingerprint : "",
  };
}

function buildMeta(
  sessions: SessionHead[],
  metaMap: Map<string, SessionCacheMeta>,
): Record<string, SessionCacheMeta> {
  const meta: Record<string, SessionCacheMeta> = {};
  for (const session of sessions) {
    const value = metaMap.get(session.id);
    if (value) meta[session.id] = value;
  }
  return meta;
}

function isWindowed(options: AgentScanOptions | undefined): boolean {
  return options?.from != null || options?.to != null;
}

export function synchronizeSessionSources(
  adapter: SessionSourceSynchronizationAdapter,
  baseline: SessionSourceSynchronizationBaseline,
  request: SessionSourceSynchronizationRequest,
): SessionSourceSynchronizationOutcome {
  adapter.setSessionMetaMap(cloneMeta(baseline.meta));
  const metaMap = adapter.getSessionMetaMap();
  const baselineMeta = new Map(metaMap);
  const baselineSessions = adapter.filterCachedSessions(baseline.sessions);
  const visibleBaselineIds = new Set(baselineSessions.map((session) => session.id));
  const filteredBaselineIds = baseline.sessions
    .map((session) => session.id)
    .filter((sessionId) => !visibleBaselineIds.has(sessionId));
  const filteredBaselineOutcomes: SessionSourceOutcome[] = filteredBaselineIds.map((sessionId) => ({
    status: "filtered",
    source: sourceForMissingId(sessionId, baselineMeta),
    reason: "cached session rejected by adapter",
  }));
  for (const sessionId of filteredBaselineIds) metaMap.delete(sessionId);
  const scanOptions = request.scanOptions;
  const sources =
    request.kind === "known-changes" && request.refs
      ? request.refs
      : adapter.listSessionSources(scanOptions);
  const sourceById = new Map(sources.map((source) => [source.sessionId, source]));
  const diff =
    request.kind === "known-changes"
      ? { changedIds: request.changedIds, removedIds: [], failedIds: [], sourceOutcomes: [] }
      : diffSessionSources(sources, baselineSessions, metaMap, scanOptions);
  const detectedSessionIds = unique([
    ...filteredBaselineIds,
    ...diff.changedIds,
    ...diff.removedIds,
  ]);
  const sourceOutcomes: SessionSourceOutcome[] = [
    ...filteredBaselineOutcomes,
    ...diff.sourceOutcomes,
  ];
  const sourceFailures = sourceOutcomes.flatMap((outcome) =>
    outcome.status === "failed" ? [outcome.failure] : [],
  );
  for (const outcome of sourceOutcomes) reportSessionSourceOutcome(adapter.name, outcome);

  if (request.kind === "inspect") {
    return {
      sessions: baselineSessions,
      meta: buildMeta(baselineSessions, metaMap),
      sources,
      sourceOutcomes,
      detectedSessionIds,
      changedSessionIds: [],
      explicitRemovedSessionIds: unique([...filteredBaselineIds, ...diff.removedIds]),
      finalizeSessionIds: [],
      sourceFailures,
      completeness: isWindowed(scanOptions) || sourceFailures.length > 0 ? "partial" : "complete",
      sourceCount: sources.length,
      removedSourceCount: diff.removedIds.length,
    };
  }

  const sessionsById = new Map(baselineSessions.map((session) => [session.id, session]));
  const changedSessionIds = new Set(filteredBaselineIds);
  const explicitRemovedSessionIds = new Set(filteredBaselineIds);
  for (const outcome of diff.sourceOutcomes) {
    if (outcome.status !== "missing") continue;
    sessionsById.delete(outcome.source.sessionId);
    metaMap.delete(outcome.source.sessionId);
    changedSessionIds.add(outcome.source.sessionId);
    explicitRemovedSessionIds.add(outcome.source.sessionId);
  }

  const requestedIds =
    request.kind === "reload"
      ? sources.map((source) => source.sessionId)
      : request.kind === "known-changes"
        ? request.changedIds
        : detectedSessionIds;
  const synchronizationIds = unique(adapter.expandChangedSessionIds(requestedIds, sources));
  if (synchronizationIds.length > 0 || request.kind === "reload") {
    scanOptions?.onProgress?.({
      total: synchronizationIds.length,
      processed: 0,
      sessions: sessionsById.size,
    });
  }

  synchronizationIds.forEach((sessionId, index) => {
    const source = sourceById.get(sessionId);
    if (!source) {
      if (!changedSessionIds.has(sessionId)) {
        const missing: SessionSourceOutcome = {
          status: "missing",
          source: sourceForMissingId(sessionId, metaMap),
        };
        sourceOutcomes.push(missing);
        reportSessionSourceOutcome(adapter.name, missing);
        sessionsById.delete(sessionId);
        metaMap.delete(sessionId);
        changedSessionIds.add(sessionId);
        explicitRemovedSessionIds.add(sessionId);
      }
    } else {
      const outcome = adapter.scanSessionSourceOutcome(source, scanOptions);
      sourceOutcomes.push(outcome);
      if (outcome.status === "parsed") {
        if (outcome.session.id !== source.sessionId) sessionsById.delete(source.sessionId);
        sessionsById.set(outcome.session.id, outcome.session);
        if (outcome.session.id !== source.sessionId) metaMap.delete(source.sessionId);
        if (outcome.session.id === source.sessionId)
          explicitRemovedSessionIds.delete(source.sessionId);
        changedSessionIds.add(source.sessionId);
      } else if (outcome.status === "filtered" || outcome.status === "missing") {
        sessionsById.delete(source.sessionId);
        metaMap.delete(source.sessionId);
        changedSessionIds.add(source.sessionId);
        explicitRemovedSessionIds.add(source.sessionId);
        reportSessionSourceOutcome(adapter.name, outcome);
      } else {
        sourceFailures.push(outcome.failure);
        reportSessionSourceOutcome(adapter.name, outcome);
      }
    }
    scanOptions?.onProgress?.({
      total: synchronizationIds.length,
      processed: index + 1,
      sessions: sessionsById.size,
    });
  });

  const failedIds = new Set(sourceFailures.map((failure) => failure.sessionId));
  const finalizeSessionIds = (
    request.kind === "reload" || (request.kind === "refresh" && !isWindowed(scanOptions))
      ? sources.map((source) => source.sessionId)
      : [...changedSessionIds]
  ).filter((sessionId) => !failedIds.has(sessionId));
  const sessions = [...sessionsById.values()];

  return {
    sessions,
    meta: buildMeta(sessions, metaMap),
    sources,
    sourceOutcomes,
    detectedSessionIds,
    changedSessionIds: [...changedSessionIds],
    explicitRemovedSessionIds: [...explicitRemovedSessionIds],
    finalizeSessionIds,
    sourceFailures,
    completeness: isWindowed(scanOptions) || sourceFailures.length > 0 ? "partial" : "complete",
    sourceCount: sources.length,
    removedSourceCount: diff.removedIds.length,
  };
}
