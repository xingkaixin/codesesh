import { describe, expect, it } from "vitest";
import type { SessionCacheMeta, SessionHead } from "@codesesh/core";
import { PendingSearchIndexJobs } from "./pending-search-index-jobs.js";
import type { SearchIndexWorkerJob } from "./search-index-worker.js";

function makeSession(id: string, title: string): SessionHead {
  return {
    id,
    slug: `agent/${id}`,
    title,
    directory: "/tmp/project",
    time_created: 1,
    stats: {
      message_count: 1,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cost: 0,
    },
  };
}

function makeMeta(id: string, version: number): SessionCacheMeta {
  return { id, sourcePath: `/tmp/${id}-${version}.jsonl` };
}

function changesJob(
  agentName: string,
  changes: Array<{ id: string; version: number }>,
  removedSessionIds: string[] = [],
): SearchIndexWorkerJob {
  return {
    kind: "changes",
    context: "scan.refresh",
    agentName,
    changes: changes.map(({ id, version }, sortIndex) => ({
      session: makeSession(id, `version ${version}`),
      sortIndex,
    })),
    removedSessionIds,
    meta: Object.fromEntries(changes.map(({ id, version }) => [id, makeMeta(id, version)])),
  };
}

function fullJob(agentName: string, version: number): SearchIndexWorkerJob {
  const session = makeSession("full", `version ${version}`);
  return {
    kind: "full",
    context: "scan.backfill",
    agentName,
    sessions: [session],
    meta: { [session.id]: makeMeta(session.id, version) },
    saveCache: true,
  };
}

describe("PendingSearchIndexJobs", () => {
  it("keeps the latest change and settles every merged caller", async () => {
    const pending = new PendingSearchIndexJobs();
    const first = pending.enqueue(1, "first", [
      changesJob("codex", [{ id: "active", version: 1 }]),
    ]);
    const second = pending.enqueue(2, "second", [
      changesJob("codex", [{ id: "active", version: 2 }]),
    ]);

    const batch = pending.take()!;
    expect(batch.context).toBe("second");
    expect(batch.jobs).toEqual([
      expect.objectContaining({
        kind: "changes",
        changes: [
          expect.objectContaining({
            session: expect.objectContaining({ title: "version 2" }),
          }),
        ],
        meta: { active: makeMeta("active", 2) },
      }),
    ]);

    expect(pending.settle(batch)).toBe(true);
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    expect(pending.settle(batch)).toBe(false);
  });

  it("applies delete and re-add transitions in submission order", async () => {
    const pending = new PendingSearchIndexJobs();
    const waiters = [
      pending.enqueue(1, "change", [changesJob("codex", [{ id: "active", version: 1 }])]),
      pending.enqueue(2, "delete", [changesJob("codex", [], ["active"])]),
      pending.enqueue(3, "re-add", [changesJob("codex", [{ id: "active", version: 3 }])]),
    ];

    const batch = pending.take()!;
    expect(batch.jobs).toEqual([
      expect.objectContaining({
        changes: [
          expect.objectContaining({
            session: expect.objectContaining({ title: "version 3" }),
          }),
        ],
        removedSessionIds: [],
        meta: { active: makeMeta("active", 3) },
      }),
    ]);
    pending.settle(batch);
    await Promise.all(waiters);
  });

  it("lets a full job replace earlier changes and keeps later changes as an overlay", async () => {
    const pending = new PendingSearchIndexJobs();
    const waiters = [
      pending.enqueue(1, "old change", [changesJob("codex", [{ id: "old", version: 1 }])]),
      pending.enqueue(2, "full", [fullJob("codex", 2)]),
      pending.enqueue(3, "new change", [changesJob("codex", [{ id: "new", version: 3 }])]),
    ];

    const batch = pending.take()!;
    expect(batch.jobs).toEqual([
      expect.objectContaining({
        kind: "full",
        sessions: [expect.objectContaining({ title: "version 2" })],
      }),
      expect.objectContaining({
        kind: "changes",
        changes: [expect.objectContaining({ session: expect.objectContaining({ id: "new" }) })],
      }),
    ]);
    pending.settle(batch);
    await Promise.all(waiters);
  });

  it("keeps jobs isolated by agent", async () => {
    const pending = new PendingSearchIndexJobs();
    const waiters = [
      pending.enqueue(1, "codex", [changesJob("codex", [{ id: "shared", version: 1 }])]),
      pending.enqueue(2, "kimi", [changesJob("kimi", [{ id: "shared", version: 2 }])]),
    ];

    const batch = pending.take()!;
    expect(batch.jobs).toEqual([
      expect.objectContaining({ agentName: "codex" }),
      expect.objectContaining({ agentName: "kimi" }),
    ]);
    pending.settle(batch);
    await Promise.all(waiters);
  });

  it("bounds queued work by unique session count", async () => {
    const pending = new PendingSearchIndexJobs();
    const waiters = Array.from({ length: 1_000 }, (_, index) =>
      pending.enqueue(index + 1, "scan.refresh", [
        changesJob("codex", [{ id: "active", version: index + 1 }]),
      ]),
    );

    expect(pending.batchCount).toBe(1);
    expect(pending.jobCount).toBe(1);
    expect(pending.changeCount).toBe(1);
    const batch = pending.take()!;
    expect(batch.jobs[0]).toEqual(
      expect.objectContaining({
        changes: [
          expect.objectContaining({
            session: expect.objectContaining({ title: "version 1000" }),
          }),
        ],
      }),
    );
    pending.settle(batch);
    await Promise.all(waiters);
  });

  it("rejects every merged caller when the worker batch fails", async () => {
    const pending = new PendingSearchIndexJobs();
    const waiters = [
      pending.enqueue(1, "first", [changesJob("codex", [{ id: "one", version: 1 }])]),
      pending.enqueue(2, "second", [changesJob("codex", [{ id: "two", version: 2 }])]),
    ];
    const outcomes = Promise.allSettled(waiters);
    const batch = pending.take()!;

    pending.settle(batch, new Error("index failed"));

    expect(await outcomes).toEqual([
      expect.objectContaining({ status: "rejected", reason: new Error("index failed") }),
      expect.objectContaining({ status: "rejected", reason: new Error("index failed") }),
    ]);
  });
});
