import { existsSync, readdirSync, statSync, type Dirent, type Stats } from "node:fs";
import { join } from "node:path";
import type { SessionHead, SessionDetail, ParseSessionResult } from "../types/index.js";
import { capturePricingMisses } from "../pricing/cost.js";
import { getCoreDiagnostics } from "../utils/diagnostics.js";
import {
  createSessionSourceFailure,
  isMissingSessionSourceError,
  matchesScanWindow,
  synchronizeSessionSources as runSessionSourceSynchronization,
} from "./session-source-synchronization.js";
import type {
  SessionSourceSynchronizationBaseline,
  SessionSourceSynchronizationOutcome,
  SessionSourceSynchronizationRequest,
} from "./session-source-synchronization.js";

export {
  createSessionSourceFailure,
  diffSessionSources,
  matchesScanWindow,
  reportSessionSourceOutcome,
  synchronizeSessionSources,
} from "./session-source-synchronization.js";
export type {
  SessionSourceSynchronizationAdapter,
  SessionSourceSynchronizationBaseline,
  SessionSourceSynchronizationOutcome,
  SessionSourceSynchronizationRequest,
} from "./session-source-synchronization.js";

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
  /** Models the head parse could not price; their arrival invalidates the cache. */
  unpricedModels?: string[];
  [key: string]: unknown;
}

export interface AgentScanOptions {
  from?: number;
  to?: number;
  fast?: boolean;
  includeRelatedSessions?: boolean;
  onProgress?: (progress: AgentScanProgress) => void;
}

export interface AgentScanProgress {
  phase?: "scanning" | "finalizing";
  total?: number;
  processed?: number;
  sessions?: number;
}

export interface FileWalkOptions {
  recursive?: boolean;
  scanWindow?: Pick<AgentScanOptions, "from" | "to">;
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
  sourceFailures?: SessionSourceFailure[];
}

export interface SessionSourceRef {
  sessionId: string;
  sourcePath: string;
  fingerprint: string;
}

export interface SessionSourceFailure {
  sessionId: string;
  sourcePath: string;
  stage: "enumeration" | "parsing";
  errorClass: string;
  message: string;
}

export interface AgentScanFailure {
  agentName: string;
  stage: string;
  sourcePath?: string;
  errorClass: string;
  message: string;
}

export type SessionSourceOutcome =
  | { status: "parsed"; session: SessionHead; source: SessionSourceRef }
  | { status: "filtered"; reason: string; source: SessionSourceRef }
  | { status: "missing"; source: SessionSourceRef }
  | { status: "failed"; failure: SessionSourceFailure };

export type SessionSourceAbsenceOutcome = Extract<
  SessionSourceOutcome,
  { status: "missing" | "failed" }
>;

export interface SessionSourceScanBatch {
  sources: SessionSourceRef[];
  outcomes: SessionSourceOutcome[];
  sessions: SessionHead[];
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
  failedIds: string[];
  sourceOutcomes: SessionSourceAbsenceOutcome[];
}

/**
 * Cached meta reaches this comparison as a live Map on the main thread and as a
 * plain object over the worker's structured-clone boundary.
 */
export type CachedMetaLookup =
  | ReadonlyMap<string, SessionCacheMeta>
  | Record<string, SessionCacheMeta>;

function failureClass(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code) return code;
  }
  if (error instanceof Error && error.name) return error.name;
  return typeof error;
}

function failureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 500);
}

export function createAgentScanFailure(
  agentName: string,
  stage: string,
  error: unknown,
  sourcePath?: string,
): AgentScanFailure {
  const scanError = error instanceof SessionScanError ? error : null;
  const cause = scanError?.cause ?? error;
  return {
    agentName: scanError?.agentName ?? agentName,
    stage: scanError?.stage ?? stage,
    ...((scanError?.sourcePath ?? sourcePath)
      ? { sourcePath: scanError?.sourcePath ?? sourcePath }
      : {}),
    errorClass: failureClass(cause),
    message: failureMessage(cause),
  };
}

