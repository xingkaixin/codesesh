import type { SearchIndexSyncOptions, SessionCacheMeta, SessionHeadChange } from "@codesesh/core";
import type { SearchIndexWorkerJob } from "./search-index-worker.js";

type FullSearchIndexJob = Extract<SearchIndexWorkerJob, { kind: "full" }>;
type ChangesSearchIndexJob = Extract<SearchIndexWorkerJob, { kind: "changes" }>;

interface JobWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
}

interface PendingChanges {
  context: string;
  agentName: string;
  changesBySessionId: Map<string, SessionHeadChange>;
  removedSessionIds: Set<string>;
  meta: Record<string, SessionCacheMeta>;
  searchIndexOptions?: SearchIndexSyncOptions;
}

interface PendingAgentJobs {
  full?: FullSearchIndexJob;
  changes?: PendingChanges;
}

export interface SearchIndexJobBatch {
  readonly id: number;
  readonly context: string;
  readonly jobs: SearchIndexWorkerJob[];
}

class PendingSearchIndexJobBatch implements SearchIndexJobBatch {
  context: string;
  private readonly jobsByAgent = new Map<string, PendingAgentJobs>();
  private readonly waiters: JobWaiter[] = [];
  private settled = false;

  constructor(
    readonly id: number,
    context: string,
    jobs: SearchIndexWorkerJob[],
    waiter: JobWaiter,
  ) {
    this.context = context;
    this.merge(context, jobs, waiter);
  }

  get jobs(): SearchIndexWorkerJob[] {
    const jobs: SearchIndexWorkerJob[] = [];
    for (const pending of this.jobsByAgent.values()) {
      if (pending.full) jobs.push(pending.full);
      if (pending.changes) jobs.push(changesJobFromPending(pending.changes));
    }
    return jobs;
  }

  get changeCount(): number {
    let count = 0;
    for (const pending of this.jobsByAgent.values()) {
      if (!pending.changes) continue;
      count += pending.changes.changesBySessionId.size + pending.changes.removedSessionIds.size;
    }
    return count;
  }

  merge(context: string, jobs: SearchIndexWorkerJob[], waiter: JobWaiter): void {
    this.context = context;
    this.waiters.push(waiter);
    for (const job of jobs) this.mergeJob(job);
  }

  settle(error?: Error): boolean {
    if (this.settled) return false;
    this.settled = true;
    for (const waiter of this.waiters) {
      if (error) waiter.reject(error);
      else waiter.resolve();
    }
    this.waiters.length = 0;
    return true;
  }

  private mergeJob(job: SearchIndexWorkerJob): void {
    const pending = this.jobsByAgent.get(job.agentName) ?? {};
    this.jobsByAgent.set(job.agentName, pending);

    if (job.kind === "full") {
      pending.full = job;
      pending.changes = undefined;
      return;
    }

    pending.changes ??= createPendingChanges(job);
    mergeChanges(pending.changes, job);
  }
}

export class PendingSearchIndexJobs {
  private pendingBatch: PendingSearchIndexJobBatch | null = null;

  get batchCount(): number {
    return this.pendingBatch ? 1 : 0;
  }

  get jobCount(): number {
    return this.pendingBatch?.jobs.length ?? 0;
  }

  get changeCount(): number {
    return this.pendingBatch?.changeCount ?? 0;
  }

  enqueue(id: number, context: string, jobs: SearchIndexWorkerJob[]): Promise<void> {
    if (jobs.length === 0) return Promise.resolve();

    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      if (this.pendingBatch) {
        this.pendingBatch.merge(context, jobs, waiter);
      } else {
        this.pendingBatch = new PendingSearchIndexJobBatch(id, context, jobs, waiter);
      }
    });
  }

  take(): SearchIndexJobBatch | null {
    const batch = this.pendingBatch;
    this.pendingBatch = null;
    return batch;
  }

  settle(batch: SearchIndexJobBatch, error?: Error): boolean {
    return batch instanceof PendingSearchIndexJobBatch && batch.settle(error);
  }

  rejectAll(error: Error): void {
    const batch = this.take();
    if (batch) this.settle(batch, error);
  }
}

function createPendingChanges(job: ChangesSearchIndexJob): PendingChanges {
  return {
    context: job.context,
    agentName: job.agentName,
    changesBySessionId: new Map(),
    removedSessionIds: new Set(),
    meta: {},
    searchIndexOptions: job.searchIndexOptions,
  };
}

function mergeChanges(pending: PendingChanges, job: ChangesSearchIndexJob): void {
  pending.context = job.context;
  pending.searchIndexOptions = mergeSearchIndexOptions(
    pending.searchIndexOptions,
    job.searchIndexOptions,
  );

  for (const sessionId of job.removedSessionIds) {
    pending.changesBySessionId.delete(sessionId);
    pending.removedSessionIds.add(sessionId);
    delete pending.meta[sessionId];
  }

  for (const change of job.changes) {
    const sessionId = change.session.id;
    pending.removedSessionIds.delete(sessionId);
    pending.changesBySessionId.set(sessionId, change);
    if (Object.hasOwn(job.meta, sessionId)) pending.meta[sessionId] = job.meta[sessionId]!;
    else delete pending.meta[sessionId];
  }

  for (const [sessionId, meta] of Object.entries(job.meta)) {
    if (!pending.removedSessionIds.has(sessionId)) pending.meta[sessionId] = meta;
  }
}

function mergeSearchIndexOptions(
  current: SearchIndexSyncOptions | undefined,
  incoming: SearchIndexSyncOptions | undefined,
): SearchIndexSyncOptions | undefined {
  if (!current) return incoming;
  if (!incoming) return current;
  return { ...current, ...incoming };
}

function changesJobFromPending(pending: PendingChanges): ChangesSearchIndexJob {
  return {
    kind: "changes",
    context: pending.context,
    agentName: pending.agentName,
    changes: [...pending.changesBySessionId.values()],
    removedSessionIds: [...pending.removedSessionIds],
    meta: pending.meta,
    ...(pending.searchIndexOptions ? { searchIndexOptions: pending.searchIndexOptions } : {}),
  };
}
