import { useEffect, useRef } from "react";
import { type AppConfig, logClientEvent } from "../lib/api";

interface WindowLoadTelemetry {
  window: AppConfig["window"] | null;
  pending: boolean;
  error: string | null;
  agentCount: number;
  sessionCount: number;
}

export function useWindowLoadTelemetry({
  window,
  pending,
  error,
  agentCount,
  sessionCount,
}: WindowLoadTelemetry): void {
  const startedAtRef = useRef<number | null>(null);

  useEffect(() => {
    startedAtRef.current = window ? performance.now() : null;
    if (window) logClientEvent("app.load.start");
  }, [window]);

  useEffect(() => {
    const startedAt = startedAtRef.current;
    if (startedAt === null || pending) return;
    const duration_ms = Math.round(performance.now() - startedAt);
    startedAtRef.current = null;
    if (error) {
      console.error("Failed to load data:", error);
      logClientEvent("app.load.error", { duration_ms });
      return;
    }
    logClientEvent("app.load.done", {
      duration_ms,
      agents: agentCount,
      sessions: sessionCount,
    });
  }, [agentCount, error, pending, sessionCount, window]);
}