export function reportAgentScanFailure(failure: AgentScanFailure, baselineRetained: boolean): void {
  getCoreDiagnostics()?.warn("agent.scan_failed", {
    agent: failure.agentName,
    stage: failure.stage,
    source_path: failure.sourcePath,
    error_class: failure.errorClass,
    message: failure.message,
    baseline_retained: baselineRetained,
  });
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

  protected scanSessionSourceResult(
    source: SessionSourceRef,
    options?: AgentScanOptions,
  ): ParseSessionResult<SessionHead> {
    const session = this.scanSessionSource(source.sourcePath, options);
    return session ? parsedSession(session) : skippedSession("source produced no session");
  }

  scanSessionSourceOutcome(
    source: SessionSourceRef,
    options?: AgentScanOptions,
  ): SessionSourceOutcome {
    const previousMeta = this.sessionMetaMap.get(source.sessionId);
    let result: ParseSessionResult<SessionHead>;
    let unpricedModels: string[] = [];
    try {
      ({ result, unpricedModels } = capturePricingMisses(() =>
        this.scanSessionSourceResult(source, options),
      ));
    } catch (error) {
      if (previousMeta) this.sessionMetaMap.set(source.sessionId, previousMeta);
      else this.sessionMetaMap.delete(source.sessionId);
      if (isMissingSessionSourceError(error)) return { status: "missing", source };
      return {
        status: "failed",
        failure: createSessionSourceFailure(source, "parsing", error),
      };
    }
    if (result.status === "parsed") {
      const meta = this.sessionMetaMap.get(result.data.id);
      if (meta) {
        if (unpricedModels.length > 0) meta.unpricedModels = unpricedModels;
        else delete meta.unpricedModels;
      }
      return { status: "parsed", source, session: result.data };
    }
    if (result.status === "filtered") {
      return { status: "filtered", source, reason: result.reason ?? "filtered by agent" };
    }
    if (previousMeta) this.sessionMetaMap.set(source.sessionId, previousMeta);
    else this.sessionMetaMap.delete(source.sessionId);
    return {
      status: "failed",
      failure: createSessionSourceFailure(
        source,
        "parsing",
        new Error(result.reason ?? "source parse skipped"),
      ),
    };
  }

  /**
   * 变更集合扩展：当某些会话变更会影响其他会话的派生数据时
   * （如 subagent 文件变更需要父会话重新聚合 token 统计），
   * 子类返回需要一并重解析的会话 ID 集合。默认无关联，原样返回。
   */
  expandChangedSessionIds(changedIds: string[], _refs?: SessionSourceRef[]): string[] {
    return changedIds;
  }

  synchronizeSessionSources(
    baseline: SessionSourceSynchronizationBaseline,
    request: SessionSourceSynchronizationRequest,
  ): SessionSourceSynchronizationOutcome {
    return runSessionSourceSynchronization(this, baseline, request);
  }

  scan(options?: AgentScanOptions): SessionHead[] {
    return this.scanSessionSources(options).sessions;
  }

  scanSessionSources(options?: AgentScanOptions): SessionSourceScanBatch {
    const outcome = this.synchronizeSessionSources(
      { sessions: [], meta: this.sessionMetaMap },
      { kind: "reload", scanOptions: options },
    );
    return {
      sources: outcome.sources,
      outcomes: outcome.sourceOutcomes,
      sessions: outcome.sessions,
    };
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
      const entries = this.readSessionSourceDirectory(directory);

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
        } catch (error) {
          if (isMissingSessionSourceError(error)) continue;
          throw new SessionScanError(this.name, "reading session source metadata", {
            cause: error,
            sourcePath: filePath,
          });
        }
        if (!matchesScanWindow(stat.mtimeMs, options.scanWindow)) continue;

        files.push({ file: filePath, stat });
        this.sourceFileStats.set(filePath, stat);
      }
    };

    for (const root of typeof roots === "string" ? [roots] : roots) walk(root);
    return files;
  }

  protected readSessionSourceDirectory(directory: string): Dirent[] {
    try {
      return readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      throw new SessionScanError(this.name, "enumerating session sources", {
        cause: error,
        sourcePath: directory,
      });
    }
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

  checkForChanges(_sinceTimestamp: number, cachedSessions: SessionHead[]): ChangeCheckResult {
    const outcome = this.synchronizeSessionSources(
      { sessions: cachedSessions, meta: this.sessionMetaMap },
      { kind: "inspect" },
    );

    return {
      hasChanges: outcome.detectedSessionIds.length > 0 || outcome.sourceFailures.length > 0,
      changedIds: outcome.detectedSessionIds,
      timestamp: Date.now(),
      refs: outcome.sources,
      sourceFailures: outcome.sourceFailures,
    };
  }

  incrementalScan(
    cachedSessions: SessionHead[],
    changedIds: string[],
    refs?: SessionSourceRef[],
  ): SessionHead[] {
    return this.synchronizeSessionSources(
      { sessions: cachedSessions, meta: this.sessionMetaMap },
      { kind: "known-changes", changedIds, refs },
    ).sessions;
  }
}

/** Shared scan template for agents whose session source is a single stat-able file. */
export abstract class SingleFileSessionSource<
  TMeta extends FileSessionMeta = FileSessionMeta,
> extends FileSystemSessionSource<TMeta> {
  private readonly pendingParseResults = new Map<
    string,
    ParseSessionResult<SessionHead> | undefined
  >();

  protected abstract parseFileSessionHead(
    sourcePath: string,
    options?: AgentScanOptions,
  ): SessionHead | null;

  protected parseFileSessionHeadResult(
    sourcePath: string,
    options?: AgentScanOptions,
  ): ParseSessionResult<SessionHead> {
    const head = this.parseFileSessionHead(sourcePath, options);
    return head ? parsedSession(head) : skippedSession("source produced no session");
  }

  protected abstract createFileSessionMeta(head: SessionHead, source: SessionSourceFile): TMeta;

  scanSessionSource(sourcePath: string, options?: AgentScanOptions): SessionHead | null {
    const result = this.parseFileSessionHeadResult(sourcePath, options);
    if (this.pendingParseResults.has(sourcePath)) {
      this.pendingParseResults.set(sourcePath, result);
    }
    if (result.status === "parsed") {
      this.sessionMetaMap.set(
        result.data.id,
        this.createFileSessionMeta(result.data, this.sessionSourceFile(sourcePath)),
      );
    }
    return getParsedSession(result);
  }

  protected override scanSessionSourceResult(
    source: SessionSourceRef,
    options?: AgentScanOptions,
  ): ParseSessionResult<SessionHead> {
    this.pendingParseResults.set(source.sourcePath, undefined);
    try {
      const head = this.scanSessionSource(source.sourcePath, options);
      const result = this.pendingParseResults.get(source.sourcePath);
      if (head) return result?.status === "parsed" ? result : parsedSession(head);
      return result ?? skippedSession("source produced no session");
    } finally {
      this.pendingParseResults.delete(source.sourcePath);
    }
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
    options?: { cause?: unknown; sourcePath?: string },
  ) {
    super(`${agentName} session scan failed while ${stage}`, options);
    this.name = "SessionScanError";
    this.sourcePath = options?.sourcePath;
  }

  readonly sourcePath?: string;
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
