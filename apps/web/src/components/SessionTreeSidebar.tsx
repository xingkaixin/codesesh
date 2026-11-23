import { Menu } from "./ui/popup-menu";
import { buildSessionTree, type SessionHead, type SessionTreeNode } from "@codesesh/contract";
import {
  memo,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useLocale } from "../hooks/useLocale";
import { t } from "../i18n/translate";
import {
  getProjectIdentityKey,
  isGitRemoteFallbackDisplayName,
  resolveProjectDisplayName,
} from "../lib/projects";
import { getSessionReferenceKey } from "../lib/session-indexes";
import { getSessionDisplayTitle } from "../lib/session-title";
import { cn } from "../lib/utils";
import { isRenderProfilerEnabled, recordRenderProfileEntry } from "./RenderProfiler";
import { SessionActionMenuItems } from "./SessionActionsMenu";
import { ChevronRight, MoreHorizontal } from "./ui/icons";

interface SessionTreeSidebarProps {
  sessions: SessionHead[];
  activeSessionReference: string | null;
  selection: { reference: string } | null;
  onSelectSession: (session: SessionHead) => void;
  bookmarkedSessionReferences: Set<string>;
  onCopySessionAsMarkdown: (session: SessionHead) => void;
  onToggleBookmark: (session: SessionHead) => void;
  onRenameSession: (session: SessionHead) => void;
  /** False when the listing already covers one project. */
  groupByProject?: boolean;
  projectDisplayNames?: ReadonlyMap<string, string>;
  sourceLabel?: (session: SessionHead) => string | undefined;
}

export interface SessionTreeItem {
  id: string;
  kind: "group" | "session" | "overflow";
  label: string;
  session?: SessionHead;
  sessionReference?: string;
  count?: number;
  children: SessionTreeItem[];
}

export interface SessionTreeModel {
  roots: SessionTreeItem[];
  ancestorIdsBySessionReference: Map<string, readonly string[]>;
  itemBySessionReference: Map<string, SessionTreeItem>;
}

interface PendingTreeFrame {
  node: SessionTreeNode;
  targetList: SessionTreeItem[];
  ancestorIds: readonly string[];
  siblingTitleCounts: Map<string, number>;
  depth: number;
  flattened: boolean;
}

interface VisibleTreeRow {
  item: SessionTreeItem;
  level: number;
  parentId: string | null;
  position: number;
  siblingCount: number;
  hasChildren: boolean;
  expanded: boolean;
}

function getDirectoryLabel(directory: string) {
  return directory.replace(/\/+$/, "").split("/").at(-1)?.trim() || "(unknown)";
}

function getProjectGroup(session: SessionHead, projectDisplayNames?: ReadonlyMap<string, string>) {
  const identity = session.project_identity;
  if (identity) {
    return {
      key: getProjectIdentityKey(identity),
      label:
        resolveProjectDisplayName(identity, projectDisplayNames) ||
        getDirectoryLabel(session.directory),
    };
  }
  const label = getDirectoryLabel(session.directory);
  return {
    key: label === "(unknown)" ? "__unknown__" : `path:${session.directory || label}`,
    label,
  };
}

function getSessionTime(session: SessionHead) {
  return session.time_updated ?? session.time_created;
}

/**
 * Hands out unique display labels for repeated group names. Each base resumes
 * its suffix search where the last collision left off so N identical labels
 * stay O(N).
 */
function createLabelAllocator() {
  const used = new Set<string>();
  const nextSuffix = new Map<string, number>();

  return function allocate(base: string): string {
    const normalized = base.trim() || "(untitled)";
    if (!used.has(normalized)) {
      used.add(normalized);
      return normalized;
    }

    let suffix = nextSuffix.get(normalized) ?? 2;
    let label = `${normalized} (${suffix})`;
    while (used.has(label)) {
      suffix += 1;
      label = `${normalized} (${suffix})`;
    }
    nextSuffix.set(normalized, suffix + 1);
    used.add(label);
    return label;
  };
}

