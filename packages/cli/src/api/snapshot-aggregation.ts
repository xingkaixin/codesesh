import {
  listFileActivity,
  listModelCostDistribution,
  type DashboardData,
  type DashboardScope,
  type SessionHead,
} from "@codesesh/core";
import { buildSessionTree, type SessionTree } from "@codesesh/core/contract";
import { appLogger } from "../logging.js";
import type { ScanResultSource } from "./scan-sources.js";

interface SnapshotAggregationCache {
  sessions: SessionHead[];
  sessionTree?: SessionTree;
  values: Map<string, unknown>;
}

const SNAPSHOT_AGGREGATION_CACHE_LIMIT = 64;
const snapshotAggregationCaches = new WeakMap<ScanResultSource, SnapshotAggregationCache>();
type SnapshotAggregationCacheState = "hit" | "miss";

function getSnapshotAggregationCache(
  source: ScanResultSource,
  sessions: SessionHead[],
): SnapshotAggregationCache {
  let cache = snapshotAggregationCaches.get(source);
  if (!cache || cache.sessions !== sessions) {
    cache = { sessions, values: new Map() };
    snapshotAggregationCaches.set(source, cache);
  }
  return cache;
}

/**
 * LiveScanStore replaces its canonical sessions array whenever the snapshot
 * changes, so that existing reference is the snapshot version.
 */
export function getSnapshotAggregation<T>(
  source: ScanResultSource,
  sessions: SessionHead[],
  key: readonly unknown[],
  build: () => T,
  onCacheState?: (state: SnapshotAggregationCacheState) => void,
): T {
  const cache = getSnapshotAggregationCache(source, sessions);

  const cacheKey = JSON.stringify(key);
  if (cache.values.has(cacheKey)) {
    const cached = cache.values.get(cacheKey) as T;
    cache.values.delete(cacheKey);
    cache.values.set(cacheKey, cached);
    onCacheState?.("hit");
    return cached;
  }

  const value = build();
  if (cache.values.size >= SNAPSHOT_AGGREGATION_CACHE_LIMIT) {
    const oldestKey = cache.values.keys().next().value;
    if (oldestKey != null) cache.values.delete(oldestKey);
  }
  cache.values.set(cacheKey, value);
  onCacheState?.("miss");
  return value;
}

export function getSnapshotSessionTree(
  source: ScanResultSource,
  sessions: SessionHead[],
): SessionTree {
  const cache = getSnapshotAggregationCache(source, sessions);
  return (cache.sessionTree ??= buildSessionTree(sessions));
}

type DashboardStorageAggregation = Pick<DashboardData, "recentFileActivities" | "modelCost">;

export function getDashboardStorageAggregation(
  source: ScanResultSource,
  sessions: SessionHead[],
  scope: DashboardScope,
  from: number | undefined,
  to: number,
  cacheTo: number,
  analyticsRevision: string | null,
): DashboardStorageAggregation {
  const build = (): DashboardStorageAggregation => ({
    recentFileActivities: listFileActivity({
      agent: scope.agent,
      projectKind: scope.projectKind,
      projectKey: scope.projectKey,
      from,
      to,
      limit: 12,
    }),
    modelCost: listModelCostDistribution({
      agent: scope.agent,
      projectKind: scope.projectKind,
      projectKey: scope.projectKey,
      from,
      to,
    }),
  });
  const startedAt = performance.now();
  const log = (cache: SnapshotAggregationCacheState | "unavailable") => {
    appLogger.info("api.dashboard.storage_aggregation", {
      cache,
      ...(analyticsRevision === null ? {} : { analytics_revision: analyticsRevision }),
      duration_ms: Math.round(performance.now() - startedAt),
    });
  };

  if (analyticsRevision === null) {
    const value = build();
    log("unavailable");
    return value;
  }

  return getSnapshotAggregation(
    source,
    sessions,
    [
      "dashboard-storage",
      scope.agent,
      scope.projectKind,
      scope.projectKey,
      from,
      cacheTo,
      analyticsRevision,
    ],
    build,
    log,
  );
}
