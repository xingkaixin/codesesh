import { createQueryWrapper } from "../test/query-wrapper";
import { queryKeys } from "../lib/query-keys";
import { act, renderHook } from "@testing-library/react";
import { SAMPLE_SESSION_HEAD } from "@codesesh/contract/test-fixtures";
import { afterEach, expect, it, vi } from "vitest";
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
