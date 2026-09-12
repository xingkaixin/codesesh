import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { OverviewModelTokens } from "./overview-model-tokens";

afterEach(cleanup);

describe("OverviewModelTokens", () => {
  it("shows exact token values through keyboard and legend tooltips", () => {
    render(
      <OverviewModelTokens
        models={[
          { model: "sonnet", tokens: 9999, sessions: 1 },
          { model: "haiku", tokens: 1, sessions: 1 },
        ]}
        totalTokens={10000}
      />,
    );
    const chart = screen.getByRole("listbox", { name: "Model token distribution chart" });
    const options = within(chart).getAllByRole("option");

    fireEvent.focus(options[0]!);
    expect(screen.getByRole("tooltip").textContent).toContain("9,999 tokens");
    fireEvent.keyDown(options[0]!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(options[1]);
    expect(screen.getByRole("tooltip").textContent).toContain("haiku");
    expect(screen.getByRole("tooltip").textContent).toContain("1 tokens · <0.1%");
    fireEvent.keyDown(options[1]!, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();

    fireEvent.pointerEnter(screen.getByRole("button", { name: /sonnet:/ }));
    expect(screen.getByRole("tooltip").textContent).toContain("sonnet");
    fireEvent.pointerLeave(screen.getByRole("button", { name: /sonnet:/ }));
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("keeps the long tail and unknown usage in the full token total", () => {
    render(
      <OverviewModelTokens
        models={[60, 20, 10, 5, 3, 1].map((tokens, index) => ({
          model: `model-${index}`,
          tokens,
          sessions: 1,
        }))}
        totalTokens={100}
      />,
    );

    expect(screen.getByRole("option", { name: "Other: 1 tokens, 1%" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Unknown model: 1 tokens, 1%" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "model-0: 60 tokens, 60%" })).toBeTruthy();
    expect(screen.getAllByRole("option")).toHaveLength(7);
  });

  it("shows an empty state for a range with no tokens", () => {
    render(<OverviewModelTokens models={[]} totalTokens={0} />);
    expect(screen.getByText("No usage data")).toBeTruthy();
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});
