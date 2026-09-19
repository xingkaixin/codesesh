import { createHash, type Hash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentCatalogEntry } from "../contract/agent-catalog.js";
import { firstExisting, readEnvPath } from "../discovery/paths.js";
import { capturePricingMisses } from "../pricing/cost.js";
import type { Message, SessionDetail, SessionHead } from "../types/index.js";
import { asString } from "../utils/narrow.js";
import { isSqliteAvailable, openDbReadOnly, type SQLiteDatabase } from "../utils/sqlite.js";
import { resolveSessionTitle } from "../utils/title-fallback.js";
import { DatabaseSessionSource, matchesScanWindow } from "./base.js";
import type { AgentScanOptions, AgentSourceOptions, SessionWatchPlan } from "./base.js";
import {
  attachMiniMaxUsage,
  miniMaxMessage,
  miniMaxUsage,
  type MiniMaxUsage,
} from "./minimax-code-content.js";

const AGENT_METADATA = getAgentCatalogEntry("minimax-code");
const DATABASE_PATH = join("v2", "sqlite", "runtime-state.sqlite");
const SESSION_FILTER =
  "(s.visibility <> 'hidden' OR s.parent_session_id IS NOT NULL) AND s.session_kind NOT IN ('peek', 'cron', 'channel')";

function dataRoots(): string[] {
  const configured = readEnvPath("MINIMAX_DATA_DIR") ?? readEnvPath("MAVIS_DATA_DIR");
  return configured
    ? [configured]
    : [join(homedir(), ".minimax"), join(homedir(), ".minimax-code")];
}

export function resolveMiniMaxCodeDataRoot(): string {
  const roots = dataRoots();
  return roots.find((root) => firstExisting(join(root, DATABASE_PATH))) ?? roots[0]!;
}

interface SessionProjection {
  head: SessionHead;
  agent: string;
  firstUserText?: string;
  signature: Hash;
  unpricedModels: Set<string>;
  messages: Message[];
  lastAssistantByTurn: Map<string, Message>;
  usageByTurn: Map<string, MiniMaxUsage[]>;
}

export class MiniMaxCodeAgent extends DatabaseSessionSource {
  readonly name = AGENT_METADATA.name;
  readonly displayName = AGENT_METADATA.displayName;
  private readonly roots: string[];

  constructor(options: AgentSourceOptions = {}) {
    super();
    this.roots = options.sourceRoot ? [options.sourceRoot] : dataRoots();
  }

  protected getDatabasePath(): string | null {
    return firstExisting(...this.roots.map((root) => join(root, DATABASE_PATH)));
  }

  isAvailable(): boolean {
    return isSqliteAvailable() && this.getDatabasePath() !== null;
  }

  getSessionWatchPlan(): SessionWatchPlan {
    return {
      status: "supported",
      targets: this.roots.flatMap((root) =>
        ["", "-wal", "-journal"].map((suffix) => ({
          path: `${join(root, DATABASE_PATH)}${suffix}`,
          pollForChanges: true,
        })),
      ),
    };
  }

