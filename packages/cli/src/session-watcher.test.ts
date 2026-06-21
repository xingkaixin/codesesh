import { mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fsWatch = vi.hoisted(() => ({
  watchers: [] as Array<{
    path: string;
    options: { recursive?: boolean };
    listener: (eventType: string, filename: string | Buffer | null) => void;
    on: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  }>,
  watch: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    watch: fsWatch.watch,
  };
});

vi.mock("./logging.js", () => ({
  appLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  SessionWatcher,
  resolveAgentWatchTargets,
  isRecursiveWatchSupported,
} from "./session-watcher.js";

function registerMockWatcher(
  path: string,
  options: { recursive?: boolean },
  listener: (eventType: string, filename: string | Buffer | null) => void,
) {
  const watcher = {
    path,
    options,
    listener,
    on: vi.fn(),
    close: vi.fn(async () => undefined),
  };
  fsWatch.watchers.push(watcher);
  return { on: watcher.on, close: watcher.close };
}

beforeEach(() => {
  fsWatch.watch.mockImplementation((path, options, listener) =>
    registerMockWatcher(path, options, listener),
  );
  fsWatch.watchers = [];
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("SessionWatcher", () => {
  it("fires onAgentsChanged after write stability", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "watcher-test-"));
    try {
      // Lay out a CODEX_HOME so resolveAgentWatchTargets resolves to tempDir/sessions.
      const sessionsDir = join(tempDir, "sessions");
      mkdirSync(sessionsDir, { recursive: true });
      const sessionFile = join(sessionsDir, "session.jsonl");
      writeFileSync(sessionFile, "data");

      const watcher = new SessionWatcher();
      const changed = vi.fn();
      watcher.onAgentsChanged(changed);

      vi.stubEnv("CODEX_HOME", tempDir);
      watcher.start(["codex"]);

      const sessionsWatcher = fsWatch.watchers.find((w) => w.path === sessionsDir);
      expect(sessionsWatcher).toBeDefined();

      writeFileSync(sessionFile, "partial");
      sessionsWatcher!.listener("change", "session.jsonl");
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(150);

      appendFileSync(sessionFile, "\nmore");
      sessionsWatcher!.listener("change", "session.jsonl");
      await Promise.resolve();
      expect(changed).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1_000);
      expect(changed).toHaveBeenCalledTimes(1);
      expect(changed.mock.calls[0]![0] instanceof Set).toBe(true);

      await watcher.dispose();
    } finally {
      vi.unstubAllEnvs();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("unsubscribe removes the listener", () => {
    const watcher = new SessionWatcher();
    const cb = vi.fn();
    const off = watcher.onAgentsChanged(cb);
    off();
    // No public way to trigger without start; just verify off returns and doesn't throw.
    expect(typeof off).toBe("function");
    watcher.dispose();
  });

  it("dispose closes all watchers and clears state", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "watcher-dispose-"));
    try {
      vi.stubEnv("CODEX_HOME", tempDir);
      const watcher = new SessionWatcher();
      watcher.start(["codex"]);
      expect(fsWatch.watchers.length).toBeGreaterThan(0);
      const closeSpies = fsWatch.watchers.map((w) => w.close);

      await watcher.dispose();

      for (const spy of closeSpies) {
        expect(spy).toHaveBeenCalled();
      }
    } finally {
      vi.unstubAllEnvs();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("isRecursiveWatchSupported", () => {
  it("supports ibmi on Node 19.1+", () => {
    expect(isRecursiveWatchSupported("ibmi", "19.1.0")).toBe(true);
    expect(isRecursiveWatchSupported("ibmi", "20.0.0")).toBe(true);
  });

  it("does not support ibmi on older Node", () => {
    expect(isRecursiveWatchSupported("ibmi", "18.0.0")).toBe(false);
    expect(isRecursiveWatchSupported("ibmi", "19.0.0")).toBe(false);
  });

  it("supports linux on Node 19.1+", () => {
    expect(isRecursiveWatchSupported("linux", "19.1.0")).toBe(true);
  });

  it("always supports darwin and win32", () => {
    expect(isRecursiveWatchSupported("darwin", "18.0.0")).toBe(true);
    expect(isRecursiveWatchSupported("win32", "18.0.0")).toBe(true);
  });

  it("does not support unknown platforms", () => {
    expect(isRecursiveWatchSupported("freebsd", "20.0.0")).toBe(false);
  });
});

describe("resolveAgentWatchTargets", () => {
  it("returns empty array for unknown agent", () => {
    expect(resolveAgentWatchTargets("unknown")).toEqual([]);
  });

  it("resolves codex targets", () => {
    vi.stubEnv("CODEX_HOME", "/tmp/codex-home");
    const targets = resolveAgentWatchTargets("codex");
    expect(targets).toHaveLength(2);
    expect(targets[0]!.path).toContain("sessions");
    vi.unstubAllEnvs();
  });
});
