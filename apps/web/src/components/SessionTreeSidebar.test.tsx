import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionHead } from "@codesesh/contract";
import { getSessionReferenceKey } from "../lib/session-indexes";
import { buildSessionTreeModel, SessionTreeSidebar } from "./SessionTreeSidebar";

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
});

function renderSessionTreeSidebar(sessions: SessionHead[]) {
  const reference = getSessionReferenceKey(sessions[0]!);
  render(
    <SessionTreeSidebar
      sessions={sessions}
      activeSessionReference={reference}
      selectedSessionReference={reference}
      onSelectSession={() => {}}
      bookmarkedSessionReferences={new Set()}
      onCopySessionAsMarkdown={() => {}}
      onToggleBookmark={() => {}}
      onRenameSession={() => {}}
    />,
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