  private readDatabase<T>(read: (db: SQLiteDatabase) => T): T {
    const path = this.getDatabasePath();
    if (!path) throw new Error("MiniMax Code runtime-state.sqlite is missing");
    return this.scanStep("reading MiniMax Code 0.4.12 sessions", path, () => {
      const db = openDbReadOnly(path);
      if (!db) throw new Error("Cannot open MiniMax Code database");
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
      for (const [id, { head }] of projections) {
        const parent = head.parent_reference?.sessionId;
        if (parent && projections.has(parent)) {
          const siblings = children.get(parent) ?? [];
          siblings.push(id);
          children.set(parent, siblings);
        } else if (matchesScanWindow(head.time_updated ?? head.time_created, options)) {
          selected.add(id);
        }
      }
      if (options?.includeRelatedSessions !== false) {
        for (const id of selected) {
          for (const child of children.get(id) ?? []) selected.add(child);
        }
      }
      const sessions: SessionHead[] = [];
      for (const id of selected) {
        const projection = projections.get(id)!;
        if (!projection.head.stats.message_count) continue;
        this.rememberSession(id, {
          sourceFingerprint: projection.signature.digest("hex"),
          headParserVersion: "minimax-code-v1",
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

  getSessionData(sessionId: string): SessionDetail {
    return this.readDatabase((db) => {
      const projection = this.readProjections(db, sessionId).get(sessionId);
      if (!projection) throw new Error(`MiniMax Code session not found: ${sessionId}`);
      for (const [turnId, usage] of projection.usageByTurn) {
        const message = projection.lastAssistantByTurn.get(turnId);
        if (message) attachMiniMaxUsage(message, usage);
      }
      return { ...projection.head, messages: projection.messages };
    });
  }

  private readProjections(db: SQLiteDatabase, sessionId?: string): Map<string, SessionProjection> {
    const filter = `${SESSION_FILTER}${sessionId ? " AND s.session_id = ?" : ""}`;
    const bindings = sessionId ? [sessionId] : [];
    const projections = new Map<string, SessionProjection>();
    const sessions = db
      .prepare(`
      SELECT s.session_id, s.columnar_version, s.title, s.workspace_dir, s.parent_session_id,
        s.created_at_ms, s.updated_at_ms, s.agent_name, s.status, s.archived, s.extra_data_json
      FROM local_runtime_sessions s WHERE ${filter} ORDER BY s.session_id
    `)
      .iterate(...bindings);
    for (const row of sessions) {
      if (row.columnar_version !== 3)
        throw new Error("Unsupported MiniMax session columnar version");
      const id = String(row.session_id);
      const parent = asString(row.parent_session_id);
      projections.set(id, {
        head: {
          ...this.sessionIdentity(id),
          title: asString(row.title) ?? "",
          directory: asString(row.workspace_dir) ?? "",
          parent_reference:
            parent && parent !== id ? { agentName: this.name, sessionId: parent } : undefined,
          time_created: Number(row.created_at_ms ?? row.updated_at_ms),
          time_updated: Number(row.updated_at_ms),
          stats: { message_count: 0, total_input_tokens: 0, total_output_tokens: 0, total_cost: 0 },
        },
        agent: asString(row.agent_name) ?? this.displayName,
        signature: createHash("sha256").update(JSON.stringify(row)),
        unpricedModels: new Set(),
        messages: [],
        lastAssistantByTurn: new Map(),
        usageByTurn: new Map(),
      });
    }
    const messages = db
      .prepare(`
      SELECT m.id, m.session_id, m.msg_id, m.role, m.turn_id, m.source, m.created_at_ms, m.data_json
      FROM local_runtime_message_rows m JOIN local_runtime_sessions s ON s.session_id = m.session_id
      WHERE ${filter} ORDER BY m.session_id, m.id
    `)
      .iterate(...bindings);
    for (const row of messages) {
      const projection = projections.get(String(row.session_id))!;
      projection.signature.update(JSON.stringify(row));
      const message = miniMaxMessage(row, projection.agent);
      projection.head.stats.message_count += 1;
      projection.head.time_updated = Math.max(
        projection.head.time_updated ?? 0,
        message.time_created,
      );
      if (message.role === "user" && !message.automated && !projection.firstUserText) {
        projection.firstUserText = message.parts.find((part) => part.type === "text")?.text;
      }
      if (sessionId) {
        projection.messages.push(message);
        const turnId = asString(row.turn_id);
        if (turnId && message.role === "assistant" && !message.mode)
          projection.lastAssistantByTurn.set(turnId, message);
      }
    }
    const usages = db
      .prepare(`
      SELECT u.id, u.session_id, u.turn_id, u.model, u.ts, u.input_tokens, u.output_tokens,
        u.reasoning_tokens, u.cache_read_tokens, u.cache_write_tokens, u.cost_usd
      FROM local_runtime_token_usage u JOIN local_runtime_sessions s ON s.session_id = u.session_id
      WHERE ${filter} ORDER BY u.session_id, u.id
    `)
      .iterate(...bindings);
    for (const row of usages) {
      const projection = projections.get(String(row.session_id))!;
      projection.signature.update(JSON.stringify(row));
      const { result: usage, unpricedModels } = capturePricingMisses(() => miniMaxUsage(row));
      for (const model of unpricedModels) projection.unpricedModels.add(model);
      const stats = projection.head.stats;
      stats.total_input_tokens += usage.tokens.input ?? 0;
      stats.total_output_tokens += usage.tokens.output ?? 0;
      stats.total_tokens = (stats.total_tokens ?? 0) + usage.total;
      stats.total_cache_read_tokens =
        (stats.total_cache_read_tokens ?? 0) + (usage.tokens.cache_read ?? 0);
      stats.total_cache_create_tokens =
        (stats.total_cache_create_tokens ?? 0) + (usage.tokens.cache_create ?? 0);
      stats.total_cost += usage.cost;
      if (usage.costSource === "estimated" || !stats.cost_source)
        stats.cost_source = usage.costSource;
      if (usage.model) {
        const modelUsage = (projection.head.model_usage ??= Object.create(null));
        modelUsage[usage.model] = (modelUsage[usage.model] ?? 0) + usage.total;
      }
      projection.head.time_updated = Math.max(projection.head.time_updated ?? 0, usage.time);
      if (sessionId && usage.turnId) {
        const turnUsage = projection.usageByTurn.get(usage.turnId) ?? [];
        turnUsage.push(usage);
        projection.usageByTurn.set(usage.turnId, turnUsage);
      }
    }
    for (const projection of projections.values()) {
      projection.head.title = resolveSessionTitle(
        projection.head.title,
        projection.firstUserText ?? null,
        null,
      );
    }
    return projections;
  }
}
