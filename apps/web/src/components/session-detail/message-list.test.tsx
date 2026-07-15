import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FilteredSessionMessage } from "./toc";
import { MessageList, type MessageListHandle, VIRTUALIZED_MESSAGE_THRESHOLD } from "./message-list";

vi.mock("./message-rendering", () => ({
  MessageItem: ({ messageIndex }: { messageIndex: number }) => (
    <div data-message-index={messageIndex}>Message {messageIndex}</div>
  ),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

class ResizeObserverMock {
  static instances: ResizeObserverMock[] = [];

  readonly targets = new Set<Element>();

  constructor(private readonly callback: ResizeObserverCallback) {
    ResizeObserverMock.instances.push(this);
  }

  observe(target: Element) {
    this.targets.add(target);
  }

  unobserve(target: Element) {
    this.targets.delete(target);
  }

  disconnect() {
    this.targets.clear();
  }

  trigger(target: Element) {
    if (!this.targets.has(target)) return;
    this.callback([{ target } as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
}

function createMessages(): FilteredSessionMessage[] {
  return Array.from({ length: VIRTUALIZED_MESSAGE_THRESHOLD + 1 }, (_, index) => ({
    msg: { id: `message-${index}` } as FilteredSessionMessage["msg"],
    blocks: [],
    index,
  }));
}

describe("MessageList virtualization", () => {
  it("renders short lists directly and clears a stale virtual API", async () => {
    const apiRef: { current: MessageListHandle | null } = {
      current: { scrollToIndex: vi.fn() },
    };
    const view = render(
      <MessageList
        messages={createMessages().slice(0, 2)}
        toolAnchorIds={new Map()}
        sessionAgentKey="claudecode"
        baseDirectory="/tmp/project"
        apiRef={apiRef}
      />,
    );

    expect(view.container.querySelectorAll("[data-message-index]")).toHaveLength(2);
    await waitFor(() => expect(apiRef.current).toBeNull());
  });

  it("does not poll layout while idle", () => {
    const setInterval = vi.spyOn(window, "setInterval");

    render(
      <MessageList
        messages={createMessages()}
        toolAnchorIds={new Map()}
        sessionAgentKey="claudecode"
        baseDirectory="/tmp/project"
        apiRef={{ current: null }}
      />,
    );

    expect(setInterval).not.toHaveBeenCalled();
  });

  it("scrolls the window to an offscreen message through the virtual API", async () => {
    vi.stubGlobal("innerHeight", 0);
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
    const apiRef: { current: MessageListHandle | null } = { current: null };
    const view = render(
      <MessageList
        messages={createMessages()}
        toolAnchorIds={new Map()}
        sessionAgentKey="claudecode"
        baseDirectory="/tmp/project"
        apiRef={apiRef}
      />,
    );
    await waitFor(() => expect(apiRef.current).not.toBeNull());

    act(() => apiRef.current?.scrollToIndex(VIRTUALIZED_MESSAGE_THRESHOLD));

    expect(scrollTo).toHaveBeenCalledWith({ top: expect.any(Number), behavior: "auto" });
    expect(view.container.querySelector('[data-message-index="80"]')).not.toBeNull();

    act(() => apiRef.current?.scrollToIndex(10_000));
    expect(scrollTo).toHaveBeenCalledOnce();

    view.unmount();
    expect(apiRef.current).toBeNull();
  });

  it("scrolls a containing element through the virtual API", async () => {
    const scrollContainer = document.createElement("div");
    scrollContainer.style.overflowY = "auto";
    document.body.append(scrollContainer);
    Object.defineProperty(scrollContainer, "clientHeight", {
      configurable: true,
      value: 300,
    });
    const scrollTo = vi.fn();
    scrollContainer.scrollTo = scrollTo;
    const apiRef: { current: MessageListHandle | null } = { current: null };
    render(
      <MessageList
        messages={createMessages()}
        toolAnchorIds={new Map()}
        sessionAgentKey="claudecode"
        baseDirectory="/tmp/project"
        apiRef={apiRef}
      />,
      { container: scrollContainer },
    );
    await waitFor(() => expect(apiRef.current).not.toBeNull());

    act(() => apiRef.current?.scrollToIndex(10));

    expect(scrollTo).toHaveBeenCalledWith({ top: expect.any(Number), behavior: "auto" });
    scrollContainer.remove();
  });

  it("coalesces viewport events and cancels pending work on unmount", () => {
    const requestAnimationFrame = vi.spyOn(window, "requestAnimationFrame").mockReturnValue(42);
    const cancelAnimationFrame = vi
      .spyOn(window, "cancelAnimationFrame")
      .mockImplementation(() => undefined);
    const view = render(
      <MessageList
        messages={createMessages()}
        toolAnchorIds={new Map()}
        sessionAgentKey="claudecode"
        baseDirectory="/tmp/project"
        apiRef={{ current: null }}
      />,
    );

    fireEvent.resize(window);
    fireEvent.resize(window);
    view.unmount();

    expect(requestAnimationFrame).toHaveBeenCalledOnce();
    expect(cancelAnimationFrame).toHaveBeenCalledWith(42);
  });

  it("updates visible rows when the scroll container resizes", async () => {
    ResizeObserverMock.instances = [];
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    const scrollContainer = document.createElement("div");
    scrollContainer.style.overflowY = "auto";
    document.body.append(scrollContainer);
    let viewportHeight = 100;
    Object.defineProperty(scrollContainer, "clientHeight", {
      configurable: true,
      get: () => viewportHeight,
    });

    const view = render(
      <MessageList
        messages={createMessages()}
        toolAnchorIds={new Map()}
        sessionAgentKey="claudecode"
        baseDirectory="/tmp/project"
        apiRef={{ current: null }}
      />,
      { container: scrollContainer },
    );
    await waitFor(() =>
      expect(view.container.querySelectorAll("[data-message-index]")).toHaveLength(7),
    );

    viewportHeight = 1_400;
    ResizeObserverMock.instances.forEach((observer) => observer.trigger(scrollContainer));

    await waitFor(() =>
      expect(view.container.querySelectorAll("[data-message-index]").length).toBeGreaterThan(7),
    );
    scrollContainer.remove();
  });

  it("remeasures a row after asynchronous content growth", async () => {
    ResizeObserverMock.instances = [];
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    const view = render(
      <MessageList
        messages={createMessages()}
        toolAnchorIds={new Map()}
        sessionAgentKey="claudecode"
        baseDirectory="/tmp/project"
        apiRef={{ current: null }}
      />,
    );
    const list = view.container.firstElementChild as HTMLElement;
    const initialHeight = Number.parseInt(list.style.height, 10);
    const row = view.container.querySelector("[data-message-index]")?.parentElement as HTMLElement;
    vi.spyOn(row, "getBoundingClientRect").mockReturnValue({
      ...row.getBoundingClientRect(),
      bottom: 600,
      height: 600,
    });

    ResizeObserverMock.instances.forEach((observer) => observer.trigger(row));

    await waitFor(() => expect(Number.parseInt(list.style.height, 10)).toBe(initialHeight + 320));

    ResizeObserverMock.instances.forEach((observer) => observer.trigger(row));
    expect(Number.parseInt(list.style.height, 10)).toBe(initialHeight + 320);
  });
});
