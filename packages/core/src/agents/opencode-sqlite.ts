import {
  DatabaseSessionSource,
  SessionScanError,
  filteredSession,
  getParsedSession,
  parsedSession,
  skippedSession,
} from "./base.js";
import type {
  AgentScanOptions,
  ChangeCheckResult,
  ParseSessionResult,
  SessionWatchPlan,
} from "./base.js";
import type { SessionHead, SessionDetail, Message, MessagePart } from "../types/index.js";
import { normalizeMessageParts } from "../contract/message-part.js";
import { capturePricingMisses } from "../pricing/cost.js";
import { columnExists, openDbReadOnly, type SQLiteDatabase } from "../utils/sqlite.js";
import { estimateTokenCost } from "../utils/cost.js";
import { resolveSessionTitle } from "../utils/title-fallback.js";
import { isInternalEventType } from "../utils/parse-cleanup.js";
import { asRecord, asString, narrowField, reportFieldMismatch } from "../utils/narrow.js";
import { getCoreDiagnostics } from "../utils/diagnostics.js";
import {
  cleanMessagePart,
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
  unpricedModels: Set<string>;
}

interface OpenCodeSqliteAgentConfig {
  name: string;
  displayName: string;
  findDbPath: () => string | null;
  getSessionWatchPlan: () => SessionWatchPlan;
}

const MESSAGE_ROLES = new Set<Message["role"]>(["user", "assistant", "tool"]);
const SESSION_ID_QUERY_CHUNK_SIZE = 500;
const HEAD_PARSER_VERSION = "opencode-sqlite-head-v1";

function compareSessionRowsByActivityDesc(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): number {
  const leftUpdated = Number(left.time_updated ?? left.time_created ?? 0);
  const rightUpdated = Number(right.time_updated ?? right.time_created ?? 0);
  return (
    rightUpdated - leftUpdated ||
    Number(right.time_created ?? 0) - Number(left.time_created ?? 0) ||
    String(right.id ?? "").localeCompare(String(left.id ?? ""))
  );
}

