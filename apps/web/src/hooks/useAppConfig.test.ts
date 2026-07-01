import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { AppConfig } from "../lib/api";
import * as api from "../lib/api";
import { useAppConfig } from "./useAppConfig";

vi.mock("../lib/api", () => ({ fetchConfig: vi.fn() }));

const config = { window: { from: "a", to: "b" } } as unknown as AppConfig;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("useAppConfig", () => {
  it("starts null and fetches + returns config on refresh", async () => {
    vi.mocked(api.fetchConfig).mockResolvedValue(config);
    const { result } = renderHook(() => useAppConfig());
    expect(result.current.appConfig).toBeNull();

    let returned: AppConfig | undefined;
    await act(async () => {
      returned = await result.current.refresh();
    });
    expect(result.current.appConfig).toEqual(config);
    expect(returned).toEqual(config);
  });
});
