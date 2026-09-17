import { createHash, type Hash } from "node:crypto";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { getAgentCatalogEntry } from "../contract/agent-catalog.js";
import { firstExisting, readEnvPath } from "../discovery/paths.js";
import { capturePricingMisses } from "../pricing/cost.js";
import type {
  Message,
  MessagePart,
  MessageTokens,
  SessionDetail,
  SessionHead,
} from "../types/index.js";
import { estimateTokenCost } from "../utils/cost.js";
import { asNumber, asRecord, asString } from "../utils/narrow.js";
import { isSqliteAvailable, openDbReadOnly, type SQLiteDatabase } from "../utils/sqlite.js";
import { resolveSessionTitle } from "../utils/title-fallback.js";
import { DatabaseSessionSource, matchesScanWindow } from "./base.js";
import type { AgentScanOptions, AgentSourceOptions, SessionWatchPlan } from "./base.js";
import {
  deepChatRawParts,
  deepChatStoredBlockPart,
  deepChatTokens,
  deepChatUserParts,
  parseDeepChatJson,
} from "./deepchat-content.js";

const AGENT_METADATA = getAgentCatalogEntry("deepchat");

export function resolveDeepChatDataRoot(): string {
  const configured = readEnvPath("DEEPCHAT_USER_DATA_DIR");
  if (configured) return configured;
  if (platform() === "darwin") return join(homedir(), "Library", "Application Support", "DeepChat");
  if (platform() === "win32") {
    return join(readEnvPath("APPDATA") ?? join(homedir(), "AppData", "Roaming"), "DeepChat");
  }
  return join(readEnvPath("XDG_CONFIG_HOME") ?? join(homedir(), ".config"), "DeepChat");
}

interface MessageUsage {
  model: string | null;
  provider: string | null;
  tokens: MessageTokens;
  cost: number;
}

interface SessionProjection {
  head: SessionHead;
  agentId: string;
  model: string | null;
  provider: string | null;
  signature: Hash;
  unpricedModels: Set<string>;
  messageUsage: Map<string, MessageUsage>;
}

function accumulateUsage(session: SessionProjection, row: Record<string, unknown>): void {
  const model = asString(row.model) ?? session.model;
  const provider = asString(row.provider) ?? session.provider;
  const tokens = deepChatTokens(row);
  if (!tokens && asNumber(row.totalTokens) === undefined) return;
  const input = tokens?.input ?? 0;
  const output = tokens?.output ?? 0;
  const total = Math.max(0, asNumber(row.totalTokens) ?? input + output);
  const { result: estimate, unpricedModels } = capturePricingMisses(() =>
    estimateTokenCost(model, tokens),
  );
  for (const missing of unpricedModels) session.unpricedModels.add(missing);
  const cost = estimate ?? 0;
  const stats = session.head.stats;
  stats.total_input_tokens += input;
  stats.total_output_tokens += output;
  stats.total_tokens = (stats.total_tokens ?? 0) + total;
  stats.total_cache_read_tokens = (stats.total_cache_read_tokens ?? 0) + (tokens?.cache_read ?? 0);
  stats.total_cache_create_tokens =
    (stats.total_cache_create_tokens ?? 0) + (tokens?.cache_create ?? 0);
  stats.total_cost += cost;
  if (cost > 0) stats.cost_source = "estimated";
  if (model && total > 0) {
    const usage = (session.head.model_usage ??= Object.create(null));
    usage[model] = (usage[model] ?? 0) + total;
  }
  const messageId = asString(row.message_id);
  if (!messageId) return;
  const previous = session.messageUsage.get(messageId);
  session.messageUsage.set(messageId, {
    model,
    provider,
    cost: (previous?.cost ?? 0) + cost,
    tokens: {
      input: (previous?.tokens.input ?? 0) + input,
      output: (previous?.tokens.output ?? 0) + output,
      cache_read: (previous?.tokens.cache_read ?? 0) + (tokens?.cache_read ?? 0),
      cache_create: (previous?.tokens.cache_create ?? 0) + (tokens?.cache_create ?? 0),
    },
  });
}

export class DeepChatAgent extends DatabaseSessionSource {
  readonly name = AGENT_METADATA.name;
  readonly displayName = AGENT_METADATA.displayName;
  private readonly sourceRoot: string;

  constructor(options: AgentSourceOptions = {}) {
    super();
    this.sourceRoot = options.sourceRoot ?? resolveDeepChatDataRoot();
  }

  protected getDatabasePath(): string | null {
    return firstExisting(join(this.sourceRoot, "app_db", "agent.db"));
  }

  isAvailable(): boolean {
    return isSqliteAvailable() && this.getDatabasePath() !== null;
  }

  getSessionWatchPlan(): SessionWatchPlan {
    return {
      status: "supported",
      targets: [{ root: this.sourceRoot, path: join(this.sourceRoot, "app_db", "agent.db") }],
    };
  }

