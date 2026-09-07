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
    expect(screen.getAllByRole("columnheader")[1]!.textContent).toBe("Sun");
    act(() => setLanguagePreference("zh-CN"));
    expect(screen.getAllByRole("columnheader")[1]!.textContent).toBe("周一");
    expect(screen.getByRole("button", { name: "周日 · 00:00–02:00 · 4 条用户消息" })).toBeTruthy();
    act(() => setLanguagePreference("ja"));
    expect(screen.getAllByRole("columnheader")[1]!.textContent).toBe("日");
    expect(screen.getByText("タイムゾーン：Asia/Shanghai")).toBeTruthy();
  });

  it("scales circle area and exposes counts with hover, keyboard and touch", () => {
    render(<OverviewActiveHours activity={activity} />);
    expect(screen.getAllByRole("rowheader").map((header) => header.textContent)).toEqual([
      "00:00",
      "02:00",
      "04:00",
      "06:00",
      "08:00",
      "10:00",
      "12:00",
      "14:00",
      "16:00",
      "18:00",
      "20:00",
      "22:00",
    ]);
    const sunday = screen.getByRole("button", { name: "Sun · 00:00–02:00 · 4 user messages" });
    const monday = screen.getByRole("button", { name: "Mon · 00:00–02:00 · 1 user messages" });
    const radius = (button: HTMLElement) =>
      Number(button.querySelector("circle")!.getAttribute("r"));
    expect(radius(sunday) ** 2 / radius(monday) ** 2).toBe(4);
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

  it.each([2342, 7, 1])("shows a relative area legend and the exact peak of %i", (peak) => {
    render(<OverviewActiveHours activity={{ ...activity, counts: [peak] }} />);
    const legend = screen.getByLabelText("Size reference (messages)");
    expect(legend.textContent).toBe("LessMore");
    const radii = Array.from(legend.querySelectorAll("svg"), (svg) =>
      Number(svg.querySelector("circle")!.getAttribute("r")),
    );
    expect(radii).toEqual([4, 8, 12]);
    expect(screen.getByText(`Peak: ${peak.toLocaleString("en-US")}`)).toBeTruthy();
  });

  it("distinguishes an empty range from unavailable data", () => {
    const { rerender } = render(
      <OverviewActiveHours activity={{ ...activity, counts: Array<number>(84).fill(0) }} />,
    );
    expect(screen.getByText("No user messages in this range.")).toBeTruthy();
    expect(screen.getByRole("table").querySelector("circle")).toBeNull();
    rerender(<OverviewActiveHours activity={null} />);
    expect(screen.getByText("Activity data is unavailable.")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });
});
