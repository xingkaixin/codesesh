import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Link, MemoryRouter, useLocation } from "react-router-dom";
import type { TimeWindow } from "../lib/time-window";
import { useTimeWindow } from "./useTimeWindow";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function TimeWindowHarness({
  observedPresets,
  defaultWindow = { days: 7 },
}: {
  observedPresets: Array<string | null>;
  defaultWindow?: TimeWindow;
}) {
  const location = useLocation();
  const controller = useTimeWindow(defaultWindow);
  observedPresets.push(controller.preset);

  return (
    <>
      <span data-testid="preset">{controller.preset}</span>
      <span data-testid="search">{location.search}</span>
      <span data-testid="from">{controller.timeWindow?.from}</span>
      <span data-testid="to">{controller.timeWindow?.to}</span>
      <Link to="/session">Open session</Link>
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

  it.each(["/", "/?range=7d"])("refreshes a rolling preset at local midnight from %s", (url) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 15, 23, 59, 59, 900));
    render(
      <MemoryRouter initialEntries={[url]}>
        <TimeWindowHarness
          observedPresets={[]}
          defaultWindow={{ from: new Date(2026, 5, 9).getTime(), days: 7 }}
        />
      </MemoryRouter>,
    );

    expect(screen.getByTestId("preset").textContent).toBe("7d");
    expect(screen.getByTestId("from").textContent).toBe(String(new Date(2026, 6, 9).getTime()));
    expect(screen.getByTestId("to").textContent).toBe(String(new Date(2026, 6, 16).getTime() - 1));

    act(() => vi.advanceTimersByTime(100));

    expect(screen.getByTestId("preset").textContent).toBe("7d");
    expect(screen.getByTestId("from").textContent).toBe(String(new Date(2026, 6, 10).getTime()));
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
