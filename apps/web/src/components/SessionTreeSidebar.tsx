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
import { getProjectIdentityKey } from "../lib/projects";
import { getSessionReferenceKey, getSessionRouteKey } from "../lib/session-indexes";
import { getSessionDisplayTitle } from "../lib/session-title";
import { isRenderProfilerEnabled, recordRenderProfileEntry } from "./RenderProfiler";

interface SessionTreeSidebarProps {
  sessions: SessionHead[];
  activeSessionReference: string | null;
  selectedSessionReference: string | null;
  onSelectSession: (session: SessionHead) => void;
  bookmarkedSessionReferences: Set<string>;
  onToggleBookmark: (session: SessionHead) => void;
  onRenameSession: (session: SessionHead) => void;
}

interface SessionTreeModel {
  paths: string[];
  sortOrderByPath: Map<string, number>;
  pathBySessionReference: Map<string, string>;
  groupPathBySessionReference: Map<string, string>;
  groupCountByPath: Map<string, string>;
  sessionByPath: Map<string, SessionHead>;
}

type TreeHostStyle = CSSProperties & Record<`--${string}`, string>;

const SESSION_TREE_CSS = `
  [data-item-section='spacing-item'] {
    border-left: none;
  }

  [data-type='item'][data-item-type='file'] > [data-item-section='icon'] {
    display: none;
  }

  [data-type='item'][data-item-type='file'] > [data-item-section='spacing'] {
    padding-left: 2px;
  }

  [data-type='item'][data-item-type='file'] > [data-item-section='spacing'] > [data-item-section='spacing-item'] {
    margin-right: 4px;
  }

  [data-type='item'][data-item-parent-path][data-item-type='folder'] > [data-item-section='spacing'] {
    padding-left: 2px;
  }

  [data-type='item'][data-item-parent-path][data-item-type='folder']
    > [data-item-section='spacing']
    > [data-item-section='spacing-item'] {
    margin-right: 4px;
  }

  [data-type='item'][data-item-parent-path][data-item-type='folder'] > [data-item-section='icon'] {
    flex: 0 0 8px;
    width: 8px;
    margin-left: calc(-1 * (8px + var(--trees-item-row-gap)));
  }

  [data-type='item'][data-item-parent-path][data-item-type='folder']
    > [data-item-section='icon']
    > svg {
    width: 8px;
    height: 8px;
  }

  [data-type='item'][data-item-type='file'] > [data-item-section='content'] {
    flex: 1 1 auto;
  }

  [data-type='item'][data-item-type='file'] > [data-item-section='decoration'] {
    flex: 1 1 0;
    padding: 0;
  }

  [data-type='item'][data-item-type='file'] > [data-item-section='decoration'] > span {
    cursor: pointer;
    font-size: 12px;
    line-height: 24px;
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

export function buildSessionTreeModel(sessions: SessionHead[]): SessionTreeModel {
  const sortOrderByPath = new Map<string, number>();
  const pathBySessionReference = new Map<string, string>();
  const groupPathBySessionReference = new Map<string, string>();
  const groupCountByPath = new Map<string, string>();
  const sessionByPath = new Map<string, SessionHead>();
  const allocateSessionPath = createPathAllocator();
  const paths: string[] = [];
  const childrenByParent = new Map<string, SessionHead[]>();
  const roots: SessionHead[] = [];
  for (const session of sessions) {
    const parentReference = session.parent_reference;
    if (!parentReference) {
      roots.push(session);
      continue;
    }
    const parentKey = getSessionRouteKey(parentReference.agentName, parentReference.sessionId);
    const children = childrenByParent.get(parentKey);
    if (children) children.push(session);
    else childrenByParent.set(parentKey, [session]);
  }

  const groups = new Map<string, { label: string; sessions: SessionHead[]; maxTime: number }>();

  for (const session of roots) {
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
  const allocateGroupPath = createPathAllocator();
  for (const [, group] of sortedGroups) {
    const bareGroupPath = allocateGroupPath(sanitizeSegment(group.label));
    const groupPath = `${bareGroupPath}/`;
    sortOrderByPath.set(groupPath, order);
    sortOrderByPath.set(bareGroupPath, order);
    order += 1;
    groupCountByPath.set(groupPath, `${group.sessions.length}`);
    groupCountByPath.set(bareGroupPath, `${group.sessions.length}`);

    const appendSession = (
      session: SessionHead,
      parentPath: string,
      siblingTitleCounts: Map<string, number>,
    ): void => {
      const title = getSessionDisplayTitle(session);
      siblingTitleCounts.set(title, (siblingTitleCounts.get(title) ?? 0) + 1);
      const siblingCount = siblingTitleCounts.get(title) ?? 1;
      const leaf =
        siblingCount > 1
          ? `${sanitizeSegment(title)} #${session.id.slice(0, 8)}`
          : sanitizeSegment(title);
      const basePath = allocateSessionPath(`${parentPath}${leaf}`);
      const reference = getSessionReferenceKey(session);
      const childSessions = childrenByParent.get(reference) ?? [];
      const isDirectory = childSessions.length > 0;
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

      const childTitleCounts = new Map<string, number>();
      for (const child of childSessions) {
        appendSession(child, sessionPath, childTitleCounts);
      }
    };

    const rootTitleCounts = new Map<string, number>();
    for (const session of group.sessions) {
      appendSession(session, groupPath, rootTitleCounts);
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
  const groupCountByPathRef = useRef(modelData.groupCountByPath);
  const sessionByPathRef = useRef(modelData.sessionByPath);
  const bookmarkedSessionReferencesRef = useRef(bookmarkedSessionReferences);
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
    bookmarkedSessionReferencesRef.current = bookmarkedSessionReferences;
  }, [bookmarkedSessionReferences]);

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
    const activePath = modelData.pathBySessionReference.get(activeSessionReference ?? "");
    const selectedPath = modelData.pathBySessionReference.get(selectedSessionReference ?? "");
    const focusedPath = selectedPath ?? activePath;
    const focusedSessionReference = selectedSessionReference ?? activeSessionReference ?? "";
    const focusedGroupPath = modelData.groupPathBySessionReference.get(focusedSessionReference);

    if (activePath) model.getItem(activePath)?.select();
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
                    {bookmarkedSessionReferencesRef.current.has(getSessionReferenceKey(menuSession))
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
