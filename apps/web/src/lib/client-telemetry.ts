import type { RemoteAccess } from "./remote-access";

export function createClientTelemetry(access: RemoteAccess) {
  return Object.freeze({
    logClientEvent(event: string, data: Record<string, unknown> = {}): void {
      const body = JSON.stringify({ event, data });

      try {
        if (!access.hasCredentials && typeof navigator !== "undefined" && navigator.sendBeacon) {
          const blob = new Blob([body], { type: "application/json" });
          if (navigator.sendBeacon("/api/logs", blob)) return;
        }
      } catch {}

      void fetch(
        "/api/logs",
        access.authorize({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          keepalive: true,
        }),
      ).catch(() => {});
    },
  });
}
