import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionHead } from "@codesesh/contract";
import { getSessionReferenceKey } from "../lib/session-indexes";
import {
  buildSessionTreeModel,
  MAX_SESSION_TREE_NESTING,
  SessionTreeSidebar,
  type SessionTreeItem,
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

function collectSessions(items: SessionTreeItem[]): SessionHead[] {
  const result: SessionHead[] = [];
  const stack = [...items].reverse();
  while (stack.length > 0) {
    const item = stack.pop()!;
    if (item.session) result.push(item.session);
    for (let index = item.children.length - 1; index >= 0; index -= 1) {
      stack.push(item.children[index]!);
    }
  }
  return result;
}

describe("buildSessionTreeModel group sorting", () => {
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
    const allSessions = collectSessions(model.roots);

    expect(model.roots.map((root) => root.label)).toEqual(["Unmounted"]);
    expect(allSessions).toHaveLength(2);
    expect(new Set(allSessions)).toEqual(new Set([a, b]));
    for (const session of [a, b]) {
      expect(model.ancestorIdsBySessionReference.get(getSessionReferenceKey(session))).toEqual([
        "group:__unmounted__",
      ]);
    }
  });

  it("keeps items for equal session ids from different agents", () => {
    const codex = makeSession({ sessionId: "same" });
    const claude = makeSession({ sessionId: "same", agentName: "claude" });

    const model = buildSessionTreeModel([codex, claude]);

    expect(model.itemBySessionReference.get(getSessionReferenceKey(codex))?.session).toBe(codex);
    expect(model.itemBySessionReference.get(getSessionReferenceKey(claude))?.session).toBe(claude);
  });

  it("mounts child sessions below their parent item", () => {
    const parent = makeSession({ sessionId: "parent", title: "Main" });
    const child = makeSession({
      sessionId: "child",
      title: "Worker",
      parent_reference: { agentName: "codex", sessionId: "parent" },
    });

    const model = buildSessionTreeModel([parent, child]);
    const parentItem = model.itemBySessionReference.get(getSessionReferenceKey(parent))!;
    const childItem = model.itemBySessionReference.get(getSessionReferenceKey(child))!;

    expect(parentItem.children).toEqual([childItem]);
    expect(parentItem.count).toBe(1);
    expect(model.ancestorIdsBySessionReference.get(getSessionReferenceKey(child))).toContain(
      parentItem.id,
    );
  });

  it("renders a child without its parent under the Unmounted group", () => {
    const rooted = makeSession({ sessionId: "rooted", directory: "/repo/known" });
    const child = makeSession({
      sessionId: "orphan",
      parent_reference: { agentName: "codex", sessionId: "missing" },
    });

    const model = buildSessionTreeModel([rooted, child]);

    expect(model.roots.map((root) => root.label)).toEqual(["known", "Unmounted"]);
    expect(model.roots[1]?.children[0]?.session).toBe(child);
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
    const orphanItem = model.itemBySessionReference.get(getSessionReferenceKey(orphan))!;
    const grandchildItem = model.itemBySessionReference.get(getSessionReferenceKey(grandchild))!;

    expect(orphanItem.children).toEqual([grandchildItem]);
  });

  it("flattens chains deeper than MAX_SESSION_TREE_NESTING into a Deeper sessions group", () => {
    const chain = Array.from({ length: MAX_SESSION_TREE_NESTING + 3 }, (_, index) =>
      makeSession({
        sessionId: `s-${index}`,
        parent_reference:
          index === 0 ? undefined : { agentName: "codex", sessionId: `s-${index - 1}` },
      }),
    );

    const model = buildSessionTreeModel(chain, { groupByProject: false });
    const deepestSession = chain.at(-1)!;
    const ancestors = model.ancestorIdsBySessionReference.get(
      getSessionReferenceKey(deepestSession),
    )!;

    expect(ancestors.some((id) => id.startsWith("overflow:"))).toBe(true);
    expect(collectSessions(model.roots)).toHaveLength(chain.length);
  });
});

