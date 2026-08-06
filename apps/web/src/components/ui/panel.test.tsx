import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Eyebrow, Panel, PanelHeader } from "./panel";

afterEach(cleanup);

describe("Panel", () => {
  it("renders its children inside a section and forwards attributes", () => {
    render(
      <Panel data-testid="overview-card" aria-label="花费构成">
        <Eyebrow>本月</Eyebrow>
      </Panel>,
    );

    const panel = screen.getByTestId("overview-card");
    expect(panel.tagName).toBe("SECTION");
    expect(panel.getAttribute("aria-label")).toBe("花费构成");
    expect(panel.textContent).toBe("本月");
  });
});

describe("PanelHeader", () => {
  it("renders the title as a heading with its meta and action", () => {
    render(<PanelHeader title="项目排行" meta="按花费 · 共 8 个" action={<button>更多</button>} />);

    expect(screen.getByRole("heading", { name: "项目排行" })).not.toBeNull();
    expect(screen.getByText("按花费 · 共 8 个")).not.toBeNull();
    expect(screen.getByRole("button", { name: "更多" })).not.toBeNull();
  });

  it("omits the meta node when no meta is given", () => {
    render(<PanelHeader title="Agent 分布" />);

    expect(screen.getByRole("heading", { name: "Agent 分布" }).parentElement?.textContent).toBe(
      "Agent 分布",
    );
  });
});
