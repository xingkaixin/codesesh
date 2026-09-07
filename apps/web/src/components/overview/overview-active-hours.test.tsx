import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { setLanguagePreference } from "../../i18n/language";
import { OverviewActiveHours } from "./overview-active-hours";

const counts = Array<number>(84).fill(0);
counts[0] = 4;
counts[12] = 1;
const activity = { timeZone: "Asia/Shanghai", counts };
afterEach(() => {
  cleanup();
  setLanguagePreference("en");
});

describe("active hours chart", () => {
  it("reorders weekdays when language changes without moving message counts", () => {
    render(<OverviewActiveHours activity={activity} />);
    expect(screen.getAllByRole("rowheader")[0]!.textContent).toBe("Sun");
    act(() => setLanguagePreference("zh-CN"));
    expect(screen.getAllByRole("rowheader")[0]!.textContent).toBe("周一");
    expect(screen.getByRole("button", { name: "周日 · 00:00–02:00 · 4 条用户消息" })).toBeTruthy();
    act(() => setLanguagePreference("ja"));
    expect(screen.getAllByRole("rowheader")[0]!.textContent).toBe("日");
    expect(screen.getByText("タイムゾーン：Asia/Shanghai")).toBeTruthy();
  });

  it("exposes exact counts with hover, keyboard and touch", () => {
    render(<OverviewActiveHours activity={activity} />);
    const sunday = screen.getByRole("button", { name: "Sun · 00:00–02:00 · 4 user messages" });
    const monday = screen.getByRole("button", { name: "Mon · 00:00–02:00 · 1 user messages" });
    expect(sunday.textContent).toBe("");
    expect(monday.textContent).toBe("");
    expect(screen.getAllByRole("rowheader")).toHaveLength(7);
    expect(
      screen
        .getAllByRole("columnheader")
        .slice(1)
        .map((header) => header.textContent),
    ).toEqual(["00", "02", "04", "06", "08", "10", "12", "14", "16", "18", "20", "22"]);
    fireEvent.mouseEnter(sunday);
    expect(screen.getByRole("tooltip").textContent).toBe(sunday.getAttribute("aria-label"));
    fireEvent.mouseLeave(sunday);
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.focus(monday);
    expect(screen.getByRole("tooltip").textContent).toBe(monday.getAttribute("aria-label"));
    fireEvent.keyDown(monday, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.click(sunday);
    expect(screen.getByRole("tooltip")).toBeTruthy();
    fireEvent.blur(sunday);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("keeps large counts out of cells and shows the full peak and tooltip", () => {
    render(<OverviewActiveHours activity={{ ...activity, counts: [1234567] }} />);
    expect(screen.getByText("Peak: 1,234,567")).toBeTruthy();
    const cell = screen.getByRole("button", {
      name: "Sun · 00:00–02:00 · 1,234,567 user messages",
    });
    expect(cell.textContent).toBe("");
    fireEvent.click(cell);
    expect(screen.getByRole("tooltip").textContent).toBe(cell.getAttribute("aria-label"));
  });

  it("distinguishes an empty range from unavailable data", () => {
    const { rerender } = render(
      <OverviewActiveHours activity={{ ...activity, counts: Array<number>(84).fill(0) }} />,
    );
    expect(screen.getByText("No user messages in this range.")).toBeTruthy();
    const cells = screen.getAllByRole("button");
    expect(cells).toHaveLength(84);
    expect(cells.every((cell) => cell.textContent === "")).toBe(true);
    fireEvent.click(cells[0]!);
    expect(screen.getByRole("tooltip").textContent).toContain("0 user messages");
    rerender(<OverviewActiveHours activity={null} />);
    expect(screen.getByText("Activity data is unavailable.")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });
});
