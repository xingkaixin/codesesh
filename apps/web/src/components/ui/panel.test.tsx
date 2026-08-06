import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Eyebrow, Panel, PanelHeader } from "./panel";

afterEach(cleanup);

describe("Panel", () => {
  it("renders its children inside a section and forwards attributes", () => {
    render(
      <Panel data-testid="overview-card" aria-label="Cost by Model">
        <Eyebrow>This month</Eyebrow>
      </Panel>,
    );

    const panel = screen.getByTestId("overview-card");
    expect(panel.tagName).toBe("SECTION");
    expect(panel.getAttribute("aria-label")).toBe("Cost by Model");
    expect(panel.textContent).toBe("This month");
  });
});

describe("PanelHeader", () => {
  it("renders the title as a heading with its meta and action", () => {
    render(
      <PanelHeader title="Projects" meta="by cost · 8 total" action={<button>More</button>} />,
    );

    expect(screen.getByRole("heading", { name: "Projects" })).not.toBeNull();
    expect(screen.getByText("by cost · 8 total")).not.toBeNull();
    expect(screen.getByRole("button", { name: "More" })).not.toBeNull();
  });

  it("omits the meta node when no meta is given", () => {
    render(<PanelHeader title="Agents" />);

    expect(screen.getByRole("heading", { name: "Agents" }).parentElement?.textContent).toBe(
      "Agents",
    );
  });
});
