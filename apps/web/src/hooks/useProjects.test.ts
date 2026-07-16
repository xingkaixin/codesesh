import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ProjectGroup } from "../lib/api";
import * as api from "../lib/api";
import { useProjects } from "./useProjects";

vi.mock("../lib/api", () => ({ fetchProjects: vi.fn() }));

const projects = [{ identityKind: "path", identityKey: "p1" }] as unknown as ProjectGroup[];

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("useProjects", () => {
  it("refresh loads the project list", async () => {
    vi.mocked(api.fetchProjects).mockResolvedValue({ projects });
    const { result } = renderHook(() => useProjects());
    const controller = new AbortController();

    await act(async () => {
      await result.current.refresh(undefined, { signal: controller.signal });
    });
    expect(result.current.projects).toEqual(projects);
    expect(api.fetchProjects).toHaveBeenCalledWith(undefined, { signal: controller.signal });
  });

  it("refresh tolerates a fetch failure and returns empty", async () => {
    vi.mocked(api.fetchProjects).mockRejectedValue(new Error("boom"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { result } = renderHook(() => useProjects());

    let returned: ProjectGroup[] | undefined;
    await act(async () => {
      returned = await result.current.refresh();
    });
    expect(returned).toEqual([]);
    expect(result.current.projects).toEqual([]);
    errorSpy.mockRestore();
  });

  it("propagates aborted refreshes without clearing projects", async () => {
    vi.mocked(api.fetchProjects)
      .mockResolvedValueOnce({ projects })
      .mockRejectedValueOnce(new DOMException("Aborted", "AbortError"));
    const { result } = renderHook(() => useProjects());

    await act(async () => {
      await result.current.refresh();
    });
    const controller = new AbortController();
    controller.abort();

    await act(async () => {
      await expect(
        result.current.refresh(undefined, { signal: controller.signal }),
      ).rejects.toMatchObject({ name: "AbortError" });
    });
    expect(result.current.projects).toEqual(projects);
  });
});
