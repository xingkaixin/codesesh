import type { AppConfig } from "../lib/api";

interface ActiveSessionStoreLoad {
  requestId: number;
  window: AppConfig["window"];
}

export type SessionStoreLoadState =
  | { status: "idle" }
  | (ActiveSessionStoreLoad & { status: "loading" })
  | (ActiveSessionStoreLoad & { status: "ready" })
  | (ActiveSessionStoreLoad & { status: "failed" });

export type SessionStoreLoadAction =
  | (ActiveSessionStoreLoad & { type: "begin" })
  | { type: "complete"; requestId: number }
  | { type: "fail"; requestId: number };

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
  if (state.status !== "loading") return state;

  switch (action.type) {
    case "complete":
      return { ...state, status: "ready" };
    case "fail":
      return { ...state, status: "failed" };
  }
}