/** Sessions the canonical hierarchy cannot mount still need a visible axis. */
const UNMOUNTED_GROUP_LABEL = "Unmounted";
const DEEP_SESSION_GROUP_LABEL = "Deeper sessions";
/** Cap visual tree depth so pathological chains flatten into one overflow node. */
export const MAX_SESSION_TREE_NESTING = 32;

/**
 * `groupByProject: false` drops the project layer, for listings that already
 * cover exactly one project — a lone group node there carries no information.
 * Orphans keep their own group either way, because that one does.
 */
export function buildSessionTreeModel(
  sessions: SessionHead[],
  {
    groupByProject = true,
    projectDisplayNames,
    sourceLabel,
  }: {
    groupByProject?: boolean;
    projectDisplayNames?: ReadonlyMap<string, string>;
    sourceLabel?: (session: SessionHead) => string | undefined;
  } = {},
): SessionTreeModel {
  const ancestorIdsBySessionReference = new Map<string, readonly string[]>();
  const itemBySessionReference = new Map<string, SessionTreeItem>();
  const tree = buildSessionTree(sessions);
  const groups = new Map<
    string,
    { key: string; label: string; nodes: SessionTreeNode[]; maxTime: number }
  >();

  for (const node of tree.roots) {
    const session = node.session;
    const { key, label } = getProjectGroup(session, projectDisplayNames);
    const time = getSessionTime(session);
    const group = groups.get(key);
    if (group) {
      group.nodes.push(node);
      if (
        !projectDisplayNames?.has(key) &&
        session.project_identity?.displayName &&
        isGitRemoteFallbackDisplayName({
          kind: session.project_identity.kind,
          key: session.project_identity.key,
          displayName: group.label,
        }) &&
        !isGitRemoteFallbackDisplayName(session.project_identity)
      ) {
        group.label = session.project_identity.displayName;
      }
      if (time > group.maxTime) group.maxTime = time;
    } else {
      groups.set(key, { key, label, nodes: [node], maxTime: time });
    }
  }

  const orderedGroups: Array<{
    key: string | null;
    label: string | null;
    nodes: SessionTreeNode[];
  }> = groupByProject
    ? [...groups.values()].sort((a, b) => {
        if (a.label === "(unknown)") return 1;
        if (b.label === "(unknown)") return -1;
        return b.maxTime - a.maxTime;
      })
    : [{ key: null, label: null, nodes: tree.roots }];

  if (tree.orphans.length > 0) {
    orderedGroups.push({
      key: "__unmounted__",
      label: t(UNMOUNTED_GROUP_LABEL),
      nodes: tree.orphans,
    });
  }

  const roots: SessionTreeItem[] = [];
  const allocateGroupLabel = createLabelAllocator();

  for (const group of orderedGroups) {
    let targetList = roots;
    let baseAncestors: readonly string[] = [];

    if (group.label !== null && group.key !== null) {
      const groupItem: SessionTreeItem = {
        id: `group:${group.key}`,
        kind: "group",
        label: allocateGroupLabel(group.label),
        count: group.nodes.length,
        children: [],
      };
      roots.push(groupItem);
      targetList = groupItem.children;
      baseAncestors = [groupItem.id];
    }

    const rootTitleCounts = new Map<string, number>();
    const pending: PendingTreeFrame[] = [];
    for (let index = group.nodes.length - 1; index >= 0; index -= 1) {
      pending.push({
        node: group.nodes[index]!,
        targetList,
        ancestorIds: baseAncestors,
        siblingTitleCounts: rootTitleCounts,
        depth: 0,
        flattened: false,
      });
    }

    while (pending.length > 0) {
      const frame = pending.pop()!;
      const { node, siblingTitleCounts } = frame;
      const session = node.session;
      const source = sourceLabel?.(session);
      const baseTitle = source
        ? `${getSessionDisplayTitle(session)} · ${source}`
        : getSessionDisplayTitle(session);
      const nextCount = (siblingTitleCounts.get(baseTitle) ?? 0) + 1;
      siblingTitleCounts.set(baseTitle, nextCount);
      const label =
        nextCount > 1 ? `${baseTitle} #${session.reference.sessionId.slice(0, 8)}` : baseTitle;
      const reference = getSessionReferenceKey(session);
      const id = `session:${reference}`;
      const hasNestedChildren = !frame.flattened && node.children.length > 0;

      const item: SessionTreeItem = {
        id,
        kind: "session",
        label,
        session,
        sessionReference: reference,
        count: hasNestedChildren ? node.children.length : undefined,
        children: [],
      };
      frame.targetList.push(item);
      ancestorIdsBySessionReference.set(reference, frame.ancestorIds);
      itemBySessionReference.set(reference, item);

      if (node.children.length === 0) continue;

      if (frame.flattened) {
        for (let index = node.children.length - 1; index >= 0; index -= 1) {
          pending.push({
            node: node.children[index]!,
            targetList: frame.targetList,
            ancestorIds: frame.ancestorIds,
            siblingTitleCounts,
            depth: frame.depth,
            flattened: true,
          });
        }
        continue;
      }

      const childTitleCounts = new Map<string, number>();
      if (frame.depth + 1 < MAX_SESSION_TREE_NESTING) {
        const childAncestors = [...frame.ancestorIds, id];
        for (let index = node.children.length - 1; index >= 0; index -= 1) {
          pending.push({
            node: node.children[index]!,
            targetList: item.children,
            ancestorIds: childAncestors,
            siblingTitleCounts: childTitleCounts,
            depth: frame.depth + 1,
            flattened: false,
          });
        }
        continue;
      }

      const overflowId = `overflow:${reference}`;
      const overflowItem: SessionTreeItem = {
        id: overflowId,
        kind: "overflow",
        label: t(DEEP_SESSION_GROUP_LABEL),
        count: node.descendantCount,
        children: [],
      };
      item.children.push(overflowItem);
      const overflowAncestors = [...frame.ancestorIds, id, overflowId];
      for (let index = node.children.length - 1; index >= 0; index -= 1) {
        pending.push({
          node: node.children[index]!,
          targetList: overflowItem.children,
          ancestorIds: overflowAncestors,
          siblingTitleCounts: childTitleCounts,
          depth: frame.depth + 1,
          flattened: true,
        });
      }
    }
  }

  return {
    roots,
    ancestorIdsBySessionReference,
    itemBySessionReference,
  };
}

