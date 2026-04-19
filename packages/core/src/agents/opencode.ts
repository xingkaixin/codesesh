import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { BaseAgent } from "./base.js";
import type { SessionCacheMeta, ChangeCheckResult } from "./base.js";
import type { SessionHead, SessionData, Message, MessagePart } from "../types/index.js";
import { resolveProviderRoots, firstExisting } from "../discovery/paths.js";
import { openDbReadOnly, isSqliteAvailable, type SQLiteDatabase } from "../utils/sqlite.js";

export class OpenCodeAgent extends BaseAgent {
  readonly name = "opencode";
  readonly displayName = "OpenCode";

  private dbPath: string | null = null;

  // Session metadata for caching
  private sessionMetaMap = new Map<string, { id: string; sourcePath: string }>();

  private findDbPath(): string | null {
    if (!isSqliteAvailable()) return null;
    const roots = resolveProviderRoots();
    return firstExisting(join(roots.opencodeRoot, "opencode.db"), "data/opencode/opencode.db");
  }

  isAvailable(): boolean {
    this.dbPath = this.findDbPath();
    return this.dbPath !== null;
  }

  scan(): SessionHead[] {
    if (!this.dbPath) return [];

    const db = openDbReadOnly(this.dbPath);
    if (!db) return [];

    try {
      const cutoffTime = Date.now() - 3650 * 24 * 60 * 60 * 1000;

      const hasMessageTable = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'message'")
        .get();

      let rows: Record<string, unknown>[];
      if (hasMessageTable) {
        rows = db
          .prepare(`
          SELECT
            s.id, s.title, s.time_created, s.time_updated, s.slug, s.directory,
            s.version, s.summary_files,
            (SELECT COUNT(*) FROM message m WHERE m.session_id = s.id) AS message_count,
            (SELECT m.data FROM message m
             WHERE m.session_id = s.id AND m.data LIKE '%"modelID"%'
             ORDER BY m.time_created DESC LIMIT 1) AS model_message_data
          FROM session s
          WHERE s.time_created >= ?
          ORDER BY s.time_created DESC
        `)
          .all(cutoffTime);
      } else {
        rows = db
          .prepare(`
          SELECT s.id, s.title, s.time_created, s.time_updated, s.slug, s.directory,
            s.version, s.summary_files, 0 AS message_count, NULL AS model_message_data
          FROM session s
          WHERE s.time_created >= ?
          ORDER BY s.time_created DESC
        `)
          .all(cutoffTime);
      }

      const heads: SessionHead[] = [];
      for (const row of rows) {
        const id = String(row.id ?? "");
        const title = String(row.title ?? "").trim() || "Untitled";
        const timeCreated = Number(row.time_created ?? 0);
        const timeUpdated = Number(row.time_updated ?? timeCreated);
        const slug = `opencode/${id}`;
        const directory = String(row.directory ?? "");
        const stats = hasMessageTable ? this.readSessionStats(db, id) : null;

        heads.push({
          id,
          slug,
          title,
          directory,
          time_created: timeCreated,
          time_updated: timeUpdated,
          stats: {
            message_count: stats?.message_count ?? Number(row.message_count ?? 0),
            total_input_tokens: stats?.total_input_tokens ?? 0,
            total_output_tokens: stats?.total_output_tokens ?? 0,
            total_cost: stats?.total_cost ?? 0,
          },
        });

        // Store session metadata for caching
        if (this.dbPath) {
          this.sessionMetaMap.set(id, {
            id,
            sourcePath: this.dbPath,
          });
        }
      }

      return heads;
    } catch {
      return [];
    } finally {
      db.close();
    }
  }

  getSessionMetaMap(): Map<string, SessionCacheMeta> {
    return this.sessionMetaMap as Map<string, SessionCacheMeta>;
  }

  setSessionMetaMap(meta: Map<string, SessionCacheMeta>): void {
    this.sessionMetaMap = meta as Map<string, { id: string; sourcePath: string }>;
  }

  /**
   * 检测数据库变更
   * 对于 SQLite，检测数据库文件修改时间
   */
  checkForChanges(sinceTimestamp: number, cachedSessions: SessionHead[]): ChangeCheckResult {
    if (!this.dbPath) {
      this.dbPath = this.findDbPath();
    }
    if (!this.dbPath || !existsSync(this.dbPath)) {
      return { hasChanges: false, timestamp: Date.now() };
    }

    try {
      // 检测数据库文件修改时间
      const stat = statSync(this.dbPath);
      const hasChanges = stat.mtimeMs > sinceTimestamp;

      // 如果数据库有变更，标记所有缓存会话需要刷新
      const changedIds = hasChanges ? cachedSessions.map((s) => s.id) : [];

      return {
        hasChanges,
        changedIds,
        timestamp: Date.now(),
      };
    } catch {
      return { hasChanges: false, timestamp: Date.now() };
    }
  }

  /**
   * 增量扫描 - 重新查询数据库
   */
  incrementalScan(_cachedSessions: SessionHead[], _changedIds: string[]): SessionHead[] {
    // 对于 OpenCode，直接重新执行完整扫描
    return this.scan();
  }

