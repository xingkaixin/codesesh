import { useCallback, useState } from "react";
import { type ProjectGroup, fetchProjects } from "../lib/api";

/**
 * Owns the project list. Refresh tolerates failures (keeps the UI usable) and
 * is driven by useInitialLoad / useLiveSync.
 */
export function useProjects() {
  const [projects, setProjects] = useState<ProjectGroup[]>([]);

  const refresh = useCallback(async () => {
    try {
      const result = await fetchProjects();
      setProjects(result.projects);
      return result.projects;
    } catch (err) {
      console.error("Failed to load projects:", err);
      setProjects([]);
      return [];
    }
  }, []);

  return { projects, refresh };
}
