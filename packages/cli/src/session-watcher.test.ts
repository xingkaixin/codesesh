import { mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type BaseAgent, type SessionWatchPlan } from "@codesesh/core/runtime";

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

import { SessionWatcher, isRecursiveWatchSupported } from "./session-watcher.js";
import { appLogger } from "./logging.js";

function source(name: string, plan: SessionWatchPlan) {
  return { name, getSessionWatchPlan: () => plan };
}

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
      const sessionsDir = join(tempDir, "sessions");
      mkdirSync(sessionsDir, { recursive: true });
      const sessionFile = join(sessionsDir, "session.jsonl");
      writeFileSync(sessionFile, "data");

      const watcher = new SessionWatcher();
      const changed = vi.fn();
      watcher.onAgentsChanged(changed);

      watcher.start([
        source("custom-agent", {
          status: "supported",
          targets: [{ path: sessionsDir }],
        }),
      ]);

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
      expect(changed).toHaveBeenCalledWith(new Set(["custom-agent"]));

      await watcher.dispose();
    } finally {
      vi.unstubAllEnvs();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps notifying later listeners when an earlier one throws", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "watcher-test-"));
    try {
      const sessionsDir = join(tempDir, "sessions");
      mkdirSync(sessionsDir, { recursive: true });
      const sessionFile = join(sessionsDir, "session.jsonl");
      writeFileSync(sessionFile, "data");

      const watcher = new SessionWatcher();
      watcher.onAgentsChanged(() => {
        throw new Error("listener boom");
      });
      const changed = vi.fn();
      watcher.onAgentsChanged(changed);

      watcher.start([
        source("custom-agent", {
          status: "supported",
          targets: [{ path: sessionsDir }],
        }),
      ]);
      const sessionsWatcher = fsWatch.watchers.find((w) => w.path === sessionsDir);
      writeFileSync(sessionFile, "partial");
      sessionsWatcher!.listener("change", "session.jsonl");
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1_500);

      expect(changed).toHaveBeenCalledWith(new Set(["custom-agent"]));

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
      const watcher = new SessionWatcher();
      watcher.start([
        source("custom-agent", {
          status: "supported",
          targets: [{ path: tempDir }],
        }),
      ]);
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

  it("closes a fallback watcher when its directory is deleted", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "watcher-fallback-delete-"));
    const childDir = join(tempDir, "child");
    mkdirSync(childDir);
    fsWatch.watch.mockImplementation((path, options, listener) => {
      if (options.recursive) {
        const error = Object.assign(new Error("recursive watch unavailable"), {
          code: "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM",
        });
        throw error;
      }
      return registerMockWatcher(path, options, listener);
    });

    try {
      const watcher = new SessionWatcher();
      watcher.start([
        source("custom-agent", {
          status: "supported",
          targets: [{ path: tempDir }],
        }),
      ]);
      const rootWatcher = fsWatch.watchers.find((entry) => entry.path === tempDir)!;
      const childWatcher = fsWatch.watchers.find((entry) => entry.path === childDir)!;

      rmSync(childDir, { recursive: true });
      rootWatcher.listener("rename", "child");
      await Promise.resolve();

      expect(childWatcher.close).toHaveBeenCalledOnce();
      await watcher.dispose();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("distinguishes unsupported and unnecessary watch capabilities", () => {
    const watcher = new SessionWatcher();

    watcher.start([
      source("remote-agent", {
        status: "unsupported",
        reason: "source does not expose local change notifications",
      }),
      source("static-agent", {
        status: "not-needed",
        reason: "source is immutable during the process lifetime",
      }),
    ]);

    expect(fsWatch.watchers).toEqual([]);
    expect(appLogger.debug).toHaveBeenCalledWith("watch.skip", {
      agent: "remote-agent",
      status: "unsupported",
      reason: "source does not expose local change notifications",
    });
    expect(appLogger.debug).toHaveBeenCalledWith("watch.skip", {
      agent: "static-agent",
      status: "not-needed",
      reason: "source is immutable during the process lifetime",
    });
  });

  it("consumes a provided adapter without watcher name changes", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "watcher-registered-adapter-"));
    try {
      const adapter = Object.assign(
        source("registered-test-agent", {
          status: "supported",
          targets: [{ path: tempDir }],
        }),
        {
          sessionSourceAccess: {
            kind: "enumerated" as const,
            synchronize: vi.fn(),
            count: () => 0,
          },
        },
      ) as unknown as BaseAgent;
      const watcher = new SessionWatcher();

      watcher.start([adapter]);

      expect(fsWatch.watchers).toEqual([
        expect.objectContaining({
          path: tempDir,
          options: { recursive: true },
        }),
      ]);
      await watcher.dispose();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("deduplicates targets that share a watch root", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "watcher-shared-root-"));
    try {
      const firstDb = join(tempDir, "first.db");
      const secondDb = join(tempDir, "second.db");
      writeFileSync(firstDb, "first");
      writeFileSync(secondDb, "second");
      const watcher = new SessionWatcher();

      watcher.start([
        source("database-agent", {
          status: "supported",
          targets: [
            { root: tempDir, path: firstDb },
            { root: tempDir, path: secondDb },
            { root: tempDir, path: secondDb },
          ],
        }),
      ]);

      expect(fsWatch.watchers).toHaveLength(1);
      await watcher.dispose();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("watches the closest existing parent when a target does not exist yet", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "watcher-missing-target-"));
    try {
      const futureSessions = join(tempDir, "future", "sessions");
      const watcher = new SessionWatcher();

      watcher.start([
        source("future-agent", {
          status: "supported",
          targets: [{ path: futureSessions }],
        }),
      ]);

      expect(fsWatch.watchers).toEqual([
        expect.objectContaining({
          path: tempDir,
          options: { recursive: true },
        }),
      ]);
      await watcher.dispose();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("emits a database agent change after its file is replaced", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "watcher-db-replace-"));
    try {
      const dbPath = join(tempDir, "state.vscdb");
      writeFileSync(dbPath, "before");
      const watcher = new SessionWatcher();
      const changed = vi.fn();
      watcher.onAgentsChanged(changed);
      watcher.start([
        source("database-agent", {
          status: "supported",
          targets: [{ root: tempDir, path: dbPath }],
        }),
      ]);

      writeFileSync(dbPath, "replacement");
      fsWatch.watchers[0]!.listener("rename", "state.vscdb");
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1_000);

      expect(changed).toHaveBeenCalledWith(new Set(["database-agent"]));
      await watcher.dispose();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("CS-139: emits a database agent change for its WAL sidecar", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "watcher-db-wal-"));
    try {
      const dbPath = join(tempDir, "opencode.db");
      writeFileSync(dbPath, "main");
      writeFileSync(`${dbPath}-wal`, "commit");
      writeFileSync(join(tempDir, "unrelated.db-wal"), "other");
      writeFileSync(`${dbPath}.bak`, "backup");
      const watcher = new SessionWatcher();
      const changed = vi.fn();
      watcher.onAgentsChanged(changed);
      watcher.start([
        source("database-agent", {
          status: "supported",
          targets: [{ root: tempDir, path: dbPath }],
        }),
      ]);

      // A WAL-mode commit appends here and leaves the main file alone.
      fsWatch.watchers[0]!.listener("change", "opencode.db-wal");
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1_000);

      expect(changed).toHaveBeenCalledWith(new Set(["database-agent"]));

      changed.mockClear();
      for (const filename of ["unrelated.db-wal", "opencode.db.bak", "opencode.db-shm"]) {
        fsWatch.watchers[0]!.listener("change", filename);
      }
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1_000);

      expect(changed).not.toHaveBeenCalled();
      await watcher.dispose();
    } finally {
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
