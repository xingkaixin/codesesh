import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import { queryKeys } from "./query-keys";
import { installSessionDetailCachePolicy, pruneSessionDetailCache } from "./session-detail-cache";

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
  return {
    reference: { agentName: "codex", sessionId: id },
    messages: [{ id: `${id}-m1`, parts: [] }],
  };
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
  it("never evicts a detail something is still watching", async () => {
    const active = makeClient();
    await openDetail(active, "watched");
    const observed = active
      .getQueryCache()
      .find({ queryKey: queryKeys.sessionDetail("codex", "watched") })!;
    const observer = new QueryObserver(active, { queryKey: observed.queryKey });
    // Simulate a mounted component holding this query.
    observed.addObserver(observer);

    for (let index = 0; index < 5; index += 1) {
      await openDetail(active, `other-${index}`);
    }
    pruneSessionDetailCache(active);

    expect(cachedDetailIds(active)).toContain("watched");
    observed.removeObserver(observer);
  });

  it("keeps a newly created detail during observer handoff", async () => {
    const active = makeClient();
    await openDetail(active, "previous-1");
    await openDetail(active, "previous-2");

    const previous = active
      .getQueryCache()
      .find({ queryKey: queryKeys.sessionDetail("codex", "previous-2") })!;
    const observer = new QueryObserver(active, { queryKey: previous.queryKey });
    previous.addObserver(observer);

    const pendingKey = queryKeys.sessionDetail("codex", "pending");
    const pending = active.getQueryCache().build(active, {
      queryKey: pendingKey,
      queryFn: async () => transcript("pending"),
    });

    previous.removeObserver(observer);

    expect(active.getQueryCache().find({ queryKey: pendingKey })).toBe(pending);
  });
});
