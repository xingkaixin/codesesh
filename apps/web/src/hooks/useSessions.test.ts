import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { AppConfig, SessionHead, SessionsUpdatedEvent } from "../lib/api";
import * as api from "../lib/api";
import * as liveUpdate from "../lib/live-update";
import { useSessions } from "./useSessions";

vi.mock("../lib/api", () => ({ fetchSessions: vi.fn() }));
vi.mock("../lib/live-update", () => ({ applyLiveSessionUpdate: vi.fn() }));

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

    await act(async () => {
      await result.current.refresh(window);
    });
    expect(result.current.sessions).toEqual(sessions);
    expect(api.fetchSessions).toHaveBeenCalledWith({ from: "a", to: "b" });
  });

  it("applyLiveEvent applies an incremental update", () => {
    const updated = [{ id: "s2" }] as unknown as SessionHead[];
    vi.mocked(liveUpdate.applyLiveSessionUpdate).mockReturnValue(updated);
    const { result } = renderHook(() => useSessions());

    act(() => result.current.applyLiveEvent({} as SessionsUpdatedEvent));
    expect(result.current.sessions).toEqual(updated);
  });
});
