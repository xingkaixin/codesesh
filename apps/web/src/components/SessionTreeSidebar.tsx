import type { FileTreeSortEntry } from "@pierre/trees";
import { FileTree, useFileTree } from "@pierre/trees/react";
import { useEffect, useMemo, useRef, type CSSProperties, type MouseEvent } from "react";
import type { SessionHead } from "../lib/api";

interface SessionTreeSidebarProps {
  sessions: SessionHead[];
  activeSessionId: string | null;
  selectedSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  bookmarkedSessionIds: Set<string>;
  onToggleBookmark: (session: SessionHead) => void;
}

interface SessionTreeModel {
  paths: string[];
  sortOrderByPath: Map<string, number>;
  pathBySessionId: Map<string, string>;
  groupPathBySessionId: Map<string, string>;
  sessionIdByPath: Map<string, string>;
  groupCountByPath: Map<string, string>;
  sessionByPath: Map<string, SessionHead>;
}

type TreeHostStyle = CSSProperties & Record<`--${string}`, string>;

const SESSION_TREE_CSS = `
  [data-type='item'][data-item-type='file'] > [data-item-section='icon'] {
    display: none;
  }

  [data-type='item'][data-item-type='file'] > [data-item-section='spacing'] {
    padding-left: 2px;
  }

  [data-type='item'][data-item-type='file'] > [data-item-section='spacing'] > [data-item-section='spacing-item'] {
    margin-right: 4px;
  }

  [data-type='item'][data-item-type='file'] > [data-item-section='content'] {
    flex: 1 1 auto;
  }

  [data-type='item'][data-item-type='file'] > [data-item-section='decoration'] {
    flex: 0 0 auto;
    padding-inline: 8px 6px;
  }

  [data-type='item'][data-item-type='file'] > [data-item-section='decoration'] > span {
    cursor: pointer;
    font-size: 18px;
    line-height: 1;
  }

  [data-type='item'][data-item-type='file'] [data-truncate-group-container='middle'] {
    width: 100%;
  }

  [data-type='item'][data-item-type='file']
    [data-truncate-group-container='middle']
    > div[data-truncate-segment-priority='2'] {
    flex: 0 1 auto;
  }

  [data-type='item'][data-item-type='file']
    [data-truncate-group-container='middle']
    > div[data-truncate-segment-priority='1'] {
    flex: 1 999999 auto;
  }

  [data-type='item'][data-item-type='file']
    [data-truncate-group-container='middle']
    [data-truncate-container='fruncate']
    [data-truncate-grid] {
    grid-template-columns: minmax(0, max-content) 0;
  }

  [data-type='item'][data-item-type='file']
    [data-truncate-group-container='middle']
    [data-truncate-container='fruncate']
    [data-truncate-content] {
    direction: ltr;
  }

  [data-type='item'][data-item-type='file']
    [data-truncate-group-container='middle']
    [data-truncate-container='fruncate']
    [data-truncate-marker] {
    right: 0;
  }
`;

function sanitizeSegment(value: string) {
  return value.replaceAll("/", "∕").trim() || "(untitled)";
}

