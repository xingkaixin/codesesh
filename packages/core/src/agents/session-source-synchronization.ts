import { statSync } from "node:fs";
import type { SessionSnapshotCompleteness } from "../discovery/cache/snapshot-types.js";
import { PRICING_CAPTURE_EPOCH, pricingBecameAvailable } from "../pricing/cost.js";
import type { SessionHead } from "../types/index.js";
import { getCoreDiagnostics } from "../utils/diagnostics.js";
import type {
  AgentScanOptions,
  SessionCacheMeta,
  SessionCacheMetaSnapshot,
  SessionSourceAbsenceOutcome,
  SessionSourceDiff,
  SessionSourceFailure,
  SessionSourceOutcome,
  SessionSourceRef,
} from "./session-source-types.js";

export interface SessionSourceSynchronizationAdapter {
  readonly name: string;
  listSessionSources(options?: AgentScanOptions): SessionSourceRef[];
  scanSessionSourceOutcome(
    source: SessionSourceRef,
    options?: AgentScanOptions,
  ): SessionSourceOutcome;
  expandChangedSessionIds(changedIds: string[], refs?: SessionSourceRef[]): string[];
  filterCachedSessions(sessions: SessionHead[]): SessionHead[];
  getSessionCacheMeta(sessionId: string): SessionCacheMeta | undefined;
  snapshotSessionCacheMeta(sessionIds?: ReadonlySet<string>): Record<string, SessionCacheMeta>;
  restoreSessionCacheMeta(meta: SessionCacheMetaSnapshot): void;
  removeSessionCacheMeta(sessionIds: Iterable<string>): void;
}

export interface SessionSourceSynchronizationBaseline {
  sessions: SessionHead[];
  meta: SessionCacheMetaSnapshot;
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
  timing: SessionSourceSynchronizationTiming;
}

export interface SessionSourceSynchronizationTiming {
  totalMs: number;
  enumerationMs: number;
  diffMs: number;
  parseMs: number;
  enumeratedSourceCount: number;
  changedSourceCount: number;
  processedSourceCount: number;
}

/** Parser/index revisions live inside the fingerprint, so comparison must be exact. */
function fingerprintMatches(ref: SessionSourceRef, cached: SessionCacheMeta | undefined): boolean {
  return (
    typeof cached?.sourceFingerprint === "string" && cached.sourceFingerprint === ref.fingerprint
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

const FAILURE_MESSAGE_LIMIT = 500;

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
  return message.slice(0, FAILURE_MESSAGE_LIMIT);
}

export function describeFailure(error: unknown) {
  return {
    errorClass: failureClass(error),
    message: failureMessage(error),
  };
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
    ...describeFailure(error),
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
  cachedMeta: SessionCacheMetaSnapshot,
  options?: AgentScanOptions,
): SessionSourceDiff {
  const cachedIds = new Set(cachedSessions.map((session) => session.reference.sessionId));
  const enumeratedIds = new Set<string>();
  const changedIds: string[] = [];

  for (const ref of refs) {
    enumeratedIds.add(ref.sessionId);
    const meta = cachedMeta[ref.sessionId];
    const unchanged =
      cachedIds.has(ref.sessionId) &&
      meta?.sourcePath === ref.sourcePath &&
      fingerprintMatches(ref, meta) &&
      meta.pricingCaptureEpoch === PRICING_CAPTURE_EPOCH &&
      !pricingBecameAvailable(meta.unpricedModels);
    if (!unchanged) changedIds.push(ref.sessionId);
  }

  const removedIds: string[] = [];
  const failedIds: string[] = [];
  const sourceOutcomes: SessionSourceAbsenceOutcome[] = [];
  for (const session of cachedSessions) {
    const sessionId = session.reference.sessionId;
    if (enumeratedIds.has(sessionId)) continue;
    const meta = cachedMeta[sessionId];
    if (!wasEnumeratedThisPass(meta, options)) continue;
    const source = {
      sessionId,
      sourcePath: typeof meta?.sourcePath === "string" ? meta.sourcePath : "",
      fingerprint: typeof meta?.sourceFingerprint === "string" ? meta.sourceFingerprint : "",
    };
    if (!source.sourcePath) {
      // No path can ever be re-checked, so keeping this entry would fail on
      // every future pass; a complete enumeration finding neither file nor
      // path proves the entry is unrecoverable.
      removedIds.push(sessionId);
      sourceOutcomes.push({ status: "missing", source });
      continue;
    }
    try {
      statSync(source.sourcePath);
      failedIds.push(sessionId);
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
        failedIds.push(sessionId);
        sourceOutcomes.push({
          status: "failed",
          failure: createSessionSourceFailure(source, "enumeration", error),
        });
        continue;
      }
      removedIds.push(sessionId);
      sourceOutcomes.push({ status: "missing", source });
    }
  }

  return { changedIds, removedIds, failedIds, sourceOutcomes };
}

function unique(values: Iterable<string>): string[] {
  return [...new Set(values)];
}

function sourceForMissingId(
  sessionId: string,
  cached: SessionCacheMeta | undefined,
): SessionSourceRef {
  return {
    sessionId,
    sourcePath: typeof cached?.sourcePath === "string" ? cached.sourcePath : "",
    fingerprint: typeof cached?.sourceFingerprint === "string" ? cached.sourceFingerprint : "",
  };
}

function isWindowed(options: AgentScanOptions | undefined): boolean {
  return options?.from != null || options?.to != null;
}