  private readDatabase<T>(read: (db: SQLiteDatabase) => T): T {
    const path = this.getDatabasePath();
    if (!path) throw new Error("DeepChat agent.db is missing");
    return this.scanStep("reading unencrypted DeepChat agent.db", path, () => {
      const db = openDbReadOnly(path);
      if (!db)
        throw new Error("Cannot open DeepChat agent.db; only unencrypted databases are supported");
      try {
        return db.transaction(() => read(db))();
      } finally {
        db.close();
      }
    });
  }

  scan(options?: AgentScanOptions): SessionHead[] {
    if (!this.getDatabasePath()) return [];
    return this.readDatabase((db) => {
      const projections = this.readProjections(db);
      const selected = new Set<string>();
      const children = new Map<string, string[]>();
      for (const [id, projection] of projections) {
        const parent = projection.head.parent_reference?.sessionId;
        if (parent && projections.has(parent)) {
          const siblings = children.get(parent) ?? [];
          siblings.push(id);
          children.set(parent, siblings);
        } else if (
          matchesScanWindow(projection.head.time_updated ?? projection.head.time_created, options)
        ) {
          selected.add(id);
        }
      }
      if (options?.includeRelatedSessions !== false) {
        // Set iteration visits newly added descendants and deduplicates repeated references.
        for (const id of selected) {
          for (const child of children.get(id) ?? []) selected.add(child);
        }
      }
      const sessions: SessionHead[] = [];
      for (const id of selected) {
        const projection = projections.get(id)!;
        if (projection.head.stats.message_count === 0) continue;
        this.rememberSession(id, {
          sourceFingerprint: projection.signature.digest("hex"),
          headParserVersion: "deepchat-v1",
          unpricedModels: [...projection.unpricedModels],
        });
        sessions.push(projection.head);
      }
      sessions.sort(
        (left, right) =>
          (right.time_updated ?? 0) - (left.time_updated ?? 0) ||
          left.reference.sessionId.localeCompare(right.reference.sessionId),
      );
      options?.onProgress?.({
        total: selected.size,
        processed: selected.size,
        sessions: sessions.length,
      });
      return sessions;
    });
  }

  private readProjections(db: SQLiteDatabase, sessionId?: string): Map<string, SessionProjection> {
    const filter = sessionId ? "AND s.id = ?" : "";
    const bindings = sessionId ? [sessionId] : [];
    const projections = new Map<string, SessionProjection>();
    const sessions = db
      .prepare(`
      SELECT s.id, s.agent_id, s.title, s.project_dir, s.parent_session_id,
        s.created_at, s.updated_at, s.revision, d.model_id, d.provider_id
      FROM new_sessions s LEFT JOIN deepchat_sessions d ON d.id = s.id
      WHERE s.is_draft = 0 ${filter}
      ORDER BY s.id
    `)
      .iterate(...bindings);
    for (const row of sessions) {
      const id = String(row.id);
      const parent = asString(row.parent_session_id);
      projections.set(id, {
        head: {
          ...this.sessionIdentity(id),
          title: resolveSessionTitle(asString(row.title), null, null),
          directory: asString(row.project_dir) ?? "",
          parent_reference: parent ? { agentName: this.name, sessionId: parent } : undefined,
          time_created: Number(row.created_at),
          time_updated: Number(row.updated_at),
          stats: { message_count: 0, total_input_tokens: 0, total_output_tokens: 0, total_cost: 0 },
        },
        agentId: String(row.agent_id),
        model: asString(row.model_id) ?? null,
        provider: asString(row.provider_id) ?? null,
        signature: createHash("sha256").update(JSON.stringify(row)),
        unpricedModels: new Set(),
        messageUsage: new Map(),
      });
    }
    const usageRows = db
      .prepare(`
      SELECT u.session_id, u.message_id, u.usage_id, u.created_at, u.updated_at,
        u.model_id AS model, u.provider_id AS provider,
        u.input_tokens AS inputTokens, u.output_tokens AS outputTokens,
        u.total_tokens AS totalTokens, u.cached_input_tokens AS cachedInputTokens,
        u.cache_write_input_tokens AS cacheWriteInputTokens
      FROM deepchat_usage_stats u JOIN new_sessions s ON s.id = u.session_id
      WHERE s.is_draft = 0 ${filter}
      ORDER BY u.session_id, u.usage_id
    `)
      .iterate(...bindings);
    for (const row of usageRows) {
      const projection = projections.get(String(row.session_id))!;
      accumulateUsage(projection, row);
      projection.signature.update(JSON.stringify(row));
      projection.head.time_updated = Math.max(
        projection.head.time_updated ?? 0,
        Number(row.created_at),
      );
    }
    const messageRows = db
      .prepare(`
      SELECT m.id, m.session_id, m.order_seq, m.role, m.status, m.metadata, m.updated_at
      FROM deepchat_messages m JOIN new_sessions s ON s.id = m.session_id
      WHERE s.is_draft = 0 ${filter}
      ORDER BY m.session_id, m.order_seq, m.id
    `)
      .iterate(...bindings);
    for (const row of messageRows) {
      const projection = projections.get(String(row.session_id))!;
      projection.signature.update(JSON.stringify(row));
      projection.head.stats.message_count += 1;
      projection.head.time_updated = Math.max(
        projection.head.time_updated ?? 0,
        Number(row.updated_at),
      );
      const metadata = asRecord(parseDeepChatJson(row.metadata));
      if (row.role === "assistant" && metadata && !projection.messageUsage.has(String(row.id))) {
        accumulateUsage(projection, { ...metadata, message_id: row.id });
      }
    }
    // Older blocks can change while the newest block's timestamp stays unchanged.
    const blockActivity = db
      .prepare(`
      SELECT m.session_id, COUNT(*) AS block_count, MAX(b.updated_at) AS updated_at,
        SUM(b.updated_at) AS block_revision
      FROM deepchat_assistant_blocks b
      JOIN deepchat_messages m ON m.id = b.message_id
      JOIN new_sessions s ON s.id = m.session_id
      WHERE s.is_draft = 0 ${filter}
      GROUP BY m.session_id ORDER BY m.session_id
    `)
      .iterate(...bindings);
    for (const row of blockActivity) {
      const projection = projections.get(String(row.session_id))!;
      projection.signature.update(JSON.stringify(row));
      projection.head.time_updated = Math.max(
        projection.head.time_updated ?? 0,
        Number(row.updated_at),
      );
    }
    return projections;
  }

