import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Link, MemoryRouter, useLocation } from "react-router-dom";
import { useTimeWindow } from "./useTimeWindow";

afterEach(cleanup);

function TimeWindowHarness({ observedPresets }: { observedPresets: Array<string | null> }) {
  const location = useLocation();
  const controller = useTimeWindow({ days: 7 });
  observedPresets.push(controller.preset);

  return (
    <>
      <span data-testid="preset">{controller.preset}</span>
      <span data-testid="search">{location.search}</span>
      <Link to="/session">Open session</Link>
      <button type="button" onClick={() => controller.selectPreset("30d")}>
        Select 30 days
      </button>
      <button type="button" onClick={() => controller.selectCustom("2026-04-01", "2026-04-30")}>
        Select custom
      </button>
    </>
  );
}

describe("useTimeWindow", () => {
  it("does not fall back to the default while restoring range after navigation", () => {
    const observedPresets: Array<string | null> = [];
    render(
      <MemoryRouter initialEntries={["/?range=14d"]}>
        <TimeWindowHarness observedPresets={observedPresets} />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("link", { name: "Open session" }));

    expect(screen.getByTestId("preset").textContent).toBe("14d");
    expect(screen.getByTestId("search").textContent).toBe("?range=14d");
    expect(observedPresets).not.toContain("7d");
  });

  it("writes preset and custom selections to the current URL", () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <TimeWindowHarness observedPresets={[]} />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Select 30 days" }));
    expect(screen.getByTestId("search").textContent).toBe("?range=30d");

    fireEvent.click(screen.getByRole("button", { name: "Select custom" }));
    expect(screen.getByTestId("search").textContent).toBe(
      "?range=custom&from=2026-04-01&to=2026-04-30",
    );
  });
});
