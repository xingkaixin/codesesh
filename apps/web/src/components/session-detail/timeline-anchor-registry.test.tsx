import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTimelineAnchorRegistry,
  TimelineAnchorRegistryProvider,
  useTimelineAnchorRef,
} from "./timeline-anchor-registry";

afterEach(cleanup);

function Anchor({ anchorId }: { anchorId: string }) {
  return <div ref={useTimelineAnchorRef(anchorId)} />;
}

describe("TimelineAnchorRegistry", () => {
  it("owns anchor registration for the rendered message tree", () => {
    const registry = createTimelineAnchorRegistry();
    const view = render(
      <TimelineAnchorRegistryProvider registry={registry}>
        <Anchor anchorId="message-1" />
      </TimelineAnchorRegistryProvider>,
    );

    expect(registry.get("message-1")).toBe(view.container.firstElementChild);

    view.unmount();
    expect(registry.get("message-1")).toBeUndefined();
  });

  it("publishes dynamic mount and unmount changes", () => {
    const registry = createTimelineAnchorRegistry();
    const listener = vi.fn();
    registry.subscribe(listener);
    const element = document.createElement("div");

    registry.register("tool-1", element);
    registry.register("tool-1", null);

    expect(listener).toHaveBeenNthCalledWith(1, "tool-1", element, undefined);
    expect(listener).toHaveBeenNthCalledWith(2, "tool-1", null, element);
  });
});