  getSessionData(sessionId: string): SessionDetail {
    return this.readDatabase((db) => {
      const projection = this.readProjections(db, sessionId).get(sessionId);
      if (!projection) throw new Error(`DeepChat session not found: ${sessionId}`);
      const partsByMessage = this.readStructuredParts(db, sessionId);
      const rows = db
        .prepare(`
        SELECT id, role, content, metadata, status, created_at, updated_at
        FROM deepchat_messages WHERE session_id = ? ORDER BY order_seq, id
      `)
        .iterate(sessionId);
      const messages: Message[] = [];
      for (const row of rows) {
        if (row.role !== "user" && row.role !== "assistant") continue;
        const id = String(row.id);
        const metadata = asRecord(parseDeepChatJson(row.metadata));
        const usage = projection.messageUsage.get(id);
        messages.push({
          id,
          role: row.role,
          agent: row.role === "assistant" ? projection.agentId : undefined,
          time_created: Number(row.created_at),
          time_completed: row.status === "pending" ? undefined : Number(row.updated_at),
          model: usage?.model ?? asString(metadata?.model) ?? projection.model,
          provider: usage?.provider ?? asString(metadata?.provider) ?? projection.provider,
          tokens: usage?.tokens,
          cost: usage?.cost,
          cost_source: usage && usage.cost > 0 ? "estimated" : undefined,
          parts: partsByMessage.get(id) ?? deepChatRawParts(row.role, String(row.content)),
        });
      }
      return { ...projection.head, messages };
    });
  }

  private readStructuredParts(db: SQLiteDatabase, sessionId: string): Map<string, MessagePart[]> {
    const parts = new Map<string, MessagePart[]>();
    const blocks = db
      .prepare(`
      SELECT b.* FROM deepchat_assistant_blocks b
      JOIN deepchat_messages m ON m.id = b.message_id
      WHERE m.session_id = ? ORDER BY b.message_id, b.block_index
    `)
      .iterate(sessionId);
    for (const block of blocks) {
      const id = String(block.message_id);
      const messageParts = parts.get(id) ?? [];
      const part = deepChatStoredBlockPart(block);
      if (part) messageParts.push(part);
      parts.set(id, messageParts);
    }
    const users = db
      .prepare(`
      SELECT u.message_id, u.text FROM deepchat_user_messages u
      JOIN deepchat_messages m ON m.id = u.message_id WHERE m.session_id = ?
    `)
      .iterate(sessionId);
    for (const user of users) parts.set(String(user.message_id), deepChatUserParts(user));
    const attachments = db
      .prepare(`
      SELECT f.message_id, f.path, f.name FROM deepchat_user_message_files f
      JOIN deepchat_messages m ON m.id = f.message_id
      WHERE m.session_id = ? ORDER BY f.message_id, f.ordinal
    `)
      .iterate(sessionId);
    for (const attachment of attachments) {
      parts.get(String(attachment.message_id))?.push(...deepChatUserParts({ files: [attachment] }));
    }
    const links = db
      .prepare(`
      SELECT l.message_id, l.url FROM deepchat_user_message_links l
      JOIN deepchat_messages m ON m.id = l.message_id
      WHERE m.session_id = ? ORDER BY l.message_id, l.ordinal
    `)
      .iterate(sessionId);
    for (const link of links)
      parts.get(String(link.message_id))?.push(...deepChatUserParts({ links: [link.url] }));
    return parts;
  }
}
