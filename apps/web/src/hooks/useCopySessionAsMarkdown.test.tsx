import { act, renderHook } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { SAMPLE_SESSION_HEAD } from "@codesesh/core/test-fixtures";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQueryClient } from "../lib/query-client";
import { useCopySessionAsMarkdown } from "./useCopySessionAsMarkdown";

const apiMocks = vi.hoisted(() => ({
  fetchSessionData: vi.fn(),
  logClientEvent: vi.fn(),
}));
const clipboardMocks = vi.hoisted(() => ({ writeToClipboard: vi.fn() }));

vi.mock("../lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/api")>()),
  fetchSessionData: apiMocks.fetchSessionData,
  logClientEvent: apiMocks.logClientEvent,
}));
vi.mock("../lib/clipboard", () => clipboardMocks);

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

function Wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={createQueryClient()}>{children}</QueryClientProvider>;
}

describe("useCopySessionAsMarkdown", () => {
  it("reports and clears a clipboard failure", async () => {
    vi.useFakeTimers();
    apiMocks.fetchSessionData.mockResolvedValue({ ...SAMPLE_SESSION_HEAD, messages: [] });
    clipboardMocks.writeToClipboard.mockResolvedValue(false);
    const { result } = renderHook(() => useCopySessionAsMarkdown(), { wrapper: Wrapper });

    await act(() => result.current.copySessionAsMarkdown(SAMPLE_SESSION_HEAD));

    expect(result.current.sessionCopyNotice).toBe("Couldn’t copy session as Markdown.");
    expect(apiMocks.logClientEvent).toHaveBeenCalledWith(
      "session.markdown_copy.error",
      expect.objectContaining({ error: "Clipboard write failed" }),
    );

    act(() => vi.advanceTimersByTime(2_500));
    expect(result.current.sessionCopyNotice).toBeNull();
  });
});
