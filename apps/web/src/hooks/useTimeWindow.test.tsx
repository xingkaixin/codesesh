import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Link, MemoryRouter, useLocation } from "react-router-dom";
import { useTimeWindow } from "./useTimeWindow";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

type ResolveWindow = ReturnType<typeof useTimeWindow>["resolve"];

function TimeWindowHarness({
  observedPresets,
  observedResolvers,
}: {
  observedPresets: Array<string | null>;
  observedResolvers?: ResolveWindow[];
}) {
  const location = useLocation();
  const controller = useTimeWindow({ days: 7 });
  observedPresets.push(controller.preset);
  observedResolvers?.push(controller.resolve);

  return (
    <>
      <span data-testid="preset">{controller.preset}</span>
      <span data-testid="search">{location.search}</span>
      <span data-testid="from">{controller.timeWindow?.from}</span>
      <span data-testid="to">{controller.timeWindow?.to}</span>
      <Link to="/session">Open session</Link>
      <Link to="/?range=14d&view=timeline">Change view</Link>
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

  it("keeps the resolver stable when unrelated URL parameters change", () => {
    const observedResolvers: ResolveWindow[] = [];
    render(
      <MemoryRouter initialEntries={["/?range=14d"]}>
        <TimeWindowHarness observedPresets={[]} observedResolvers={observedResolvers} />
      </MemoryRouter>,
    );
    const initialResolver = observedResolvers.at(-1);

    fireEvent.click(screen.getByRole("link", { name: "Change view" }));

    expect(observedResolvers.at(-1)).toBe(initialResolver);
  });

  it("refreshes a rolling preset at local midnight", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 15, 23, 59, 59, 900));
    render(
      <MemoryRouter initialEntries={["/?range=7d"]}>
        <TimeWindowHarness observedPresets={[]} />
      </MemoryRouter>,
    );

    expect(screen.getByTestId("to").textContent).toBe(String(new Date(2026, 6, 16).getTime() - 1));

    act(() => vi.advanceTimersByTime(100));

    expect(screen.getByTestId("to").textContent).toBe(String(new Date(2026, 6, 17).getTime() - 1));
  });

  it("keeps a custom range fixed across local midnight", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 15, 23, 59, 59, 900));
    render(
      <MemoryRouter initialEntries={["/?range=custom&from=2026-07-01&to=2026-07-15"]}>
        <TimeWindowHarness observedPresets={[]} />
      </MemoryRouter>,
    );
    const initialFrom = screen.getByTestId("from").textContent;
    const initialTo = screen.getByTestId("to").textContent;

    act(() => vi.advanceTimersByTime(48 * 60 * 60 * 1000));

    expect(screen.getByTestId("from").textContent).toBe(initialFrom);
    expect(screen.getByTestId("to").textContent).toBe(initialTo);
  });
});
