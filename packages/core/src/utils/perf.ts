/**
 * 性能追踪工具 - 用于测量启动过程中的各个阶段耗时
 */

export interface PerfMarker {
  name: string;
  startTime: number;
  endTime?: number;
  duration?: number;
  children: PerfMarker[];
  parent?: PerfMarker;
}

class PerfTracer {
  private rootMarkers: PerfMarker[] = [];
  private activeStack: PerfMarker[] = [];
  private enabled = false;

  enable() {
    this.enabled = true;
  }

  start(name: string): PerfMarker {
    const marker: PerfMarker = {
      name,
      startTime: performance.now(),
      children: [],
    };

    if (!this.enabled) return marker;

    const parent = this.activeStack[this.activeStack.length - 1];
    if (parent) {
      marker.parent = parent;
      parent.children.push(marker);
    } else {
      this.rootMarkers.push(marker);
    }

    this.activeStack.push(marker);
    return marker;
  }

  end(marker?: PerfMarker): void {
    if (!this.enabled) return;

    const target = marker ?? this.activeStack[this.activeStack.length - 1];
    if (!target) return;

    target.endTime = performance.now();
    target.duration = target.endTime - target.startTime;

    // Pop until we remove the target
    while (this.activeStack.length > 0) {
      const popped = this.activeStack.pop();
      if (popped === target) break;
    }
  }

  measure<T>(name: string, fn: () => T): T {
    const marker = this.start(name);
    try {
      return fn();
    } finally {
      this.end(marker);
    }
  }

  async measureAsync<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const marker = this.start(name);
    try {
      return await fn();
    } finally {
      this.end(marker);
    }
  }

  getReport(): string {
    if (!this.enabled) return "Performance tracing disabled";

    const lines: string[] = [];
    lines.push("\n=== Performance Report ===\n");

    for (const marker of this.rootMarkers) {
      this.formatMarker(marker, 0, lines);
    }

    return lines.join("\n");
  }

  private formatMarker(marker: PerfMarker, depth: number, lines: string[]): void {
    const indent = "  ".repeat(depth);
    const duration = marker.duration?.toFixed(2) ?? "?";
    lines.push(`${indent}${marker.name}: ${duration}ms`);

    for (const child of marker.children) {
      this.formatMarker(child, depth + 1, lines);
    }
  }

  reset(): void {
    this.rootMarkers = [];
    this.activeStack = [];
  }
}

export const perf = new PerfTracer();
