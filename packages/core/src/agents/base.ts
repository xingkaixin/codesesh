import type { SessionHead, SessionData } from "../types/index.js";

export interface SessionCacheMeta {
  id: string;
  sourcePath: string;
  [key: string]: unknown;
}

export interface AgentScanOptions {
  from?: number;
  to?: number;
  fast?: boolean;
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

  getUri(sessionId: string): string {
    return `${this.name}://${sessionId}`;
  }

  /**
   * Get session metadata for caching.
   * Override this to enable caching of session metadata.
   */
  getSessionMetaMap?(): Map<string, SessionCacheMeta>;

  /**
   * Restore session metadata from cache.
   * Override this to enable restoring cached metadata.
   */
  setSessionMetaMap?(meta: Map<string, SessionCacheMeta>): void;

  /**
   * 检查是否有变更（用于智能刷新）
   * @param sinceTimestamp 上次缓存时间戳
   * @param cachedSessions 缓存的会话列表
   * @returns 变更检测结果
   */
  checkForChanges?(
    sinceTimestamp: number,
    cachedSessions: SessionHead[],
  ): Promise<ChangeCheckResult> | ChangeCheckResult;

  /**
   * 增量扫描（仅扫描变更的会话）
   * @param cachedSessions 缓存的会话列表
   * @param changedIds 变更的会话 ID 列表
   * @returns 更新后的会话列表
   */
  incrementalScan?(
    cachedSessions: SessionHead[],
    changedIds: string[],
  ): Promise<SessionHead[]> | SessionHead[];

  /**
   * Persist a user-editable display title for the session.
   * Implementations write back to the session's underlying storage so that
   * subsequent scans pick the new title up. Pass `null` or an empty string
   * to clear the alias and fall back to the auto-derived title.
   * Returns the refreshed SessionHead, or `null` when the session is unknown.
   */
  setSessionAlias?(sessionId: string, alias: string | null): SessionHead | null;
}
