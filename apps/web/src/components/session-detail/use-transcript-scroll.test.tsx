import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useTranscriptScroll } from "./use-transcript-scroll";

function Transcript({ revision }: { revision: number }) {
  const ref = useTranscriptScroll(revision);
  return (
    <div ref={ref}>
      <div data-message-id="stable">Message {revision}</div>
    </div>
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("follows appended content only while the reader remains at the bottom", () => {
  const parent = document.createElement("div");
  parent.style.overflowY = "auto";
  document.body.append(parent);
  let height = 1000;
  Object.defineProperty(parent, "scrollHeight", { get: () => height });
  Object.defineProperty(parent, "clientHeight", { value: 200 });
  parent.scrollTop = 800;
  const scroll = vi.fn((options?: ScrollToOptions | number) => {
    if (typeof options === "object") parent.scrollTop = options.top ?? parent.scrollTop;
  });
  parent.scrollTo = scroll;
  const view = render(<Transcript revision={0} />, { container: parent });
  scroll.mockClear();
  height = 1400;
  fireEvent.scroll(parent);
  view.rerender(<Transcript revision={1} />);
  expect(scroll).toHaveBeenLastCalledWith({ top: 1200, behavior: "auto" });
  act(() => {
    parent.scrollTop = 400;
    fireEvent.scroll(parent);
  });
  scroll.mockClear();
  height = 1800;
  view.rerender(<Transcript revision={2} />);
  expect(scroll).not.toHaveBeenCalled();
  view.unmount();
  parent.remove();
});

it("retains the visible message when earlier content changes height", () => {
  const parent = document.createElement("div");
  parent.style.overflowY = "auto";
  document.body.append(parent);
  Object.defineProperty(parent, "scrollHeight", { value: 2000 });
  Object.defineProperty(parent, "clientHeight", { value: 200 });
  parent.scrollTop = 400;
  const scroll = vi.fn();
  parent.scrollTo = scroll;
  let top = -20;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    return { top: this.dataset.messageId ? top : 0, bottom: 100 } as DOMRect;
  });
  const view = render(<Transcript revision={0} />, { container: parent });
  scroll.mockClear();
  top = 80;
  view.rerender(<Transcript revision={1} />);
  expect(scroll).toHaveBeenLastCalledWith({ top: 500, behavior: "auto" });
  view.unmount();
  parent.remove();
});
