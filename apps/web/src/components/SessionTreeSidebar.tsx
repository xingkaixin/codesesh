import { Menu } from "@base-ui/react/menu";
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
import { getSessionDisplayTitle } from "../lib/session-title";
import { isRenderProfilerEnabled, recordRenderProfileEntry } from "./RenderProfiler";

interface SessionTreeSidebarProps {
  sessions: SessionHead[];
  activeSessionId: string | null;
  selectedSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  bookmarkedSessionIds: Set<string>;
  onToggleBookmark: (session: SessionHead) => void;
  onRenameSession: (session: SessionHead) => void;
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
    padding-inline: 6px 2px;
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

  [data-type='item'][data-item-type='file'] [data-truncate-marker] {
    display: none;
  }
`;

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
      key: `${identity.kind}:${identity.key}`,
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

export function buildSessionTreeModel(sessions: SessionHead[]): SessionTreeModel {
  const sortOrderByPath = new Map<string, number>();
  const pathBySessionId = new Map<string, string>();
  const groupPathBySessionId = new Map<string, string>();
  const sessionIdByPath = new Map<string, string>();
  const groupCountByPath = new Map<string, string>();
  const sessionByPath = new Map<string, SessionHead>();
  const usedPaths = new Set<string>();
  const paths: string[] = [];
  const groups = new Map<string, { label: string; sessions: SessionHead[]; maxTime: number }>();

  for (const session of sessions) {
    const { key, label } = getProjectGroup(session);
    const time = getSessionTime(session);
    const group = groups.get(key);
    if (group) {
      group.sessions.push(session);
      if (time > group.maxTime) group.maxTime = time;
    } else {
      groups.set(key, { label, sessions: [session], maxTime: time });
    }
  }

  const sortedGroups = [...groups.entries()].sort(([, a], [, b]) => {
    if (a.label === "(unknown)") return 1;
    if (b.label === "(unknown)") return -1;
    return b.maxTime - a.maxTime;
  });

  let order = 0;
  const usedGroupPaths = new Set<string>();
  for (const [, group] of sortedGroups) {
    const groupLeaf = sanitizeSegment(group.label);
    let groupPath = `${groupLeaf}/`;
    let groupSuffix = 2;
    while (usedGroupPaths.has(groupPath)) {
      groupPath = `${groupLeaf} (${groupSuffix})/`;
      groupSuffix += 1;
    }
    usedGroupPaths.add(groupPath);
    const bareGroupPath = groupPath.slice(0, -1);
    const titleCounts = new Map<string, number>();

    sortOrderByPath.set(groupPath, order);
    sortOrderByPath.set(bareGroupPath, order);
    order += 1;
    groupCountByPath.set(groupPath, `${group.sessions.length}`);
    groupCountByPath.set(bareGroupPath, `${group.sessions.length}`);
    for (const session of group.sessions) {
      const title = getSessionDisplayTitle(session);
      titleCounts.set(title, (titleCounts.get(title) ?? 0) + 1);
    }

    for (const session of group.sessions) {
      const title = getSessionDisplayTitle(session);
      const needsDisambiguation = (titleCounts.get(title) ?? 0) > 1;
      const leaf = needsDisambiguation
        ? `${sanitizeSegment(title)} #${session.id.slice(0, 8)}`
        : sanitizeSegment(title);
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
  activeSessionId,
  selectedSessionId,
  onSelectSession,
  bookmarkedSessionIds,
  onToggleBookmark,
  onRenameSession,
}: SessionTreeSidebarProps) {
  const [menuSession, setMenuSession] = useState<SessionHead | null>(null);
  const menuAnchorRef = useRef<HTMLElement | null>(null);
  const menuTriggerRef = useRef<HTMLElement | null>(null);
  const menuProxyTriggerRef = useRef<HTMLButtonElement>(null);
  const modelData = useMemo(
    () =>
      measureSessionTreeWork("SessionTreeSidebar:buildTreeModel", () =>
        buildSessionTreeModel(sessions),
      ),
    [sessions],
  );
  const sortOrderRef = useRef(modelData.sortOrderByPath);
  const sessionIdByPathRef = useRef(modelData.sessionIdByPath);
  const groupCountByPathRef = useRef(modelData.groupCountByPath);
  const sessionByPathRef = useRef(modelData.sessionByPath);
  const bookmarkedSessionIdsRef = useRef(bookmarkedSessionIds);
  const onSelectSessionRef = useRef(onSelectSession);
  const onToggleBookmarkRef = useRef(onToggleBookmark);
  const onRenameSessionRef = useRef(onRenameSession);
  const treeHostStyle: TreeHostStyle = {
    "--trees-bg-override": "transparent",
    "--trees-border-color-override": "var(--console-border)",
    "--trees-fg-override": "var(--console-text)",
    "--trees-fg-muted-override": "var(--console-muted)",
    "--trees-font-family-override":
      '"JetBrains Mono", "IBM Plex Mono", "SFMono-Regular", Menlo, Monaco, Consolas, monospace',
    "--trees-font-size-override": "12px",
    "--trees-item-margin-x-override": "0px",
    "--trees-item-padding-x-override": "4px",
    "--trees-padding-inline-override": "4px",
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
        return { text: "⋯", title: "Session options" };
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
  }, [bookmarkedSessionIds]);

  useEffect(() => {
    onToggleBookmarkRef.current = onToggleBookmark;
  }, [onToggleBookmark]);

  useEffect(() => {
    onRenameSessionRef.current = onRenameSession;
  }, [onRenameSession]);

  function openSessionMenu(session: SessionHead, anchor: HTMLElement, trigger: HTMLElement) {
    menuAnchorRef.current = anchor;
    menuTriggerRef.current = trigger;
    setMenuSession(session);
    // The tree row is the visual/focus trigger, but Base UI's roving-focus and
    // open-interaction tracking are wired to its own <Menu.Trigger>. Dispatching
    // ArrowDown at the hidden proxy trigger opens the menu through that wiring so
    // the first item is focused, matching native menu keyboard behavior.
    menuProxyTriggerRef.current?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
    );
  }

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

    if (!decoration || !item || !session) return;
    event.preventDefault();
    event.stopPropagation();
    openSessionMenu(session, decoration, item);
  }

  function handleTreeKeyDownCapture(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;

    const path = event.nativeEvent.composedPath();
    const item = path.find(
      (target): target is HTMLElement =>
        target instanceof HTMLElement && target.getAttribute("data-type") === "item",
    );
    const session = item
      ? sessionByPathRef.current.get(item.getAttribute("data-item-path") ?? "")
      : null;
    if (!item || !session) return;

    event.preventDefault();
    event.stopPropagation();
    const anchor =
      item.querySelector<HTMLElement>("[data-item-section='decoration'] > span") ?? item;
    openSessionMenu(session, anchor, item);
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
              className="motion-menu w-36 rounded-sm border border-[var(--console-border-strong)] bg-[var(--console-surface)] p-1 shadow-lg focus-visible:outline-none"
            >
              {menuSession ? (
                <>
                  <Menu.Item
                    onClick={() => onRenameSessionRef.current(menuSession)}
                    className="motion-hover motion-press block w-full rounded-sm px-2 py-1.5 text-left text-xs text-[var(--console-text)] hover:bg-[var(--console-surface-muted)] data-[highlighted]:bg-[var(--console-surface-muted)] focus-visible:outline-none"
                  >
                    Rename
                  </Menu.Item>
                  <Menu.Item
                    onClick={() => onToggleBookmarkRef.current(menuSession)}
                    className="motion-hover motion-press block w-full rounded-sm px-2 py-1.5 text-left text-xs text-[var(--console-text)] hover:bg-[var(--console-surface-muted)] data-[highlighted]:bg-[var(--console-surface-muted)] focus-visible:outline-none"
                  >
                    {bookmarkedSessionIdsRef.current.has(menuSession.id)
                      ? "Remove bookmark"
                      : "Add bookmark"}
                  </Menu.Item>
                </>
              ) : null}
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    </div>
  );
});