function collectVisibleRows(
  roots: SessionTreeItem[],
  expandedIds: ReadonlySet<string>,
): VisibleTreeRow[] {
  const rows: VisibleTreeRow[] = [];
  const stack: Omit<VisibleTreeRow, "hasChildren" | "expanded">[] = [];
  for (let index = roots.length - 1; index >= 0; index -= 1) {
    stack.push({
      item: roots[index]!,
      level: 1,
      parentId: null,
      position: index + 1,
      siblingCount: roots.length,
    });
  }

  while (stack.length > 0) {
    const current = stack.pop()!;
    const hasChildren = current.item.children.length > 0;
    const expanded = hasChildren && expandedIds.has(current.item.id);
    rows.push({
      ...current,
      hasChildren,
      expanded,
    });
    if (expanded) {
      for (let index = current.item.children.length - 1; index >= 0; index -= 1) {
        stack.push({
          item: current.item.children[index]!,
          level: current.level + 1,
          parentId: current.item.id,
          position: index + 1,
          siblingCount: current.item.children.length,
        });
      }
    }
  }

  return rows;
}

function measureSessionTreeWork<T>(id: string, compute: () => T): T {
  if (!isRenderProfilerEnabled()) return compute();

  const startedAt = performance.now();
  const value = compute();
  const endedAt = performance.now();
  recordRenderProfileEntry({
    id,
    source: "custom-timing",
    phase: "measure",
    actualDuration: Math.round((endedAt - startedAt) * 100) / 100,
    baseDuration: 0,
    startTime: startedAt,
    commitTime: endedAt,
  });
  return value;
}

const TREE_ROW_STRIDE = 30;
const TREE_OVERSCAN = 4;
const TREE_MAX_HEIGHT = 560;

