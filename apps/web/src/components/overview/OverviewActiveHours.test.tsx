import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { setLanguagePreference } from "../../i18n/language";
import { OverviewActiveHours } from "./OverviewActiveHours";

const counts = Array<number>(84).fill(0);
counts[0] = 4;
counts[12] = 1;
const activity = { timeZone: "Asia/Shanghai", counts };
afterEach(() => {
  cleanup();
  setLanguagePreference("en");
});

describe("active hours chart", () => {
  const rowHeaders = () => screen.getAllByRole("rowheader").map((header) => header.textContent);
  const dotSize = (element: Element) => Number.parseFloat((element as HTMLElement).style.width);

  it("reorders weekdays when language changes without moving message counts", () => {
    render(<OverviewActiveHours activity={activity} />);
    expect(rowHeaders()).toEqual(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]);
    act(() => setLanguagePreference("zh-CN"));
    expect(rowHeaders()[0]).toBe("周一");
    expect(screen.getByRole("button", { name: "周日 · 00:00–02:00 · 4 条用户消息" })).toBeTruthy();
    act(() => setLanguagePreference("ja"));
    expect(rowHeaders()[0]).toBe("日");
    expect(screen.getByText(/タイムゾーン：Asia\/Shanghai/)).toBeTruthy();
  });

  it("scales dot area and exposes counts with hover, keyboard and touch", () => {
    render(<OverviewActiveHours activity={activity} />);
    expect(screen.getAllByRole("button")).toHaveLength(84);
    const sunday = screen.getByRole("button", { name: "Sun · 00:00–02:00 · 4 user messages" });
    const monday = screen.getByRole("button", { name: "Mon · 00:00–02:00 · 1 user messages" });
    expect(dotSize(sunday.firstElementChild!) ** 2 / dotSize(monday.firstElementChild!) ** 2).toBe(
      4,
    );
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

  it("summarizes the busiest slot, period shares and weekend share", () => {
    render(<OverviewActiveHours activity={activity} />);
    expect(screen.getByText("Most active").parentElement!.textContent).toContain("Sun 00:00–02:00");
    const share = (term: string) => screen.getByText(term).nextElementSibling?.textContent;
    expect(share("Overnight")).toBe("100%");
    expect(share("Evening")).toBe("0%");
    expect(share("Weekend")).toBe("80%");
  });

  it.each([2342, 7, 1])("shows a relative area legend and the exact peak of %i", (peak) => {
    render(<OverviewActiveHours activity={{ ...activity, counts: [peak] }} />);
    const legend = screen.getByLabelText("Size reference (messages)");
    expect(legend.textContent).toBe("LessMore");
    expect(Array.from(legend.querySelectorAll("span"), dotSize)).toEqual([6, 12, 18]);
    expect(screen.getByText(`Peak: ${peak.toLocaleString("en-US")}`)).toBeTruthy();
  });

  it("distinguishes an empty range from unavailable data", () => {
    const { rerender } = render(
      <OverviewActiveHours activity={{ ...activity, counts: Array<number>(84).fill(0) }} />,
    );
    expect(screen.getByText("No user messages in this range.")).toBeTruthy();
    expect(screen.queryByText("Most active")).toBeNull();
    rerender(<OverviewActiveHours activity={null} />);
    expect(screen.getByText("Activity data is unavailable.")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });
});