describe("buildSessionTreeModel allocation and naming", () => {
  it("CS-145: handles 20,000 sessions with colliding titles and id prefixes in linear time", () => {
    const sessions = Array.from({ length: 20_000 }, (_, index) =>
      makeSession({
        sessionId: `deadbeef-${index}`,
        title: "Same title",
        directory: "/repo/one",
      }),
    );

    const model = buildSessionTreeModel(sessions);
    const items = model.roots[0]!.children;

    expect(items).toHaveLength(sessions.length);
    expect(new Set(items.map((item) => item.id)).size).toBe(sessions.length);
    for (const session of sessions) {
      const item = model.itemBySessionReference.get(getSessionReferenceKey(session));
      expect(item?.session).toBe(session);
    }
  });

  it("CS-145: keeps groups with the same label distinct", () => {
    const sessions = [
      makeSession({ sessionId: "a", directory: "/repo/one/shared" }),
      makeSession({ sessionId: "b", directory: "/repo/two/shared" }),
      makeSession({ sessionId: "c", directory: "/repo/three/shared" }),
    ];

    const model = buildSessionTreeModel(sessions);

    expect(model.roots.map((root) => root.label)).toEqual(["shared", "shared (2)", "shared (3)"]);
  });

  it("prefers ProjectGroup displayName for grouped session roots", () => {
    const fallback = makeSession({
      sessionId: "a",
      project_identity: {
        kind: "git_remote",
        key: "github.com/xingkaixin/codesesh",
        displayName: "codesesh",
      },
    });
    const model = buildSessionTreeModel([fallback], {
      projectDisplayNames: new Map([
        ["git_remote:github.com/xingkaixin/codesesh", "codesesh-monorepo"],
      ]),
    });

    expect(model.roots.map((root) => root.label)).toEqual(["codesesh-monorepo"]);
  });
});

