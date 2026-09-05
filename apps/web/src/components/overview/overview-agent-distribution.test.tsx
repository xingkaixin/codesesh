import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { DashboardAgentStat } from "../../lib/api";
import { OverviewAgentDistribution } from "./overview-agent-distribution";

const perAgent: DashboardAgentStat[] = [
  {
    name: "codex",
    displayName: "Codex",
    icon: "/icon/agent/codex.svg",
    sessions: 3,
    messages: 30,
    tokens: 3_000,
    cost: 4,
  },
  {
    name: "claudecode",
    displayName: "Claude Code",
    icon: "/icon/agent/claudecode.svg",
    sessions: 2,
    messages: 20,
    tokens: 2_000,
    cost: 2,
  },
];

afterEach(cleanup);

describe("OverviewAgentDistribution", () => {
  it("browses agent columns and announces their values from the keyboard", () => {
    render(<OverviewAgentDistribution perAgent={perAgent} />);
    const region = screen.getByRole("region", { name: "Agents" });
    const chart = within(region).getByRole("listbox", { name: "Agent distribution chart" });
    const options = within(chart).getAllByRole("option");
    const liveSummary = within(region).getByRole("status");

    fireEvent.focus(options[0]!);
    expect(liveSummary.textContent).toBe("Codex: $4.00, 3 sessions");
    expect(screen.getByRole("tooltip").textContent).toBe(
      "Codex3.0k tok · $4.003 sessions · 30 messages",
    );

    fireEvent.keyDown(options[0]!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(options[1]);
    expect(liveSummary.textContent).toBe("Claude Code: $2.00, 2 sessions");
    expect(screen.getByRole("tooltip").textContent).toBe(
      "Claude Code2.0k tok · $2.002 sessions · 20 messages",
    );

    fireEvent.keyDown(options[1]!, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
});
