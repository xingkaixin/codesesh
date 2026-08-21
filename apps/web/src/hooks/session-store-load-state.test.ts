import { describe, expect, it } from "vitest";
import {
  INITIAL_SESSION_STORE_LOAD_STATE,
  reduceSessionStoreLoad,
} from "./session-store-load-state";

const firstWindow = { from: 1, to: 2 };
const secondWindow = { from: 3, to: 4 };

describe("session store load state", () => {
  it("tracks the active request lifecycle without storing query data", () => {
    const loading = reduceSessionStoreLoad(INITIAL_SESSION_STORE_LOAD_STATE, {
      type: "begin",
      requestId: 1,
      window: firstWindow,
    });
    const ready = reduceSessionStoreLoad(loading, {
      type: "complete",
      requestId: 1,
    });

    expect(loading).toEqual({ status: "loading", requestId: 1, window: firstWindow });
    expect(ready).toEqual({
      status: "ready",
      requestId: 1,
      window: firstWindow,
    });
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
      }),
    ).toBe(latestLoad);
    expect(
      reduceSessionStoreLoad(latestLoad, {
        type: "fail",
        requestId: 1,
      }),
    ).toBe(latestLoad);
  });

  it("records a failure only for the active in-flight request", () => {
    const loading = reduceSessionStoreLoad(INITIAL_SESSION_STORE_LOAD_STATE, {
      type: "begin",
      requestId: 1,
      window: firstWindow,
    });
    const failed = reduceSessionStoreLoad(loading, {
      type: "fail",
      requestId: 1,
    });

    expect(failed).toEqual({
      status: "failed",
      requestId: 1,
      window: firstWindow,
    });
    expect(
      reduceSessionStoreLoad(failed, {
        type: "complete",
        requestId: 1,
      }),
    ).toBe(failed);
  });
});
