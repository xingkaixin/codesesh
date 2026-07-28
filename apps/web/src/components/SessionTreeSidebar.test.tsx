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

function renderSessionTreeSidebar() {
  const session = makeSession({ id: "s1" });
  const onToggleBookmark = vi.fn();
  const onRenameSession = vi.fn();
  render(
    <SessionTreeSidebar
      sessions={[session]}
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
  const Ctor = type === "keydown" ? KeyboardEvent : MouseEvent;
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
