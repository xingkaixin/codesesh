import { useCallback, useEffect, useState } from "react";
import {
  type AppConfig,
  type DashboardData,
  type ProjectIdentityKind,
  fetchDashboard,
} from "../lib/api";

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
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (identityKey) setSelectedAgent(undefined);
  }, [identityKey]);

  const load = useCallback(async () => {
    if (!window || (isFiltered && !projectKey)) return null;
    return fetchDashboard(window, {
      projectKind,
      projectKey,
      agent: selectedAgent,
    });
  }, [isFiltered, projectKey, projectKind, selectedAgent, window]);

  useEffect(() => {
    if (!window || (isFiltered && !projectKey)) {
      setDashboard(null);
      setError(null);
      setLoading(false);
      return;
    }

    let current = true;
    setLoading(true);
    setError(null);
    void load()
      .then((data) => {
        if (current) setDashboard(data);
      })
      .catch((loadError) => {
        if (!current) return;
        console.error("Failed to load dashboard:", loadError);
        setDashboard(null);
        setError("Failed to load dashboard");
      })
      .finally(() => {
        if (current) setLoading(false);
      });

    return () => {
      current = false;
    };
  }, [isFiltered, load, projectKey, window]);

  return {
    dashboard,
    loading,
    error,
    selectedAgent,
    setSelectedAgent,
  };
}
