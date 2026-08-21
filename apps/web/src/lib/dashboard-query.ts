import { queryOptions } from "@tanstack/react-query";
import { type AppConfig, type DashboardFilters, fetchDashboard } from "./api";
import { queryKeys } from "./query-keys";

export const DASHBOARD_STALE_TIME_MS = 2_000;

export function dashboardQueryOptions(window: AppConfig["window"], filters: DashboardFilters) {
  return queryOptions({
    queryKey: queryKeys.dashboard(window, filters),
    staleTime: DASHBOARD_STALE_TIME_MS,
    queryFn: async ({ signal }) => {
      try {
        return await fetchDashboard(window, filters, { signal });
      } catch (error) {
        if (!signal.aborted) console.error("Failed to load dashboard:", error);
        throw error;
      }
    },
  });
}
