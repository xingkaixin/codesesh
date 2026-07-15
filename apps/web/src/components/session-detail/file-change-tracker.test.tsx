import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FileChangeSummary } from "./file-change";
import { FileChangeTracker } from "./file-change-tracker";

const summary: FileChangeSummary = {
  read: [
    {
      path: "/workspace/README.md",
      count: 1,
      latestTime: 1,
      latestAnchorId: "tool-1-0",
      toolLabel: "Read",
      anchors: [{ anchorId: "tool-1-0", time: 1, toolLabel: "Read" }],
    },
  ],
  edit: [],
  write: [],
  delete: [],
};

afterEach(cleanup);

describe("FileChangeTracker", () => {
  it("uses smooth scrolling for pointer activation", () => {
    const onJumpToAnchor = vi.fn();
    const view = render(
      <FileChangeTracker
        summary={summary}
        baseDirectory="/workspace"
        onJumpToAnchor={onJumpToAnchor}
      />,
    );

    fireEvent.click(view.getByRole("button", { name: /Read/ }));
    fireEvent.click(view.getByTitle("/workspace/README.md"), { detail: 1 });

    expect(onJumpToAnchor).toHaveBeenCalledWith("tool-1-0", "smooth");
  });

  it("uses immediate scrolling for keyboard activation", () => {
    const onJumpToAnchor = vi.fn();
    const view = render(
      <FileChangeTracker
        summary={summary}
        baseDirectory="/workspace"
        onJumpToAnchor={onJumpToAnchor}
      />,
    );

    fireEvent.click(view.getByRole("button", { name: /Read/ }));
    fireEvent.click(view.getByTitle("/workspace/README.md"), { detail: 0 });

    expect(onJumpToAnchor).toHaveBeenCalledWith("tool-1-0", "auto");
  });
});
