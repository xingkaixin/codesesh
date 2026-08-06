import { useQuery } from "@tanstack/react-query";
import {
  type AppConfig,
  type DashboardData,
  type DashboardFilters,
  fetchDashboard,
} from "../lib/api";
import { queryKeys } from "../lib/query-keys";

export type { DashboardFilters };

export function useDashboard(
  window: AppConfig["window"] | null,
  filters: DashboardFilters,
): { dashboard: DashboardData | null; loading: boolean; error: string | null } {
  const isEnabled = window !== null;

  const query = useQuery({
    queryKey: queryKeys.dashboard(window ?? {}, filters),
    enabled: isEnabled,
    queryFn: async ({ signal }) => {
      if (!window) throw new Error("Dashboard window is required");
      try {
        return await fetchDashboard(window, filters, { signal });
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
  };
}
