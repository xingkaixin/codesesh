import { useCallback, useEffect, useState } from "react";
import { type AppConfig, type DashboardData, fetchDashboard } from "../lib/api";

/**
 * Owns the top-level dashboard: fetches once the app window is known and
 * exposes refresh() for the live-update subscription.
 */
export function useDashboard(window: AppConfig["window"] | null) {
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);

  useEffect(() => {
    if (!window) return;
    let cancelled = false;
    void fetchDashboard(window)
      .then((data) => {
        if (!cancelled) setDashboard(data);
      })
      .catch((err) => {
        console.error("Failed to load dashboard:", err);
      });
    return () => {
      cancelled = true;
    };
  }, [window]);

  const refresh = useCallback(async () => {
    try {
      const data = await fetchDashboard(window ?? undefined);
      setDashboard(data);
    } catch (err) {
      console.error("Failed to refresh dashboard:", err);
    }
  }, [window]);

  return { dashboard, refresh };
}
