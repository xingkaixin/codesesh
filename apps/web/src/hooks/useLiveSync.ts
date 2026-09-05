import { t } from "../i18n/translate";
import { mergeSessionsUpdatedEvents } from "@codesesh/core/contract";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import {
  type ScanStatusEvent,
  type SessionsUpdatedEvent,
  subscribeSessionUpdates,
} from "../lib/api";
import type { LiveSessionApplyResult } from "./useSessionStore";

interface LiveSyncDeps {
  applyLiveEvent: (event: SessionsUpdatedEvent) => Promise<LiveSessionApplyResult | null>;
  resyncLiveState: () => Promise<void>;
  setScanStatus: (event: ScanStatusEvent) => void;
}

const LIVE_UPDATE_WINDOW_MS = 500;

export function useLiveSync({ applyLiveEvent, resyncLiveState, setScanStatus }: LiveSyncDeps) {
  const [newSessionCount, setNewSessionCount] = useState<number | null>(null);
  const [disconnected, setDisconnected] = useState(false);
  const pendingEventRef = useRef<SessionsUpdatedEvent | null>(null);
  const pendingTimerRef = useRef<number | null>(null);
  const updateChainRef = useRef(Promise.resolve());

  const syncLiveUpdate = useEffectEvent(async (event: SessionsUpdatedEvent) => {
    try {
      const result = await applyLiveEvent(event);
      if (result && result.visibleNewSessions > 0) {
        setNewSessionCount(result.visibleNewSessions);
      }
    } catch (error) {
      console.error("Failed to sync live session update:", error);
    }
  });

  const flushLiveUpdate = useEffectEvent(() => {
    pendingTimerRef.current = null;
    const event = pendingEventRef.current;
    pendingEventRef.current = null;
    if (!event) return;
    updateChainRef.current = updateChainRef.current.then(() => syncLiveUpdate(event));
  });

  const clearPendingLiveUpdate = useEffectEvent(() => {
    pendingEventRef.current = null;
    if (pendingTimerRef.current === null) return;
    window.clearTimeout(pendingTimerRef.current);
    pendingTimerRef.current = null;
  });

  const handleReconnect = useEffectEvent(async () => {
    clearPendingLiveUpdate();
    setDisconnected(false);
    try {
      await updateChainRef.current;
      await resyncLiveState();
    } catch (error) {
      console.error("Failed to resync live session state:", error);
    }
  });

  useEffect(() => {
    return subscribeSessionUpdates(
      (event) => {
        pendingEventRef.current = pendingEventRef.current
          ? mergeSessionsUpdatedEvents(pendingEventRef.current, event)
          : event;
        pendingTimerRef.current ??= window.setTimeout(
          () => flushLiveUpdate(),
          LIVE_UPDATE_WINDOW_MS,
        );
      },
      setScanStatus,
      () => void handleReconnect(),
      () => {
        setDisconnected(true);
      },
    );
  }, [setScanStatus]);

  useEffect(() => () => clearPendingLiveUpdate(), []);

  useEffect(() => {
    if (!newSessionCount) return;
    const timer = window.setTimeout(() => setNewSessionCount(null), 3500);
    return () => window.clearTimeout(timer);
  }, [newSessionCount]);

  return {
    liveNotice: disconnected
      ? t("Live updates disconnected; reconnecting…")
      : newSessionCount == null
        ? null
        : t("{0} new sessions found; the list refreshed automatically", [newSessionCount]),
  };
}
