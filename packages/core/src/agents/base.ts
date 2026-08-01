import { existsSync, readdirSync, statSync, type Dirent, type Stats } from "node:fs";
import { join } from "node:path";
import type { SessionHead, SessionDetail, ParseSessionResult } from "../types/index.js";
import { getCoreDiagnostics } from "../utils/diagnostics.js";

export type { ParseSessionResult };

export function parsedSession<T>(session: T): ParseSessionResult<T> {
  return { status: "parsed", data: session };
}

export function skippedSession<T>(reason: string): ParseSessionResult<T> {
  return { status: "skipped", reason };
}

export function filteredSession<T>(reason: string): ParseSessionResult<T> {
  return { status: "filtered", reason };
}

export function getParsedSession<T>(result: ParseSessionResult<T>): T | null {
  return result.status === "parsed" ? result.data : null;
}

export interface SessionCacheMeta {
  id: string;
  sourcePath: string;
  [key: string]: unknown;
}

export interface AgentScanOptions {
  from?: number;
  to?: number;
  fast?: boolean;
  onProgress?: (progress: AgentScanProgress) => void;
}

export interface AgentScanProgress {
  total?: number;
  processed?: number;
  sessions?: number;
}

export interface FileWalkOptions {
  recursive?: boolean;
  scanWindow?: Pick<AgentScanOptions, "from" | "to">;
}

export function matchesScanWindow(activityTime: number, options?: AgentScanOptions): boolean {
  if (options?.from != null && activityTime < options.from) return false;
  if (options?.to != null && activityTime > options.to) return false;
  return true;
}

/** 变更检测结果 */
export interface ChangeCheckResult {
  /** 是否有变更 */
  hasChanges: boolean;
  /** 可精确定位时的变更会话 ID；省略表示只能确认数据源发生过变化 */
  changedIds?: string[];
  /** 检测时间戳 */
  timestamp: number;
  /** 检测过程中已枚举的会话源（可选），供 incrementalScan 复用以避免二次枚举 */
  refs?: SessionSourceRef[];
}

export interface SessionSourceRef {
  sessionId: string;
  sourcePath: string;
  fingerprint: string;
}

export interface SessionSourceFile {
  file: string;
  stat: Stats;
}

