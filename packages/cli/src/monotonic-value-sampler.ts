export class MonotonicValueSampler<Value> {
  private phase: string | null = null;
  private lastEmittedAt = -Infinity;
  private pending: Value | undefined;
  private hasPending = false;

  constructor(
    private readonly intervalMs: number,
    private readonly emit: (value: Value) => void,
    private readonly now: () => number = () => performance.now(),
  ) {}

  push(value: Value, phase: string): void {
    if (this.phase !== phase) {
      this.flush();
      this.phase = phase;
      this.emitNow(value);
      return;
    }

    if (this.now() - this.lastEmittedAt >= this.intervalMs) {
      this.pending = undefined;
      this.hasPending = false;
      this.emitNow(value);
      return;
    }

    this.pending = value;
    this.hasPending = true;
  }

  flush(): void {
    if (!this.hasPending) return;
    const pending = this.pending as Value;
    this.pending = undefined;
    this.hasPending = false;
    this.emitNow(pending);
  }

  cancel(): void {
    this.phase = null;
    this.lastEmittedAt = -Infinity;
    this.pending = undefined;
    this.hasPending = false;
  }

  private emitNow(value: Value): void {
    this.lastEmittedAt = this.now();
    this.emit(value);
  }
}
