/**
 * Parent/child structure over a session snapshot: mount classification,
 * inclusive stat rollups and calendar-day grouping. Everything here is a pure
 * derivation of `parent_reference` — the wire format carries no tree.
 */
import type { CostSource, ReferencedSessionHead, SessionHead } from "./session.js";
import { startOfCalendarDay, toCalendarDayKey } from "./calendar-day.js";
import {
  applySessionChanges,
  compareSessionActivityDesc,
  getSessionRouteKey,
  type SessionHeadChange,
  type SessionHeadRemoval,
} from "./session-index.js";
import {
  formatSessionReference,
  getSessionAgentKey,
  type SessionReference,
} from "./session-reference.js";

/**
 * Where a session sits relative to its parent, with orphans distinguished
 * from mounted children.
 */
export type SessionMountState = "root" | "mounted-child" | "orphan";

export interface InclusiveSessionStats {
  messageCount: number;
  /** Raw `total_input_tokens`; cache reads/creates are part of it. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  totalTokens: number;
  cost: number;
  /** Undefined while the subtree costs nothing; "estimated" wins over "recorded". */
  costSource?: CostSource;
}

export interface SessionTreeNode {
  session: SessionHead;
  /** Direct children only, in the input array's order. */
  children: SessionTreeNode[];
  /** Total number of descendants at every depth. */
  descendantCount: number;
  /** stats rolled up over this node and every descendant. */
  inclusiveStats: InclusiveSessionStats;
}

export interface SessionTree {
  /** Sessions with no parent_reference, in input order. */
  roots: SessionTreeNode[];
  /** Sessions whose parent is not present in the input (未挂载), in input order. */
  orphans: SessionTreeNode[];
  /** roots ∪ orphans, in input order — the set that owns the main axis. */
  entries: SessionTreeNode[];
  byRouteKey: Map<string, SessionTreeNode>;
  mountStateOf(session: SessionHead): SessionMountState;
}

export interface SessionDayGroup {
  /** "YYYY-MM-DD" local calendar day. */
  dayKey: string;
  dayStart: number;
  nodes: SessionTreeNode[];
  mainCount: number;
  subCount: number;
}

function sessionKey(session: SessionHead): string {
  return getSessionRouteKey(getSessionAgentKey(session), session.id);
}

function parentKey(session: SessionHead): string | null {
  return session.parent_reference ? formatSessionReference(session.parent_reference) : null;
}

function activityTime(session: SessionHead): number {
  return session.time_updated ?? session.time_created;
}

function hasActivityInWindow(session: SessionHead, from?: number, to?: number): boolean {
  const activity = activityTime(session);
  return (from == null || activity >= from) && (to == null || activity <= to);
}

function ownStats(session: SessionHead): InclusiveSessionStats {
  const stats = session.stats;
  const cost = stats.total_cost ?? 0;
  return {
    messageCount: stats.message_count,
    inputTokens: stats.total_input_tokens,
    outputTokens: stats.total_output_tokens,
    cacheReadTokens: stats.total_cache_read_tokens ?? 0,
    cacheCreateTokens: stats.total_cache_create_tokens ?? 0,
    totalTokens: stats.total_tokens ?? stats.total_input_tokens + stats.total_output_tokens,
    cost,
    costSource: cost > 0 ? (stats.cost_source ?? "recorded") : undefined,
  };
}

function addStats(target: InclusiveSessionStats, source: InclusiveSessionStats): void {
  target.messageCount += source.messageCount;
  target.inputTokens += source.inputTokens;
  target.outputTokens += source.outputTokens;
  target.cacheReadTokens += source.cacheReadTokens;
  target.cacheCreateTokens += source.cacheCreateTokens;
  target.totalTokens += source.totalTokens;
  target.cost += source.cost;
  if (source.costSource === "estimated") target.costSource = "estimated";
}

/**
 * Post-order rollup of `descendantCount` and `inclusiveStats` over one entry.
 * Folds children into each node's own stats in place, which is sound because a
 * node hangs off exactly one entry and every entry is rolled up once.
 */
function rollUpSubtree(entry: SessionTreeNode): void {
  const order: SessionTreeNode[] = [];
  const pending = [entry];
  while (pending.length > 0) {
    const node = pending.pop()!;
    order.push(node);
    for (const child of node.children) pending.push(child);
  }

  for (let index = order.length - 1; index >= 0; index -= 1) {
    const node = order[index]!;
    const stats = node.inclusiveStats;
    let descendants = 0;
    for (const child of node.children) {
      descendants += 1 + child.descendantCount;
      addStats(stats, child.inclusiveStats);
    }
    if (stats.cost > 0 && stats.costSource == null) stats.costSource = "recorded";
    node.descendantCount = descendants;
  }
}

