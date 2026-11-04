import { act, cleanup, render, screen } from "@testing-library/react";
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

  it("summarizes the busiest slot, period shares and weekend share", () => {
    render(<OverviewActiveHours activity={activity} />);
    expect(screen.getByText("Most active").parentElement!.textContent).toContain("Sun 00:00–02:00");
    const share = (term: string) => screen.getByText(term).nextElementSibling?.textContent;
    expect(share("Overnight")).toBe("100%");
    expect(share("Evening")).toBe("0%");
    expect(share("Weekend")).toBe("80%");
  });
});
