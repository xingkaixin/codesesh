import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { AppConfig, SessionHead } from "../lib/api";
import * as api from "../lib/api";
import { useSessions } from "./useSessions";

vi.mock("../lib/api", () => ({ fetchSessions: vi.fn() }));

const window = { from: "a", to: "b" } as unknown as AppConfig["window"];
const sessions = [{ id: "s1" }] as unknown as SessionHead[];

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("useSessions", () => {
  it("refresh(window) loads the session list", async () => {
    vi.mocked(api.fetchSessions).mockResolvedValue({ sessions });
    const { result } = renderHook(() => useSessions());
    const controller = new AbortController();

    await act(async () => {
      await result.current.refresh(window, { signal: controller.signal });
    });
    expect(result.current.sessions).toEqual(sessions);
    expect(api.fetchSessions).toHaveBeenCalledWith(
      { from: "a", to: "b" },
      { signal: controller.signal },
    );
  });
});
