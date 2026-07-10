/**
 * SessionWatcher — a deep module that hides platform-specific file watching
 * (recursive watch availability, non-recursive fallback trees, write-stability
 * polling, debounce) behind a tiny interface.
 *
 * Consumers only need to know: start watching these agent names, stop, and get
 * notified (post write-stability + debounce) which agents' data changed. The
 * recursive-vs-fallback strategy, APFS mtime quirks, and path-stability polling
 * are all internal details.
 */
import { existsSync, readdirSync, statSync, watch, type FSWatcher } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { getCursorDataPath, resolveProviderRoots } from "@codesesh/core";
import { appLogger } from "./logging.js";

const WRITE_STABILITY_THRESHOLD_MS = 250;
const WRITE_STABILITY_POLL_MS = 100;

export interface WatchTarget {
  path: string;
  root?: string;
}

interface WatchScope {
  agentName: string;
  targetPath: string;
}

interface StablePathState {
  path: string;
  agentNames: Set<string>;
  lastMtimeMs: number | null;
  lastSize: number | null;
  stableSince: number;
  timer: NodeJS.Timeout | null;
}

export type AgentsChangedListener = (agentNames: Set<string>) => void;

export function toAbsolutePath(path: string): string {
  return isAbsolute(path) ? path : resolve(path);
}

function closestWatchablePath(targetPath: string): string | null {
  if (!isAbsolute(targetPath) && !existsSync(targetPath)) {
    return null;
  }

  let current = toAbsolutePath(targetPath);

  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }

  return current;
}

function getWatchRoot(path: string): string {
  const stat = statSync(path);
  return stat.isDirectory() ? path : dirname(path);
}

export function isRecursiveWatchSupported(
  // "ibmi" is a real process.platform value on IBM i (PASE) but is not yet
  // declared in @types/node's Platform union.
  platform: NodeJS.Platform | "ibmi" = process.platform,
  nodeVersion = process.versions.node,
): boolean {
  if (platform === "darwin" || platform === "win32") {
    return true;
  }
  if (platform !== "linux" && platform !== "aix" && platform !== "ibmi") {
    return false;
  }

  const [major = 0, minor = 0] = nodeVersion.split(".").map((part) => Number(part));
  return major > 19 || (major === 19 && minor >= 1);
}

function isRecursiveWatchUnavailable(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM"
  );
}

