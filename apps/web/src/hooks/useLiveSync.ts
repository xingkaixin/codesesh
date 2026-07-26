import { useEffect, useEffectEvent, useState } from "react";
import {
  type ScanStatusEvent,
  type SessionsUpdatedEvent,
  subscribeSessionUpdates,
} from "../lib/api";
import type { SessionStoreSnapshot } from "./useSessionStore";

interface LiveSyncDeps {
  applyLiveEvent: (event: SessionsUpdatedEvent) => Promise<SessionStoreSnapshot | null>;
  resyncLiveState: () => Promise<SessionStoreSnapshot | null>;
  setScanStatus: (event: ScanStatusEvent) => void;
}

export function useLiveSync({ applyLiveEvent, resyncLiveState, setScanStatus }: LiveSyncDeps) {
  const [liveNotice, setLiveNotice] = useState<string | null>(null);
  const [connectionNotice, setConnectionNotice] = useState<string | null>(null);

  const syncLiveUpdate = useEffectEvent(async (event: SessionsUpdatedEvent) => {
    try {
      const snapshot = await applyLiveEvent(event);
      if (snapshot && event.newSessions > 0) {
        setLiveNotice(`发现 ${event.newSessions} 个新会话，列表已自动刷新`);
      }
    } catch (error) {
      console.error("Failed to sync live session update:", error);
    }
  });

  const handleReconnect = useEffectEvent(async () => {
    setConnectionNotice(null);
    try {
      await resyncLiveState();
    } catch (error) {
      console.error("Failed to resync live session state:", error);
    }
  });

  useEffect(() => {
    return subscribeSessionUpdates(
      (event) => {
        void syncLiveUpdate(event);
      },
      setScanStatus,
      () => void handleReconnect(),
      () => {
        setConnectionNotice("实时更新已断开，重连中…");
      },
    );
  }, [setScanStatus]);

  useEffect(() => {
    if (!liveNotice) return;
    const timer = window.setTimeout(() => setLiveNotice(null), 3500);
    return () => window.clearTimeout(timer);
  }, [liveNotice]);

  return { liveNotice: connectionNotice ?? liveNotice };
}
