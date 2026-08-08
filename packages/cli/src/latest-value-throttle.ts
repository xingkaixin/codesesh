export class LatestValueThrottle<Value> {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private phase: string | null = null;
  private pending: Value | undefined;
  private hasPending = false;

  constructor(
    private readonly intervalMs: number,
    private readonly emit: (value: Value) => void,
  ) {}

  push(value: Value, phase: string): void {
    if (this.phase !== phase) {
      this.flush();
      this.phase = phase;
      this.emit(value);
      this.schedule();
      return;
    }

    if (this.timer) {
      this.pending = value;
      this.hasPending = true;
      return;
    }

    this.emit(value);
    this.schedule();
  }

  flush(): void {
    this.clearTimer();
    if (!this.hasPending) return;
    const pending = this.pending as Value;
    this.pending = undefined;
    this.hasPending = false;
    this.emit(pending);
  }

  cancel(): void {
    this.dropPending();
    this.phase = null;
  }

  private schedule(): void {
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.hasPending) return;
      const pending = this.pending as Value;
      this.pending = undefined;
      this.hasPending = false;
      this.emit(pending);
      this.schedule();
    }, this.intervalMs);
  }

  private clearTimer(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  private dropPending(): void {
    this.clearTimer();
    this.pending = undefined;
    this.hasPending = false;
  }
}
