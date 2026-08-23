import { SAMPLE_SESSIONS_UPDATED_EVENT } from "@codesesh/core/test-fixtures";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionsUpdatedEvent } from "./api";
import { queryKeys } from "./query-keys";
import { invalidateLiveSessionDerivedQueries } from "./session-query-consistency";

let client: QueryClient | null = null;

afterEach(() => {
  client?.clear();
  client = null;
});

function makeClient(): QueryClient {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return client;
}

function changedHead(
  agentName: string,
  sessionId: string,
): SessionsUpdatedEvent["changedSessionHeads"][number] {
  const sample = SAMPLE_SESSIONS_UPDATED_EVENT.changedSessionHeads[0]!;
  return {
    reference: { agentName, sessionId },
    session: sample.session,
  };
}

describe("live session detail invalidation", () => {
  it("invalidates every changed detail with one cache scan request", async () => {
    const active = makeClient();
    const changedKey = queryKeys.sessionDetail("codex", "changed");
    const removedKey = queryKeys.sessionDetail("codex", "removed");
    const unchangedKey = queryKeys.sessionDetail("codex", "unchanged");
    const descendantKey = [...changedKey, "messages"] as const;
    active.setQueryData(changedKey, { id: "changed" });
    active.setQueryData(removedKey, { id: "removed" });
    active.setQueryData(unchangedKey, { id: "unchanged" });
    active.setQueryData(descendantKey, { id: "changed-messages" });
    const invalidateQueries = vi.spyOn(active, "invalidateQueries");
    const event = {
      ...SAMPLE_SESSIONS_UPDATED_EVENT,
      changedSessionHeads: [
        changedHead("CodeX", "changed"),
        ...Array.from({ length: 1_000 }, (_, index) => changedHead("CodeX", `absent-${index}`)),
      ],
      removedSessionRefs: [
        { agentName: "CodeX", sessionId: "removed" },
        { agentName: "CodeX", sessionId: "changed" },
      ],
    } satisfies SessionsUpdatedEvent;

    await invalidateLiveSessionDerivedQueries(active, event);

    expect(invalidateQueries).toHaveBeenCalledOnce();
    expect(active.getQueryState(changedKey)?.isInvalidated).toBe(true);
    expect(active.getQueryState(removedKey)?.isInvalidated).toBe(true);
    expect(active.getQueryState(unchangedKey)?.isInvalidated).toBe(false);
    expect(active.getQueryState(descendantKey)?.isInvalidated).toBe(false);
  });

  it("does not scan the cache when no detail changed", async () => {
    const active = makeClient();
    const invalidateQueries = vi.spyOn(active, "invalidateQueries");

    await invalidateLiveSessionDerivedQueries(active, {
      ...SAMPLE_SESSIONS_UPDATED_EVENT,
      changedSessionHeads: [],
      removedSessionRefs: [],
    });

    expect(invalidateQueries).not.toHaveBeenCalled();
  });
});