function accumulateTokenStats(
  stats: SessionHead["stats"],
  msgData: Record<string, unknown>,
  agentName: string,
): void {
  const cost = Number(msgData.cost ?? 0);
  const tokens = parseTokens(msgData.tokens, agentName);
  const inputTokens = Number(tokens?.input ?? 0);
  const outputTokens = Number(tokens?.output ?? 0);
  const model = parseModel(msgData.modelID, agentName);
  const estimatedCost =
    cost > 0 ? null : estimateTokenCost(model, { input: inputTokens, output: outputTokens });

  if (estimatedCost !== null) stats.cost_source = "estimated";
  stats.total_cost += cost || estimatedCost || 0;
  stats.total_input_tokens += inputTokens;
  stats.total_output_tokens += outputTokens;
}

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

  getSessionWatchPlan(): SessionWatchPlan {
    return this.config.getSessionWatchPlan();
  }

  private findDbPath(): string | null {
    return this.config.findDbPath();
  }

  isAvailable(): boolean {
    this.dbPath = this.findDbPath();
    return this.dbPath !== null;
  }

  scan(options?: AgentScanOptions): SessionHead[] {
    const dbPath = this.getDatabasePath();
    if (!dbPath) return [];

    const db = openDbReadOnly(dbPath);
    if (!db) throw new SessionScanError(this.name, "opening the database");

    try {
      const cutoffTime = options?.from ?? Date.now() - 3650 * 24 * 60 * 60 * 1000;
      const activityPredicate =
        options?.to == null
          ? "COALESCE(s.time_updated, s.time_created) >= ?"
          : "COALESCE(s.time_updated, s.time_created) >= ? AND COALESCE(s.time_updated, s.time_created) <= ?";
      const activityBindings = options?.to == null ? [cutoffTime] : [cutoffTime, options.to];

      const hasMessageTable = Boolean(
        db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'message'")
          .get(),
      );

      const hasTaskType = columnExists(db, "session", "task_type");
      const hasParentId = columnExists(db, "session", "parent_id");
      const childPredicate = hasParentId
        ? "AND s.parent_id IS NULL"
        : hasTaskType
          ? "AND (s.task_type IS NULL OR s.task_type != 'subagent_child')"
          : "";

      let rows: Record<string, unknown>[];
      const parentIdSelect = hasParentId ? ", s.parent_id" : "";
      if (hasMessageTable) {
        rows = db
          .prepare(`
          SELECT
            s.id, s.title, s.time_created, s.time_updated, s.slug, s.directory,
            s.version, s.summary_files${parentIdSelect}
          FROM session s
          WHERE ${activityPredicate}
          ${childPredicate}
          ORDER BY COALESCE(s.time_updated, s.time_created) DESC, s.time_created DESC, s.id DESC
        `)
          .all(...activityBindings);
      } else {
        rows = db
          .prepare(`
          SELECT s.id, s.title, s.time_created, s.time_updated, s.slug, s.directory,
            s.version, s.summary_files, 0 AS message_count, NULL AS model_message_data${parentIdSelect}
          FROM session s
          WHERE ${activityPredicate}
          ${childPredicate}
          ORDER BY COALESCE(s.time_updated, s.time_created) DESC, s.time_created DESC, s.id DESC
        `)
          .all(...activityBindings);
      }

      if (hasParentId && options?.includeRelatedSessions !== false) {
        const rootIds = rows.map((row) => String(row.id ?? "")).filter(Boolean);
        const relatedRows = this.readRelatedSessionRows(db, rootIds);
        const knownIds = new Set(rootIds);
        rows.push(...relatedRows.filter((row) => !knownIds.has(String(row.id ?? ""))));
      }

      rows.sort(compareSessionRowsByActivityDesc);

      const sessionIds = new Set(rows.map((row) => String(row.id ?? "")).filter(Boolean));

      const headContexts = hasMessageTable
        ? this.buildHeadContexts(
            this.readHeadMessageRows(db, cutoffTime, sessionIds.size > 0 ? sessionIds : undefined),
            this.readHeadPartRows(db, cutoffTime, sessionIds.size > 0 ? sessionIds : undefined),
          )
        : new Map<string, OpenCodeHeadContext>();
      const heads: SessionHead[] = [];
      options?.onProgress?.({ total: rows.length, processed: 0, sessions: 0 });
      let processed = 0;
      for (const row of rows) {
        const context = headContexts.get(String(row.id ?? ""));
        const head = getParsedSession(this.parseSessionHeadRow(row, hasMessageTable, context));
        if (head) {
          heads.push(head);
          this.rememberSession(head.reference.sessionId, {
            headParserVersion: HEAD_PARSER_VERSION,
            ...(context && context.unpricedModels.size > 0
              ? { unpricedModels: [...context.unpricedModels] }
              : {}),
          });
        }
        processed += 1;
        options?.onProgress?.({ total: rows.length, processed, sessions: heads.length });
      }

      return heads;
    } catch (error) {
      throw new SessionScanError(this.name, "reading sessions", { cause: error });
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
      ...this.sessionIdentity(id),
      title: resolveSessionTitle(String(row.title ?? ""), messageTitle, null),
      directory: String(row.directory ?? ""),
      parent_reference:
        row.parent_id == null || String(row.parent_id) === ""
          ? undefined
          : { agentName: this.name, sessionId: String(row.parent_id) },
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

  private readHeadMessageRows(
    db: SQLiteDatabase,
    cutoffTime: number,
    sessionIds?: Set<string>,
  ): OpenCodeMessageRow[] {
    const ids = sessionIds ? [...sessionIds] : [];
    if (ids.length === 0) {
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

    const rows: OpenCodeMessageRow[] = [];
    for (let offset = 0; offset < ids.length; offset += SESSION_ID_QUERY_CHUNK_SIZE) {
      const chunk = ids.slice(offset, offset + SESSION_ID_QUERY_CHUNK_SIZE);
      rows.push(
        ...(db
          .prepare(
            `
              SELECT m.id, m.session_id, m.data, m.time_created
              FROM message m
              JOIN session s ON s.id = m.session_id
              WHERE s.id IN (${chunk.map(() => "?").join(",")})
              ORDER BY m.session_id, m.time_created ASC
            `,
          )
          .all(...chunk) as OpenCodeMessageRow[]),
      );
    }
    return rows;
  }

  private readHeadPartRows(
    db: SQLiteDatabase,
    cutoffTime: number,
    sessionIds?: Set<string>,
  ): OpenCodePartRow[] {
    const ids = sessionIds ? [...sessionIds] : [];
    if (ids.length === 0) {
      return db
        .prepare(
          `
            SELECT p.message_id, p.data, p.time_created
            FROM part p
            JOIN message m ON m.id = p.message_id
            JOIN session s ON s.id = m.session_id
            WHERE COALESCE(s.time_updated, s.time_created) >= ?
            ORDER BY p.message_id, p.time_created ASC, p.id ASC
          `,
        )
        .all(cutoffTime) as OpenCodePartRow[];
    }

    const rows: OpenCodePartRow[] = [];
    for (let offset = 0; offset < ids.length; offset += SESSION_ID_QUERY_CHUNK_SIZE) {
      const chunk = ids.slice(offset, offset + SESSION_ID_QUERY_CHUNK_SIZE);
      rows.push(
        ...(db
          .prepare(
            `
              SELECT p.message_id, p.data, p.time_created
              FROM part p
              JOIN message m ON m.id = p.message_id
              JOIN session s ON s.id = m.session_id
              WHERE s.id IN (${chunk.map(() => "?").join(",")})
              ORDER BY p.message_id, p.time_created ASC, p.id ASC
            `,
          )
          .all(...chunk) as OpenCodePartRow[]),
      );
    }
    return rows;
  }

  private readRelatedSessionRows(db: SQLiteDatabase, rootIds: string[]): Record<string, unknown>[] {
    if (rootIds.length === 0) return [];

    const startedAt = performance.now();
    const relatedById = new Map<string, Record<string, unknown>>();
    let candidateRows = 0;
    let queryCount = 0;
    for (let offset = 0; offset < rootIds.length; offset += SESSION_ID_QUERY_CHUNK_SIZE) {
      const chunk = rootIds.slice(offset, offset + SESSION_ID_QUERY_CHUNK_SIZE);
      const rows = db
        .prepare(
          `
            WITH RECURSIVE related_sessions(
              id, title, time_created, time_updated, slug, directory,
              version, summary_files, parent_id
            ) AS (
              SELECT
                s.id, s.title, s.time_created, s.time_updated, s.slug, s.directory,
                s.version, s.summary_files, s.parent_id
              FROM session s
              WHERE s.parent_id IN (${chunk.map(() => "?").join(",")})

              UNION

              SELECT
                child.id, child.title, child.time_created, child.time_updated,
                child.slug, child.directory, child.version, child.summary_files, child.parent_id
              FROM session child
              JOIN related_sessions parent ON child.parent_id = parent.id
            )
            SELECT
              id, title, time_created, time_updated, slug, directory,
              version, summary_files, parent_id
            FROM related_sessions
            ORDER BY time_created ASC, id ASC
          `,
        )
        .all(...chunk) as Record<string, unknown>[];
      queryCount += 1;
      candidateRows += rows.length;
      for (const row of rows) {
        const id = String(row.id ?? "");
        if (id && !relatedById.has(id)) relatedById.set(id, row);
      }
    }
    const result = [...relatedById.values()];
    getCoreDiagnostics()?.info?.("agent.related_sessions.query", {
      agent_name: this.name,
      root_count: rootIds.length,
      query_count: queryCount,
      candidate_rows: candidateRows,
      related_rows: result.length,
      duration_ms: Number((performance.now() - startedAt).toFixed(2)),
    });
    return result;
  }

  private parsePartRow(
    partRow: Pick<OpenCodePartRow, "data" | "time_created">,
  ): MessagePart | null {
    const partData = parseJsonRecord(partRow.data, this.name, "part.data");
    const partType = String(partData.type ?? "");
    if (isInternalEventType(partType)) return null;
    const [part] = normalizeMessageParts([
      { ...partData, time_created: Number(partRow.time_created ?? 0) },
    ]);
    return part ? cleanMessagePart(part) : null;
  }

  /**
   * Every part of one session in a single read. Fetching per message turned a
   * detail into M+2 queries, and without an index on part(message_id) each one
   * scanned the whole table.
   */
  private readSessionPartRows(db: SQLiteDatabase, sessionId: string): OpenCodePartRow[] {
    return db
      .prepare(
        `
          SELECT p.message_id, p.data, p.time_created
          FROM part p
          JOIN message m ON m.id = p.message_id
          WHERE m.session_id = ?
          ORDER BY p.message_id, p.time_created ASC, p.id ASC
        `,
      )
      .all(sessionId) as OpenCodePartRow[];
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

    const ensureContext = (sessionId: string): OpenCodeHeadContext => {
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
          unpricedModels: new Set(),
        };
        contexts.set(sessionId, context);
      }
      return context;
    };

    for (const row of messageRows) {
      const sessionId = String(row.session_id ?? "");
      if (!sessionId) continue;
      const msgData = parseJsonRecord(row.data, this.name, "message.data");
      if (isInternalEventType(msgData.type)) continue;

      const parts = partsByMessage.get(String(row.id ?? "")) ?? [];
      if (parts.length === 0) continue;

      const context = ensureContext(sessionId);
      const { unpricedModels } = capturePricingMisses(() =>
        accumulateTokenStats(context.stats, msgData, this.name),
      );
      for (const model of unpricedModels) context.unpricedModels.add(model);
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

  checkForChanges(sinceTimestamp: number, cachedSessions: SessionHead[]): ChangeCheckResult {
    const hasStaleHead = cachedSessions.some(
      (session) =>
        this.sessionMetaMap.get(session.reference.sessionId)?.headParserVersion !==
        HEAD_PARSER_VERSION,
    );
    if (hasStaleHead) return { hasChanges: true, timestamp: Date.now() };
    return super.checkForChanges(sinceTimestamp, cachedSessions);
  }

  private sumChildTokenStats(db: SQLiteDatabase, parentSessionId: string): SessionHead["stats"][] {
    if (!columnExists(db, "session", "parent_id")) return [];

    const childRows = this.readRelatedSessionRows(db, [parentSessionId]).filter(
      (row) => String(row.id ?? "") !== parentSessionId,
    );

    const results: SessionHead["stats"][] = [];
    for (const child of childRows) {
      const childId = String(child.id ?? "");
      if (!childId) continue;
      const msgRows = db
        .prepare("SELECT data FROM message WHERE session_id = ? ORDER BY time_created ASC, id ASC")
        .all(childId) as OpenCodeMessageRow[];
      const stats: SessionHead["stats"] = {
        message_count: 0,
        total_input_tokens: 0,
        total_output_tokens: 0,
        total_cost: 0,
      };
      for (const row of msgRows) {
        const msgData = parseJsonRecord(row.data, this.name, "message.data");
        if (isInternalEventType(msgData.type)) continue;
        accumulateTokenStats(stats, msgData, this.name);
      }
      results.push(stats);
    }
    return results;
  }

  getSessionData(sessionId: string): SessionDetail {
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
      const directory = String(sessionRow.directory ?? "");
      const timeCreated = Number(sessionRow.time_created ?? 0);
      const timeUpdated = Number(sessionRow.time_updated ?? timeCreated);

      const messages: Message[] = [];
      let hasEstimatedCost = false;

      // Get messages
      const msgRows = db
        .prepare("SELECT * FROM message WHERE session_id = ? ORDER BY time_created ASC, id ASC")
        .all(sessionId) as Record<string, unknown>[];
      const partsByMessage = this.buildPartsByMessage(this.readSessionPartRows(db, sessionId));

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

        const parts = partsByMessage.get(String(msgRow.id ?? "")) ?? [];
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
      const stats: SessionHead["stats"] = {
        message_count: cleanedMessages.length,
        total_input_tokens: 0,
        total_output_tokens: 0,
        total_cost: 0,
      };
      for (const message of cleanedMessages) {
        stats.total_cost += message.cost ?? 0;
        stats.total_input_tokens += message.tokens?.input ?? 0;
        stats.total_output_tokens += message.tokens?.output ?? 0;
        if (message.cost_source === "estimated") hasEstimatedCost = true;
      }

      for (const childStats of this.sumChildTokenStats(db, sessionId)) {
        stats.total_cost += childStats.total_cost;
        stats.total_input_tokens += childStats.total_input_tokens;
        stats.total_output_tokens += childStats.total_output_tokens;
        if (childStats.cost_source === "estimated") hasEstimatedCost = true;
      }

      return {
        ...this.sessionIdentity(id),
        title,
        directory,
        parent_reference:
          sessionRow.parent_id == null || String(sessionRow.parent_id) === ""
            ? undefined
            : { agentName: this.name, sessionId: String(sessionRow.parent_id) },
        version: asString(sessionRow.version) ?? undefined,
        time_created: timeCreated,
        time_updated: timeUpdated,
        summary_files: sessionRow.summary_files ?? undefined,
        stats: {
          message_count: stats.message_count,
          total_input_tokens: stats.total_input_tokens,
          total_output_tokens: stats.total_output_tokens,
          total_cost: stats.total_cost,
          cost_source:
            stats.total_cost > 0 ? (hasEstimatedCost ? "estimated" : "recorded") : undefined,
        },
        messages: cleanedMessages,
      };
    } finally {
      db.close();
    }
  }
}
