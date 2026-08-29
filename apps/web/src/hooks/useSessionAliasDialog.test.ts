import { SAMPLE_SESSION_HEAD } from "@codesesh/core/test-fixtures";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BookmarkView } from "../lib/api";
import { createQueryWrapper } from "../test/query-wrapper";
import { useSessionAliasDialog } from "./useSessionAliasDialog";

vi.mock("../lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/api")>()),
  deleteSessionAlias: vi.fn(),
  upsertSessionAlias: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("useSessionAliasDialog", () => {
  it("owns target creation for sessions and unavailable bookmarks", () => {
    const { Wrapper } = createQueryWrapper();
    const { result } = renderHook(
      () => useSessionAliasDialog(vi.fn().mockResolvedValue(undefined)),
      { wrapper: Wrapper },
    );

    act(() => result.current.openSession(SAMPLE_SESSION_HEAD));
    expect(result.current.target).toEqual({
      agentKey: SAMPLE_SESSION_HEAD.reference.agentName,
      sessionId: SAMPLE_SESSION_HEAD.reference.sessionId,
      title: SAMPLE_SESSION_HEAD.title,
      displayTitle: undefined,
    });

    act(() => result.current.close());
    expect(result.current.target).toBeNull();

    const bookmark = {
      reference: { agentName: "codex", sessionId: "missing-session" },
      bookmarkedAt: 1,
      availability: "session-unavailable",
      display_title: "Saved title",
    } satisfies BookmarkView;
    act(() => result.current.openBookmark(bookmark));

    expect(result.current.target).toEqual({
      agentKey: "codex",
      sessionId: "missing-session",
      title: "missing-session",
      displayTitle: "Saved title",
    });
  });
});
