import { useEffect, useEffectEvent, useState } from "react";
import { type ScanStatusEvent, subscribeSessionUpdates } from "../lib/api";
import type { LiveSessionsUpdate, SessionStoreSnapshot } from "./useSessionStore";

interface LiveSyncDeps {
  applyLiveEvent: (event: LiveSessionsUpdate) => Promise<SessionStoreSnapshot | null>;
  setScanStatus: (event: ScanStatusEvent) => void;
}

export function useLiveSync({ applyLiveEvent, setScanStatus }: LiveSyncDeps) {
  const [liveNotice, setLiveNotice] = useState<string | null>(null);
  const [connectionNotice, setConnectionNotice] = useState<string | null>(null);

  const syncLiveUpdate = useEffectEvent(async (event: LiveSessionsUpdate) => {
    try {
      const snapshot = await applyLiveEvent(event);
      if (snapshot && event.newSessions > 0) {
        setLiveNotice(`发现 ${event.newSessions} 个新会话，列表已自动刷新`);
      }
    } catch (error) {
      console.error("Failed to sync live session update:", error);
    }
  });

  const handleReconnect = useEffectEvent(() => {
    setConnectionNotice(null);
    void syncLiveUpdate({
      type: "sessions-updated",
      changedAgents: [],
      newSessions: 0,
      updatedSessions: 0,
      removedSessions: 0,
      totalSessions: 0,
      timestamp: Date.now(),
    });
  });

  useEffect(() => {
    return subscribeSessionUpdates(
      (event) => {
        void syncLiveUpdate(event);
      },
      setScanStatus,
      handleReconnect,
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
