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

const originalClipboardItem = globalThis.ClipboardItem;
const originalClipboard = navigator.clipboard;

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  Object.defineProperty(globalThis, "ClipboardItem", {
    value: originalClipboardItem,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(navigator, "clipboard", {
    value: originalClipboard,
    configurable: true,
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

it("copies the complete transcript via writeToClipboard when ClipboardItem is unavailable", async () => {
  Object.defineProperty(globalThis, "ClipboardItem", {
    value: undefined,
    configurable: true,
    writable: true,
  });
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

it("passes a Promise<Blob> to ClipboardItem synchronously and tracks isCopying while fetching", async () => {
  const { Wrapper } = createQueryWrapper();
  const pendingFetch = deferred<typeof SAMPLE_SESSION_HEAD & { messages: unknown[] }>();
  apiMocks.fetchSessionData.mockReturnValue(pendingFetch.promise);

  let capturedBlobPromise: Promise<Blob> | undefined;
  class MockClipboardItem {
    constructor(items: Record<string, Blob | Promise<Blob>>) {
      const value = items["text/plain"];
      if (value instanceof Promise) capturedBlobPromise = value;
    }
  }
  const writeMock = vi.fn(async () => {
    await capturedBlobPromise;
  });

  Object.defineProperty(globalThis, "ClipboardItem", {
    value: MockClipboardItem,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(navigator, "clipboard", {
    value: { write: writeMock },
    configurable: true,
  });

  const { result } = renderHook(() => useCopySessionAsMarkdown(), { wrapper: Wrapper });

  let copyPromise!: Promise<void>;
  act(() => {
    copyPromise = result.current.copySessionAsMarkdown(SAMPLE_SESSION_HEAD);
  });

  // Safari and Firefox require clipboard.write() before the first async yield.
  expect(writeMock).toHaveBeenCalledTimes(1);
  expect(result.current.isCopying).toBe(true);

  pendingFetch.resolve({
    ...SAMPLE_SESSION_HEAD,
    messages: [
      {
        id: "m1",
        role: "user",
        time_created: 1,
        parts: [{ type: "text", text: "Fetched asynchronously" }],
      },
    ],
  });

  await act(async () => {
    await copyPromise;
  });

  const writtenBlob = await capturedBlobPromise;
  expect(writtenBlob).toBeInstanceOf(Blob);
  expect(await writtenBlob?.text()).toContain("Fetched asynchronously");
  expect(clipboardMocks.writeToClipboard).not.toHaveBeenCalled();
  expect(result.current.isCopying).toBe(false);
  expect(result.current.sessionCopyNotice).toBe("Session copied as Markdown.");
});

it("falls back to writeToClipboard without re-fetching when ClipboardItem write rejects", async () => {
  const { Wrapper } = createQueryWrapper();
  apiMocks.fetchSessionData.mockResolvedValue({
    ...SAMPLE_SESSION_HEAD,
    messages: [
      {
        id: "m1",
        role: "assistant",
        time_created: 1,
        parts: [{ type: "text", text: "Fallback content" }],
      },
    ],
  });
  clipboardMocks.writeToClipboard.mockResolvedValue(true);

  class MockClipboardItem {
    constructor(_items: Record<string, Blob | Promise<Blob>>) {}
  }
  Object.defineProperty(globalThis, "ClipboardItem", {
    value: MockClipboardItem,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(navigator, "clipboard", {
    value: { write: vi.fn().mockRejectedValue(new DOMException("Denied", "NotAllowedError")) },
    configurable: true,
  });

  const { result } = renderHook(() => useCopySessionAsMarkdown(), { wrapper: Wrapper });
  await act(() => result.current.copySessionAsMarkdown(SAMPLE_SESSION_HEAD));

  expect(apiMocks.fetchSessionData).toHaveBeenCalledTimes(1);
  expect(clipboardMocks.writeToClipboard).toHaveBeenCalledWith(
    expect.stringContaining("Fallback content"),
  );
  expect(result.current.isCopying).toBe(false);
  expect(result.current.sessionCopyNotice).toBe("Session copied as Markdown.");
});

it("downloads the complete session as a sanitized .md file", async () => {
  const { Wrapper } = createQueryWrapper();
  const head = { ...SAMPLE_SESSION_HEAD, display_title: "Debug: API / Crash?" };
  apiMocks.fetchSessionData.mockResolvedValue({
    ...head,
    messages: [
      {
        id: "m1",
        role: "user",
        time_created: 1,
        parts: [{ type: "text", text: "Download body" }],
      },
    ],
  });

  const createdBlobs: Blob[] = [];
  const createObjectURL = vi.spyOn(URL, "createObjectURL").mockImplementation((value) => {
    if (value instanceof Blob) createdBlobs.push(value);
    return "blob:session-markdown";
  });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

  let downloadedName: string | null = null;
  const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    downloadedName = this.download;
  });

  const { result } = renderHook(() => useCopySessionAsMarkdown(), { wrapper: Wrapper });
  await act(() => result.current.downloadSessionAsMarkdown(head));

  expect(createObjectURL).toHaveBeenCalledTimes(1);
  expect(clickSpy).toHaveBeenCalledTimes(1);
  expect(downloadedName).toBe("Debug-API-Crash.md");
  expect(await createdBlobs[0]?.text()).toContain("Download body");
  expect(result.current.isDownloading).toBe(false);
  expect(result.current.sessionCopyNotice).toBe("Session downloaded as Markdown.");
});
