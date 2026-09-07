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
const LIVE_RECOVERY_RETRY_MS = 5_000;

export function useLiveSync({ applyLiveEvent, resyncLiveState, setScanStatus }: LiveSyncDeps) {
  const [newSessionCount, setNewSessionCount] = useState<number | null>(null);
  const [connectionState, setConnectionState] = useState<
    "connected" | "disconnected" | "recovering"
  >("connected");
  const pendingEventRef = useRef<SessionsUpdatedEvent | null>(null);
  const pendingTimerRef = useRef<number | null>(null);
  const updateChainRef = useRef(Promise.resolve());
  const startRecoveryRef = useRef(() => {});

  const syncLiveUpdate = useEffectEvent(async (event: SessionsUpdatedEvent) => {
    try {
      const result = await applyLiveEvent(event);
      if (result && result.visibleNewSessions > 0) {
        setNewSessionCount(result.visibleNewSessions);
      }
    } catch (error) {
      console.error("Failed to sync live session update:", error);
      startRecoveryRef.current();
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

  const resync = useEffectEvent(async () => {
    await updateChainRef.current;
    await resyncLiveState();
  });

  useEffect(() => {
    let cancelRecovery = () => {};
    const startRecovery = () => {
      cancelRecovery();
      clearPendingLiveUpdate();
      setConnectionState("recovering");
      let cancelled = false;
      let retryTimer: ReturnType<typeof setTimeout> | undefined;
      cancelRecovery = () => {
        cancelled = true;
        clearTimeout(retryTimer);
      };
      const recover = async () => {
        try {
          await resync();
          if (!cancelled) setConnectionState("connected");
        } catch (error) {
          if (cancelled) return;
          console.error("Failed to resync live session state:", error);
          retryTimer = setTimeout(() => void recover(), LIVE_RECOVERY_RETRY_MS);
        }
      };
      void recover();
    };
    startRecoveryRef.current = startRecovery;
    const unsubscribe = subscribeSessionUpdates(
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
      () => {
        startRecoveryRef.current = startRecovery;
        startRecovery();
      },
      () => {
        startRecoveryRef.current = () => {};
        cancelRecovery();
        setConnectionState("disconnected");
      },
    );
    return () => {
      startRecoveryRef.current = () => {};
      cancelRecovery();
      unsubscribe();
    };
  }, [setScanStatus]);

  useEffect(() => () => clearPendingLiveUpdate(), []);

  useEffect(() => {
    if (!newSessionCount) return;
    const timer = window.setTimeout(() => setNewSessionCount(null), 3500);
    return () => window.clearTimeout(timer);
  }, [newSessionCount]);

  return {
    liveNotice:
      connectionState === "disconnected"
        ? t("Live updates disconnected; reconnecting…")
        : connectionState === "recovering"
          ? t("Live data may be out of date; synchronizing…")
          : newSessionCount == null
            ? null
            : t("{0} new sessions found; the list refreshed automatically", [newSessionCount]),
  };
}
