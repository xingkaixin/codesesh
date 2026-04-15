import { describe, it, expect, beforeEach } from "vitest";
import { perf } from "../perf.js";

beforeEach(() => {
  perf.reset();
});

describe("PerfTracer", () => {
  describe("enable / getReport", () => {
    it("reports disabled when not enabled", () => {
      expect(perf.getReport()).toBe("Performance tracing disabled");
    });

    it("reports enabled state after enable()", () => {
      perf.enable();
      expect(perf.getReport()).toContain("Performance Report");
    });
  });

  describe("start / end", () => {
    it("creates a marker and records duration", () => {
      perf.enable();
      const marker = perf.start("test");
      perf.end(marker);
      expect(marker.duration).toBeGreaterThanOrEqual(0);
    });

    it("supports nested markers", () => {
      perf.enable();
      const parent = perf.start("parent");
      const child = perf.start("child");
      perf.end(child);
      perf.end(parent);

      expect(parent.children).toHaveLength(1);
      expect(parent.children[0]!.name).toBe("child");
    });

    it("end without marker ends the most recent", () => {
      perf.enable();
      perf.start("a");
      perf.start("b");
      perf.end();
      // Should have ended "b"
      const report = perf.getReport();
      expect(report).toContain("a");
    });

    it("start always creates marker with startTime", () => {
      const marker = perf.start("noop");
      expect(marker.startTime).toBeGreaterThanOrEqual(0);
      expect(marker.children).toEqual([]);
    });
  });

  describe("measure", () => {
    it("returns the function result", () => {
      perf.enable();
      const result = perf.measure("sync", () => 42);
      expect(result).toBe(42);
    });

    it("records duration for synchronous function", () => {
      perf.enable();
      perf.measure("sync", () => {});
      const report = perf.getReport();
      expect(report).toContain("sync:");
    });
  });

  describe("measureAsync", () => {
    it("returns the async function result", async () => {
      perf.enable();
      const result = await perf.measureAsync("async", async () => "hello");
      expect(result).toBe("hello");
    });

    it("records duration for async function", async () => {
      perf.enable();
      await perf.measureAsync("async", async () => {});
      const report = perf.getReport();
      expect(report).toContain("async:");
    });
  });

  describe("reset", () => {
    it("clears all markers", () => {
      perf.enable();
      perf.start("a");
      perf.end();
      perf.reset();
      // After reset, report should show no markers (just the header/footer)
      const report = perf.getReport();
      expect(report).not.toContain("a:");
    });
  });
});
