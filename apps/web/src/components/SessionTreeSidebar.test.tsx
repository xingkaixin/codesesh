import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionHead } from "../lib/api";
import { getSessionReferenceKey } from "../lib/session-indexes";
import { buildSessionTreeModel, SessionTreeSidebar } from "./SessionTreeSidebar";

function makeSession(overrides: Partial<SessionHead> & { id: string }): SessionHead {
  return {
    slug: `codex/${overrides.id}`,
    title: overrides.id,
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
  it("orders groups by most recent session time, descending", () => {
    const sessions = [
      makeSession({
        id: "old-1",
        directory: "/repo/old",
        time_created: 100,
      }),
      makeSession({
        id: "new-1",
        directory: "/repo/new",
        time_created: 300,
      }),
      makeSession({
        id: "mid-1",
        directory: "/repo/mid",
        time_created: 200,
      }),
      // A second, older session in the "new" group should not pull its maxTime down.
      makeSession({
        id: "new-2",
        directory: "/repo/new",
        time_created: 10,
      }),
    ];

    const { paths } = buildSessionTreeModel(sessions);

    expect(groupOrderOf(paths)).toEqual(["new", "mid", "old"]);
  });

  it("always places the unknown group last, regardless of session recency", () => {
    const sessions = [
      makeSession({ id: "known-1", directory: "/repo/known", time_created: 10 }),
      makeSession({ id: "unknown-1", directory: "", time_created: 9999 }),
    ];

    const { paths } = buildSessionTreeModel(sessions);

    expect(groupOrderOf(paths)).toEqual(["known", "(unknown)"]);
  });

  it("sorts a huge group against another group without throwing (no Math.max spread)", () => {
    // 200k sessions in one group reliably overflows `Math.max(...arr)`'s call
    // stack, so this only passes if the comparator avoids spreading.
    const bigGroup: SessionHead[] = Array.from({ length: 200_000 }, (_, index) =>
      makeSession({
        id: `big-${index}`,
        directory: "/repo/big",
        time_created: index,
      }),
    );
    const sessions = [
      ...bigGroup,
      makeSession({ id: "small-1", directory: "/repo/small", time_created: 999_999 }),
    ];

    const { paths } = buildSessionTreeModel(sessions);

    expect(groupOrderOf(paths)).toEqual(["small", "big"]);
    // 200k heads is heavy enough to exceed the default timeout on a loaded runner.
  }, 30_000);

  it("keeps paths for equal session ids from different agents", () => {
    const codex = makeSession({ id: "same", slug: "codex/same" });
    const claude = makeSession({ id: "same", slug: "claude/same" });

    const model = buildSessionTreeModel([codex, claude]);

    expect(model.pathBySessionReference.get(getSessionReferenceKey(codex))).toBeDefined();
    expect(model.pathBySessionReference.get(getSessionReferenceKey(claude))).toBeDefined();
  });

  it("mounts child sessions below their parent path", () => {
    const parent = makeSession({ id: "parent", title: "Main" });
    const child = makeSession({
      id: "child",
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

  it("does not render a child without its parent", () => {
    const child = makeSession({
      id: "orphan",
      parent_reference: { agentName: "codex", sessionId: "missing" },
    });

    const model = buildSessionTreeModel([child]);

    expect(model.paths).toEqual([]);
    expect(model.pathBySessionReference).toEqual(new Map());
  });
});

describe("buildSessionTreeModel path allocation", () => {
  it("CS-145: allocates unique paths for fully colliding titles and id prefixes", () => {
    // Same title and same first 8 id characters: every leaf lands on one base
    // path. A restart-from-2 probe is O(N²) here and cannot finish in time.
    const sessions = Array.from({ length: 20_000 }, (_, index) =>
      makeSession({
        id: `deadbeef-${index}`,
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
      makeSession({ id: "a", directory: "/repo/one/shared" }),
      makeSession({ id: "b", directory: "/repo/two/shared" }),
      makeSession({ id: "c", directory: "/repo/three/shared" }),
    ];

    const { paths } = buildSessionTreeModel(sessions);

    expect(groupOrderOf(paths)).toEqual(["shared", "shared (2)", "shared (3)"]);
  });

  it("CS-145: does not reuse a numbered label already taken by another title", () => {
    const sessions = [
      makeSession({ id: "a", title: "Report (2)" }),
      makeSession({ id: "b", title: "Report" }),
      makeSession({ id: "c", title: "Report" }),
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

function renderSessionTreeSidebar(sessions = [makeSession({ id: "s1" })]) {
  const session = sessions[0]!;
  const onToggleBookmark = vi.fn();
  const onRenameSession = vi.fn();
  render(
    <SessionTreeSidebar
      sessions={sessions}
      activeSessionReference={getSessionReferenceKey(session)}
      selectedSessionReference={getSessionReferenceKey(session)}
      onSelectSession={() => {}}
      bookmarkedSessionReferences={new Set()}
      onToggleBookmark={onToggleBookmark}
      onRenameSession={onRenameSession}
    />,
  );
  const shadowRoot = document.querySelector("file-tree-container")!.shadowRoot!;
  const item = shadowRoot.querySelector<HTMLElement>('[data-item-type="file"]')!;
  const decoration = item.querySelector<HTMLElement>('[data-item-section="decoration"] > span')!;
  return { session, onToggleBookmark, onRenameSession, shadowRoot, item, decoration };
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
    dispatch(bookmarkItem, "click");

    expect(onToggleBookmark).toHaveBeenCalledWith(session);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await waitFor(() => expect((item.getRootNode() as ShadowRoot).activeElement).toBe(item));
  });

  it("scrolls an overflowing title once while hovered", async () => {
    const title = "A deliberately long session title that needs a marquee";
    const { shadowRoot } = renderSessionTreeSidebar([makeSession({ id: "long", title })]);
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
      runFrame(3_000);
      expect(content.scrollLeft).toBeLessThan(scrollDistance);
      expect(content.scrollLeft).toBeGreaterThan(200);
      expect(content.dataset.sessionTitleScrollComplete).toBeUndefined();
      runFrame(4_200);
      expect(content.scrollLeft).toBe(scrollDistance);
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
    const parent = makeSession({ id: "parent", title: "Main parent session with child" });
    const child = makeSession({
      id: "child",
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
    const bookmarkItem = screen.getByRole("menuitem", { name: "Add bookmark" });
    await waitFor(() => expect(document.activeElement).toBe(renameItem));

    dispatch(renameItem, "keydown", { key: "ArrowDown" });
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
