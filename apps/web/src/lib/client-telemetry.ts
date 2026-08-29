import type { RemoteAccess } from "./remote-access";

interface ClientTelemetryData {
  actual_duration_ms?: number;
  agent?: string | null;
  agents?: number;
  base_duration_ms?: number;
  commit_time_ms?: number;
  duration_ms?: number;
  error_name?: string;
  error_status?: number;
  messages?: number;
  mode?: string;
  operation_id?: string;
  phase?: string;
  profiler_id?: string;
  query_length?: number;
  reason?: string;
  request_key?: string;
  results?: number;
  session?: string | null;
  sessions?: number;
  source?: string;
  start_time_ms?: number;
  trigger?: string;
}

export function createClientTelemetry(access: RemoteAccess) {
  return Object.freeze({
    logClientEvent(event: string, data: ClientTelemetryData = {}): void {
      try {
        const body = JSON.stringify({ event, data });
        if (!access.hasCredentials && typeof navigator !== "undefined" && navigator.sendBeacon) {
          const blob = new Blob([body], { type: "application/json" });
          if (navigator.sendBeacon("/api/logs", blob)) return;
        }
        void fetch(
          "/api/logs",
          access.authorize({
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body,
            keepalive: true,
          }),
        ).catch(() => {});
      } catch {}
    },
  });
}