export function buildSessionTree(sessions: SessionHead[]): SessionTree {
  const byRouteKey = new Map<string, SessionTreeNode>();
  for (const session of sessions) {
    const key = sessionKey(session);
    if (byRouteKey.has(key)) continue;
    byRouteKey.set(key, {
      session,
      children: [],
      descendantCount: 0,
      inclusiveStats: ownStats(session),
    });
  }
  const nodes = [...byRouteKey.values()];

  // A session whose parent chain re-enters itself can never reach a root, so it
  // is mounted nowhere. Memoized so the walk stays linear over long chains.
  const chainTerminates = new Map<string, boolean>();
  function reachesRoot(startKey: string): boolean {
    const path: string[] = [];
    const onPath = new Set<string>();
    let key: string | null = startKey;
    let terminates = true;

    while (key != null) {
      const memo = chainTerminates.get(key);
      if (memo != null) {
        terminates = memo;
        break;
      }
      if (onPath.has(key)) {
        terminates = false;
        break;
      }
      onPath.add(key);
      path.push(key);
      const parent = parentKey(byRouteKey.get(key)!.session);
      key = parent != null && byRouteKey.has(parent) ? parent : null;
    }

    for (const visited of path) chainTerminates.set(visited, terminates);
    return terminates;
  }

  const mountStates = new Map<string, SessionMountState>();
  const roots: SessionTreeNode[] = [];
  const orphans: SessionTreeNode[] = [];
  const entries: SessionTreeNode[] = [];

  for (const node of nodes) {
    const key = sessionKey(node.session);
    const parent = parentKey(node.session);
    const state: SessionMountState =
      parent == null
        ? "root"
        : byRouteKey.has(parent) && reachesRoot(key)
          ? "mounted-child"
          : "orphan";

    mountStates.set(key, state);
    if (state === "mounted-child") {
      byRouteKey.get(parent!)!.children.push(node);
      continue;
    }
    (state === "root" ? roots : orphans).push(node);
    entries.push(node);
  }

  for (const entry of entries) rollUpSubtree(entry);

  return {
    roots,
    orphans,
    entries,
    byRouteKey,
    mountStateOf(session) {
      return mountStates.get(sessionKey(session)) ?? (session.parent_reference ? "orphan" : "root");
    },
  };
}

/**
 * Groups top-level nodes by the calendar day of their activity time,
 * newest day first, newest node first.
 */
export function groupSessionsByCalendarDay(nodes: SessionTreeNode[]): SessionDayGroup[] {
  const groups = new Map<string, SessionDayGroup>();

  for (const node of nodes) {
    const activity = activityTime(node.session);
    const dayKey = toCalendarDayKey(activity);
    let group = groups.get(dayKey);
    if (!group) {
      group = {
        dayKey,
        dayStart: startOfCalendarDay(activity),
        nodes: [],
        mainCount: 0,
        subCount: 0,
      };
      groups.set(dayKey, group);
    }
    group.nodes.push(node);
  }

  const days = [...groups.values()];
  for (const group of days) {
    group.nodes.sort((a, b) => compareSessionActivityDesc(a.session, b.session));
    group.mainCount = group.nodes.length;
    group.subCount = group.nodes.reduce((sum, node) => sum + node.descendantCount, 0);
  }
  return days.sort((a, b) => b.dayStart - a.dayStart);
}

/**
 * Filters main-axis sessions (roots and orphans) by activity and keeps every
 * mounted descendant of a match. The input order is preserved so callers keep
 * their existing sort behavior.
 */
export function filterSessionTreeByActivityWindow(
  sessions: SessionHead[],
  from?: number,
  to?: number,
  tree: SessionTree = buildSessionTree(sessions),
): SessionHead[] {
  if (from == null && to == null) return sessions;

  const pending = filterSessionTreeEntriesByActivityWindow(tree, from, to);

  const visible = new Set<string>();
  while (pending.length > 0) {
    const node = pending.pop()!;
    const key = sessionKey(node.session);
    if (visible.has(key)) continue;
    visible.add(key);
    for (const child of node.children) pending.push(child);
  }

  return sessions.filter((session) => visible.has(sessionKey(session)));
}

export function filterSessionTreeEntriesByActivityWindow(
  tree: SessionTree,
  from?: number,
  to?: number,
): SessionTreeNode[] {
  if (from == null && to == null) return tree.entries;
  return tree.entries.filter((node) => hasActivityInWindow(node.session, from, to));
}

interface SessionHierarchyGraph {
  sessionsByKey: Map<string, SessionHead>;
  parentByKey: Map<string, string>;
  childrenByKey: Map<string, string[]>;
}

function createSessionHierarchyGraph(sessions: SessionHead[]): SessionHierarchyGraph {
  const sessionsByKey = new Map<string, SessionHead>();
  for (const session of sessions) {
    const key = sessionKey(session);
    if (!sessionsByKey.has(key)) sessionsByKey.set(key, session);
  }

  const parentByKey = new Map<string, string>();
  const childrenByKey = new Map<string, string[]>();
  for (const [key, session] of sessionsByKey) {
    const parent = parentKey(session);
    if (!parent || !sessionsByKey.has(parent)) continue;
    parentByKey.set(key, parent);
    const children = childrenByKey.get(parent);
    if (children) children.push(key);
    else childrenByKey.set(parent, [key]);
  }
  return { sessionsByKey, parentByKey, childrenByKey };
}

