import type { ScanStatusEvent, SessionsUpdatedEvent } from "@codesesh/core/contract";
import type { RemoteAccess } from "./remote-access";

const INITIAL_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;
const DISCONNECT_NOTICE_DELAY_MS = 5_000;

function jitter(delayMs: number): number {
  const spread = delayMs * 0.2;
  return delayMs + (Math.random() * 2 - 1) * spread;
}

export function createSessionUpdateSubscriber(access: RemoteAccess) {
  return function subscribeSessionUpdates(
    onUpdate: (event: SessionsUpdatedEvent) => void,
    onScanStatus?: (event: ScanStatusEvent) => void,
    onReconnect?: () => void,
    onDisconnect?: () => void,
  ): () => void {
    let disposed = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let disconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let retryDelayMs = INITIAL_RETRY_MS;
    let hasConnectedOnce = false;
    let disconnectNotified = false;
    let currentSource: EventSource | undefined;

    const clearDisconnectTimer = () => {
      if (disconnectTimer === undefined) return;
      clearTimeout(disconnectTimer);
      disconnectTimer = undefined;
    };

    const notifyDisconnect = () => {
      if (disconnectNotified) return;
      disconnectNotified = true;
      onDisconnect?.();
    };

    const connect = () => {
      const source = new EventSource(access.eventUrl("/api/events"));
      currentSource = source;

      source.addEventListener("sessions-updated", (event) => {
        try {
          onUpdate(JSON.parse(event.data) as SessionsUpdatedEvent);
        } catch (error) {
          console.error("Failed to parse session update event:", error);
        }
      });

      source.addEventListener("scan-status", (event) => {
        if (!onScanStatus) return;
        try {
          onScanStatus(JSON.parse(event.data) as ScanStatusEvent);
        } catch (error) {
          console.error("Failed to parse scan status event:", error);
        }
      });

      source.onopen = () => {
        clearDisconnectTimer();
        retryDelayMs = INITIAL_RETRY_MS;
        const recoveredFromDisconnect = disconnectNotified;
        disconnectNotified = false;
        if (hasConnectedOnce || recoveredFromDisconnect) onReconnect?.();
        hasConnectedOnce = true;
      };

      source.onerror = () => {
        if (source.readyState !== EventSource.CLOSED) {
          disconnectTimer ??= setTimeout(() => {
            disconnectTimer = undefined;
            if (!disposed && currentSource === source) notifyDisconnect();
          }, DISCONNECT_NOTICE_DELAY_MS);
          return;
        }
        clearDisconnectTimer();
        source.close();
        if (disposed) return;
        notifyDisconnect();
        const delay = jitter(retryDelayMs);
        retryDelayMs = Math.min(retryDelayMs * 2, MAX_RETRY_MS);
        retryTimer = setTimeout(connect, delay);
      };
    };

    connect();

    return () => {
      disposed = true;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      clearDisconnectTimer();
      currentSource?.close();
    };
  };
}