  private readSessionStats(
    db: SQLiteDatabase,
    sessionId: string,
  ): SessionHead["stats"] | null {
    try {
      const rows = db
        .prepare("SELECT data FROM message WHERE session_id = ? ORDER BY time_created ASC")
        .all(sessionId) as Array<{ data?: string }>;

      let totalCost = 0;
      let totalInputTokens = 0;
      let totalOutputTokens = 0;

      for (const row of rows) {
        const msgData = JSON.parse(String(row.data ?? "{}")) as Record<string, unknown>;
        const cost = Number(msgData.cost ?? 0);
        const tokens = msgData.tokens as Record<string, unknown> | undefined;

        totalCost += cost;
        totalInputTokens += Number(tokens?.input ?? 0);
        totalOutputTokens += Number(tokens?.output ?? 0);
      }

      return {
        message_count: rows.length,
        total_input_tokens: totalInputTokens,
        total_output_tokens: totalOutputTokens,
        total_cost: totalCost,
      };
    } catch {
      return null;
    }
  }

  getSessionData(sessionId: string): SessionData {
    // Ensure dbPath is set
    if (!this.dbPath) {
      this.dbPath = this.findDbPath();
    }
    if (!this.dbPath) {
      throw new Error("OpenCode database is missing");
    }

    const db = openDbReadOnly(this.dbPath);
    if (!db) {
      throw new Error("OpenCode database is missing");
    }

    try {
      // First get session metadata
      const sessionRow = db.prepare("SELECT * FROM session WHERE id = ?").get(sessionId) as
        | Record<string, unknown>
        | undefined;
      if (!sessionRow) {
        throw new Error(`Session not found: ${sessionId}`);
      }

      const id = String(sessionRow.id ?? sessionId);
      const title = String(sessionRow.title ?? "Untitled");
      const slug = `opencode/${id}`;
      const directory = String(sessionRow.directory ?? "");
      const timeCreated = Number(sessionRow.time_created ?? 0);
      const timeUpdated = Number(sessionRow.time_updated ?? timeCreated);

      const messages: Message[] = [];
      let totalCost = 0;
      let totalInputTokens = 0;
      let totalOutputTokens = 0;

      // Get messages
      const msgRows = db
        .prepare("SELECT * FROM message WHERE session_id = ? ORDER BY time_created ASC")
        .all(sessionId) as Record<string, unknown>[];

      for (const msgRow of msgRows) {
        const msgData = JSON.parse(String(msgRow.data ?? "{}")) as Record<string, unknown>;

        const parts: MessagePart[] = [];
        const cost = Number(msgData.cost ?? 0);
        const tokens = msgData.tokens as Record<string, unknown> | undefined;
        const inputTokens = Number(tokens?.input ?? 0);
        const outputTokens = Number(tokens?.output ?? 0);

        totalCost += cost;
        totalInputTokens += inputTokens;
        totalOutputTokens += outputTokens;

        // Get parts for this message
        const partRows = db
          .prepare("SELECT * FROM part WHERE message_id = ? ORDER BY time_created ASC")
          .all(msgRow.id) as Record<string, unknown>[];

        for (const partRow of partRows) {
          const partData = JSON.parse(String(partRow.data ?? "{}")) as Record<string, unknown>;
          const partType = String(partData.type ?? "");

          if (partType === "text" || partType === "reasoning") {
            parts.push({
              type: partType as "text" | "reasoning",
              text: partData.text ?? "",
              time_created: Number(partRow.time_created ?? 0),
            });
          } else if (partType === "tool") {
            parts.push({
              type: "tool",
              tool: String(partData.tool ?? ""),
              callID: String(partData.callID ?? ""),
              title: String(partData.title ?? ""),
              state: (partData.state ?? {}) as MessagePart["state"],
              time_created: Number(partRow.time_created ?? 0),
            });
          }
          // Skip step-start, step-finish parts
        }

        messages.push({
          id: String(msgRow.id ?? ""),
          role: String(msgData.role ?? "assistant") as Message["role"],
          agent: (msgData.agent as string | null) ?? null,
          mode: (msgData.mode as string | null) ?? null,
          model: (msgData.modelID as string | null) ?? null,
          provider: (msgData.providerID as string | null) ?? null,
          time_created: Number(msgRow.time_created ?? 0),
          tokens: tokens ? { input: inputTokens, output: outputTokens } : undefined,
          cost,
          parts,
        });
      }

      return {
        id,
        title,
        slug,
        directory,
        version: (sessionRow.version as string | null) ?? undefined,
        time_created: timeCreated,
        time_updated: timeUpdated,
        summary_files: sessionRow.summary_files ?? undefined,
        stats: {
          message_count: messages.length,
          total_input_tokens: totalInputTokens,
          total_output_tokens: totalOutputTokens,
          total_cost: totalCost,
        },
        messages,
      };
    } finally {
      db.close();
    }
  }
}
