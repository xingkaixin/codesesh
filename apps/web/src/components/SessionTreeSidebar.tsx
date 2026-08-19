import { Menu } from "@base-ui/react/menu";
import { buildSessionTree, type SessionTreeNode } from "@codesesh/core/contract";
import type { FileTreeSortEntry } from "@pierre/trees";
import { FileTree, useFileTree } from "@pierre/trees/react";
import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent,
} from "react";
import type { SessionHead } from "../lib/api";
import { getProjectIdentityKey } from "../lib/projects";
import { getSessionReferenceKey } from "../lib/session-indexes";
import { getSessionDisplayTitle } from "../lib/session-title";
import { isRenderProfilerEnabled, recordRenderProfileEntry } from "./RenderProfiler";
import { SessionActionMenuItems } from "./SessionActionsMenu";
import {
  getSessionTreeMenuTarget,
  installSessionTreeDomAdapter,
  openSessionTreeMenu,
  SESSION_TREE_UNSAFE_CSS,
} from "./session-tree-adapter";

interface SessionTreeSidebarProps {
  sessions: SessionHead[];
  activeSessionReference: string | null;
  selectedSessionReference: string | null;
  onSelectSession: (session: SessionHead) => void;
  bookmarkedSessionReferences: Set<string>;
  onToggleBookmark: (session: SessionHead) => void;
  onRenameSession: (session: SessionHead) => void;
  /** False when the listing already covers one project. */
  groupByProject?: boolean;
}

interface SessionTreeModel {
  paths: string[];
  sortOrderByPath: Map<string, number>;
  pathBySessionReference: Map<string, string>;
  groupPathBySessionReference: Map<string, string>;
  groupCountByPath: Map<string, string>;
  sessionByPath: Map<string, SessionHead>;
}

interface PendingSessionTreeNode {
  node: SessionTreeNode;
  parentPath: string;
  siblingTitleCounts: Map<string, number>;
  depth: number;
  flattened: boolean;
}

type TreeHostStyle = CSSProperties & Record<`--${string}`, string>;

function sanitizeSegment(value: string) {
  return value.replaceAll("/", "∕").trim() || "(untitled)";
}

function getDirectoryLabel(directory: string) {
  return directory.replace(/\/+$/, "").split("/").at(-1)?.trim() || "(unknown)";
}

