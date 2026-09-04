import { afterEach, describe, expect, it, vi } from "vitest";
import { createSnapshotPaginator } from "../snapshot-pagination.js";

const request = { limit: 1, query: new URLSearchParams("agent=codex&from=100") };

function startPagination() {
  const paginate = createSnapshotPaginator<number, string>();
  const source = {};
  const load = vi.fn(() => ({ items: [1, 2, 3], view: "original" }));
  const first = paginate(source, request, load);
  if (first.kind !== "page" || !first.nextCursor) throw new Error("Expected a paginated snapshot");
  return { paginate, source, load, cursor: first.nextCursor };
}

afterEach(() => vi.useRealTimers());

describe("snapshot pagination", () => {
  it("retains the original items and view without reloading later pages", () => {
    const { paginate, source, load, cursor } = startPagination();
    load.mockReturnValue({ items: [4], view: "updated" });
    const nextRequest = {
      limit: 2,
      query: new URLSearchParams("from=100&agent=codex&limit=2&cursor=ignored"),
      cursor,
    };

    expect(paginate(source, nextRequest, load)).toEqual({
      kind: "page",
      items: [2, 3],
      view: "original",
    });
    expect(paginate(source, nextRequest, load)).toEqual({
      kind: "page",
      items: [2, 3],
      view: "original",
    });
    expect(load).toHaveBeenCalledOnce();
    expect(paginate(source, request, load)).toEqual({
      kind: "page",
      items: [4],
      view: "updated",
    });
  });

  it("expires a snapshot after one minute even if its pages were recently read", () => {
    vi.useFakeTimers();
    const { paginate, source, load, cursor } = startPagination();
    vi.advanceTimersByTime(59_999);
    expect(paginate(source, { ...request, cursor }, load).kind).toBe("page");

    vi.advanceTimersByTime(1);
    expect(paginate(source, { ...request, cursor }, load)).toEqual({ kind: "stale_snapshot" });
    expect(load).toHaveBeenCalledOnce();
    expect(paginate(source, request, load).kind).toBe("page");
  });

  it("evicts the oldest snapshot when more than 32 reads need retained pages", () => {
    const { paginate, source, load, cursor } = startPagination();
    for (let index = 0; index < 31; index++) paginate(source, request, load);
    expect(paginate(source, { ...request, cursor }, load).kind).toBe("page");

    const newest = paginate(source, request, load);
    expect(paginate(source, { ...request, cursor }, load)).toEqual({ kind: "stale_snapshot" });
    if (newest.kind !== "page") throw new Error("Expected newest page");
    expect(paginate(source, { ...request, cursor: newest.nextCursor }, load).kind).toBe("page");
  });

  it("does not spend retention capacity on single-page responses", () => {
    const { paginate, source, load, cursor } = startPagination();
    load.mockReturnValue({ items: [], view: "empty" });
    for (let index = 0; index < 33; index++) {
      expect(paginate(source, request, load)).toEqual({ kind: "page", items: [], view: "empty" });
    }
    expect(paginate(source, { ...request, cursor }, load).kind).toBe("page");
  });

  it("rejects a cursor reused for another query, source, or collection", () => {
    const { paginate, source, load, cursor } = startPagination();
    expect(
      paginate(
        source,
        { ...request, cursor, query: new URLSearchParams("agent=claudecode") },
        load,
      ),
    ).toEqual({ kind: "invalid_cursor" });
    expect(paginate({}, { ...request, cursor }, load)).toEqual({ kind: "stale_snapshot" });
    const otherCollection = createSnapshotPaginator<number, string>();
    expect(otherCollection(source, { ...request, cursor }, load)).toEqual({
      kind: "stale_snapshot",
    });
    expect(load).toHaveBeenCalledOnce();
  });

  it("rejects malformed cursors and offsets outside their retained snapshot", () => {
    const { paginate, source, load, cursor } = startPagination();
    const payload = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    const malformed = ["!", "x".repeat(513), Buffer.from("{").toString("base64url")];
    for (const value of [
      null,
      {},
      { ...payload, version: 2 },
      { ...payload, offset: 0 },
      { ...payload, offset: 3 },
    ]) {
      malformed.push(Buffer.from(JSON.stringify(value)).toString("base64url"));
    }
    for (const invalid of malformed) {
      expect(paginate(source, { ...request, cursor: invalid }, load)).toEqual({
        kind: "invalid_cursor",
      });
    }
    expect(load).toHaveBeenCalledOnce();
  });
});
