import { useEffect, useEffectEvent, useState } from "react";
import { type AppConfig, type ScanStatusEvent, subscribeSessionUpdates } from "../lib/api";
import type { LiveSessionsUpdate } from "../lib/live-update";
import type { ViewState } from "../lib/view-state";

interface LiveSyncDeps {
  resolveTimeWindow: () => AppConfig["window"] | null;
  viewState: ViewState;
  refreshAgents: (window: AppConfig["window"]) => Promise<unknown>;
  refreshSessions: (window: AppConfig["window"]) => Promise<unknown>;
  refreshProjects: (window: AppConfig["window"]) => Promise<unknown>;
  refreshDashboard: () => Promise<void>;
  refreshProjectDashboard: () => Promise<void>;
  refreshSessionDetail: () => Promise<void>;
  refreshSearch: () => Promise<void>;
  setScanStatus: (event: ScanStatusEvent) => void;
}

/**
 * Owns the live-update subscription and its fan-out: applies incremental session
 * updates, refreshes every domain, surfaces the transient liveNotice, routes
 * scan-status events to useScanStatus, and surfaces a persistent connection
 * notice while the SSE stream is reconnecting (takes priority over liveNotice).
 */
export function useLiveSync(deps: LiveSyncDeps) {
  const [liveNotice, setLiveNotice] = useState<string | null>(null);
  const [connectionNotice, setConnectionNotice] = useState<string | null>(null);
  const {
    resolveTimeWindow,
    viewState,
    refreshAgents,
    refreshSessions,
    refreshProjects,
    refreshDashboard,
    refreshProjectDashboard,
    refreshSessionDetail,
    refreshSearch,
    setScanStatus,
  } = deps;

  const syncLiveUpdate = useEffectEvent(async (event: LiveSessionsUpdate) => {
    try {
      const timeWindow = resolveTimeWindow();
      await Promise.all([
        timeWindow ? refreshAgents(timeWindow) : Promise.resolve(),
        timeWindow ? refreshSessions(timeWindow) : Promise.resolve(),
        timeWindow ? refreshProjects(timeWindow) : Promise.resolve(),
      ]);

      await refreshDashboard();
      await refreshProjectDashboard();

      if (viewState.mode === "session") {
        await refreshSessionDetail();
      }

      await refreshSearch();

      if (event.newSessions > 0) {
        setLiveNotice(`发现 ${event.newSessions} 个新会话，列表已自动刷新`);
      }
    } catch (err) {
      console.error("Failed to sync live session update:", err);
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
    const unsubscribe = subscribeSessionUpdates(
      (event) => {
        void syncLiveUpdate(event);
      },
      (event) => {
        setScanStatus(event);
      },
      () => {
        handleReconnect();
      },
      () => {
        setConnectionNotice("实时更新已断开，重连中…");
      },
    );

    return unsubscribe;
  }, [setScanStatus]);

  useEffect(() => {
    if (!liveNotice) {
      return;
    }

    const timer = window.setTimeout(() => {
      setLiveNotice(null);
    }, 3500);

    return () => {
      window.clearTimeout(timer);
    };
  }, [liveNotice]);

  return { liveNotice: connectionNotice ?? liveNotice };
}
