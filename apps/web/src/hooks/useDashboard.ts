import { useCallback, useEffect, useState } from "react";
import { type AppConfig, type DashboardData, fetchDashboard } from "../lib/api";

/**
 * Owns the top-level dashboard: fetches once the app window is known and
 * exposes refresh() for the live-update subscription.
 */
export function useDashboard(appConfig: AppConfig | null) {
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);

  useEffect(() => {
    if (!appConfig) return;
    let cancelled = false;
    void fetchDashboard(appConfig.window)
      .then((data) => {
        if (!cancelled) setDashboard(data);
      })
      .catch((err) => {
        console.error("Failed to load dashboard:", err);
      });
    return () => {
      cancelled = true;
    };
  }, [appConfig]);

  const refresh = useCallback(async () => {
    try {
      const data = await fetchDashboard(appConfig?.window);
      setDashboard(data);
    } catch (err) {
      console.error("Failed to refresh dashboard:", err);
    }
  }, [appConfig]);

  return { dashboard, refresh };
}