function collectAffectedHierarchyKeys(
  graph: SessionHierarchyGraph,
  seedKeys: Iterable<string>,
  includeAncestors: boolean,
  collected: Set<string>,
): void {
  const visited = new Set<string>();
  const pending = [...seedKeys].filter((key) => graph.sessionsByKey.has(key));
  while (pending.length > 0) {
    const key = pending.pop()!;
    if (visited.has(key)) continue;
    visited.add(key);
    collected.add(key);
    for (const child of graph.childrenByKey.get(key) ?? []) pending.push(child);
  }

  if (!includeAncestors) return;
  for (const seed of seedKeys) {
    let key = graph.sessionsByKey.has(seed) ? seed : undefined;
    const onPath = new Set<string>();
    while (key && !onPath.has(key)) {
      onPath.add(key);
      collected.add(key);
      key = graph.parentByKey.get(key);
    }
  }
}

export interface SessionProjectionContext {
  relatedSessionHeads: ReferencedSessionHead[];
  sessionOrder: SessionReference[];
}

export function createSessionProjectionContext(
  previousSessions: SessionHead[],
  nextSessions: SessionHead[],
  changedSessionHeads: ReferencedSessionHead[],
  removedSessionRefs: SessionReference[],
): SessionProjectionContext {
  const changedKeys = new Set(
    changedSessionHeads.map(({ reference }) =>
      getSessionRouteKey(reference.agentName, reference.sessionId),
    ),
  );
  const removedKeys = removedSessionRefs.map(({ agentName, sessionId }) =>
    getSessionRouteKey(agentName, sessionId),
  );
  const affectedKeys = new Set<string>();
  const previousGraph = createSessionHierarchyGraph(previousSessions);
  const nextGraph = createSessionHierarchyGraph(nextSessions);
  collectAffectedHierarchyKeys(previousGraph, changedKeys, true, affectedKeys);
  collectAffectedHierarchyKeys(nextGraph, changedKeys, true, affectedKeys);
  collectAffectedHierarchyKeys(previousGraph, removedKeys, false, affectedKeys);

  const emitted = new Set<string>();
  const relatedSessionHeads = nextSessions.flatMap((session) => {
    const key = sessionKey(session);
    if (!affectedKeys.has(key) || changedKeys.has(key) || emitted.has(key)) return [];
    emitted.add(key);
    return [
      {
        reference: { agentName: getSessionAgentKey(session), sessionId: session.id },
        session,
      },
    ];
  });
  const affectedActivityTimes = new Set(
    [...changedSessionHeads, ...relatedSessionHeads].map(({ session }) => activityTime(session)),
  );
  const sessionOrder = nextSessions.flatMap((session) =>
    affectedActivityTimes.has(activityTime(session))
      ? [{ agentName: getSessionAgentKey(session), sessionId: session.id }]
      : [],
  );
  return { relatedSessionHeads, sessionOrder };
}

export interface SessionWindowChanges {
  changedSessionHeads: SessionHeadChange[];
  projectionRelatedSessionHeads?: SessionHeadChange[];
  projectionSessionOrder?: SessionReference[];
  removedSessionRefs: SessionHeadRemoval[];
  from?: number;
  to?: number;
}

export interface SessionWindowChangeResult {
  sessions: SessionHead[];
  visibleAddedSessions: number;
  visibleRemovedSessions: number;
}

export function applySessionWindowChanges(
  sessions: SessionHead[],
  changes: SessionWindowChanges,
): SessionWindowChangeResult {
  const previousKeys = new Set(sessions.map(sessionKey));
  const upserts = [
    ...(changes.projectionRelatedSessionHeads ?? []),
    ...changes.changedSessionHeads,
  ];
  const upsertsByKey = new Map(
    upserts.map((change) => [
      getSessionRouteKey(change.reference.agentName, change.reference.sessionId),
      change,
    ]),
  );
  const sessionsByKey = new Map(sessions.map((session) => [sessionKey(session), session]));
  const orderedUpserts: SessionHeadChange[] = [];
  const reorderedRefs: SessionReference[] = [];
  for (const reference of changes.projectionSessionOrder ?? []) {
    const key = getSessionRouteKey(reference.agentName, reference.sessionId);
    const change = upsertsByKey.get(key);
    const session = change?.session ?? sessionsByKey.get(key);
    if (!session) continue;
    orderedUpserts.push(change ?? { reference, session });
    reorderedRefs.push(reference);
    upsertsByKey.delete(key);
  }
  orderedUpserts.push(...upsertsByKey.values());
  const merged = applySessionChanges(sessions, orderedUpserts, [
    ...changes.removedSessionRefs,
    ...reorderedRefs,
  ]);
  const projected = filterSessionTreeByActivityWindow(merged, changes.from, changes.to);
  const nextKeys = new Set(projected.map(sessionKey));
  let visibleAddedSessions = 0;
  let visibleRemovedSessions = 0;
  for (const key of nextKeys) {
    if (!previousKeys.has(key)) visibleAddedSessions += 1;
  }
  for (const key of previousKeys) {
    if (!nextKeys.has(key)) visibleRemovedSessions += 1;
  }
  return { sessions: projected, visibleAddedSessions, visibleRemovedSessions };
}
