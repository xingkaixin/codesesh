import {
  DatabaseSessionSource,
  filteredSession,
  getParsedSession,
  parsedSession,
  skippedSession,
} from "./base.js";
import type { AgentScanOptions, ParseSessionResult } from "./base.js";
import type { SessionHead, SessionData, Message, MessagePart } from "../types/index.js";
import { openDbReadOnly, type SQLiteDatabase } from "../utils/sqlite.js";
import { estimateTokenCost } from "../utils/cost.js";
import { resolveSessionTitle } from "../utils/title-fallback.js";
import { isInternalEventType } from "../utils/parse-cleanup.js";
import { asRecord, asString, narrowField, reportFieldMismatch } from "../utils/narrow.js";
import {
  cleanInternalText,
  cleanParsedMessages,
  firstUserMessageTitle,
} from "../utils/session-normalization.js";

interface OpenCodeMessageRow {
  id?: unknown;
  session_id?: unknown;
  data?: string;
  time_created?: unknown;
}

interface OpenCodePartRow {
  message_id?: unknown;
  data?: string;
  time_created?: unknown;
}

interface OpenCodeHeadContext {
  stats: SessionHead["stats"];
  messageTitle: string | null;
}

interface OpenCodeSqliteAgentConfig {
  name: string;
  displayName: string;
  findDbPath: () => string | null;
}

const MESSAGE_ROLES = new Set<Message["role"]>(["user", "assistant", "tool"]);

/** Parses a SQLite `data` JSON column; non-object payloads fall back to `{}` (reported as drift). */
function parseJsonRecord(raw: unknown, agentName: string, field: string): Record<string, unknown> {
  const parsed = asRecord(JSON.parse(String(raw ?? "{}")));
  if (parsed) return parsed;
  reportFieldMismatch(agentName, field);
  return {};
}

function narrowMessageRole(value: unknown): Message["role"] | undefined {
  const role = asString(value);
  return role !== undefined && (MESSAGE_ROLES as Set<string>).has(role)
    ? (role as Message["role"])
    : undefined;
}

function parseMessageRole(value: unknown, agentName: string): Message["role"] {
  return narrowField(agentName, "message.role", value, narrowMessageRole) ?? "assistant";
}

function parseTokens(value: unknown, agentName: string): Record<string, unknown> | undefined {
  return narrowField(agentName, "message.tokens", value, asRecord);
}

function parseModel(value: unknown, agentName: string): string | null {
  return narrowField(agentName, "message.modelID", value, asString) ?? null;
}

export class OpenCodeSqliteAgent extends DatabaseSessionSource {
  readonly name: string;
  readonly displayName: string;

  private dbPath: string | null = null;

  constructor(private readonly config: OpenCodeSqliteAgentConfig) {
    super();
    this.name = config.name;
    this.displayName = config.displayName;
  }

  protected getDatabasePath(): string | null {
    if (!this.dbPath) {
      this.dbPath = this.findDbPath();
    }
    return this.dbPath;
  }

