import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FilteredSessionMessage } from "./toc";
import { MessageList, VIRTUALIZED_MESSAGE_THRESHOLD } from "./message-list";

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
  });
});
