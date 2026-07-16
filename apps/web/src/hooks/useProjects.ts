import { useCallback, useState } from "react";
import { type AppConfig, type FetchOptions, type ProjectGroup, fetchProjects } from "../lib/api";

/**
 * Owns the project list. Refresh tolerates failures (keeps the UI usable) and
 * is driven by useWindowedDataLoad / useLiveSync.
 */
export function useProjects() {
  const [projects, setProjects] = useState<ProjectGroup[]>([]);

  const refresh = useCallback(async (window?: AppConfig["window"], options?: FetchOptions) => {
    try {
      const result = await fetchProjects(window, options);
      setProjects(result.projects);
      return result.projects;
    } catch (err) {
      if (options?.signal?.aborted) throw err;
      console.error("Failed to load projects:", err);
      setProjects([]);
      return [];
    }
  }, []);

  return { projects, refresh };
}
