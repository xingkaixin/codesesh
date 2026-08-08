import type { ScanStatusEvent } from "@codesesh/core/contract";

interface PendingFrame {
  bytes: Uint8Array;
  critical: boolean;
}

export const MAX_PENDING_CRITICAL_SSE_FRAMES = 64;

function scanStatusMilestone(status: ScanStatusEvent): string {
  const agentStates = Object.entries(status.agentStatuses)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([agentName, agentStatus]) => [agentName, agentStatus.status, agentStatus.error ?? null]);
  return JSON.stringify([
    status.active,
    status.phase,
    status.totalAgents,
    status.pendingAgents,
    status.scanningAgents,
    status.completedAgents,
    agentStates,
    status.backfill.active,
    status.backfill.currentAgent ?? null,
    status.backfill.pendingAgents,
    status.backfill.completedAgents,
    status.backfill.failedAgents,
    status.backfill.progress?.phase ?? null,
  ]);
}

export class SseEventBuffer {
  private readonly encoder = new TextEncoder();
  private readonly frames: PendingFrame[] = [];
  private replaceableStatus: PendingFrame | null = null;
  private lastStatusMilestone: string | null = null;
  private criticalFrameCount = 0;
  private isClosed = false;

  constructor(
    private readonly controller: ReadableStreamDefaultController<Uint8Array>,
    private readonly onOverflow: () => void,
  ) {}

  enqueue(event: string, data: unknown): void {
    if (!this.freezeReplaceableStatus()) return;
    this.appendCritical(this.frame(event, data));
  }

  enqueueScanStatus(status: ScanStatusEvent): void {
    if (this.isClosed) return;
    const milestone = scanStatusMilestone(status);
    const bytes = this.frame(status.type, status);

    if (this.lastStatusMilestone !== milestone) {
      if (!this.freezeReplaceableStatus()) return;
      this.lastStatusMilestone = milestone;
      this.appendCritical(bytes);
      return;
    }

    if (this.replaceableStatus) {
      this.replaceableStatus.bytes = bytes;
      return;
    }

    const frame = { bytes, critical: false };
    this.frames.push(frame);
    this.replaceableStatus = frame;
    this.drain();
  }

  enqueueHeartbeat(): void {
    if (
      this.isClosed ||
      this.frames.length > 0 ||
      this.controller.desiredSize == null ||
      this.controller.desiredSize <= 0
    ) {
      return;
    }
    this.controller.enqueue(this.encoder.encode(": keepalive\n\n"));
  }

  drain(): void {
    while (
      !this.isClosed &&
      this.frames.length > 0 &&
      this.controller.desiredSize != null &&
      this.controller.desiredSize > 0
    ) {
      const frame = this.frames.shift()!;
      if (frame === this.replaceableStatus) this.replaceableStatus = null;
      if (frame.critical) this.criticalFrameCount -= 1;
      this.controller.enqueue(frame.bytes);
    }
  }

  close(): void {
    this.isClosed = true;
    this.frames.length = 0;
    this.replaceableStatus = null;
    this.criticalFrameCount = 0;
  }

  private freezeReplaceableStatus(): boolean {
    if (!this.replaceableStatus) return !this.isClosed;
    if (this.criticalFrameCount >= MAX_PENDING_CRITICAL_SSE_FRAMES) {
      this.overflow();
      return false;
    }
    this.replaceableStatus.critical = true;
    this.replaceableStatus = null;
    this.criticalFrameCount += 1;
    return true;
  }

  private appendCritical(bytes: Uint8Array): void {
    if (this.isClosed) return;
    if (this.criticalFrameCount >= MAX_PENDING_CRITICAL_SSE_FRAMES) {
      this.overflow();
      return;
    }
    this.frames.push({ bytes, critical: true });
    this.criticalFrameCount += 1;
    this.drain();
  }

  private overflow(): void {
    if (this.isClosed) return;
    this.close();
    this.onOverflow();
  }

  private frame(event: string, data: unknown): Uint8Array {
    return this.encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
}