describe("SessionTreeSidebar interaction and live updates", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("CS-275: renders HTML metacharacters in titles as text, not markup", () => {
    const hostileTitle = '<img src=x onerror="globalThis.__cs275 = true"> <b>bold';
    const session = makeSession({ sessionId: "hostile", title: hostileTitle });
    const reference = getSessionReferenceKey(session);

    render(
      <SessionTreeSidebar
        sessions={[session]}
        activeSessionReference={reference}
        selection={{ reference }}
        onSelectSession={() => {}}
        bookmarkedSessionReferences={new Set()}
        onCopySessionAsMarkdown={() => {}}
        onToggleBookmark={() => {}}
        onRenameSession={() => {}}
      />,
    );

    expect(screen.getByRole("treeitem", { name: hostileTitle })).toBeTruthy();
    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector("b")).toBeNull();
    expect((globalThis as { __cs275?: boolean }).__cs275).toBeUndefined();
  });

  it("preserves expanded groups and does not re-scroll across live SSE session updates", () => {
    const alpha = makeSession({
      sessionId: "a1",
      title: "Alpha session",
      directory: "/repo/alpha",
      time_updated: 20,
    });
    const beta = makeSession({
      sessionId: "b1",
      title: "Beta session",
      directory: "/repo/beta",
      time_updated: 10,
    });
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;

    const alphaRef = getSessionReferenceKey(alpha);
    const props = {
      activeSessionReference: alphaRef,
      selection: { reference: alphaRef },
      onSelectSession: vi.fn(),
      bookmarkedSessionReferences: new Set<string>(),
      onCopySessionAsMarkdown: vi.fn(),
      onToggleBookmark: vi.fn(),
      onRenameSession: vi.fn(),
      groupByProject: true,
    };

    const { rerender } = render(<SessionTreeSidebar sessions={[alpha, beta]} {...props} />);

    // Active group is expanded on mount; non-active group starts collapsed.
    expect(screen.getByRole("treeitem", { name: "Alpha session" })).toBeTruthy();
    expect(screen.queryByRole("treeitem", { name: "Beta session" })).toBeNull();
    expect(scrollIntoView).toHaveBeenCalledTimes(1);

    // User manually expands the Beta group.
    fireEvent.click(screen.getByRole("treeitem", { name: "beta" }));
    expect(screen.getByRole("treeitem", { name: "Beta session" })).toBeTruthy();

    // Live SSE update pushes a fresh sessions array with updated metadata and a new session.
    const betaTwo = makeSession({
      sessionId: "b2",
      title: "Beta follow-up",
      directory: "/repo/beta",
      time_updated: 30,
    });
    rerender(
      <SessionTreeSidebar
        sessions={[{ ...alpha, time_updated: 25 }, { ...beta }, betaTwo]}
        {...props}
      />,
    );

    // Both groups remain expanded and scrollIntoView is not re-triggered.
    expect(screen.getByRole("treeitem", { name: "Alpha session" })).toBeTruthy();
    expect(screen.getByRole("treeitem", { name: "Beta session" })).toBeTruthy();
    expect(screen.getByRole("treeitem", { name: "Beta follow-up" })).toBeTruthy();
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it("highlights and scrolls keyboard-selected sessions on Project views when activeSessionReference is null", () => {
    const first = makeSession({
      sessionId: "p1",
      title: "Parent session",
      directory: "/repo/project",
      time_updated: 30,
    });
    const child = makeSession({
      sessionId: "c1",
      title: "Nested worker",
      directory: "/repo/project",
      parent_reference: { agentName: "codex", sessionId: "p1" },
      time_updated: 20,
    });
    const second = makeSession({
      sessionId: "p2",
      title: "Second root",
      directory: "/repo/project",
      time_updated: 10,
    });
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;

    const baseProps = {
      sessions: [first, child, second],
      activeSessionReference: null,
      onSelectSession: vi.fn(),
      bookmarkedSessionReferences: new Set<string>(),
      onCopySessionAsMarkdown: vi.fn(),
      onToggleBookmark: vi.fn(),
      onRenameSession: vi.fn(),
      groupByProject: false,
    };

    const { rerender } = render(<SessionTreeSidebar {...baseProps} selection={null} />);

    expect(screen.queryByRole("treeitem", { name: "Nested worker" })).toBeNull();
    expect(scrollIntoView).not.toHaveBeenCalled();

    // Keyboard navigation selects the nested child on a Project view.
    rerender(
      <SessionTreeSidebar
        {...baseProps}
        selection={{ reference: getSessionReferenceKey(child) }}
      />,
    );

    const childItem = screen.getByRole("treeitem", { name: "Nested worker" });
    expect(childItem.getAttribute("data-selected")).toBe("true");
    expect(childItem.getAttribute("aria-selected")).toBe("true");
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });

    // Moving to another root updates selection and scrolls it into view.
    rerender(
      <SessionTreeSidebar
        {...baseProps}
        selection={{ reference: getSessionReferenceKey(second) }}
      />,
    );

    const secondItem = screen.getByRole("treeitem", { name: "Second root" });
    expect(secondItem.getAttribute("data-selected")).toBe("true");
    expect(scrollIntoView).toHaveBeenCalledTimes(2);
  });

  it("opens session action menu items from the row trigger without selecting the session", () => {
    const session = makeSession({ sessionId: "s1", title: "Inspectable session" });
    const onSelectSession = vi.fn();
    const onRenameSession = vi.fn();
    const onToggleBookmark = vi.fn();

    render(
      <SessionTreeSidebar
        sessions={[session]}
        activeSessionReference={null}
        selection={null}
        onSelectSession={onSelectSession}
        bookmarkedSessionReferences={new Set()}
        onCopySessionAsMarkdown={vi.fn()}
        onToggleBookmark={onToggleBookmark}
        onRenameSession={onRenameSession}
        groupByProject={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Session options" }));
    expect(onSelectSession).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    expect(onRenameSession).toHaveBeenCalledWith(session);
  });
});