export interface FileSessionMeta extends SessionCacheMeta {
  id: string;
  title: string;
  sourcePath: string;
  sourceFingerprint: string;
  sourceMtimeMs: number;
  directory: string;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface SessionWatchTarget {
  /** Session source path whose related changes should trigger a refresh. */
  path: string;
  /** Stable ancestor to watch when the source path can be created or replaced. */
  root?: string;
}

/** `supported` may have no targets when the provider has no location in the current environment. */
export type SessionWatchPlan =
  | { status: "supported"; targets: SessionWatchTarget[] }
  | { status: "unsupported"; reason: string }
  | { status: "not-needed"; reason: string };

/** What a source enumeration says needs re-parsing and what disappeared. */
export interface SessionSourceDiff {
  changedIds: string[];
  removedIds: string[];
}

/**
 * Cached meta reaches this comparison as a live Map on the main thread and as a
 * plain object over the worker's structured-clone boundary.
 */
export type CachedMetaLookup =
  | ReadonlyMap<string, SessionCacheMeta>
  | Record<string, SessionCacheMeta>;

function readCachedMeta(meta: CachedMetaLookup, sessionId: string): SessionCacheMeta | undefined {
  if (meta instanceof Map) return meta.get(sessionId);
  return (meta as Record<string, SessionCacheMeta>)[sessionId];
}

/**
 * Fingerprints compare by exact string equality. Agents encode their head-index
 * and parser versions into the fingerprint precisely so that bumping either one
 * invalidates every cached head — a tolerant comparison would defeat that.
 */
function fingerprintMatches(ref: SessionSourceRef, cached: SessionCacheMeta | undefined): boolean {
  return (
    typeof cached?.sourceFingerprint === "string" && cached.sourceFingerprint === ref.fingerprint
  );
}

/**
 * Decides whether a cached session was in scope for this enumeration pass, which
 * is what makes its absence from the refs mean "deleted on disk" rather than
 * "outside the window".
 *
 * `sourceMtimeMs` must hold the same quantity the agent's `listSessionSources`
 * window-filters on, or the two disagree and sessions are dropped or kept wrongly.
 *
 * When it is missing we cannot tell, and the two wrong answers are not
 * symmetric: wrongly removing destroys cached sessions and their messages, while
 * wrongly keeping leaves a stale entry that the next unwindowed pass clears. So
 * an unknown mtime means "not enumerated" — keep it.
 */
function wasEnumeratedThisPass(
  cached: SessionCacheMeta | undefined,
  options: AgentScanOptions | undefined,
): boolean {
  if (options?.from == null && options?.to == null) return true;
  const mtimeMs = cached?.sourceMtimeMs;
  return typeof mtimeMs === "number" && matchesScanWindow(mtimeMs, options);
}

/**
 * Single owner of "which sources changed" for file-backed agents. The main
 * thread reaches it through FileSystemSessionSource.checkForChanges; the
 * scan-refresh worker calls it directly, because it holds cached meta received
 * over workerData rather than a live agent metaMap.
 */
export function diffSessionSources(
  refs: SessionSourceRef[],
  cachedSessions: SessionHead[],
  cachedMeta: CachedMetaLookup,
  options?: AgentScanOptions,
): SessionSourceDiff {
  const cachedIds = new Set(cachedSessions.map((session) => session.id));
  const enumeratedIds = new Set<string>();
  const changedIds: string[] = [];

  for (const ref of refs) {
    enumeratedIds.add(ref.sessionId);
    const meta = readCachedMeta(cachedMeta, ref.sessionId);
    // A ref with no cached session has to be parsed even when its meta matches:
    // the caller's session list is what the refresh merges into.
    const unchanged =
      cachedIds.has(ref.sessionId) &&
      meta?.sourcePath === ref.sourcePath &&
      fingerprintMatches(ref, meta);
    if (!unchanged) changedIds.push(ref.sessionId);
  }

  const removedIds: string[] = [];
  for (const session of cachedSessions) {
    if (enumeratedIds.has(session.id)) continue;
    if (!wasEnumeratedThisPass(readCachedMeta(cachedMeta, session.id), options)) continue;
    removedIds.push(session.id);
  }

  return { changedIds, removedIds };
}

export abstract class BaseAgent {
  abstract readonly name: string;
  abstract readonly displayName: string;

  /** Check if this agent has data available on the local filesystem. */
  abstract isAvailable(): boolean;

  /** Scan for available sessions, returning lightweight metadata. */
  abstract scan(options?: AgentScanOptions): SessionHead[];

  /** Load full session data including all messages. */
  abstract getSessionData(sessionId: string): SessionDetail;

  /** Describe how changes to this agent's session sources can be observed. */
  abstract getSessionWatchPlan(): SessionWatchPlan;

  /**
   * 检查是否有变更（用于智能刷新）
   * @param sinceTimestamp 上次缓存时间戳
   * @param cachedSessions 缓存的会话列表
   * @returns 变更检测结果
   */
  abstract checkForChanges(
    sinceTimestamp: number,
    cachedSessions: SessionHead[],
  ): Promise<ChangeCheckResult> | ChangeCheckResult;

  /**
   * 增量扫描（仅扫描变更的会话）
   * @param cachedSessions 缓存的会话列表
   * @param changedIds 变更的会话 ID 列表
   * @returns 更新后的会话列表
   */
  abstract incrementalScan(
    cachedSessions: SessionHead[],
    changedIds: string[],
    refs?: SessionSourceRef[],
  ): Promise<SessionHead[]> | SessionHead[];

  filterCachedSessions(sessions: SessionHead[]): SessionHead[] {
    return sessions;
  }

