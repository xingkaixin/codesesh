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

  [data-type='item'] > [data-item-section='content'] {
    flex: 1 1 auto;
  }

  [data-type='item'] > [data-item-section='content'] {
    min-width: 0;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    direction: ltr;
  }

  [data-type='item'] > [data-item-section='decoration'] {
    flex: 0 0 auto;
    padding-inline: 6px 2px;
  }

  [data-type='item'] > [data-item-section='decoration']:has(> span[title='Session options']) {
    flex-basis: 24px;
    padding-inline: 0;
  }

  [data-type='item'] > [data-item-section='decoration'] > span[title='Session options'] {
    box-sizing: border-box;
    width: 24px;
    height: 24px;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    border: 1px solid transparent;
    border-radius: 6px;
    font-size: 12px;
    line-height: 24px;
    transition:
      color var(--dur-fast) var(--ease-out),
      background-color var(--dur-fast) var(--ease-out),
      border-color var(--dur-fast) var(--ease-out),
      transform var(--dur-fast) var(--ease-out);
  }

  [data-type='item'] > [data-item-section='decoration'] > span[title='Session options']:hover {
    color: var(--console-text);
    background-color: var(--console-surface-muted);
    border-color: var(--console-border);
  }

  [data-type='item'] > [data-item-section='decoration'] > span[title='Session options']:active {
    transform: scale(0.97);
  }

  [data-type='item'] [data-truncate-group-container='middle'] {
    display: inline;
    min-width: 0;
    white-space: nowrap;
  }

  [data-type='item'] [data-truncate-group-container='middle'] > div {
    display: inline;
    min-width: 0;
  }

  [data-type='item'] [data-truncate-container] {
    display: inline;
    height: auto;
    margin: 0;
    overflow: visible;
  }

  [data-type='item'] [data-truncate-grid] {
    display: inline;
    position: static;
  }

  [data-type='item'] [data-truncate-grid] > div:not([data-truncate-marker-cell]) {
    display: inline;
  }

  [data-type='item'] [data-truncate-content='visible'] {
    display: inline;
    white-space: nowrap;
    direction: ltr;
  }

  [data-type='item'] [data-truncate-content='overflow'],
  [data-type='item'] [data-truncate-fill],
  [data-type='item'] [data-truncate-marker-cell],
  [data-type='item'] [data-truncate-marker] {
    display: none;
  }

  [data-type='item'] [data-session-title-scroll='running'],
  [data-type='item'] [data-session-title-scroll-complete] {
    text-overflow: clip;
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

/** Sessions the canonical hierarchy cannot mount still need a visible axis. */
const UNMOUNTED_GROUP_LABEL = "Unmounted";

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

    const appendSession = (
      node: SessionTreeNode,
      parentPath: string,
      siblingTitleCounts: Map<string, number>,
    ): void => {
      const session = node.session;
      const title = getSessionDisplayTitle(session);
      siblingTitleCounts.set(title, (siblingTitleCounts.get(title) ?? 0) + 1);
      const siblingCount = siblingTitleCounts.get(title) ?? 1;
      const leaf =
        siblingCount > 1
          ? `${sanitizeSegment(title)} #${session.id.slice(0, 8)}`
          : sanitizeSegment(title);
      const basePath = allocateSessionPath(`${parentPath}${leaf}`);
      const reference = getSessionReferenceKey(session);
      const isDirectory = node.children.length > 0;
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
      for (const child of node.children) {
        appendSession(child, sessionPath, childTitleCounts);
      }
    };

    const rootTitleCounts = new Map<string, number>();
    for (const node of group.nodes) {
      appendSession(node, groupPath, rootTitleCounts);
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

const SESSION_TITLE_SCROLL_SPEED_PX_PER_MS = 0.08;
const SESSION_TITLE_SCROLL_GAP_PX = 16;
const SESSION_TITLE_SCROLL_MIN_DURATION_MS = 700;
const SESSION_TITLE_SCROLL_SLOWDOWN_DISTANCE = 1 / 3;
const SESSION_TITLE_SCROLL_DURATION_MULTIPLIER = 1 + SESSION_TITLE_SCROLL_SLOWDOWN_DISTANCE;
const SESSION_TITLE_SCROLL_SLOWDOWN_START =
  (1 - SESSION_TITLE_SCROLL_SLOWDOWN_DISTANCE) / SESSION_TITLE_SCROLL_DURATION_MULTIPLIER;

function getSessionTitleContent(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  const content = target.closest<HTMLElement>('[data-item-section="content"]');
  if (!content || content.parentElement?.getAttribute("data-type") !== "item") return null;
  return content;
}

function isReducedMotionPreferred() {
  return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

function easeSessionTitleScrollToStop(progress: number) {
  if (progress <= SESSION_TITLE_SCROLL_SLOWDOWN_START) {
    return (
      (progress / SESSION_TITLE_SCROLL_SLOWDOWN_START) *
      (1 - SESSION_TITLE_SCROLL_SLOWDOWN_DISTANCE)
    );
  }

  const slowdownProgress =
    (progress - SESSION_TITLE_SCROLL_SLOWDOWN_START) / (1 - SESSION_TITLE_SCROLL_SLOWDOWN_START);
  const slowdownPosition = slowdownProgress * (2 - slowdownProgress);
  return (
    1 -
    SESSION_TITLE_SCROLL_SLOWDOWN_DISTANCE +
    SESSION_TITLE_SCROLL_SLOWDOWN_DISTANCE * slowdownPosition
  );
}

function installSessionTitleScrolling(host: HTMLElement) {
  const root = host.shadowRoot;
  if (!root) return () => {};

  const activeElements = new Set<HTMLElement>();
  const preparedElements = new Set<HTMLElement>();
  const frameByElement = new WeakMap<HTMLElement, number>();
  const copyByElement = new WeakMap<HTMLElement, HTMLElement>();

  function reset(element: HTMLElement) {
    const frame = frameByElement.get(element);
    if (frame !== undefined) cancelAnimationFrame(frame);
    copyByElement.get(element)?.remove();
    copyByElement.delete(element);
    preparedElements.delete(element);
    frameByElement.delete(element);
    activeElements.delete(element);
    element.scrollLeft = 0;
    element.removeAttribute("data-session-title-scroll");
    element.removeAttribute("data-session-title-scroll-complete");
  }

  function start(element: HTMLElement) {
    if (isReducedMotionPreferred() || element.hasAttribute("data-session-title-scroll-complete")) {
      return;
    }

    reset(element);
    const track = element.querySelector<HTMLElement>('[data-truncate-group-container="middle"]');
    const trackWidth = track?.getBoundingClientRect().width ?? 0;
    if (!track || trackWidth <= element.clientWidth + 1) return;

    const copy = track.cloneNode(true) as HTMLElement;
    copy.dataset.sessionTitleScrollCopy = "true";
    copy.setAttribute("aria-hidden", "true");
    copy.style.marginInlineStart = `${SESSION_TITLE_SCROLL_GAP_PX}px`;
    element.append(copy);
    copyByElement.set(element, copy);
    preparedElements.add(element);
    element.setAttribute("data-session-title-scroll", "running");

    const scrollDistance = trackWidth + SESSION_TITLE_SCROLL_GAP_PX;
    const forwardDuration = Math.max(
      SESSION_TITLE_SCROLL_MIN_DURATION_MS,
      (scrollDistance / SESSION_TITLE_SCROLL_SPEED_PX_PER_MS) *
        SESSION_TITLE_SCROLL_DURATION_MULTIPLIER,
    );
    const startedAt = performance.now();
    activeElements.add(element);

    const step = (now: number) => {
      if (!activeElements.has(element)) return;

      const progress = Math.min(1, Math.max(0, (now - startedAt) / forwardDuration));
      element.scrollLeft = scrollDistance * easeSessionTitleScrollToStop(progress);

      if (progress >= 1) {
        activeElements.delete(element);
        frameByElement.delete(element);
        element.removeAttribute("data-session-title-scroll");
        element.setAttribute("data-session-title-scroll-complete", "true");
        return;
      }

      frameByElement.set(element, requestAnimationFrame(step));
    };

    frameByElement.set(element, requestAnimationFrame(step));
  }

  function handlePointerOver(event: Event) {
    const element = getSessionTitleContent(event.target);
    const relatedTarget = (event as PointerEvent).relatedTarget;
    if (!element || (relatedTarget instanceof Node && element.contains(relatedTarget))) return;
    start(element);
  }

  function handlePointerOut(event: Event) {
    const element = getSessionTitleContent(event.target);
    const relatedTarget = (event as PointerEvent).relatedTarget;
    if (!element || (relatedTarget instanceof Node && element.contains(relatedTarget))) return;
    reset(element);
  }

  root.addEventListener("pointerover", handlePointerOver);
  root.addEventListener("pointerout", handlePointerOut);

  return () => {
    root.removeEventListener("pointerover", handlePointerOver);
    root.removeEventListener("pointerout", handlePointerOut);
    for (const element of preparedElements) reset(element);
  };
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
  const bookmarkedSessionReferencesRef = useRef(bookmarkedSessionReferences);
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
  const { model } = useFileTree({
    flattenEmptyDirectories: false,
    initialExpansion: "closed",
    paths: modelData.paths,
    sort: (left, right) => compareTreeOrder(sortOrderRef.current, left, right),
    density: "compact",
    unsafeCSS: SESSION_TREE_CSS,
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
    bookmarkedSessionReferencesRef.current = bookmarkedSessionReferences;
  }, [bookmarkedSessionReferences]);

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
      cleanup = installSessionTitleScrolling(host);
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
                  bookmarked={bookmarkedSessionReferencesRef.current.has(
                    getSessionReferenceKey(menuSession),
                  )}
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
