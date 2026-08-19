import { SAMPLE_DASHBOARD_DATA } from "@codesesh/core/test-fixtures";
import { describe, expect, it } from "vitest";
import type { SessionStoreSnapshot } from "./session-store-load-state";
import {
  INITIAL_SESSION_STORE_LOAD_STATE,
  reduceSessionStoreLoad,
  sessionStoreLoadSnapshot,
} from "./session-store-load-state";

const firstWindow = { from: 1, to: 2 };
const secondWindow = { from: 3, to: 4 };

function snapshot(window: { from: number; to: number }): SessionStoreSnapshot {
  return {
    window,
    agents: [],
    sessions: [],
    dashboard: SAMPLE_DASHBOARD_DATA,
  };
}

describe("session store load state", () => {
  it("moves through loading, preview, and ready states", () => {
    const loading = reduceSessionStoreLoad(INITIAL_SESSION_STORE_LOAD_STATE, {
      type: "begin",
      requestId: 1,
      window: firstWindow,
    });
    const previewSnapshot = snapshot(firstWindow);
    const preview = reduceSessionStoreLoad(loading, {
      type: "publish-preview",
      requestId: 1,
      snapshot: previewSnapshot,
    });
    const readySnapshot = snapshot(firstWindow);
    const ready = reduceSessionStoreLoad(preview, {
      type: "complete",
      requestId: 1,
      snapshot: readySnapshot,
    });

    expect(loading).toEqual({ status: "loading", requestId: 1, window: firstWindow });
    expect(preview).toEqual({
      status: "preview",
      requestId: 1,
      window: firstWindow,
      snapshot: previewSnapshot,
    });
    expect(ready).toEqual({
      status: "ready",
      requestId: 1,
      window: firstWindow,
      snapshot: readySnapshot,
    });
    expect(sessionStoreLoadSnapshot(ready)).toBe(readySnapshot);
  });

  it("ignores late publications from an obsolete request", () => {
    const firstLoad = reduceSessionStoreLoad(INITIAL_SESSION_STORE_LOAD_STATE, {
      type: "begin",
      requestId: 1,
      window: firstWindow,
    });
    const latestLoad = reduceSessionStoreLoad(firstLoad, {
      type: "begin",
      requestId: 2,
      window: secondWindow,
    });

    expect(
      reduceSessionStoreLoad(latestLoad, {
        type: "complete",
        requestId: 1,
        snapshot: snapshot(firstWindow),
      }),
    ).toBe(latestLoad);
    expect(
      reduceSessionStoreLoad(latestLoad, {
        type: "fail",
        requestId: 1,
        error: new Error("late failure"),
      }),
    ).toBe(latestLoad);
  });

  it("records only a failure for the active in-flight request", () => {
    const error = new Error("unavailable");
    const loading = reduceSessionStoreLoad(INITIAL_SESSION_STORE_LOAD_STATE, {
      type: "begin",
      requestId: 1,
      window: firstWindow,
    });
    const failed = reduceSessionStoreLoad(loading, {
      type: "fail",
      requestId: 1,
      error,
    });

    expect(failed).toEqual({
      status: "failed",
      requestId: 1,
      window: firstWindow,
      error,
    });
    expect(sessionStoreLoadSnapshot(failed)).toBeNull();
    expect(
      reduceSessionStoreLoad(failed, {
        type: "publish-preview",
        requestId: 1,
        snapshot: snapshot(firstWindow),
      }),
    ).toBe(failed);
  });
});
