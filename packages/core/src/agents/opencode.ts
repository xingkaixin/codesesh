import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  BaseAgent,
  filteredSession,
  getParsedSession,
  parsedSession,
  skippedSession,
} from "./base.js";
import type {
  AgentScanOptions,
  ChangeCheckResult,
  ParseSessionResult,
  SessionCacheMeta,
} from "./base.js";
import type { SessionHead, SessionData, Message, MessagePart } from "../types/index.js";
import { resolveProviderRoots, firstExisting } from "../discovery/paths.js";
import { openDbReadOnly, isSqliteAvailable, type SQLiteDatabase } from "../utils/sqlite.js";
import { estimateTokenCost } from "../utils/cost.js";
import { resolveSessionTitle } from "../utils/title-fallback.js";
import { isInternalEventType } from "../utils/parse-cleanup.js";
import {
  cleanInternalText,
  cleanParsedMessages,
  firstUserMessageTitle,
} from "../utils/session-normalization.js";

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

  scan(options?: AgentScanOptions): SessionHead[] {
    if (!this.dbPath) return [];

    const db = openDbReadOnly(this.dbPath);
    if (!db) return [];

    try {
      const cutoffTime = options?.from ?? Date.now() - 3650 * 24 * 60 * 60 * 1000;

      const hasMessageTable = Boolean(
        db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'message'")
          .get(),
      );

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
          WHERE COALESCE(s.time_updated, s.time_created) >= ?
          ORDER BY s.time_created DESC
        `)
          .all(cutoffTime);
      } else {
        rows = db
          .prepare(`
          SELECT s.id, s.title, s.time_created, s.time_updated, s.slug, s.directory,
            s.version, s.summary_files, 0 AS message_count, NULL AS model_message_data
          FROM session s
          WHERE COALESCE(s.time_updated, s.time_created) >= ?
          ORDER BY s.time_created DESC
        `)
          .all(cutoffTime);
      }

      const heads: SessionHead[] = [];
      for (const row of rows) {
        const head = getParsedSession(this.parseSessionHeadRow(db, row, hasMessageTable));
        if (!head) continue;

        heads.push(head);

        // Store session metadata for caching
        if (this.dbPath) {
          this.sessionMetaMap.set(head.id, {
            id: head.id,
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

  private parseSessionHeadRow(
    db: SQLiteDatabase,
    row: Record<string, unknown>,
    hasMessageTable: boolean,
  ): ParseSessionResult<SessionHead> {
    const id = String(row.id ?? "");
    if (!id) return skippedSession("missing session id");

    const timeCreated = Number(row.time_created ?? 0);
    const timeUpdated = Number(row.time_updated ?? timeCreated);
    const stats = hasMessageTable ? this.readSessionStats(db, id) : null;
    const messageCount = stats?.message_count ?? Number(row.message_count ?? 0);
    if (hasMessageTable && messageCount === 0) return filteredSession("no visible messages");
    const messageTitle = hasMessageTable ? this.readFirstUserTitle(db, id) : null;

    return parsedSession({
      id,
      slug: `opencode/${id}`,
      title: resolveSessionTitle(String(row.title ?? ""), messageTitle, null),
      directory: String(row.directory ?? ""),
      time_created: timeCreated,
      time_updated: timeUpdated,
      stats: {
        message_count: messageCount,
        total_input_tokens: stats?.total_input_tokens ?? 0,
        total_output_tokens: stats?.total_output_tokens ?? 0,
        total_cost: stats?.total_cost ?? 0,
        cost_source: stats?.cost_source,
      },
    });
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

  private readMessageParts(db: SQLiteDatabase, messageId: unknown): MessagePart[] {
    const partRows = db
      .prepare("SELECT * FROM part WHERE message_id = ? ORDER BY time_created ASC")
      .all(messageId) as Record<string, unknown>[];
    const parts: MessagePart[] = [];

    for (const partRow of partRows) {
      const partData = JSON.parse(String(partRow.data ?? "{}")) as Record<string, unknown>;
      const partType = String(partData.type ?? "");
      if (isInternalEventType(partType)) continue;

      if (partType === "text" || partType === "reasoning") {
        const text = cleanInternalText(String(partData.text ?? ""));
        if (text) {
          parts.push({
            type: partType as "text" | "reasoning",
            text,
            time_created: Number(partRow.time_created ?? 0),
          });
        }
      } else if (partType === "tool") {
        parts.push({
          type: "tool",
          tool: String(partData.tool ?? ""),
          callID: String(partData.callID ?? ""),
          title: cleanInternalText(String(partData.title ?? "")),
          state: (partData.state ?? {}) as MessagePart["state"],
          time_created: Number(partRow.time_created ?? 0),
        });
      }
    }

    return parts;
  }

  private readFirstUserTitle(db: SQLiteDatabase, sessionId: string): string | null {
    const rows = db
      .prepare(
        "SELECT id, data, time_created FROM message WHERE session_id = ? ORDER BY time_created ASC",
      )
      .all(sessionId) as Record<string, unknown>[];

    for (const row of rows) {
      const msgData = JSON.parse(String(row.data ?? "{}")) as Record<string, unknown>;
      if (isInternalEventType(msgData.type)) continue;
      if (String(msgData.role ?? "") !== "user") continue;
      const parts = this.readMessageParts(db, row.id);
      const title = firstUserMessageTitle([
        {
          id: String(row.id ?? ""),
          role: "user",
          agent: null,
          time_created: Number(row.time_created ?? 0),
          parts,
        },
      ]);
      if (title) return title;
    }

    return null;
  }

  private readSessionStats(db: SQLiteDatabase, sessionId: string): SessionHead["stats"] | null {
    try {
      const rows = db
        .prepare("SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created ASC")
        .all(sessionId) as Array<{ id?: unknown; data?: string }>;

      let totalCost = 0;
      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      let hasEstimatedCost = false;
      let messageCount = 0;

      for (const row of rows) {
        const msgData = JSON.parse(String(row.data ?? "{}")) as Record<string, unknown>;
        if (isInternalEventType(msgData.type)) continue;
        const parts = this.readMessageParts(db, row.id);
        if (parts.length === 0) continue;

        const cost = Number(msgData.cost ?? 0);
        const tokens = msgData.tokens as Record<string, unknown> | undefined;
        const inputTokens = Number(tokens?.input ?? 0);
        const outputTokens = Number(tokens?.output ?? 0);
        const model = (msgData.modelID as string | null) ?? null;
        const estimatedCost =
          cost > 0 ? null : estimateTokenCost(model, { input: inputTokens, output: outputTokens });

        if (estimatedCost !== null) hasEstimatedCost = true;
        totalCost += cost || estimatedCost || 0;
        totalInputTokens += inputTokens;
        totalOutputTokens += outputTokens;
        messageCount++;
      }

      return {
        message_count: messageCount,
        total_input_tokens: totalInputTokens,
        total_output_tokens: totalOutputTokens,
        total_cost: totalCost,
        cost_source: totalCost > 0 ? (hasEstimatedCost ? "estimated" : "recorded") : undefined,
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
      const slug = `opencode/${id}`;
      const directory = String(sessionRow.directory ?? "");
      const timeCreated = Number(sessionRow.time_created ?? 0);
      const timeUpdated = Number(sessionRow.time_updated ?? timeCreated);

      const messages: Message[] = [];
      let totalCost = 0;
      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      let hasEstimatedCost = false;

      // Get messages
      const msgRows = db
        .prepare("SELECT * FROM message WHERE session_id = ? ORDER BY time_created ASC")
        .all(sessionId) as Record<string, unknown>[];

      for (const msgRow of msgRows) {
        const msgData = JSON.parse(String(msgRow.data ?? "{}")) as Record<string, unknown>;
        if (isInternalEventType(msgData.type)) continue;

        const cost = Number(msgData.cost ?? 0);
        const tokens = msgData.tokens as Record<string, unknown> | undefined;
        const inputTokens = Number(tokens?.input ?? 0);
        const outputTokens = Number(tokens?.output ?? 0);
        const model = (msgData.modelID as string | null) ?? null;
        const estimatedCost =
          cost > 0 ? null : estimateTokenCost(model, { input: inputTokens, output: outputTokens });
        const resolvedCost = cost || estimatedCost || 0;

        const parts = this.readMessageParts(db, msgRow.id);
        if (parts.length === 0) continue;

        messages.push({
          id: String(msgRow.id ?? ""),
          role: String(msgData.role ?? "assistant") as Message["role"],
          agent: (msgData.agent as string | null) ?? null,
          mode: (msgData.mode as string | null) ?? null,
          model,
          provider: (msgData.providerID as string | null) ?? null,
          time_created: Number(msgRow.time_created ?? 0),
          tokens: tokens ? { input: inputTokens, output: outputTokens } : undefined,
          cost: resolvedCost,
          cost_source: resolvedCost > 0 ? (cost > 0 ? "recorded" : "estimated") : undefined,
          parts,
        });
      }

      const cleanedMessages = cleanParsedMessages(messages);
      const title = resolveSessionTitle(
        String(sessionRow.title ?? ""),
        firstUserMessageTitle(cleanedMessages),
        null,
      );
      for (const message of cleanedMessages) {
        totalCost += message.cost ?? 0;
        totalInputTokens += message.tokens?.input ?? 0;
        totalOutputTokens += message.tokens?.output ?? 0;
        if (message.cost_source === "estimated") hasEstimatedCost = true;
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
          message_count: cleanedMessages.length,
          total_input_tokens: totalInputTokens,
          total_output_tokens: totalOutputTokens,
          total_cost: totalCost,
          cost_source: totalCost > 0 ? (hasEstimatedCost ? "estimated" : "recorded") : undefined,
        },
        messages: cleanedMessages,
      };
    } finally {
      db.close();
    }
  }
}