function getDirectoryLabel(directory: string) {
  return directory.replace(/\/+$/, "").split("/").at(-1)?.trim() || "(unknown)";
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

function buildSessionTreeModel(sessions: SessionHead[]): SessionTreeModel {
  const sortOrderByPath = new Map<string, number>();
  const pathBySessionId = new Map<string, string>();
  const groupPathBySessionId = new Map<string, string>();
  const sessionIdByPath = new Map<string, string>();
  const groupCountByPath = new Map<string, string>();
  const sessionByPath = new Map<string, SessionHead>();
  const usedPaths = new Set<string>();
  const paths: string[] = [];
  const groups = new Map<string, { label: string; sessions: SessionHead[] }>();

  for (const session of sessions) {
    const label = getDirectoryLabel(session.directory);
    const key = label === "(unknown)" ? "__unknown__" : label;
    const group = groups.get(key);
    if (group) {
      group.sessions.push(session);
    } else {
      groups.set(key, { label, sessions: [session] });
    }
  }

  const sortedGroups = [...groups.entries()].sort(([, a], [, b]) => {
    if (a.label === "(unknown)") return 1;
    if (b.label === "(unknown)") return -1;
    const aTime = Math.max(...a.sessions.map(getSessionTime));
    const bTime = Math.max(...b.sessions.map(getSessionTime));
    return bTime - aTime;
  });

  let order = 0;
  for (const [groupKey, group] of sortedGroups) {
    const groupPath = `${sanitizeSegment(group.label)}/`;
    const bareGroupPath = groupPath.slice(0, -1);
    const titleCounts = new Map<string, number>();

    sortOrderByPath.set(groupPath, order);
    sortOrderByPath.set(bareGroupPath, order);
    order += 1;
    groupCountByPath.set(groupPath, `${group.sessions.length}`);
    groupCountByPath.set(bareGroupPath, `${group.sessions.length}`);
    for (const session of group.sessions) {
      titleCounts.set(session.title, (titleCounts.get(session.title) ?? 0) + 1);
    }

    for (const session of group.sessions) {
      const needsDisambiguation = (titleCounts.get(session.title) ?? 0) > 1;
      const leaf = needsDisambiguation
        ? `${sanitizeSegment(session.title)} #${session.id.slice(0, 8)}`
        : sanitizeSegment(session.title);
      let path = `${groupPath}${leaf}`;
      let suffix = 2;
      while (usedPaths.has(path)) {
        path = `${groupPath}${leaf} (${suffix})`;
        suffix += 1;
      }

      usedPaths.add(path);
      paths.push(path);
      sortOrderByPath.set(path, order);
      order += 1;
      pathBySessionId.set(session.id, path);
      groupPathBySessionId.set(session.id, groupPath);
      sessionIdByPath.set(path, session.id);
      sessionByPath.set(path, session);
    }
    if (groupKey === "__unknown__") groupCountByPath.set("(unknown)", `${group.sessions.length}`);
  }

  return {
    paths,
    sortOrderByPath,
    pathBySessionId,
    groupPathBySessionId,
    sessionIdByPath,
    groupCountByPath,
    sessionByPath,
  };
}

export function SessionTreeSidebar({
  sessions,
  activeSessionId,
  selectedSessionId,
  onSelectSession,
  bookmarkedSessionIds,
  onToggleBookmark,
}: SessionTreeSidebarProps) {
  const modelData = useMemo(() => buildSessionTreeModel(sessions), [sessions]);
  const sortOrderRef = useRef(modelData.sortOrderByPath);
  const sessionIdByPathRef = useRef(modelData.sessionIdByPath);
  const groupCountByPathRef = useRef(modelData.groupCountByPath);
  const sessionByPathRef = useRef(modelData.sessionByPath);
  const bookmarkedSessionIdsRef = useRef(bookmarkedSessionIds);
  const onSelectSessionRef = useRef(onSelectSession);
  const onToggleBookmarkRef = useRef(onToggleBookmark);
  const treeHostStyle: TreeHostStyle = {
    "--trees-bg-override": "transparent",
    "--trees-border-color-override": "var(--console-border)",
    "--trees-fg-override": "var(--console-text)",
    "--trees-fg-muted-override": "var(--console-muted)",
    "--trees-font-family-override":
      '"JetBrains Mono", "IBM Plex Mono", "SFMono-Regular", Menlo, Monaco, Consolas, monospace',
    "--trees-font-size-override": "12px",
    "--trees-item-margin-x-override": "0px",
    "--trees-item-padding-x-override": "8px",
    "--trees-selected-bg-override": "var(--console-surface-muted)",
  };
  const { model } = useFileTree({
    flattenEmptyDirectories: false,
    initialExpansion: "closed",
    paths: modelData.paths,
    sort: (left, right) => compareTreeOrder(sortOrderRef.current, left, right),
    density: "compact",
    unsafeCSS: SESSION_TREE_CSS,
    onSelectionChange(paths) {
      const sessionId = sessionIdByPathRef.current.get(paths[0] ?? "");
      if (sessionId) onSelectSessionRef.current(sessionId);
    },
    renderRowDecoration({ item }) {
      const session = sessionByPathRef.current.get(item.path);
      if (session) {
        const active = bookmarkedSessionIdsRef.current.has(session.id);
        return { text: active ? "★" : "☆", title: active ? "Remove bookmark" : "Add bookmark" };
      }
      return groupCountByPathRef.current.get(item.path)
        ? { text: groupCountByPathRef.current.get(item.path)!, title: "Sessions" }
        : null;
    },
  });

  useEffect(() => {
    sortOrderRef.current = modelData.sortOrderByPath;
    sessionIdByPathRef.current = modelData.sessionIdByPath;
    groupCountByPathRef.current = modelData.groupCountByPath;
    sessionByPathRef.current = modelData.sessionByPath;
    model.resetPaths(modelData.paths);
  }, [model, modelData]);

  useEffect(() => {
    onSelectSessionRef.current = onSelectSession;
  }, [onSelectSession]);

  useEffect(() => {
    bookmarkedSessionIdsRef.current = bookmarkedSessionIds;
    model.resetPaths(modelData.paths);
  }, [bookmarkedSessionIds, model, modelData.paths]);

  useEffect(() => {
    onToggleBookmarkRef.current = onToggleBookmark;
  }, [onToggleBookmark]);

  function handleTreeClickCapture(event: MouseEvent<HTMLDivElement>) {
    const path = event.nativeEvent.composedPath();
    const decoration = path.find(
      (target): target is HTMLElement =>
        target instanceof HTMLElement &&
        target.parentElement?.getAttribute("data-item-section") === "decoration",
    );
    const item = path.find(
      (target): target is HTMLElement =>
        target instanceof HTMLElement && target.getAttribute("data-type") === "item",
    );
    const session = item
      ? sessionByPathRef.current.get(item.getAttribute("data-item-path") ?? "")
      : null;

    if (!decoration || !session) return;
    event.preventDefault();
    event.stopPropagation();
    onToggleBookmarkRef.current(session);
  }

  useEffect(() => {
    const activePath = modelData.pathBySessionId.get(activeSessionId ?? "");
    const selectedPath = modelData.pathBySessionId.get(selectedSessionId ?? "");
    const focusedPath = selectedPath ?? activePath;
    const focusedSessionId = selectedSessionId ?? activeSessionId ?? "";
    const focusedGroupPath = modelData.groupPathBySessionId.get(focusedSessionId);

    if (activePath) model.getItem(activePath)?.select();
    if (focusedPath && activeSessionId) {
      const focusedGroup = focusedGroupPath ? model.getItem(focusedGroupPath) : null;
      if (focusedGroup && "expand" in focusedGroup) focusedGroup.expand();
      model.focusPath(focusedPath);
      return;
    }
    if (focusedGroupPath) model.focusPath(focusedGroupPath);
  }, [activeSessionId, model, modelData, selectedSessionId]);

  return (
    <div
      className="session-tree h-[min(560px,calc(100vh-410px))] min-h-56 overflow-hidden"
      style={treeHostStyle}
      onClickCapture={handleTreeClickCapture}
    >
      <FileTree model={model} style={{ height: "100%" }} aria-label="Sessions" />
    </div>
  );
}
