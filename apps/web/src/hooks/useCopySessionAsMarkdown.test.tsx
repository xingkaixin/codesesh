import { createQueryWrapper } from "../test/query-wrapper";
import { queryKeys } from "../lib/query-keys";
import { act, renderHook } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { SAMPLE_SESSION_HEAD } from "@codesesh/contract/test-fixtures";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQueryClient } from "../lib/query-client";
import { useCopySessionAsMarkdown } from "./useCopySessionAsMarkdown";

const apiMocks = vi.hoisted(() => ({
  fetchSessionData: vi.fn(),
  logClientEvent: vi.fn(),
}));
const clipboardMocks = vi.hoisted(() => ({ writeToClipboard: vi.fn() }));

// oxlint-disable-next-line anti-slop/no-module-mocking -- Control API response ordering and failures while testing client state transitions.
vi.mock("../lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/api")>()),
  fetchSessionData: apiMocks.fetchSessionData,
  logClientEvent: apiMocks.logClientEvent,
}));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Control clipboard success and failure while verifying the copy action state.
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
      expect.objectContaining({ error_name: "Error" }),
    );
    const errorData = apiMocks.logClientEvent.mock.calls.find(
      ([event]) => event === "session.markdown_copy.error",
    )?.[1];
    expect(JSON.stringify(errorData)).not.toContain("Clipboard write failed");

    act(() => vi.advanceTimersByTime(2_500));
    expect(result.current.sessionCopyNotice).toBeNull();
  });
});

it("copies the complete transcript when the detail cache only contains a prefix", async () => {
  const { client, Wrapper } = createQueryWrapper();
  const head = {
    ...SAMPLE_SESSION_HEAD,
    reference: { ...SAMPLE_SESSION_HEAD.reference, sourceNodeId: "office" },
  };
  const first = {
    id: "first",
    role: "user" as const,
    time_created: 1,
    parts: [{ type: "text" as const, text: "First page" }],
  };
  const last = { ...first, id: "last", parts: [{ type: "text" as const, text: "Unloaded tail" }] };
  const partial = { ...head, messages: [first], message_total: 2 };
  const key = queryKeys.sessionDetail(head.reference.agentName, head.reference.sessionId, "office");
  client.setQueryData(key, partial);
  apiMocks.fetchSessionData.mockResolvedValue({ ...head, messages: [first, last] });
  clipboardMocks.writeToClipboard.mockResolvedValue(true);
  const { result } = renderHook(() => useCopySessionAsMarkdown(), { wrapper: Wrapper });
  await act(() => result.current.copySessionAsMarkdown(head));
  expect(apiMocks.fetchSessionData).toHaveBeenCalledWith(
    head.reference.agentName,
    head.reference.sessionId,
    { sourceNodeId: "office" },
  );
  expect(clipboardMocks.writeToClipboard).toHaveBeenCalledWith(
    expect.stringContaining("Unloaded tail"),
  );
  expect(client.getQueryData(key)).toEqual(partial);
});
