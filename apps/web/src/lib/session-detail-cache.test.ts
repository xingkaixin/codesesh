import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import { queryKeys } from "./query-keys";
import {
  RETAINED_INACTIVE_SESSION_DETAILS,
  installSessionDetailCachePolicy,
  pruneSessionDetailCache,
} from "./session-detail-cache";

let unsubscribe: (() => void) | null = null;
let client: QueryClient | null = null;

afterEach(() => {
  unsubscribe?.();
  unsubscribe = null;
  client?.clear();
  client = null;
});

function makeClient() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  unsubscribe = installSessionDetailCachePolicy(client);
  return client;
}

/** Stand-in for a full transcript; only its identity matters here. */
function transcript(id: string) {
  return { id, messages: [{ id: `${id}-m1`, parts: [] }] };
}

async function openDetail(active: QueryClient, sessionId: string) {
  await active.fetchQuery({
    queryKey: queryKeys.sessionDetail("codex", sessionId),
    queryFn: async () => transcript(sessionId),
  });
}

function cachedDetailIds(active: QueryClient): string[] {
  return active
    .getQueryCache()
    .getAll()
    .filter((query) => query.queryKey[0] === queryKeys.sessionDetails[0])
    .map((query) => String(query.queryKey[2]));
}

describe("CS-147: session detail cache is bounded", () => {
  it("keeps only the most recent inactive details", async () => {
    const active = makeClient();

    for (let index = 0; index < 10; index += 1) {
      await openDetail(active, `s${index}`);
    }
    pruneSessionDetailCache(active);

    const cached = cachedDetailIds(active);
    expect(cached).toHaveLength(RETAINED_INACTIVE_SESSION_DETAILS);
    expect(cached.sort()).toEqual(["s8", "s9"]);
  });

  it("never evicts a detail something is still watching", async () => {
    const active = makeClient();
    await openDetail(active, "watched");
    const observed = active
      .getQueryCache()
      .find({ queryKey: queryKeys.sessionDetail("codex", "watched") })!;
    const observer = { onQueryUpdate: () => {} };
    // Simulate a mounted component holding this query.
    observed.addObserver(observer as never);

    for (let index = 0; index < 5; index += 1) {
      await openDetail(active, `other-${index}`);
    }
    pruneSessionDetailCache(active);

    expect(cachedDetailIds(active)).toContain("watched");
    observed.removeObserver(observer as never);
  });

  it("keeps a newly created detail during observer handoff", async () => {
    const active = makeClient();
    await openDetail(active, "previous-1");
    await openDetail(active, "previous-2");

    const previous = active
      .getQueryCache()
      .find({ queryKey: queryKeys.sessionDetail("codex", "previous-2") })!;
    const observer = { onQueryUpdate: () => {} };
    previous.addObserver(observer as never);

    const pendingKey = queryKeys.sessionDetail("codex", "pending");
    const pending = active.getQueryCache().build(active, {
      queryKey: pendingKey,
      queryFn: async () => transcript("pending"),
    });

    previous.removeObserver(observer as never);

    expect(active.getQueryCache().find({ queryKey: pendingKey })).toBe(pending);
  });

  it("leaves other resources alone", async () => {
    const active = makeClient();
    for (const key of [queryKeys.bookmarks, queryKeys.config, queryKeys.dashboards]) {
      await active.fetchQuery({ queryKey: key, queryFn: async () => ({ ok: true }) });
    }
    for (let index = 0; index < 5; index += 1) {
      await openDetail(active, `s${index}`);
    }
    pruneSessionDetailCache(active);

    const remaining = active
      .getQueryCache()
      .getAll()
      .map((query) => String(query.queryKey[0]));
    expect(remaining).toContain("bookmarks");
    expect(remaining).toContain("config");
    expect(remaining).toContain("dashboard");
  });

  it("applies the bound when a detail stops being displayed", async () => {
    const active = makeClient();

    // Each session is watched while open, then released on navigation.
    for (let index = 0; index < 6; index += 1) {
      await openDetail(active, `s${index}`);
      const query = active
        .getQueryCache()
        .find({ queryKey: queryKeys.sessionDetail("codex", `s${index}`) })!;
      const observer = { onQueryUpdate: () => {} };
      query.addObserver(observer as never);
      query.removeObserver(observer as never);
    }

    expect(cachedDetailIds(active)).toHaveLength(RETAINED_INACTIVE_SESSION_DETAILS);
  });
});
