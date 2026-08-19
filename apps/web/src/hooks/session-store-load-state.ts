import type { AgentInfo, AppConfig, DashboardData, SessionHead } from "../lib/api";

export interface SessionStoreSnapshot {
  window: AppConfig["window"];
  agents: AgentInfo[];
  sessions: SessionHead[];
  dashboard: DashboardData;
}

interface ActiveSessionStoreLoad {
  requestId: number;
  window: AppConfig["window"];
}

export type SessionStoreLoadState =
  | { status: "idle" }
  | (ActiveSessionStoreLoad & { status: "loading" })
  | (ActiveSessionStoreLoad & { status: "preview"; snapshot: SessionStoreSnapshot })
  | (ActiveSessionStoreLoad & { status: "ready"; snapshot: SessionStoreSnapshot })
  | (ActiveSessionStoreLoad & { status: "failed"; error: unknown });

export type SessionStoreLoadAction =
  | (ActiveSessionStoreLoad & { type: "begin" })
  | { type: "publish-preview"; requestId: number; snapshot: SessionStoreSnapshot }
  | { type: "complete"; requestId: number; snapshot: SessionStoreSnapshot }
  | { type: "fail"; requestId: number; error: unknown };

export const INITIAL_SESSION_STORE_LOAD_STATE: SessionStoreLoadState = { status: "idle" };

export function reduceSessionStoreLoad(
  state: SessionStoreLoadState,
  action: SessionStoreLoadAction,
): SessionStoreLoadState {
  if (action.type === "begin") {
    return {
      status: "loading",
      requestId: action.requestId,
      window: action.window,
    };
  }
  if (state.status === "idle" || action.requestId !== state.requestId) return state;
  if (state.status !== "loading" && state.status !== "preview") return state;

  switch (action.type) {
    case "publish-preview":
      return { ...state, status: "preview", snapshot: action.snapshot };
    case "complete":
      return { ...state, status: "ready", snapshot: action.snapshot };
    case "fail":
      return { ...state, status: "failed", error: action.error };
  }
}

export function sessionStoreLoadSnapshot(
  state: SessionStoreLoadState,
): SessionStoreSnapshot | null {
  return state.status === "preview" || state.status === "ready" ? state.snapshot : null;
}