export const SessionTreeSidebar = memo(function SessionTreeSidebar({
  sessions,
  activeSessionReference,
  selection,
  onSelectSession,
  bookmarkedSessionReferences,
  onCopySessionAsMarkdown,
  onToggleBookmark,
  onRenameSession,
  groupByProject = true,
  projectDisplayNames,
  sourceLabel,
}: SessionTreeSidebarProps) {
  const locale = useLocale();

  const modelData = useMemo(
    () =>
      measureSessionTreeWork("SessionTreeSidebar:buildTreeModel", () =>
        buildSessionTreeModel(sessions, { groupByProject, projectDisplayNames, sourceLabel }),
      ),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Display formatters read the active locale.
    [locale, sessions, groupByProject, projectDisplayNames, sourceLabel],
  );

  const selectedSessionReference = selection?.reference ?? activeSessionReference;
  const targetReference = selectedSessionReference;
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => {
    const initialAncestors = targetReference
      ? modelData.ancestorIdsBySessionReference.get(targetReference)
      : undefined;
    return initialAncestors && initialAncestors.length > 0 ? new Set(initialAncestors) : new Set();
  });
  const [focusedItemId, setFocusedItemId] = useState<string | null>(null);
  const [menuSession, setMenuSession] = useState<SessionHead | null>(null);
  const menuAnchorRef = useRef<HTMLElement | null>(null);
  const menuTriggerRef = useRef<HTMLElement | null>(null);
  const rowElementsRef = useRef(new Map<string, HTMLDivElement>());
  const treeRef = useRef<HTMLDivElement | null>(null);
  const pendingFocus = useRef<string | null>(null);
  const menuKeyboardOpen = useRef(false);
  const [scrollRow, setScrollRow] = useState(0);
  const ancestors = targetReference
    ? modelData.ancestorIdsBySessionReference.get(targetReference)
    : undefined;
  const targetPath = ancestors ? JSON.stringify([targetReference, ...ancestors]) : null;
  const target = useMemo(
    () => (targetPath ? { path: targetPath, selection } : null),
    [targetPath, selection],
  );
  const focusedAncestors = focusedItemId?.startsWith("session:")
    ? modelData.ancestorIdsBySessionReference.get(focusedItemId.slice("session:".length))
    : undefined;
  const focusPath = focusedAncestors ? JSON.stringify([focusedItemId, ...focusedAncestors]) : null;
  const [expandedPaths, setExpandedPaths] = useState({ target, focusPath });
  if (expandedPaths.target !== target || expandedPaths.focusPath !== focusPath) {
    const reveal = [
      ...(expandedPaths.target !== target ? (ancestors ?? []) : []),
      ...(expandedPaths.focusPath !== focusPath ? (focusedAncestors ?? []) : []),
    ];
    setExpandedPaths({ target, focusPath });
    if (reveal.some((id) => !expandedIds.has(id)))
      setExpandedIds(new Set([...expandedIds, ...reveal]));
  }
  // Each explicit selection is a new object; without one, the active reference
  // is the request. Rebuilds that only move the target's path reuse the same
  // request, so they scroll to it once but never take focus from another row.
  const targetRequest = selection ?? targetReference;
  const lastFocusedRequestRef = useRef<typeof targetRequest>(null);
  const lastRevealedTargetRef = useRef<typeof target>(null);

  const visibleRows = useMemo(
    () => collectVisibleRows(modelData.roots, expandedIds),
    [modelData.roots, expandedIds],
  );

  const toggleExpanded = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const setExpanded = useCallback((id: string, expanded: boolean) => {
    setExpandedIds((prev) => {
      if (prev.has(id) === expanded) return prev;
      const next = new Set(prev);
      if (expanded) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const openSessionMenu = useCallback(
    (session: SessionHead, anchor: HTMLElement, trigger: HTMLElement, keyboard = false) => {
      const reference = getSessionReferenceKey(session);
      if (menuSession && getSessionReferenceKey(menuSession) === reference) {
        setMenuSession(null);
        return;
      }
      menuKeyboardOpen.current = keyboard;
      menuAnchorRef.current = anchor;
      menuTriggerRef.current = trigger;
      setMenuSession(session);
    },
    [menuSession],
  );

  useLayoutEffect(() => {
    if (!target || !targetReference) {
      lastFocusedRequestRef.current = null;
      return;
    }
    if (lastRevealedTargetRef.current === target) return;
    const id = `session:${targetReference}`;
    const row = rowElementsRef.current.get(id);
    if (!row) return;
    lastRevealedTargetRef.current = target;
    if (lastFocusedRequestRef.current === targetRequest) {
      // Only a reader on another session row keeps its place; group rows,
      // the target row and focus outside the tree still follow the target.
      const focusedRow = document.activeElement?.closest<HTMLElement>('[role="treeitem"]');
      const readingOtherSession =
        focusedRow !== row &&
        focusedRow?.dataset.sessionReference !== undefined &&
        treeRef.current?.contains(focusedRow);
      if (!readingOtherSession) row.scrollIntoView?.({ block: "nearest" });
      return;
    }
    lastFocusedRequestRef.current = targetRequest;
    if (treeRef.current?.contains(document.activeElement)) row.focus({ preventScroll: true });
    setFocusedItemId(id);
    row.scrollIntoView?.({ block: "nearest" });
  }, [target, targetReference, targetRequest, visibleRows]);

  const registerRowRef = useCallback((id: string, element: HTMLDivElement | null) => {
    if (element) rowElementsRef.current.set(id, element);
    else rowElementsRef.current.delete(id);
  }, []);

  const focusItem = useCallback((id: string) => {
    const element = rowElementsRef.current.get(id);
    pendingFocus.current = element ? null : id;
    setFocusedItemId(id);
    element?.focus({ preventScroll: true });
    element?.scrollIntoView?.({ block: "nearest" });
  }, []);
  useLayoutEffect(() => {
    const id = pendingFocus.current;
    if (!id) return;
    const element = rowElementsRef.current.get(id);
    if (element) {
      pendingFocus.current = null;
      element.focus({ preventScroll: true });
      element.scrollIntoView?.({ block: "nearest" });
    }
  }, [focusedItemId, visibleRows]);

  const visibleRowIndexById = useMemo(() => {
    const map = new Map<string, number>();
    for (let index = 0; index < visibleRows.length; index += 1) {
      map.set(visibleRows[index]!.item.id, index);
    }
    return map;
  }, [visibleRows]);

  const targetItemId = targetReference ? `session:${targetReference}` : null;
  const tabbableItemId =
    (focusedItemId && visibleRowIndexById.has(focusedItemId) ? focusedItemId : null) ??
    (targetItemId && visibleRowIndexById.has(targetItemId) ? targetItemId : null) ??
    visibleRows[0]?.item.id ??
    null;

  const first = Math.max(0, Math.min(scrollRow, visibleRows.length - 1) - TREE_OVERSCAN);
  const end = Math.min(
    visibleRows.length,
    first + Math.ceil(TREE_MAX_HEIGHT / TREE_ROW_STRIDE) + 2 * TREE_OVERSCAN,
  );
  const mounted = new Set<number>();
  for (let index = first; index < end; index++) mounted.add(index);
  for (const id of [tabbableItemId, targetItemId]) {
    const index = id == null ? undefined : visibleRowIndexById.get(id);
    if (index !== undefined) mounted.add(index);
  }

  const hasPendingSessionSelection =
    selectedSessionReference !== null && selectedSessionReference !== activeSessionReference;
  const openMenuSessionReference = menuSession ? getSessionReferenceKey(menuSession) : null;

  const handleRowKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>, row: VisibleTreeRow) => {
      if (
        (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) &&
        row.item.session
      ) {
        event.preventDefault();
        event.stopPropagation();
        openSessionMenu(
          row.item.session,
          event.currentTarget,
          event.target instanceof HTMLElement ? event.target : event.currentTarget,
          true,
        );
        return;
      }

      if (event.target !== event.currentTarget) return;
      const index = visibleRowIndexById.get(row.item.id);
      if (index === undefined) return;

      if (event.key === "ArrowDown") {
        const next = visibleRows[index + 1];
        if (!next) return;
        event.preventDefault();
        focusItem(next.item.id);
        return;
      }

      if (event.key === "ArrowUp") {
        const previous = visibleRows[index - 1];
        if (!previous) return;
        event.preventDefault();
        focusItem(previous.item.id);
        return;
      }

      if (event.key === "Home") {
        const first = visibleRows[0];
        if (!first) return;
        event.preventDefault();
        focusItem(first.item.id);
        return;
      }

      if (event.key === "End") {
        const last = visibleRows.at(-1);
        if (!last) return;
        event.preventDefault();
        focusItem(last.item.id);
        return;
      }

      if (event.key === "ArrowRight") {
        if (!row.hasChildren) return;
        event.preventDefault();
        if (!row.expanded) {
          setExpanded(row.item.id, true);
        } else if (row.item.children[0]) {
          focusItem(row.item.children[0].id);
        }
        return;
      }

      if (event.key === "ArrowLeft") {
        if (row.hasChildren && row.expanded) {
          event.preventDefault();
          setExpanded(row.item.id, false);
        } else if (row.parentId) {
          event.preventDefault();
          focusItem(row.parentId);
        }
        return;
      }

      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        if (row.item.session) {
          onSelectSession(row.item.session);
        } else if (row.hasChildren) {
          toggleExpanded(row.item.id);
        }
        return;
      }
    },
    [
      focusItem,
      onSelectSession,
      openSessionMenu,
      setExpanded,
      toggleExpanded,
      visibleRowIndexById,
      visibleRows,
    ],
  );

  return (
    <div
      role="tree"
      ref={treeRef}
      aria-label={t("Sessions")}
      className="session-tree h-[min(560px,calc(100vh-410px))] min-h-56 overflow-y-auto"
      onScroll={(event) =>
        setScrollRow(Math.floor(event.currentTarget.scrollTop / TREE_ROW_STRIDE))
      }
    >
      <div
        role="presentation"
        className="relative"
        style={{ height: visibleRows.length * TREE_ROW_STRIDE }}
      >
        {[...mounted]
          .sort((a, b) => a - b)
          .map((index) => {
            const row = visibleRows[index]!;
            const { item, level, hasChildren, expanded } = row;
            const isSession = item.kind === "session" && item.session !== undefined;
            const reference = item.sessionReference;
            const isActive = isSession && reference === activeSessionReference;
            const isSelected = isSession && reference === selectedSessionReference;
            const isHighlighted =
              (isActive && !hasPendingSessionSelection) ||
              (isSelected && (hasPendingSessionSelection || activeSessionReference === null));
            const isMenuOpen = isSession && reference === openMenuSessionReference;

            return (
              <div
                key={item.id}
                ref={(element) => registerRowRef(item.id, element)}
                role="treeitem"
                tabIndex={item.id === tabbableItemId ? 0 : -1}
                aria-level={level}
                aria-posinset={row.position}
                aria-setsize={row.siblingCount}
                aria-expanded={hasChildren ? expanded : undefined}
                aria-selected={isSession ? isHighlighted : undefined}
                aria-label={item.label}
                data-active={isActive ? "true" : undefined}
                data-selected={isSelected ? "true" : undefined}
                data-session-reference={reference}
                style={{
                  top: index * TREE_ROW_STRIDE,
                  height: TREE_ROW_STRIDE - 2,
                  paddingLeft: level > 1 ? (level - 1) * 12 + 4 : undefined,
                }}
                onFocus={() => setFocusedItemId(item.id)}
                onKeyDown={(event) => handleRowKeyDown(event, row)}
                onClick={() => {
                  if (item.session) onSelectSession(item.session);
                  else if (hasChildren) toggleExpanded(item.id);
                }}
                className={cn(
                  "group/tree-row motion-hover absolute inset-x-0 flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 text-xs select-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none",
                  isHighlighted
                    ? "bg-[var(--console-sidebar-accent)] font-medium text-[var(--console-text)]"
                    : "text-[var(--console-text-secondary)] hover:bg-[var(--console-sidebar-accent)]/60 hover:text-[var(--console-text)]",
                  isSelected &&
                    hasPendingSessionSelection &&
                    "ring-1 ring-[var(--brand)]/50 ring-inset",
                )}
              >
                {level > 1 ? (
                  <span
                    aria-hidden="true"
                    style={{ left: `${(level - 1) * 12 - 2}px` }}
                    className="pointer-events-none absolute top-0 bottom-0 w-px bg-[var(--console-border-strong)]"
                  />
                ) : null}

                {hasChildren ? (
                  isSession ? (
                    <button
                      type="button"
                      tabIndex={-1}
                      aria-label={t("Sub-sessions")}
                      aria-expanded={expanded}
                      onClick={(event) => {
                        event.stopPropagation();
                        toggleExpanded(item.id);
                      }}
                      className="inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-[var(--console-muted)] hover:bg-[var(--console-surface-muted)] hover:text-[var(--console-text)]"
                    >
                      <ChevronRight
                        aria-hidden="true"
                        className={cn(
                          "size-3 transition-transform duration-150",
                          expanded && "rotate-90",
                        )}
                      />
                    </button>
                  ) : (
                    <ChevronRight
                      aria-hidden="true"
                      className={cn(
                        "size-3 shrink-0 text-[var(--console-muted)] transition-transform duration-150",
                        expanded && "rotate-90",
                      )}
                    />
                  )
                ) : null}

                <span className="min-w-0 flex-1 truncate" title={item.label}>
                  {item.label}
                </span>

                {item.count !== undefined ? (
                  <span className="console-mono shrink-0 text-[10.5px] text-[var(--console-muted)]">
                    {item.count}
                  </span>
                ) : null}

                {isSession && item.session ? (
                  <button
                    type="button"
                    tabIndex={-1}
                    aria-label={t("Session options")}
                    aria-haspopup="menu"
                    aria-expanded={isMenuOpen}
                    onClick={(event) => {
                      event.stopPropagation();
                      openSessionMenu(
                        item.session!,
                        event.currentTarget,
                        event.currentTarget,
                        event.detail === 0,
                      );
                    }}
                    className={cn(
                      "motion-hover motion-press inline-flex size-5 shrink-0 items-center justify-center rounded-sm border border-transparent text-[var(--console-muted)] hover:border-[var(--console-border)] hover:bg-[var(--console-surface-muted)] hover:text-[var(--console-text)] focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:outline-none",
                      isMenuOpen || isActive || isSelected
                        ? "opacity-100"
                        : "opacity-0 group-focus-within/tree-row:opacity-100 group-hover/tree-row:opacity-100",
                    )}
                  >
                    <MoreHorizontal className="size-3.5" aria-hidden="true" />
                  </button>
                ) : null}
              </div>
            );
          })}
      </div>

      <Menu.Root
        open={menuSession !== null}
        onOpenChange={(open) => {
          if (!open) setMenuSession(null);
        }}
        modal={false}
      >
        <Menu.Portal>
          <Menu.Positioner
            anchor={menuAnchorRef}
            side="bottom"
            align="end"
            sideOffset={4}
            className="z-40"
          >
            <Menu.Popup
              onFocus={(event) => {
                if (menuKeyboardOpen.current && event.target === event.currentTarget) {
                  event.currentTarget.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
                }
              }}
              finalFocus={menuTriggerRef}
              className="motion-menu w-40 rounded-md border border-[var(--console-border)] bg-[var(--console-surface)] p-1 shadow-[var(--shadow-overlay)] focus-visible:outline-none"
            >
              {menuSession ? (
                <SessionActionMenuItems
                  bookmarked={bookmarkedSessionReferences.has(getSessionReferenceKey(menuSession))}
                  onCopyAsMarkdown={() => onCopySessionAsMarkdown(menuSession)}
                  onRename={() => onRenameSession(menuSession)}
                  onToggleBookmark={() => onToggleBookmark(menuSession)}
                />
              ) : null}
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    </div>
  );
});