export function synchronizeSessionSources(
  adapter: SessionSourceSynchronizationAdapter,
  baseline: SessionSourceSynchronizationBaseline,
  request: SessionSourceSynchronizationRequest,
): SessionSourceSynchronizationOutcome {
  const startedAt = performance.now();
  adapter.restoreSessionCacheMeta(baseline.meta);
  const baselineMeta = adapter.snapshotSessionCacheMeta();
  const baselineSessions = adapter.filterCachedSessions(baseline.sessions);
  const visibleBaselineIds = new Set(
    baselineSessions.map((session) => session.reference.sessionId),
  );
  const filteredBaselineIds = baseline.sessions
    .map((session) => session.reference.sessionId)
    .filter((sessionId) => !visibleBaselineIds.has(sessionId));
  const filteredBaselineOutcomes: SessionSourceOutcome[] = filteredBaselineIds.map((sessionId) => ({
    status: "filtered",
    source: sourceForMissingId(sessionId, baselineMeta[sessionId]),
    reason: "cached session rejected by adapter",
  }));
  adapter.removeSessionCacheMeta(filteredBaselineIds);
  const scanOptions = request.scanOptions;
  const suppliedSources = request.kind === "known-changes" ? request.refs : undefined;
  const enumerationStartedAt = performance.now();
  const sources = suppliedSources ?? adapter.listSessionSources(scanOptions);
  const enumerationMs = suppliedSources ? 0 : performance.now() - enumerationStartedAt;
  const sourceById = new Map(sources.map((source) => [source.sessionId, source]));
  const diffStartedAt = performance.now();
  const diff =
    request.kind === "known-changes"
      ? { changedIds: request.changedIds, removedIds: [], failedIds: [], sourceOutcomes: [] }
      : diffSessionSources(
          sources,
          baselineSessions,
          adapter.snapshotSessionCacheMeta(),
          scanOptions,
        );
  const diffMs = performance.now() - diffStartedAt;
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
      meta: adapter.snapshotSessionCacheMeta(visibleBaselineIds),
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
      timing: {
        totalMs: performance.now() - startedAt,
        enumerationMs,
        diffMs,
        parseMs: 0,
        enumeratedSourceCount: sources.length,
        changedSourceCount: diff.changedIds.length,
        processedSourceCount: 0,
      },
    };
  }

  const sessionsById = new Map(
    baselineSessions.map((session) => [session.reference.sessionId, session]),
  );
  const changedSessionIds = new Set(filteredBaselineIds);
  const explicitRemovedSessionIds = new Set(filteredBaselineIds);
  for (const outcome of diff.sourceOutcomes) {
    if (outcome.status !== "missing") continue;
    sessionsById.delete(outcome.source.sessionId);
    adapter.removeSessionCacheMeta([outcome.source.sessionId]);
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

  const parseStartedAt = performance.now();
  synchronizationIds.forEach((sessionId, index) => {
    const source = sourceById.get(sessionId);
    if (!source) {
      if (!changedSessionIds.has(sessionId)) {
        const missing: SessionSourceOutcome = {
          status: "missing",
          source: sourceForMissingId(sessionId, adapter.getSessionCacheMeta(sessionId)),
        };
        sourceOutcomes.push(missing);
        reportSessionSourceOutcome(adapter.name, missing);
        sessionsById.delete(sessionId);
        adapter.removeSessionCacheMeta([sessionId]);
        changedSessionIds.add(sessionId);
        explicitRemovedSessionIds.add(sessionId);
      }
    } else {
      const outcome = adapter.scanSessionSourceOutcome(source, scanOptions);
      sourceOutcomes.push(outcome);
      if (outcome.status === "parsed") {
        const parsedSessionId = outcome.session.reference.sessionId;
        if (parsedSessionId !== source.sessionId) sessionsById.delete(source.sessionId);
        sessionsById.set(parsedSessionId, outcome.session);
        if (parsedSessionId !== source.sessionId)
          adapter.removeSessionCacheMeta([source.sessionId]);
        if (parsedSessionId === source.sessionId)
          explicitRemovedSessionIds.delete(source.sessionId);
        changedSessionIds.add(source.sessionId);
      } else if (outcome.status === "filtered" || outcome.status === "missing") {
        sessionsById.delete(source.sessionId);
        adapter.removeSessionCacheMeta([source.sessionId]);
        changedSessionIds.add(source.sessionId);
        explicitRemovedSessionIds.add(source.sessionId);
        reportSessionSourceOutcome(adapter.name, outcome);
      } else {
        // "last-known-good data retained" is only a failure when data exists;
        // a source that never produced a session (empty or malformed file) is
        // logged and skipped so it cannot poison every future pass.
        if (visibleBaselineIds.has(source.sessionId)) sourceFailures.push(outcome.failure);
        reportSessionSourceOutcome(adapter.name, outcome);
      }
    }
    scanOptions?.onProgress?.({
      total: synchronizationIds.length,
      processed: index + 1,
      sessions: sessionsById.size,
    });
  });
  const parseMs = performance.now() - parseStartedAt;

  const failedIds = new Set(sourceFailures.map((failure) => failure.sessionId));
  const finalizeSessionIds = (
    request.kind === "reload" || (request.kind === "refresh" && !isWindowed(scanOptions))
      ? sources.map((source) => source.sessionId)
      : [...changedSessionIds]
  ).filter((sessionId) => !failedIds.has(sessionId));
  const sessions = [...sessionsById.values()];

  return {
    sessions,
    meta: adapter.snapshotSessionCacheMeta(new Set(sessionsById.keys())),
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
    timing: {
      totalMs: performance.now() - startedAt,
      enumerationMs,
      diffMs,
      parseMs,
      enumeratedSourceCount: sources.length,
      changedSourceCount: diff.changedIds.length,
      processedSourceCount: synchronizationIds.length,
    },
  };
}