  /** Get session metadata for caching. */
  abstract getSessionMetaMap(): Map<string, SessionCacheMeta>;

  /** Restore session metadata from cache. */
  abstract setSessionMetaMap(meta: Map<string, SessionCacheMeta>): void;

  getUri(sessionId: string): string {
    return `${this.name}://${sessionId}`;
  }
}

/**
 * 文件型 Agent 基类：每个会话对应磁盘上一个独立文件/目录。
 *
 * 子类只需实现两个文件级原语：
 *   - listSessionSources(): 枚举所有源 + 计算指纹
 *   - scanSessionSource(): 解析单个源（同时写入 metaMap）
 *
 * 变更检测 / 增量扫描 / metaMap 管理由本基类统一提供：
 *   checkForChanges 用 listSessionSources 的指纹与缓存 metaMap 比对，
 *   incrementalScan 对变更集合调用 scanSessionSource 重解析。
 * 两原语在各子类中复用同一个 sourceFingerprint 计算，故指纹精确比对即等价于变更检测。
 */
export abstract class FileSystemSessionSource<
  TMeta extends SessionCacheMeta = SessionCacheMeta,
> extends BaseAgent {
  protected sessionMetaMap = new Map<string, TMeta>();
  private sourceFileStats = new Map<string, Stats>();

  /** 枚举所有会话源及其指纹。传入 options 时按 mtime 限定扫描窗口。 */
  abstract listSessionSources(options?: AgentScanOptions): SessionSourceRef[];

  /** 解析单个源并写入 metaMap，返回会话 head（解析失败/不可见返回 null）。 */
  abstract scanSessionSource(sourcePath: string, options?: AgentScanOptions): SessionHead | null;

  scan(options?: AgentScanOptions): SessionHead[] {
    const sources = this.listSessionSources(options);
    const sessions: SessionHead[] = [];
    options?.onProgress?.({ total: sources.length, processed: 0, sessions: 0 });

    for (const [index, source] of sources.entries()) {
      try {
        const session = this.scanSessionSource(source.sourcePath, options);
        if (session) sessions.push(session);
      } catch (error) {
        getCoreDiagnostics()?.warn("agent.session_parse_failed", {
          agentName: this.name,
          sourcePath: source.sourcePath,
          message: error instanceof Error ? error.message : String(error),
        });
        continue;
      } finally {
        options?.onProgress?.({
          total: sources.length,
          processed: index + 1,
          sessions: sessions.length,
        });
      }
    }

    return sessions;
  }

  getSessionMetaMap(): Map<string, SessionCacheMeta> {
    return this.sessionMetaMap as Map<string, SessionCacheMeta>;
  }

  setSessionMetaMap(meta: Map<string, SessionCacheMeta>): void {
    this.sessionMetaMap = meta as Map<string, TMeta>;
  }

  protected walkFiles(
    roots: string | readonly string[],
    isSessionFile: (entry: Dirent) => boolean,
    options: FileWalkOptions = {},
  ): SessionSourceFile[] {
    const files: SessionSourceFile[] = [];
    this.sourceFileStats.clear();

    const walk = (directory: string): void => {
      let entries: Dirent[];
      try {
        entries = readdirSync(directory, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        const filePath = join(directory, entry.name);
        if (entry.isDirectory()) {
          if (options.recursive !== false) walk(filePath);
          continue;
        }
        if (!isSessionFile(entry)) continue;

        let stat: Stats;
        try {
          stat = statSync(filePath);
        } catch {
          continue;
        }
        if (!matchesScanWindow(stat.mtimeMs, options.scanWindow)) continue;

        files.push({ file: filePath, stat });
        this.sourceFileStats.set(filePath, stat);
      }
    };

    for (const root of typeof roots === "string" ? [roots] : roots) walk(root);
    return files;
  }

  protected sessionSourceFile(sourcePath: string): SessionSourceFile {
    return {
      file: sourcePath,
      stat: this.sourceFileStats.get(sourcePath) ?? statSync(sourcePath),
    };
  }

  protected readFileMtimeMs(filePath: string | null): number | null {
    if (!filePath) return null;
    try {
      return statSync(filePath).mtimeMs;
    } catch {
      return null;
    }
  }

  /**
   * 变更检测：枚举当前源 → 交给 diffSessionSources 比对。
   * 新增、变更、删除三类统一产出 changedIds。
   */
  checkForChanges(_sinceTimestamp: number, cachedSessions: SessionHead[]): ChangeCheckResult {
    const currentRefs = this.listSessionSources();
    const diff = diffSessionSources(currentRefs, cachedSessions, this.sessionMetaMap);
    const changedIds = [...new Set([...diff.changedIds, ...diff.removedIds])];

    return {
      hasChanges: changedIds.length > 0,
      changedIds,
      timestamp: Date.now(),
      refs: currentRefs,
    };
  }

  /**
   * 增量扫描：对变更/新增源调用 scanSessionSource 重解析，
   * 删除已消失的源，合并回 cachedSessions。
   * refs 未传时回退为自行枚举，供独立调用方（如测试）沿用旧行为。
   */
  incrementalScan(
    cachedSessions: SessionHead[],
    changedIds: string[],
    refs?: SessionSourceRef[],
  ): SessionHead[] {
    const sessionMap = new Map(cachedSessions.map((session) => [session.id, session]));
    const changedSet = new Set(changedIds);
    const currentIds = new Set<string>();

    for (const ref of refs ?? this.listSessionSources()) {
      currentIds.add(ref.sessionId);
      if (!changedSet.has(ref.sessionId)) continue;
      const head = this.scanSessionSource(ref.sourcePath);
      if (head) {
        sessionMap.set(head.id, head);
      } else {
        sessionMap.delete(ref.sessionId);
        this.sessionMetaMap.delete(ref.sessionId);
      }
    }

    // Drop sessions flagged as changed but no longer present on disk.
    for (const id of changedSet) {
      if (!currentIds.has(id)) {
        sessionMap.delete(id);
        this.sessionMetaMap.delete(id);
      }
    }

    return [...sessionMap.values()];
  }
}

/** Shared scan template for agents whose session source is a single stat-able file. */
export abstract class SingleFileSessionSource<
  TMeta extends FileSessionMeta = FileSessionMeta,
> extends FileSystemSessionSource<TMeta> {
  protected abstract parseFileSessionHead(
    sourcePath: string,
    options?: AgentScanOptions,
  ): SessionHead | null;

  protected abstract createFileSessionMeta(head: SessionHead, source: SessionSourceFile): TMeta;

  scanSessionSource(sourcePath: string, options?: AgentScanOptions): SessionHead | null {
    const head = this.parseFileSessionHead(sourcePath, options);
    if (head) {
      this.sessionMetaMap.set(
        head.id,
        this.createFileSessionMeta(head, this.sessionSourceFile(sourcePath)),
      );
    }
    return head;
  }

  protected buildFileSessionMeta<TExtra extends object>({
    head,
    source,
    fingerprint,
    extras,
  }: {
    head: SessionHead;
    source: SessionSourceFile;
    fingerprint: string;
    extras: TExtra;
  }): FileSessionMeta & TExtra {
    return {
      ...extras,
      id: head.id,
      title: head.title,
      sourcePath: source.file,
      sourceFingerprint: fingerprint,
      sourceMtimeMs: source.stat.mtimeMs,
      directory: head.directory,
      messageCount: head.stats.message_count,
      createdAt: head.time_created,
      updatedAt: head.time_updated ?? head.time_created,
    };
  }
}

/**
 * 数据库型 Agent 基类：所有会话聚合在单个 SQLite 数据库中，
 * 无法做 per-file 指纹，故变更检测退化为"库文件 mtime 是否推进"，
 * 增量扫描退化为全量重扫。
 */
/**
 * A scan that could not prove its result complete — the database would not
 * open, a table was missing, or a top-level query failed.
 *
 * This is not the same as an agent with no sessions. Callers must keep the last
 * successful snapshot: treating it as an empty result would diff every known
 * session into a removal and wipe the agent from cache, search and the UI.
 */
export class SessionScanError extends Error {
  constructor(
    readonly agentName: string,
    readonly stage: string,
    options?: { cause?: unknown },
  ) {
    super(`${agentName} session scan failed while ${stage}`, options);
    this.name = "SessionScanError";
  }
}

/**
 * Files that reflect committed data. `-shm` is deliberately absent: opening the
 * database read-only rewrites it, so including it would report a change after
 * every scan.
 */
export function sqliteSourceFiles(dbPath: string): string[] {
  return [dbPath, `${dbPath}-wal`];
}

function statOrNull(path: string): { size: number; mtimeMs: number } | null {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

/** Changes whenever committed data changes, and only then. */
function sqliteSourceFingerprint(dbPath: string): string {
  return sqliteSourceFiles(dbPath)
    .map((path) => {
      const stats = statOrNull(path);
      return stats ? `${stats.size}:${Math.round(stats.mtimeMs)}` : "-";
    })
    .join("|");
}

function latestSqliteSourceMtime(dbPath: string): number {
  return sqliteSourceFiles(dbPath).reduce((latest, path) => {
    const stats = statOrNull(path);
    return stats && stats.mtimeMs > latest ? stats.mtimeMs : latest;
  }, 0);
}

export abstract class DatabaseSessionSource extends BaseAgent {
  protected sessionMetaMap = new Map<string, SessionCacheMeta>();
  private lastSourceFingerprint: string | null = null;

  /** 返回数据库文件路径（供 mtime 检测）。 */
  protected abstract getDatabasePath(): string | null;

  /** 记录单个会话的缓存 meta（sourcePath = dbPath）。 */
  protected rememberSession(sessionId: string): void {
    const dbPath = this.getDatabasePath();
    if (!dbPath) return;
    this.sessionMetaMap.set(sessionId, { id: sessionId, sourcePath: dbPath });
  }

  getSessionMetaMap(): Map<string, SessionCacheMeta> {
    return this.sessionMetaMap;
  }

  setSessionMetaMap(meta: Map<string, SessionCacheMeta>): void {
    this.sessionMetaMap = meta;
  }

  /**
   * 变更检测：数据库内部变更难以按行定位，按库文件集合的指纹判定。
   *
   * In WAL mode a commit appends to the sidecar and leaves the main file
   * untouched until checkpoint, so watching the database alone misses recent
   * writes entirely. Size is part of the fingerprint because an uncheckpointed
   * commit may land in the same millisecond as the previous one.
   */
  checkForChanges(sinceTimestamp: number, _cachedSessions: SessionHead[]): ChangeCheckResult {
    const dbPath = this.getDatabasePath();
    if (!dbPath || !existsSync(dbPath)) {
      return { hasChanges: false, timestamp: Date.now() };
    }

    try {
      const fingerprint = sqliteSourceFingerprint(dbPath);
      const previous = this.lastSourceFingerprint;
      this.lastSourceFingerprint = fingerprint;
      // Nothing to compare against on the first pass — fall back to the caller's
      // baseline, which also covers a WAL written while the process was down.
      const hasChanges =
        previous == null
          ? latestSqliteSourceMtime(dbPath) > sinceTimestamp
          : fingerprint !== previous;
      return {
        hasChanges,
        timestamp: Date.now(),
      };
    } catch {
      return { hasChanges: false, timestamp: Date.now() };
    }
  }

  /** 增量扫描：数据库型无法增量，直接全量重扫。 */
  incrementalScan(_cachedSessions: SessionHead[], _changedIds: string[]): SessionHead[] {
    return this.scan();
  }
}