  private findDbPath(): string | null {
    return this.config.findDbPath();
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
            s.version, s.summary_files
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

      const headContexts = hasMessageTable
        ? this.buildHeadContexts(
            this.readHeadMessageRows(db, cutoffTime),
            this.readHeadPartRows(db, cutoffTime),
          )
        : new Map<string, OpenCodeHeadContext>();
      const heads: SessionHead[] = [];
      options?.onProgress?.({ total: rows.length, processed: 0, sessions: 0 });
      let processed = 0;
      for (const row of rows) {
        const head = getParsedSession(
          this.parseSessionHeadRow(row, hasMessageTable, headContexts.get(String(row.id ?? ""))),
        );
        if (head) {
          heads.push(head);

          // Store session metadata for caching
          if (this.dbPath) {
            this.sessionMetaMap.set(head.id, {
              id: head.id,
              sourcePath: this.dbPath,
            });
          }
        }
        processed += 1;
        options?.onProgress?.({ total: rows.length, processed, sessions: heads.length });
      }

      return heads;
    } catch {
      return [];
    } finally {
      db.close();
    }
  }

  private parseSessionHeadRow(
    row: Record<string, unknown>,
    hasMessageTable: boolean,
    context?: OpenCodeHeadContext,
  ): ParseSessionResult<SessionHead> {
    const id = String(row.id ?? "");
    if (!id) return skippedSession("missing session id");

    const timeCreated = Number(row.time_created ?? 0);
    const timeUpdated = Number(row.time_updated ?? timeCreated);
    const stats = context?.stats ?? null;
    const messageCount = stats?.message_count ?? 0;
    if (hasMessageTable && messageCount === 0) return filteredSession("no visible messages");
    const messageTitle = context?.messageTitle ?? null;

    return parsedSession({
      id,
      slug: `${this.name}/${id}`,
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

  private readHeadMessageRows(db: SQLiteDatabase, cutoffTime: number): OpenCodeMessageRow[] {
    return db
      .prepare(
        `
          SELECT m.id, m.session_id, m.data, m.time_created
          FROM message m
          JOIN session s ON s.id = m.session_id
          WHERE COALESCE(s.time_updated, s.time_created) >= ?
          ORDER BY m.session_id, m.time_created ASC
        `,
      )
      .all(cutoffTime) as OpenCodeMessageRow[];
  }

  private readHeadPartRows(db: SQLiteDatabase, cutoffTime: number): OpenCodePartRow[] {
    return db
      .prepare(
        `
          SELECT p.message_id, p.data, p.time_created
          FROM part p
          JOIN message m ON m.id = p.message_id
          JOIN session s ON s.id = m.session_id
          WHERE COALESCE(s.time_updated, s.time_created) >= ?
          ORDER BY p.message_id, p.time_created ASC
        `,
      )
      .all(cutoffTime) as OpenCodePartRow[];
  }

  private parsePartRow(
    partRow: Pick<OpenCodePartRow, "data" | "time_created">,
  ): MessagePart | null {
    const partData = parseJsonRecord(partRow.data, this.name, "part.data");
    const partType = String(partData.type ?? "");
    if (isInternalEventType(partType)) return null;

    if (partType === "text" || partType === "reasoning") {
      const text = cleanInternalText(String(partData.text ?? ""));
      if (!text) return null;
      return {
        type: partType as "text" | "reasoning",
        text,
        time_created: Number(partRow.time_created ?? 0),
      };
    }

    if (partType === "tool") {
      return {
        type: "tool",
        tool: String(partData.tool ?? ""),
        callID: String(partData.callID ?? ""),
        title: cleanInternalText(String(partData.title ?? "")),
        state: asRecord(partData.state) ?? {},
        time_created: Number(partRow.time_created ?? 0),
      };
    }

    return null;
  }

  private readMessageParts(db: SQLiteDatabase, messageId: unknown): MessagePart[] {
    const partRows = db
      .prepare("SELECT data, time_created FROM part WHERE message_id = ? ORDER BY time_created ASC")
      .all(messageId) as OpenCodePartRow[];
    return partRows
      .map((partRow) => this.parsePartRow(partRow))
      .filter((part): part is MessagePart => part !== null);
  }

  private buildPartsByMessage(partRows: OpenCodePartRow[]): Map<string, MessagePart[]> {
    const partsByMessage = new Map<string, MessagePart[]>();
    for (const row of partRows) {
      const messageId = String(row.message_id ?? "");
      if (!messageId) continue;
      const part = this.parsePartRow(row);
      if (!part) continue;
      const parts = partsByMessage.get(messageId);
      if (parts) {
        parts.push(part);
      } else {
        partsByMessage.set(messageId, [part]);
      }
    }
    return partsByMessage;
  }

  private buildHeadContexts(
    messageRows: OpenCodeMessageRow[],
    partRows: OpenCodePartRow[],
  ): Map<string, OpenCodeHeadContext> {
    const partsByMessage = this.buildPartsByMessage(partRows);
    const contexts = new Map<string, OpenCodeHeadContext>();

    for (const row of messageRows) {
      const sessionId = String(row.session_id ?? "");
      if (!sessionId) continue;
      const msgData = parseJsonRecord(row.data, this.name, "message.data");
      if (isInternalEventType(msgData.type)) continue;
      const parts = partsByMessage.get(String(row.id ?? "")) ?? [];
      if (parts.length === 0) continue;

      let context = contexts.get(sessionId);
      if (!context) {
        context = {
          stats: {
            message_count: 0,
            total_input_tokens: 0,
            total_output_tokens: 0,
            total_cost: 0,
          },
          messageTitle: null,
        };
        contexts.set(sessionId, context);
      }

      const cost = Number(msgData.cost ?? 0);
      const tokens = parseTokens(msgData.tokens, this.name);
      const inputTokens = Number(tokens?.input ?? 0);
      const outputTokens = Number(tokens?.output ?? 0);
      const model = parseModel(msgData.modelID, this.name);
      const estimatedCost =
        cost > 0 ? null : estimateTokenCost(model, { input: inputTokens, output: outputTokens });

      if (estimatedCost !== null) context.stats.cost_source = "estimated";
      context.stats.total_cost += cost || estimatedCost || 0;
      context.stats.total_input_tokens += inputTokens;
      context.stats.total_output_tokens += outputTokens;
      context.stats.message_count += 1;

      if (!context.messageTitle && String(msgData.role ?? "") === "user") {
        context.messageTitle = firstUserMessageTitle([
          {
            id: String(row.id ?? ""),
            role: "user",
            agent: null,
            time_created: Number(row.time_created ?? 0),
            parts,
          },
        ]);
      }
    }

    for (const context of contexts.values()) {
      if (context.stats.total_cost > 0 && context.stats.cost_source !== "estimated") {
        context.stats.cost_source = "recorded";
      }
    }

    return contexts;
  }

  getSessionData(sessionId: string): SessionData {
    // Ensure dbPath is set
    if (!this.dbPath) {
      this.dbPath = this.findDbPath();
    }
    if (!this.dbPath) {
      throw new Error(`${this.displayName} database is missing`);
    }

    const db = openDbReadOnly(this.dbPath);
    if (!db) {
      throw new Error(`${this.displayName} database is missing`);
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
      const slug = `${this.name}/${id}`;
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
        const msgData = parseJsonRecord(msgRow.data, this.name, "message.data");
        if (isInternalEventType(msgData.type)) continue;

        const cost = Number(msgData.cost ?? 0);
        const tokens = parseTokens(msgData.tokens, this.name);
        const inputTokens = Number(tokens?.input ?? 0);
        const outputTokens = Number(tokens?.output ?? 0);
        const model = parseModel(msgData.modelID, this.name);
        const estimatedCost =
          cost > 0 ? null : estimateTokenCost(model, { input: inputTokens, output: outputTokens });
        const resolvedCost = cost || estimatedCost || 0;

        const parts = this.readMessageParts(db, msgRow.id);
        if (parts.length === 0) continue;

        messages.push({
          id: String(msgRow.id ?? ""),
          role: parseMessageRole(msgData.role, this.name),
          agent: asString(msgData.agent) ?? null,
          mode: asString(msgData.mode) ?? null,
          model,
          provider: asString(msgData.providerID) ?? null,
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
        version: asString(sessionRow.version) ?? undefined,
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
