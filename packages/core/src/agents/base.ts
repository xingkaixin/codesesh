import { existsSync, statSync } from "node:fs";
import type { SessionHead, SessionData, ParseSessionResult } from "../types/index.js";
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

export function matchesScanWindow(activityTime: number, options?: AgentScanOptions): boolean {
  if (options?.from != null && activityTime < options.from) return false;
  if (options?.to != null && activityTime > options.to) return false;
  return true;
}

/** 变更检测结果 */
export interface ChangeCheckResult {
  /** 是否有变更 */
  hasChanges: boolean;
  /** 变更的会话 ID 列表（可选，用于精确更新） */
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

export abstract class BaseAgent {
  abstract readonly name: string;
  abstract readonly displayName: string;

  /** Check if this agent has data available on the local filesystem. */
  abstract isAvailable(): boolean;

  /** Scan for available sessions, returning lightweight metadata. */
  abstract scan(options?: AgentScanOptions): SessionHead[];

  /** Load full session data including all messages. */
  abstract getSessionData(sessionId: string): SessionData;

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

  /**
   * 变更检测：枚举当前源 → 与缓存 metaMap 的指纹/路径比对。
   * 新增、变更、删除三类统一产出 changedIds。
   */
  checkForChanges(_sinceTimestamp: number, cachedSessions: SessionHead[]): ChangeCheckResult {
    const currentRefs = this.listSessionSources();
    const currentIds = new Set(currentRefs.map((ref) => ref.sessionId));
    const changedIds = new Set<string>();

    for (const ref of currentRefs) {
      const meta = this.sessionMetaMap.get(ref.sessionId);
      const samePath = meta?.sourcePath === ref.sourcePath;
      const sameFingerprint =
        typeof meta?.sourceFingerprint === "string" && meta.sourceFingerprint === ref.fingerprint;
      if (!samePath || !sameFingerprint) changedIds.add(ref.sessionId);
    }

    for (const session of cachedSessions) {
      if (!currentIds.has(session.id)) changedIds.add(session.id);
    }

    const changedIdList = [...changedIds];
    return {
      hasChanges: changedIdList.length > 0,
      changedIds: changedIdList,
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

/**
 * 数据库型 Agent 基类：所有会话聚合在单个 SQLite 数据库中，
 * 无法做 per-file 指纹，故变更检测退化为"库文件 mtime 是否推进"，
 * 增量扫描退化为全量重扫。
 */
export abstract class DatabaseSessionSource extends BaseAgent {
  protected sessionMetaMap = new Map<string, SessionCacheMeta>();

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
   * 变更检测：数据库内部变更难以按行定位，简单起见按库文件 mtime 判定。
   * 库有变更则标记全部缓存会话刷新。
   */
  checkForChanges(sinceTimestamp: number, cachedSessions: SessionHead[]): ChangeCheckResult {
    const dbPath = this.getDatabasePath();
    if (!dbPath || !existsSync(dbPath)) {
      return { hasChanges: false, timestamp: Date.now() };
    }

    try {
      const hasChanges = statSync(dbPath).mtimeMs > sinceTimestamp;
      return {
        hasChanges,
        changedIds: hasChanges ? cachedSessions.map((session) => session.id) : [],
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
