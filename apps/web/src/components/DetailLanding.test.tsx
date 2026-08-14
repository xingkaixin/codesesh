import { cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentCatalog } from "../lib/agents";
import type { IndexedSession } from "../lib/session-indexes";
import { DetailLanding } from "./DetailLanding";

afterEach(cleanup);

describe("DetailLanding", () => {
  it("reuses session aggregates across unrelated parent renders", () => {
    const readMessageCount = vi.fn(() => 3);
    const stats = {
      total_input_tokens: 5,
      total_output_tokens: 8,
      total_cost: 0.1,
    } as IndexedSession["stats"];
    Object.defineProperty(stats, "message_count", { get: readMessageCount });
    const sessions: IndexedSession[] = [
      {
        id: "session-1",
        sessionId: "session-1",
        agentKey: "codex",
        reference: "codex/session-1",
        slug: "codex/session-1",
        title: "Session",
        directory: "/repo",
        time_created: 1,
        time_updated: 2,
        stats,
      },
    ];
    const props = {
      type: "global" as const,
      agentCatalog: createAgentCatalog([]),
      sessions,
      agentItems: [],
      isBookmarked: vi.fn(() => false),
      onToggleBookmark: vi.fn(),
    };
    const view = render(
      <MemoryRouter>
        <DetailLanding {...props} />
      </MemoryRouter>,
    );
    const readsAfterFirstRender = readMessageCount.mock.calls.length;
    expect(readsAfterFirstRender).toBeGreaterThan(0);

    view.rerender(
      <MemoryRouter>
        <DetailLanding {...props} />
      </MemoryRouter>,
    );

    expect(readMessageCount).toHaveBeenCalledTimes(readsAfterFirstRender);
  });

  it("CS-258: reuses the accessible agent panel across landing states", () => {
    const props = {
      type: "global" as const,
      agentCatalog: createAgentCatalog([]),
      sessions: [],
      agentItems: [{ key: "codex", name: "Codex", count: 2 }],
      isBookmarked: vi.fn(() => false),
      onToggleBookmark: vi.fn(),
    };
    const view = render(
      <MemoryRouter>
        <DetailLanding {...props} />
      </MemoryRouter>,
    );
    const globalLink = view.getByRole("link", { name: /Codex/ });
    const globalClassName = globalLink.className;

    expect(globalLink.getAttribute("href")).toBe("/codex");
    expect(globalClassName).toContain("focus-visible:ring-2");

    view.rerender(
      <MemoryRouter>
        <DetailLanding {...props} type="missing-agent" attemptedAgentKey="unknown" />
      </MemoryRouter>,
    );

    expect(view.getByRole("link", { name: /Codex/ }).className).toBe(globalClassName);
  });
});
