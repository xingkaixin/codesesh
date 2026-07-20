import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { type AppConfig, type ProjectIdentityKind, fetchDashboard } from "../lib/api";
import { queryKeys } from "../lib/query-keys";

export interface DashboardFilters {
  projectKind?: ProjectIdentityKind;
  projectKey?: string;
  identityKey?: string;
}

export function useDashboard(window: AppConfig["window"] | null, filters?: DashboardFilters) {
  const projectKind = filters?.projectKind;
  const projectKey = filters?.projectKey;
  const identityKey = filters?.identityKey;
  const isFiltered = filters !== undefined;
  const [selectedAgent, setSelectedAgent] = useState<string | undefined>(undefined);
  const isEnabled = window !== null && (!isFiltered || projectKey !== undefined);

  useEffect(() => {
    if (identityKey) setSelectedAgent(undefined);
  }, [identityKey]);

  const query = useQuery({
    queryKey: queryKeys.dashboard(window ?? {}, { projectKind, projectKey, agent: selectedAgent }),
    enabled: isEnabled,
    queryFn: async ({ signal }) => {
      if (!window) throw new Error("Dashboard window is required");
      try {
        return await fetchDashboard(
          window,
          { projectKind, projectKey, agent: selectedAgent },
          { signal },
        );
      } catch (error) {
        if (!signal.aborted) console.error("Failed to load dashboard:", error);
        throw error;
      }
    },
  });

  return {
    dashboard: isEnabled ? (query.data ?? null) : null,
    loading: isEnabled && query.isPending,
    error: isEnabled && query.isError ? "Failed to load dashboard" : null,
    selectedAgent,
    setSelectedAgent,
  };
}
