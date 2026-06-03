import {
  Profiler,
  useLayoutEffect,
  useRef,
  type ProfilerOnRenderCallback,
  type ReactNode,
} from "react";
import { logClientEvent } from "../lib/api";

const PROFILER_STORAGE_KEY = "codeseshProfiler";
const PROFILER_LOG_STORAGE_KEY = "codeseshProfilerLog";
const PROFILER_SLOW_COMMIT_MS = 16;
const PROFILER_MAX_ENTRIES = 500;

interface RenderProfileEntry {
  id: string;
  source: "react-profiler" | "commit-latency" | "custom-timing";
  phase: "mount" | "update" | "nested-update" | "measure";
  actualDuration: number;
  baseDuration: number;
  startTime: number;
  commitTime: number;
  route: string;
  detail?: Record<string, unknown>;
}

declare global {
  interface Window {
    __CODESHESH_RENDER_PROFILE__?: RenderProfileEntry[];
  }
}

export function isRenderProfilerEnabled() {
  if (typeof window === "undefined") return false;

  try {
    return window.localStorage.getItem(PROFILER_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function shouldLogRenderProfilerEntries() {
  if (typeof window === "undefined") return false;

  try {
    return window.localStorage.getItem(PROFILER_LOG_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function pushProfileEntry(entry: RenderProfileEntry) {
  const entries = window.__CODESHESH_RENDER_PROFILE__ ?? [];
  entries.push(entry);
  if (entries.length > PROFILER_MAX_ENTRIES) {
    entries.splice(0, entries.length - PROFILER_MAX_ENTRIES);
  }
  window.__CODESHESH_RENDER_PROFILE__ = entries;
}

export function recordRenderProfileEntry(
  entry: Omit<RenderProfileEntry, "commitTime" | "route" | "startTime"> & {
    startTime?: number;
    commitTime?: number;
    route?: string;
  },
) {
  if (!isRenderProfilerEnabled() || typeof window === "undefined") return;

  const now = performance.now();
  pushProfileEntry({
    ...entry,
    startTime: roundDuration(entry.startTime ?? now),
    commitTime: roundDuration(entry.commitTime ?? now),
    route: entry.route ?? window.location.pathname,
  });
}

function roundDuration(value: number) {
  return Math.round(value * 100) / 100;
}

export function RenderProfiler({
  id,
  detail,
  children,
}: {
  id: string;
  detail?: Record<string, unknown>;
  children: ReactNode;
}) {
  if (!isRenderProfilerEnabled()) return children;

  const onRender: ProfilerOnRenderCallback = (
    profilerId,
    phase,
    actualDuration,
    baseDuration,
    startTime,
    commitTime,
  ) => {
    const entry: RenderProfileEntry = {
      id: profilerId,
      source: "react-profiler",
      phase,
      actualDuration: roundDuration(actualDuration),
      baseDuration: roundDuration(baseDuration),
      startTime: roundDuration(startTime),
      commitTime: roundDuration(commitTime),
      route: window.location.pathname,
      ...(detail ? { detail } : {}),
    };

    pushProfileEntry(entry);

    if (entry.actualDuration >= PROFILER_SLOW_COMMIT_MS && shouldLogRenderProfilerEntries()) {
      logClientEvent("react.profiler.commit", { ...entry });
    }
  };

  return (
    <Profiler id={id} onRender={onRender}>
      <CommitLatencyProfiler id={id} detail={detail}>
        {children}
      </CommitLatencyProfiler>
    </Profiler>
  );
}

function CommitLatencyProfiler({
  id,
  detail,
  children,
}: {
  id: string;
  detail?: Record<string, unknown>;
  children: ReactNode;
}) {
  const renderStartedAt = performance.now();
  const commitCountRef = useRef(0);

  useLayoutEffect(() => {
    commitCountRef.current += 1;
    const commitTime = performance.now();
    const entry: RenderProfileEntry = {
      id,
      source: "commit-latency",
      phase: commitCountRef.current === 1 ? "mount" : "update",
      actualDuration: roundDuration(commitTime - renderStartedAt),
      baseDuration: 0,
      startTime: roundDuration(renderStartedAt),
      commitTime: roundDuration(commitTime),
      route: window.location.pathname,
      ...(detail ? { detail } : {}),
    };

    pushProfileEntry(entry);
  });

  return children;
}