function getProjectGroup(session: SessionHead) {
  const identity = session.project_identity;
  if (identity) {
    return {
      key: getProjectIdentityKey(identity),
      label: identity.displayName || getDirectoryLabel(session.directory),
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

function compareTreeOrder(
  sortOrderByPath: Map<string, number>,
  left: FileTreeSortEntry,
  right: FileTreeSortEntry,
) {
  const leftOrder = sortOrderByPath.get(left.path) ?? Number.MAX_SAFE_INTEGER;
  const rightOrder = sortOrderByPath.get(right.path) ?? Number.MAX_SAFE_INTEGER;
  if (leftOrder !== rightOrder) return leftOrder - rightOrder;
  return left.path.localeCompare(right.path);
}

/**
 * Hands out unique paths for repeated labels. Each base resumes its suffix
 * search where the last collision left off, so a run of N identical labels
 * costs O(N) probes instead of O(N²).
 */
function createPathAllocator() {
  const used = new Set<string>();
  const nextSuffix = new Map<string, number>();

  return function allocate(base: string): string {
    if (!used.has(base)) {
      used.add(base);
      return base;
    }

    let suffix = nextSuffix.get(base) ?? 2;
    let path = `${base} (${suffix})`;
    // A distinct base may already own this exact numbered label.
    while (used.has(path)) {
      suffix += 1;
      path = `${base} (${suffix})`;
    }
    nextSuffix.set(base, suffix + 1);
    used.add(path);
    return path;
  };
}

/** Sessions the canonical hierarchy cannot mount still need a visible axis. */
const UNMOUNTED_GROUP_LABEL = "Unmounted";
const DEEP_SESSION_GROUP_LABEL = "Deeper sessions";
/** FileTree keys contain every ancestor, so unbounded nesting would retain quadratic text. */
export const MAX_SESSION_TREE_NESTING = 32;

/**
 * `groupByProject: false` drops the project layer, for listings that already
 * cover exactly one project — a lone group node there carries no information.
 * Orphans keep their own group either way, because that one does.
 */
export function buildSessionTreeModel(
  sessions: SessionHead[],
  { groupByProject = true }: { groupByProject?: boolean } = {},
): SessionTreeModel {
  const sortOrderByPath = new Map<string, number>();
  const pathBySessionReference = new Map<string, string>();
  const groupPathBySessionReference = new Map<string, string>();
  const groupCountByPath = new Map<string, string>();
  const sessionByPath = new Map<string, SessionHead>();
  const allocateSessionPath = createPathAllocator();
  const paths: string[] = [];
  const tree = buildSessionTree(sessions);
  const groups = new Map<string, { label: string; nodes: SessionTreeNode[]; maxTime: number }>();

  for (const node of tree.roots) {
    const session = node.session;
    const { key, label } = getProjectGroup(session);
    const time = getSessionTime(session);
    const group = groups.get(key);
    if (group) {
      group.nodes.push(node);
      if (time > group.maxTime) group.maxTime = time;
    } else {
      groups.set(key, { label, nodes: [node], maxTime: time });
    }
  }

  const orderedGroups: Array<{ label: string | null; nodes: SessionTreeNode[] }> = groupByProject
    ? [...groups.values()].sort((a, b) => {
        if (a.label === "(unknown)") return 1;
        if (b.label === "(unknown)") return -1;
        return b.maxTime - a.maxTime;
      })
    : [{ label: null, nodes: tree.roots }];
  if (tree.orphans.length > 0) {
    orderedGroups.push({ label: UNMOUNTED_GROUP_LABEL, nodes: tree.orphans });
  }

  let order = 0;
  const allocateGroupPath = createPathAllocator();
  for (const group of orderedGroups) {
    let groupPath = "";
    if (group.label !== null) {
      const bareGroupPath = allocateGroupPath(sanitizeSegment(group.label));
      groupPath = `${bareGroupPath}/`;
      sortOrderByPath.set(groupPath, order);
      sortOrderByPath.set(bareGroupPath, order);
      order += 1;
      groupCountByPath.set(groupPath, `${group.nodes.length}`);
      groupCountByPath.set(bareGroupPath, `${group.nodes.length}`);
    }

    const rootTitleCounts = new Map<string, number>();
    const pending: PendingSessionTreeNode[] = [];
    for (let index = group.nodes.length - 1; index >= 0; index -= 1) {
      pending.push({
        node: group.nodes[index]!,
        parentPath: groupPath,
        siblingTitleCounts: rootTitleCounts,
        depth: 0,
        flattened: false,
      });
    }

    while (pending.length > 0) {
      const frame = pending.pop()!;
      const { node, parentPath, siblingTitleCounts } = frame;
      const session = node.session;
      const title = getSessionDisplayTitle(session);
      siblingTitleCounts.set(title, (siblingTitleCounts.get(title) ?? 0) + 1);
      const siblingCount = siblingTitleCounts.get(title) ?? 1;
      const leaf =
        siblingCount > 1
          ? `${sanitizeSegment(title)} #${session.reference.sessionId.slice(0, 8)}`
          : sanitizeSegment(title);
      const basePath = allocateSessionPath(`${parentPath}${leaf}`);
      const reference = getSessionReferenceKey(session);
      const isDirectory = !frame.flattened && node.children.length > 0;
      const sessionPath = isDirectory ? `${basePath}/` : basePath;

      if (isDirectory) {
        sortOrderByPath.set(basePath, order);
        sortOrderByPath.set(sessionPath, order);
        sessionByPath.set(basePath, session);
        sessionByPath.set(sessionPath, session);
      } else {
        paths.push(basePath);
        sortOrderByPath.set(basePath, order);
        sessionByPath.set(basePath, session);
      }
      order += 1;
      pathBySessionReference.set(reference, sessionPath);
      groupPathBySessionReference.set(reference, groupPath);

      if (node.children.length === 0) continue;

      if (frame.flattened) {
        for (let index = node.children.length - 1; index >= 0; index -= 1) {
          pending.push({
            node: node.children[index]!,
            parentPath,
            siblingTitleCounts,
            depth: frame.depth,
            flattened: true,
          });
        }
        continue;
      }

      const childTitleCounts = new Map<string, number>();
      if (frame.depth + 1 < MAX_SESSION_TREE_NESTING) {
        for (let index = node.children.length - 1; index >= 0; index -= 1) {
          pending.push({
            node: node.children[index]!,
            parentPath: sessionPath,
            siblingTitleCounts: childTitleCounts,
            depth: frame.depth + 1,
            flattened: false,
          });
        }
        continue;
      }

      const overflowBasePath = allocateSessionPath(`${sessionPath}${DEEP_SESSION_GROUP_LABEL}`);
      const overflowPath = `${overflowBasePath}/`;
      sortOrderByPath.set(overflowBasePath, order);
      sortOrderByPath.set(overflowPath, order);
      groupCountByPath.set(overflowBasePath, `${node.descendantCount}`);
      groupCountByPath.set(overflowPath, `${node.descendantCount}`);
      order += 1;
      for (let index = node.children.length - 1; index >= 0; index -= 1) {
        pending.push({
          node: node.children[index]!,
          parentPath: overflowPath,
          siblingTitleCounts: childTitleCounts,
          depth: frame.depth + 1,
          flattened: true,
        });
      }
    }
  }

  return {
    paths,
    sortOrderByPath,
    pathBySessionReference,
    groupPathBySessionReference,
    groupCountByPath,
    sessionByPath,
  };
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

export const SessionTreeSidebar = memo(function SessionTreeSidebar({
  sessions,
  activeSessionReference,
  selectedSessionReference,
  onSelectSession,
  bookmarkedSessionReferences,
  onToggleBookmark,
  onRenameSession,
  groupByProject = true,
}: SessionTreeSidebarProps) {
  const [menuSession, setMenuSession] = useState<SessionHead | null>(null);
  const menuAnchorRef = useRef<HTMLElement | null>(null);
  const menuTriggerRef = useRef<HTMLElement | null>(null);
  const menuProxyTriggerRef = useRef<HTMLButtonElement>(null);
  const modelData = useMemo(
    () =>
      measureSessionTreeWork("SessionTreeSidebar:buildTreeModel", () =>
        buildSessionTreeModel(sessions, { groupByProject }),
      ),
    [sessions, groupByProject],
  );
  const sortOrderRef = useRef(modelData.sortOrderByPath);
  const groupCountByPathRef = useRef(modelData.groupCountByPath);
  const sessionByPathRef = useRef(modelData.sessionByPath);
  const onSelectSessionRef = useRef(onSelectSession);
  const onToggleBookmarkRef = useRef(onToggleBookmark);
  const onRenameSessionRef = useRef(onRenameSession);
  const syncingActiveSelectionRef = useRef(false);
  const hasPendingSessionSelection =
    selectedSessionReference !== null && selectedSessionReference !== activeSessionReference;
  const treeHostStyle: TreeHostStyle = {
    "--trees-bg-override": "transparent",
    "--trees-border-color-override": "var(--console-border)",
    "--trees-fg-override": "var(--console-text)",
    "--trees-fg-muted-override": "var(--console-muted)",
    "--trees-font-family-override": "var(--font-mono)",
    "--trees-font-size-override": "12px",
    "--trees-item-margin-x-override": "0px",
    "--trees-item-padding-x-override": "4px",
    "--trees-padding-inline-override": "4px",
    "--trees-selected-bg-override": hasPendingSessionSelection
      ? "transparent"
      : "var(--brand-soft)",
  };
  // Keep composition unset; @pierre/trees renders it with innerHTML, so session-derived HTML is unsafe.
  const { model } = useFileTree({
    flattenEmptyDirectories: false,
    initialExpansion: "closed",
    paths: modelData.paths,
    sort: (left, right) => compareTreeOrder(sortOrderRef.current, left, right),
    density: "compact",
    unsafeCSS: SESSION_TREE_UNSAFE_CSS,
    onSelectionChange(paths) {
      if (syncingActiveSelectionRef.current) return;
      const session = sessionByPathRef.current.get(paths[0] ?? "");
      if (session) onSelectSessionRef.current(session);
    },
    renderRowDecoration({ item }) {
      const session = sessionByPathRef.current.get(item.path);
      if (session) {
        return { text: "⋯", title: "Session options" };
      }
      return groupCountByPathRef.current.get(item.path)
        ? { text: groupCountByPathRef.current.get(item.path)!, title: "Sessions" }
        : null;
    },
  });

  useEffect(() => {
    sortOrderRef.current = modelData.sortOrderByPath;
    groupCountByPathRef.current = modelData.groupCountByPath;
    sessionByPathRef.current = modelData.sessionByPath;
    model.resetPaths(modelData.paths);
  }, [model, modelData]);

  useEffect(() => {
    onSelectSessionRef.current = onSelectSession;
  }, [onSelectSession]);

  useEffect(() => {
    onToggleBookmarkRef.current = onToggleBookmark;
  }, [onToggleBookmark]);

  useEffect(() => {
    onRenameSessionRef.current = onRenameSession;
  }, [onRenameSession]);

  useEffect(() => {
    let cleanup: (() => void) | undefined;
    let frame = 0;

    const install = () => {
      const host = model.getFileTreeContainer();
      if (!host) {
        frame = requestAnimationFrame(install);
        return;
      }
      cleanup = installSessionTreeDomAdapter(host);
    };

    install();
    return () => {
      if (frame) cancelAnimationFrame(frame);
      cleanup?.();
    };
  }, [model]);

  function openSessionMenu(session: SessionHead, anchor: HTMLElement, trigger: HTMLElement) {
    menuAnchorRef.current = anchor;
    menuTriggerRef.current = trigger;
    setMenuSession(session);
    openSessionTreeMenu(menuProxyTriggerRef.current);
  }

  function handleTreeClickCapture(event: MouseEvent<HTMLDivElement>) {
    const target = getSessionTreeMenuTarget(event.nativeEvent, { requireDecoration: true });
    const session = target ? sessionByPathRef.current.get(target.path) : null;
    if (!target || !session) return;
    event.preventDefault();
    event.stopPropagation();
    openSessionMenu(session, target.anchor, target.item);
  }

  function handleTreeKeyDownCapture(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;

    const target = getSessionTreeMenuTarget(event.nativeEvent, { requireDecoration: false });
    const session = target ? sessionByPathRef.current.get(target.path) : null;
    if (!target || !session) return;

    event.preventDefault();
    event.stopPropagation();
    openSessionMenu(session, target.anchor, target.item);
  }

  useEffect(() => {
    const activePath = modelData.pathBySessionReference.get(activeSessionReference ?? "");
    const selectedPath = modelData.pathBySessionReference.get(selectedSessionReference ?? "");
    const focusedPath = selectedPath ?? activePath;
    const focusedSessionReference = selectedSessionReference ?? activeSessionReference ?? "";
    const focusedGroupPath = modelData.groupPathBySessionReference.get(focusedSessionReference);

    syncingActiveSelectionRef.current = true;
    try {
      for (const path of model.getSelectedPaths()) {
        if (path !== activePath) model.getItem(path)?.deselect();
      }
      if (activePath && !model.getSelectedPaths().includes(activePath)) {
        model.getItem(activePath)?.select();
      }
    } finally {
      syncingActiveSelectionRef.current = false;
    }
    if (focusedPath && activeSessionReference) {
      const segments = focusedPath.split("/").filter(Boolean);
      for (let index = 1; index <= segments.length; index += 1) {
        const ancestorPath = `${segments.slice(0, index).join("/")}/`;
        const ancestor = model.getItem(ancestorPath);
        if (ancestor && "expand" in ancestor) ancestor.expand();
      }
      const focusedGroup = focusedGroupPath ? model.getItem(focusedGroupPath) : null;
      if (focusedGroup && "expand" in focusedGroup) focusedGroup.expand();
      model.focusPath(focusedPath);
      return;
    }
    if (focusedGroupPath) model.focusPath(focusedGroupPath);
  }, [activeSessionReference, model, modelData, selectedSessionReference]);

  return (
    <div
      className="session-tree h-[min(560px,calc(100vh-410px))] min-h-56 overflow-hidden"
      style={treeHostStyle}
      onClickCapture={handleTreeClickCapture}
      onKeyDownCapture={handleTreeKeyDownCapture}
    >
      <FileTree model={model} style={{ height: "100%" }} aria-label="Sessions" />
      <Menu.Root modal={false}>
        <Menu.Trigger
          ref={menuProxyTriggerRef}
          tabIndex={-1}
          aria-hidden="true"
          className="pointer-events-none absolute size-0 opacity-0"
        />
        <Menu.Portal>
          <Menu.Positioner
            anchor={menuAnchorRef}
            side="bottom"
            align="end"
            sideOffset={4}
            className="z-40"
          >
            <Menu.Popup
              finalFocus={menuTriggerRef}
              className="motion-menu w-36 rounded-md border border-[var(--console-border)] bg-[var(--console-surface)] p-1 shadow-[var(--shadow-overlay)] focus-visible:outline-none"
            >
              {menuSession ? (
                <SessionActionMenuItems
                  // Read the prop directly: a ref read during render lags one
                  // update behind, leaving an open menu with a stale label.
                  bookmarked={bookmarkedSessionReferences.has(getSessionReferenceKey(menuSession))}
                  onRename={() => onRenameSessionRef.current(menuSession)}
                  onToggleBookmark={() => onToggleBookmarkRef.current(menuSession)}
                />
              ) : null}
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    </div>
  );
});
