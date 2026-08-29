import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionHead } from "../lib/api";
import { getSessionReferenceKey } from "../lib/session-indexes";
import {
  buildSessionTreeModel,
  MAX_SESSION_TREE_NESTING,
  SessionTreeSidebar,
} from "./SessionTreeSidebar";

function makeSession(
  input: Partial<SessionHead> & { sessionId: string; agentName?: string },
): SessionHead {
  const { sessionId, agentName = "codex", ...overrides } = input;
  return {
    reference: { agentName, sessionId },
    title: sessionId,
    directory: "/repo/unused",
    time_created: 0,
    stats: {
      message_count: 1,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cost: 0,
    },
    ...overrides,
  };
}

function groupOrderOf(paths: string[]) {
  const seen: string[] = [];
  for (const path of paths) {
    const group = path.split("/")[0]!;
    if (!seen.includes(group)) seen.push(group);
  }
  return seen;
}

describe("buildSessionTreeModel group sorting", () => {
  it("folds a deeply nested session chain without recursive or quadratic paths", () => {
    const depth = 12_000;
    const sessions = Array.from({ length: depth }, (_, index) =>
      makeSession({
        sessionId: `deep-${index}`,
        title: "x",
        ...(index > 0
          ? { parent_reference: { agentName: "codex", sessionId: `deep-${index - 1}` } }
          : {}),
      }),
    );
    const model = buildSessionTreeModel(sessions);
    const deepestPath = model.pathBySessionReference.get(getSessionReferenceKey(sessions.at(-1)!))!;
    let longestPathLength = 0;
    let totalPathLength = 0;
    for (const path of model.pathBySessionReference.values()) {
      longestPathLength = Math.max(longestPathLength, path.length);
      totalPathLength += path.length;
    }

    expect(model.pathBySessionReference.size).toBe(depth);
    expect(deepestPath).toContain("Deeper sessions/");
    expect(deepestPath.split("/")).toHaveLength(MAX_SESSION_TREE_NESTING + 3);
    expect(longestPathLength).toBeLessThan(256);
    expect(totalPathLength).toBeLessThan(depth * 256);
    expect(model.paths).toContain(deepestPath);
  });

  it("renders every cycle member once under the Unmounted group", () => {
    const a = makeSession({
      sessionId: "a",
      parent_reference: { agentName: "codex", sessionId: "b" },
    });
    const b = makeSession({
      sessionId: "b",
      parent_reference: { agentName: "codex", sessionId: "a" },
    });

    const model = buildSessionTreeModel([a, b]);
    const references = [a, b].map((session) => getSessionReferenceKey(session));

    expect(model.paths).toHaveLength(2);
    expect(new Set(model.paths).size).toBe(2);
    for (const reference of references) {
      expect(model.pathBySessionReference.get(reference)).toMatch(/^Unmounted\//);
    }
  });

  it("orders groups by most recent session time, descending", () => {
    const sessions = [
      makeSession({
        sessionId: "old-1",
        directory: "/repo/old",
        time_created: 100,
      }),
      makeSession({
        sessionId: "new-1",
        directory: "/repo/new",
        time_created: 300,
      }),
      makeSession({
        sessionId: "mid-1",
        directory: "/repo/mid",
        time_created: 200,
      }),
      // A second, older session in the "new" group should not pull its maxTime down.
      makeSession({
        sessionId: "new-2",
        directory: "/repo/new",
        time_created: 10,
      }),
    ];

    const { paths } = buildSessionTreeModel(sessions);

    expect(groupOrderOf(paths)).toEqual(["new", "mid", "old"]);
  });

  it("always places the unknown group last, regardless of session recency", () => {
    const sessions = [
      makeSession({ sessionId: "known-1", directory: "/repo/known", time_created: 10 }),
      makeSession({ sessionId: "unknown-1", directory: "", time_created: 9999 }),
    ];

    const { paths } = buildSessionTreeModel(sessions);

    expect(groupOrderOf(paths)).toEqual(["known", "(unknown)"]);
  });

  it("sorts a huge group against another group without throwing (no Math.max spread)", () => {
    // 200k sessions in one group reliably overflows `Math.max(...arr)`'s call
    // stack, so this only passes if the comparator avoids spreading.
    const bigGroup: SessionHead[] = Array.from({ length: 200_000 }, (_, index) =>
      makeSession({
        sessionId: `big-${index}`,
        directory: "/repo/big",
        time_created: index,
      }),
    );
    const sessions = [
      ...bigGroup,
      makeSession({ sessionId: "small-1", directory: "/repo/small", time_created: 999_999 }),
    ];

    const { paths } = buildSessionTreeModel(sessions);

    expect(groupOrderOf(paths)).toEqual(["small", "big"]);
    // 200k heads is heavy enough to exceed the default timeout on a loaded runner.
  }, 30_000);

  it("keeps paths for equal session ids from different agents", () => {
    const codex = makeSession({ sessionId: "same" });
    const claude = makeSession({ sessionId: "same", agentName: "claude" });

    const model = buildSessionTreeModel([codex, claude]);

    expect(model.pathBySessionReference.get(getSessionReferenceKey(codex))).toBeDefined();
    expect(model.pathBySessionReference.get(getSessionReferenceKey(claude))).toBeDefined();
  });

  it("mounts child sessions below their parent path", () => {
    const parent = makeSession({ sessionId: "parent", title: "Main" });
    const child = makeSession({
      sessionId: "child",
      title: "Worker",
      parent_reference: { agentName: "codex", sessionId: "parent" },
    });

    const model = buildSessionTreeModel([parent, child]);
    const parentPath = model.pathBySessionReference.get(getSessionReferenceKey(parent))!;
    const childPath = model.pathBySessionReference.get(getSessionReferenceKey(child))!;

    expect(parentPath.endsWith("/")).toBe(true);
    expect(childPath.startsWith(parentPath)).toBe(true);
    expect(model.paths).toContain(childPath);
    expect(model.sessionByPath.get(parentPath)).toBe(parent);
    expect(model.sessionByPath.get(childPath)).toBe(child);
  });

  it("renders a child without its parent under the Unmounted group", () => {
    const rooted = makeSession({ sessionId: "rooted", directory: "/repo/known" });
    const child = makeSession({
      sessionId: "orphan",
      parent_reference: { agentName: "codex", sessionId: "missing" },
    });

    const model = buildSessionTreeModel([rooted, child]);
    const childPath = model.pathBySessionReference.get(getSessionReferenceKey(child))!;

    expect(childPath.startsWith("Unmounted/")).toBe(true);
    expect(model.paths).toContain(childPath);
    expect(model.sessionByPath.get(childPath)).toBe(child);
    expect(groupOrderOf(model.paths)).toEqual(["known", "Unmounted"]);
  });

  it("keeps a grandchild mounted under its orphaned parent", () => {
    const orphan = makeSession({
      sessionId: "orphan",
      parent_reference: { agentName: "codex", sessionId: "missing" },
    });
    const grandchild = makeSession({
      sessionId: "grandchild",
      parent_reference: { agentName: "codex", sessionId: "orphan" },
    });

    const model = buildSessionTreeModel([orphan, grandchild]);
    const orphanPath = model.pathBySessionReference.get(getSessionReferenceKey(orphan))!;
    const grandchildPath = model.pathBySessionReference.get(getSessionReferenceKey(grandchild))!;

    expect(orphanPath.endsWith("/")).toBe(true);
    expect(grandchildPath.startsWith(orphanPath)).toBe(true);
  });
});

describe("buildSessionTreeModel path allocation", () => {
  it("CS-145: allocates unique paths for fully colliding titles and id prefixes", () => {
    // Same title and same first 8 id characters: every leaf lands on one base
    // path. A restart-from-2 probe is O(N²) here and cannot finish in time.
    const sessions = Array.from({ length: 20_000 }, (_, index) =>
      makeSession({
        sessionId: `deadbeef-${index}`,
        title: "Same title",
        directory: "/repo/one",
      }),
    );

    const model = buildSessionTreeModel(sessions);

    expect(model.paths).toHaveLength(sessions.length);
    expect(new Set(model.paths).size).toBe(sessions.length);
    for (const session of sessions) {
      const path = model.pathBySessionReference.get(getSessionReferenceKey(session));
      expect(model.sessionByPath.get(path ?? "")).toBe(session);
    }
  });

  it("CS-145: keeps groups with the same label distinct", () => {
    const sessions = [
      makeSession({ sessionId: "a", directory: "/repo/one/shared" }),
      makeSession({ sessionId: "b", directory: "/repo/two/shared" }),
      makeSession({ sessionId: "c", directory: "/repo/three/shared" }),
    ];

    const { paths } = buildSessionTreeModel(sessions);

    expect(groupOrderOf(paths)).toEqual(["shared", "shared (2)", "shared (3)"]);
  });

  it("CS-145: does not reuse a numbered label already taken by another title", () => {
    const sessions = [
      makeSession({ sessionId: "a", title: "Report (2)" }),
      makeSession({ sessionId: "b", title: "Report" }),
      makeSession({ sessionId: "c", title: "Report" }),
    ];

    const { paths } = buildSessionTreeModel(sessions);

    expect(new Set(paths).size).toBe(sessions.length);
  });
});

// happy-dom dispatches events into the tree's shadow DOM without retargeting
// `event.target` for listeners outside the shadow root (unlike real browsers),
// which breaks React's target-based event delegation. This patches the test
// environment to match spec behavior so SessionTreeSidebar's onClickCapture /
// onKeyDownCapture handlers on the light-DOM host receive the events.
function patchShadowEventRetargeting() {
  const retarget = (event: Event) => {
    const root = (event.target as Node | null)?.getRootNode?.();
    if (root instanceof ShadowRoot) {
      Object.defineProperty(event, "target", { value: root.host, configurable: true });
    }
  };
  document.addEventListener("click", retarget, true);
  document.addEventListener("keydown", retarget, true);
}

function renderSessionTreeSidebar(sessions = [makeSession({ sessionId: "s1" })]) {
  const session = sessions[0]!;
  const onCopySessionAsMarkdown = vi.fn();
  const onToggleBookmark = vi.fn();
  const onRenameSession = vi.fn();
  render(
    <SessionTreeSidebar
      sessions={sessions}
      activeSessionReference={getSessionReferenceKey(session)}
      selectedSessionReference={getSessionReferenceKey(session)}
      onSelectSession={() => {}}
      bookmarkedSessionReferences={new Set()}
      onCopySessionAsMarkdown={onCopySessionAsMarkdown}
      onToggleBookmark={onToggleBookmark}
      onRenameSession={onRenameSession}
    />,
  );
  const shadowRoot = document.querySelector("file-tree-container")!.shadowRoot!;
  const item = shadowRoot.querySelector<HTMLElement>('[data-item-type="file"]')!;
  const decoration = item.querySelector<HTMLElement>('[data-item-section="decoration"] > span')!;
  return {
    session,
    onCopySessionAsMarkdown,
    onToggleBookmark,
    onRenameSession,
    shadowRoot,
    item,
    decoration,
  };
}

function dispatch(target: HTMLElement, type: string, init: EventInit & { key?: string } = {}) {
  const Ctor =
    type === "keydown"
      ? KeyboardEvent
      : type.startsWith("pointer") && typeof PointerEvent !== "undefined"
        ? PointerEvent
        : MouseEvent;
  target.dispatchEvent(
    new Ctor(type, { bubbles: true, cancelable: true, composed: true, ...init }),
  );
}

describe("CS-275: untrusted session titles stay inert", () => {
  afterEach(cleanup);

  // The sidebar's XSS safety rests on two facts about @pierre/trees: node
  // labels go through vnodes (escaped), and the innerHTML-rendered
  // `composition` slot stays unset. This test enforces the invariant so a
  // dependency bump or a future `composition` use cannot silently turn
  // transcript-derived titles into an HTML sink.
  function queryDeep(root: ParentNode, selector: string): Element | null {
    const direct = root.querySelector(selector);
    if (direct) return direct;
    for (const element of root.querySelectorAll("*")) {
      const nested = (element as HTMLElement).shadowRoot;
      if (nested) {
        const hit = queryDeep(nested, selector);
        if (hit) return hit;
      }
    }
    return null;
  }

  it("renders HTML metacharacters in titles as text, not markup", async () => {
    const hostileTitle = '<img src=x onerror="globalThis.__cs275 = true"> <b>bold';
    renderSessionTreeSidebar([makeSession({ sessionId: "hostile", title: hostileTitle })]);

    // The full title survives verbatim as escaped text (the visible label is
    // split by MiddleTruncate, so assert on the row's aria-label instead).
    await waitFor(() =>
      expect(queryDeep(document, `[aria-label='${hostileTitle}']`)).not.toBeNull(),
    );
    expect(queryDeep(document, "img")).toBeNull();
    expect(queryDeep(document, "b")).toBeNull();
    expect((globalThis as { __cs275?: boolean }).__cs275).toBeUndefined();
  });
});

describe("SessionTreeSidebar selection state", () => {
  afterEach(cleanup);

  it("keeps one active row and hides its fill while keyboard focus is elsewhere", async () => {
    const first = makeSession({ sessionId: "first", title: "First session" });
    const second = makeSession({ sessionId: "second", title: "Second session" });
    const sessions = [first, second];
    const firstReference = getSessionReferenceKey(first);
    const secondReference = getSessionReferenceKey(second);
    const onSelectSession = vi.fn();
    const renderTree = (activeSessionReference: string, selectedSessionReference: string) => (
      <SessionTreeSidebar
        sessions={sessions}
        activeSessionReference={activeSessionReference}
        selectedSessionReference={selectedSessionReference}
        onSelectSession={onSelectSession}
        bookmarkedSessionReferences={new Set()}
        onCopySessionAsMarkdown={() => {}}
        onToggleBookmark={() => {}}
        onRenameSession={() => {}}
        groupByProject={false}
      />
    );
    const { rerender } = render(renderTree(firstReference, secondReference));
    const tree = document.querySelector<HTMLElement>(".session-tree")!;
    const shadowRoot = document.querySelector("file-tree-container")!.shadowRoot!;

    await waitFor(() => {
      const activeRows = shadowRoot.querySelectorAll('[aria-selected="true"]');
      expect(activeRows).toHaveLength(1);
      expect(activeRows[0]?.getAttribute("aria-label")).toBe("First session");
    });
    expect(tree.style.getPropertyValue("--trees-selected-bg-override")).toBe("transparent");
    expect(onSelectSession).not.toHaveBeenCalled();

    rerender(renderTree(secondReference, secondReference));

    await waitFor(() => {
      const activeRows = shadowRoot.querySelectorAll('[aria-selected="true"]');
      expect(activeRows).toHaveLength(1);
      expect(activeRows[0]?.getAttribute("aria-label")).toBe("Second session");
    });
    expect(tree.style.getPropertyValue("--trees-selected-bg-override")).toBe("var(--brand-soft)");
    expect(onSelectSession).not.toHaveBeenCalled();
  });
});

describe("SessionTreeSidebar session options menu", () => {
  beforeEach(() => {
    patchShadowEventRetargeting();
  });
  afterEach(cleanup);

  it("opens from the row's options button, runs the selected action, and returns focus", async () => {
    const { session, onToggleBookmark, item, decoration } = renderSessionTreeSidebar();

    dispatch(decoration, "click");
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeNull());

    const bookmarkItem = await screen.findByRole("menuitem", { name: "Add bookmark" });
    expect(screen.getByRole("menuitem", { name: "Rename" }).querySelector("svg")).not.toBeNull();
    expect(bookmarkItem.querySelector("svg")).not.toBeNull();
    dispatch(bookmarkItem, "click");

    expect(onToggleBookmark).toHaveBeenCalledWith(session);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await waitFor(() => expect((item.getRootNode() as ShadowRoot).activeElement).toBe(item));
  });

  it("copies the session selected by the context menu", async () => {
    const { session, onCopySessionAsMarkdown, decoration } = renderSessionTreeSidebar();

    dispatch(decoration, "click");
    const copyItem = await screen.findByRole("menuitem", { name: "Copy as Markdown" });
    dispatch(copyItem, "click");

    expect(onCopySessionAsMarkdown).toHaveBeenCalledWith(session);
  });

  it("scrolls an overflowing title once while hovered", async () => {
    const title = "A deliberately long session title that needs a marquee";
    const { shadowRoot } = renderSessionTreeSidebar([makeSession({ sessionId: "long", title })]);
    const content = await waitFor(() => {
      const element = shadowRoot.querySelector<HTMLElement>(
        '[data-item-type="file"] [data-item-section="content"]',
      );
      expect(element).not.toBeNull();
      return element!;
    });
    const track = content.querySelector<HTMLElement>('[data-truncate-group-container="middle"]');
    expect(track).not.toBeNull();
    Object.defineProperty(track!, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ width: 320 }) as DOMRect,
    });
    Object.defineProperties(content, {
      clientWidth: { configurable: true, value: 100 },
      scrollWidth: { configurable: true, value: 640 },
    });

    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 1;
    const requestFrame = vi
      .spyOn(globalThis, "requestAnimationFrame")
      .mockImplementation((callback) => {
        const frame = nextFrame++;
        frames.set(frame, callback);
        return frame;
      });
    const cancelFrame = vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation((frame) => {
      frames.delete(frame);
    });
    const performanceNow = vi.spyOn(performance, "now").mockReturnValue(0);

    const runFrame = (timestamp: number) => {
      const callbacks = [...frames.values()];
      frames.clear();
      for (const callback of callbacks) callback(timestamp);
    };

    try {
      dispatch(content, "pointerover");
      expect(content.dataset.sessionTitleScroll).toBe("running");
      const copy = content.querySelector<HTMLElement>("[data-session-title-scroll-copy]");
      expect(copy).not.toBeNull();
      const gap = Number.parseFloat(copy!.style.marginInlineStart);
      expect(gap).toBeGreaterThan(0);
      const scrollDistance = 320 + gap;

      runFrame(0);
      expect(content.scrollLeft).toBe(0);
      runFrame(1_500);
      expect(content.scrollLeft).toBeGreaterThan(0);
      runFrame(2_800);
      expect(content.scrollLeft).toBeCloseTo((scrollDistance * 2) / 3, 5);
      const slowdownStartOffset = content.scrollLeft;
      runFrame(4_200);
      expect(content.scrollLeft).toBeGreaterThan(slowdownStartOffset);
      expect(content.scrollLeft).toBeLessThan(scrollDistance);
      expect(content.dataset.sessionTitleScrollComplete).toBeUndefined();
      const slowdownMidpointOffset = content.scrollLeft;
      runFrame(5_600);
      expect(content.scrollLeft).toBe(scrollDistance);
      expect(slowdownMidpointOffset - slowdownStartOffset).toBeGreaterThan(
        scrollDistance - slowdownMidpointOffset,
      );
      expect(content.dataset.sessionTitleScrollComplete).toBe("true");

      dispatch(content, "pointerout");
      expect(content.scrollLeft).toBe(0);
      expect(content.dataset.sessionTitleScroll).toBeUndefined();
      expect(content.dataset.sessionTitleScrollComplete).toBeUndefined();
      expect(content.querySelector("[data-session-title-scroll-copy]")).toBeNull();
    } finally {
      requestFrame.mockRestore();
      cancelFrame.mockRestore();
      performanceNow.mockRestore();
    }
  });

  it("shows and opens the parent row options when it has a child session", async () => {
    const parent = makeSession({ sessionId: "parent", title: "Main parent session with child" });
    const child = makeSession({
      sessionId: "child",
      title: "Worker",
      parent_reference: { agentName: "codex", sessionId: "parent" },
    });

    const { onToggleBookmark, shadowRoot } = renderSessionTreeSidebar([parent, child]);

    const parentItem = await waitFor(() => {
      const parentItem = shadowRoot.querySelector<HTMLElement>(
        '[data-item-type="folder"][aria-label="Main parent session with child"]',
      );
      expect(parentItem).not.toBeNull();
      return parentItem!;
    });
    const decoration = parentItem.querySelector<HTMLElement>(
      '[data-item-section="decoration"] > span',
    );
    expect(decoration).not.toBeNull();
    dispatch(decoration!, "click");

    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeNull());
    dispatch(await screen.findByRole("menuitem", { name: "Add bookmark" }), "click");
    expect(onToggleBookmark).toHaveBeenCalledWith(parent);
  });

  it("opens via keyboard (ContextMenu key) with the first item focused, navigates, and executes", async () => {
    const { session, onToggleBookmark, item } = renderSessionTreeSidebar();

    item.focus();
    dispatch(item, "keydown", { key: "ContextMenu" });
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeNull());

    const renameItem = await screen.findByRole("menuitem", { name: "Rename" });
    const copyItem = screen.getByRole("menuitem", { name: "Copy as Markdown" });
    const bookmarkItem = screen.getByRole("menuitem", { name: "Add bookmark" });
    await waitFor(() => expect(document.activeElement).toBe(renameItem));

    dispatch(renameItem, "keydown", { key: "ArrowDown" });
    await waitFor(() => expect(document.activeElement).toBe(copyItem));
    dispatch(copyItem, "keydown", { key: "ArrowDown" });
    await waitFor(() => expect(document.activeElement).toBe(bookmarkItem));

    dispatch(bookmarkItem, "keydown", { key: "Enter" });
    expect(onToggleBookmark).toHaveBeenCalledWith(session);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await waitFor(() => expect((item.getRootNode() as ShadowRoot).activeElement).toBe(item));
  });

  it("closes on Escape and returns focus to the row", async () => {
    const { item, decoration } = renderSessionTreeSidebar();

    dispatch(decoration, "click");
    const renameItem = await screen.findByRole("menuitem", { name: "Rename" });
    await waitFor(() => expect(document.activeElement).toBe(renameItem));

    dispatch(renameItem, "keydown", { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await waitFor(() => expect((item.getRootNode() as ShadowRoot).activeElement).toBe(item));
  });

  it("closes on an outside pointer press and returns focus to the row", async () => {
    const { item, decoration } = renderSessionTreeSidebar();

    dispatch(decoration, "click");
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeNull());

    document.body.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, cancelable: true, composed: true }),
    );

    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await waitFor(() => expect((item.getRootNode() as ShadowRoot).activeElement).toBe(item));
  });
});
