import { useQuery } from "@tanstack/react-query";
import { useCallback } from "react";
import { type AppConfig, type DashboardData, type DashboardFilters } from "../lib/api";
import { dashboardQueryOptions } from "../lib/dashboard-query";

export type { DashboardFilters };

export function useDashboard(
  window: AppConfig["window"] | null,
  filters: DashboardFilters,
): {
  dashboard: DashboardData | null;
  loading: boolean;
  error: string | null;
  retry: () => Promise<void>;
} {
  const isEnabled = window !== null;

  const query = useQuery({
    ...dashboardQueryOptions(window ?? {}, filters),
    enabled: isEnabled,
  });
  const refetch = query.refetch;
  const retry = useCallback(async () => {
    await refetch();
  }, [refetch]);

  return {
    dashboard: isEnabled ? (query.data ?? null) : null,
    loading: isEnabled && query.isPending,
    error:
      isEnabled && query.isError
        ? query.error instanceof Error
          ? query.error.message
          : "Unable to load dashboard."
        : null,
    retry,
  };
}
