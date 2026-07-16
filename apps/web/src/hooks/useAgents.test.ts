import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { AgentInfo } from "../lib/api";
import * as api from "../lib/api";
import { useAgents } from "./useAgents";

vi.mock("../lib/api", () => ({ fetchAgents: vi.fn() }));

const agents = [
  { name: "ClaudeCode", displayName: "Claude Code", count: 1 },
] as unknown as AgentInfo[];

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("useAgents", () => {
  it("refresh populates agents and lookup derivations", async () => {
    vi.mocked(api.fetchAgents).mockResolvedValue(agents);
    const { result } = renderHook(() => useAgents());
    const controller = new AbortController();

    await act(async () => {
      await result.current.refresh(undefined, { signal: controller.signal });
    });
    expect(result.current.agents).toEqual(agents);
    expect(result.current.validAgentKeys.has("claudecode")).toBe(true);
    expect(result.current.agentNameMap.get("claudecode")).toBe("Claude Code");
    expect(api.fetchAgents).toHaveBeenCalledWith(undefined, { signal: controller.signal });
  });
});
