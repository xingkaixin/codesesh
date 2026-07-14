import { useCallback, useEffect, useState } from "react";
import {
  type AppConfig,
  type DashboardData,
  type ProjectIdentityKind,
  fetchDashboard,
} from "../lib/api";

/**
 * Owns the project-scoped dashboard and its agent filter: fetches when the
 * active project or filter changes, resets the filter on project switch, and
 * exposes refresh() for the live-update subscription.
 */
export function useProjectDashboard(
  window: AppConfig["window"] | null,
  activeProjectKind: ProjectIdentityKind | null,
  activeProjectKey: string | null,
  activeProjectIdentityKey: string | null,
) {
  const [projectDashboard, setProjectDashboard] = useState<DashboardData | null>(null);
  const [projectDashboardLoading, setProjectDashboardLoading] = useState(false);
  const [projectDashboardError, setProjectDashboardError] = useState<string | null>(null);
  const [selectedProjectAgent, setSelectedProjectAgent] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (activeProjectIdentityKey) setSelectedProjectAgent(undefined);
  }, [activeProjectIdentityKey]);

  useEffect(() => {
    if (!activeProjectKey || !window) {
      setProjectDashboard(null);
      setProjectDashboardError(null);
      setProjectDashboardLoading(false);
      return;
    }

    let cancelled = false;
    setProjectDashboardLoading(true);
    setProjectDashboardError(null);

    void fetchDashboard(window, {
      projectKind: activeProjectKind ?? undefined,
      projectKey: activeProjectKey,
      agent: selectedProjectAgent,
    })
      .then((data) => {
        if (cancelled) return;
        setProjectDashboard(data);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error("Failed to load project dashboard:", err);
        setProjectDashboard(null);
        setProjectDashboardError("Failed to load project dashboard");
      })
      .finally(() => {
        if (cancelled) return;
        setProjectDashboardLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [activeProjectKind, activeProjectKey, selectedProjectAgent, window]);

  const refresh = useCallback(async () => {
    if (!activeProjectKey || !window) return;
    try {
      const data = await fetchDashboard(window, {
        projectKind: activeProjectKind ?? undefined,
        projectKey: activeProjectKey,
        agent: selectedProjectAgent,
      });
      setProjectDashboard(data);
    } catch (err) {
      console.error("Failed to refresh project dashboard:", err);
    }
  }, [activeProjectKind, activeProjectKey, selectedProjectAgent, window]);

  return {
    projectDashboard,
    projectDashboardLoading,
    projectDashboardError,
    selectedProjectAgent,
    setSelectedProjectAgent,
    refresh,
  };
}