function isSameOrChildPath(parentPath: string, childPath: string): boolean {
  const path = relative(parentPath, childPath);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function isRelatedPath(changedPath: string, targetPath: string): boolean {
  return isSameOrChildPath(targetPath, changedPath) || isSameOrChildPath(changedPath, targetPath);
}

function mergeScopes(target: WatchScope[], scopes: WatchScope[]): void {
  for (const scope of scopes) {
    if (
      !target.some(
        (item) => item.agentName === scope.agentName && item.targetPath === scope.targetPath,
      )
    ) {
      target.push(scope);
    }
  }
}

function resolveWatchEventPath(watchPath: string, filename: string | Buffer | null): string {
  const filenameText = filename?.toString();
  if (!filenameText) {
    return watchPath;
  }
  return isAbsolute(filenameText) ? filenameText : join(watchPath, filenameText);
}

export function resolveAgentWatchTargets(agentName: string): WatchTarget[] {
  const roots = resolveProviderRoots();
  const cursorDataPath = getCursorDataPath();

  switch (agentName) {
    case "claudecode":
      return [
        { root: roots.claudeRoot, path: join(roots.claudeRoot, "projects") },
        { path: "data/claudecode" },
      ];
    case "codex":
      return [
        { path: join(roots.codexRoot, "sessions") },
        { path: join(roots.codexRoot, "session_index.jsonl") },
      ];
    case "pi":
      return [
        { root: roots.piRoot, path: join(roots.piRoot, "agent", "sessions") },
        { root: "data/pi", path: "data/pi" },
      ];
    case "cursor":
      return cursorDataPath
        ? [
            {
              root: cursorDataPath,
              path: join(cursorDataPath, "globalStorage", "state.vscdb"),
            },
            { root: cursorDataPath, path: join(cursorDataPath, "workspaceStorage") },
          ]
        : [];
    case "kimi":
      return [
        { root: roots.kimiRoot, path: join(roots.kimiRoot, "sessions") },
        { path: "data/kimi" },
      ];
    case "opencode":
      return [
        { root: roots.opencodeRoot, path: join(roots.opencodeRoot, "opencode.db") },
        { root: "data/opencode", path: "data/opencode/opencode.db" },
      ];
    case "zcode":
      return roots.zcodeRoot
        ? [{ root: roots.zcodeRoot, path: join(roots.zcodeRoot, "cli", "db", "db.sqlite") }]
        : [];
    default:
      return [];
  }
}

export class SessionWatcher {
  private watchers: FSWatcher[] = [];
  private fallbackWatchScopes = new Map<string, WatchScope[]>();
  private stablePaths = new Map<string, StablePathState>();
  private listeners = new Set<AgentsChangedListener>();

  /** Register a listener fired (after write-stability polling) with the changed agent set. */
  onAgentsChanged(cb: AgentsChangedListener): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /** Begin watching the given agent names' data directories. */
  start(agentNames: string[]): void {
    const scopesByRoot = new Map<string, WatchScope[]>();

    for (const agentName of agentNames) {
      const watchTargets = resolveAgentWatchTargets(agentName);

      if (watchTargets.length === 0) {
        appLogger.debug("watch.skip", { agent: agentName });
        continue;
      }

      for (const target of watchTargets) {
        const watchRootPath = closestWatchablePath(target.root ?? target.path);
        if (!watchRootPath) continue;

        let rootPath: string;
        try {
          rootPath = getWatchRoot(watchRootPath);
        } catch (error) {
          this.reportWatchError("watch.resolve.error", { path: watchRootPath, error });
          continue;
        }
        const targetPath = toAbsolutePath(target.path);
        const scopes = scopesByRoot.get(rootPath) ?? [];
        if (
          !scopes.some((scope) => scope.agentName === agentName && scope.targetPath === targetPath)
        ) {
          scopes.push({ agentName, targetPath });
        }
        scopesByRoot.set(rootPath, scopes);
      }
    }

    for (const [rootPath, scopes] of scopesByRoot.entries()) {
      const agents = Array.from(new Set(scopes.map((scope) => scope.agentName)));
      appLogger.info("watch.start", {
        root: rootPath,
        agents,
        targets: scopes.map((scope) => ({
          agent: scope.agentName,
          path: scope.targetPath,
        })),
      });

      if (isRecursiveWatchSupported()) {
        const started = this.watchDirectory(rootPath, scopes, true);
        if (started) {
          continue;
        }
      }

      this.watchDirectoryTree(rootPath, scopes);
    }
  }

  /** Stop all watchers and clear pending stability polls. */
  async dispose(): Promise<void> {
    for (const state of this.stablePaths.values()) {
      if (state.timer) {
        clearTimeout(state.timer);
      }
    }
    this.stablePaths.clear();

    await Promise.all(this.watchers.map((watcher) => watcher.close()));
    this.watchers = [];
    this.fallbackWatchScopes.clear();
    this.listeners.clear();
  }

  private watchDirectory(path: string, scopes: WatchScope[], recursive: boolean): boolean {
    try {
      const watcher = watch(path, { recursive }, (eventType, filename) => {
        queueMicrotask(() => {
          try {
            const activeScopes = recursive
              ? scopes
              : (this.fallbackWatchScopes.get(path) ?? scopes);
            this.handleWatchEvent(path, activeScopes, eventType, filename);
            if (!recursive) {
              this.watchNewDirectories(path, filename, activeScopes);
            }
          } catch (error) {
            this.reportWatchError("watch.event.error", { path, recursive, error });
          }
        });
      });

      watcher.on("error", (error) => {
        this.reportWatchError("watch.error", { path, recursive, error });
      });

      this.watchers.push(watcher);
      return true;
    } catch (error) {
      if (recursive && isRecursiveWatchUnavailable(error)) {
        appLogger.warn("watch.recursive_unavailable", { path, error });
        return false;
      }

      this.reportWatchError("watch.start.error", { path, recursive, error });
      return false;
    }
  }

  private watchDirectoryTree(rootPath: string, scopes: WatchScope[]): void {
    const pending = [rootPath];

    while (pending.length > 0) {
      const dirPath = pending.pop()!;
      this.watchFallbackDirectory(dirPath, scopes);

      try {
        for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
          if (entry.isDirectory()) {
            pending.push(join(dirPath, entry.name));
          }
        }
      } catch (error) {
        this.reportWatchError("watch.scan.error", { path: dirPath, error });
      }
    }
  }

  private watchFallbackDirectory(path: string, scopes: WatchScope[]): void {
    const existingScopes = this.fallbackWatchScopes.get(path);
    if (existingScopes) {
      mergeScopes(existingScopes, scopes);
      return;
    }

    const storedScopes = [...scopes];
    this.fallbackWatchScopes.set(path, storedScopes);
    if (!this.watchDirectory(path, storedScopes, false)) {
      this.fallbackWatchScopes.delete(path);
    }
  }

  private watchNewDirectories(
    watchPath: string,
    filename: string | Buffer | null,
    scopes: WatchScope[],
  ): void {
    const path = resolveWatchEventPath(watchPath, filename);
    try {
      if (statSync(path).isDirectory()) {
        this.watchDirectoryTree(path, scopes);
      }
    } catch {}
  }

  private handleWatchEvent(
    watchPath: string,
    scopes: WatchScope[],
    eventType: string,
    filename: string | Buffer | null,
  ): void {
    const changedPath = resolveWatchEventPath(watchPath, filename);
    const agentNames = new Set(
      scopes
        .filter((scope) => isRelatedPath(changedPath, scope.targetPath))
        .map((scope) => scope.agentName),
    );

    if (agentNames.size === 0) {
      return;
    }

    appLogger.debug("watch.event", {
      event: eventType,
      path: changedPath,
      agents: Array.from(agentNames),
    });
    this.waitForStablePath(changedPath, agentNames);
  }

  private waitForStablePath(path: string, agentNames: Set<string>): void {
    const existing = this.stablePaths.get(path);
    if (existing) {
      for (const agentName of agentNames) {
        existing.agentNames.add(agentName);
      }
      return;
    }

    const state: StablePathState = {
      path,
      agentNames: new Set(agentNames),
      lastMtimeMs: null,
      lastSize: null,
      stableSince: Date.now(),
      timer: null,
    };
    this.stablePaths.set(path, state);
    this.pollStablePath(path);
  }

  private pollStablePath(path: string): void {
    const state = this.stablePaths.get(path);
    if (!state) {
      return;
    }

    let size: number;
    let mtimeMs: number;
    try {
      const stat = statSync(path);
      size = stat.size;
      mtimeMs = stat.mtimeMs;
    } catch {
      this.stablePaths.delete(path);
      this.emitAgentsChanged(state.agentNames);
      return;
    }

    const now = Date.now();
    const unchanged = state.lastSize === size && state.lastMtimeMs === mtimeMs;
    if (!unchanged) {
      state.lastSize = size;
      state.lastMtimeMs = mtimeMs;
      state.stableSince = now;
    }

    if (unchanged && now - state.stableSince >= WRITE_STABILITY_THRESHOLD_MS) {
      this.stablePaths.delete(path);
      this.emitAgentsChanged(state.agentNames);
      return;
    }

    state.timer = setTimeout(() => this.pollStablePath(path), WRITE_STABILITY_POLL_MS);
  }

  private emitAgentsChanged(agentNames: Set<string>): void {
    if (agentNames.size === 0) return;
    for (const listener of this.listeners) {
      listener(new Set(agentNames));
    }
  }

  private reportWatchError(event: string, data: Record<string, unknown>): void {
    appLogger.error(event, data);
    console.error("[watch] File watcher failed:", data.error);
  }
}
