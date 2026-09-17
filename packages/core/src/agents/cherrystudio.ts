import { createHash } from "node:crypto";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { getAgentCatalogEntry } from "../contract/agent-catalog.js";
import { firstExisting, readEnvPath } from "../discovery/paths.js";
import { capturePricingMisses } from "../pricing/cost.js";
import type { SessionDetail, SessionHead } from "../types/index.js";
import { asString } from "../utils/narrow.js";
import { firstUserMessageTitle } from "../utils/session-normalization.js";
import {
  isSqliteAvailable,
  openDbReadOnly,
  type DatabaseRow,
  type SQLiteDatabase,
} from "../utils/sqlite.js";
import { resolveSessionTitle } from "../utils/title-fallback.js";
import { DatabaseSessionSource, matchesScanWindow } from "./base.js";
import type { AgentScanOptions, AgentSourceOptions, SessionWatchPlan } from "./base.js";
import { cherryStudioTranscript } from "./cherrystudio-content.js";

const AGENT_METADATA = getAgentCatalogEntry("cherrystudio");

type ConversationKind = "agent" | "topic";

export function resolveCherryStudioDataRoot(): string {
  const configured = readEnvPath("CHERRYSTUDIO_USER_DATA_DIR");
  if (configured) return configured;
  if (platform() === "darwin")
    return join(homedir(), "Library", "Application Support", "CherryStudio");
  if (platform() === "win32") {
    return join(readEnvPath("APPDATA") ?? join(homedir(), "AppData", "Roaming"), "CherryStudio");
  }
  return join(readEnvPath("XDG_CONFIG_HOME") ?? join(homedir(), ".config"), "CherryStudio");
}

function liveRows(db: SQLiteDatabase, table: string, alias: string): string {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  return columns.some((column) => column.name === "deleted_at")
    ? `${alias}.deleted_at IS NULL`
    : "1 = 1";
}

function activeBranch(rows: DatabaseRow[], activeId: unknown): DatabaseRow[] {
  const byId = new Map(rows.map((row) => [String(row.id), row]));
  const selected: DatabaseRow[] = [];
  const visited = new Set<string>();
  let id = asString(activeId);
  while (id) {
    if (visited.has(id)) throw new Error("Cherry Studio message branch contains a cycle");
    visited.add(id);
    const row = byId.get(id);
    if (!row) break;
    selected.push(row);
    id = asString(row.parent_id);
  }
  return selected.reverse();
}

export class CherryStudioAgent extends DatabaseSessionSource {
  readonly name = AGENT_METADATA.name;
  readonly displayName = AGENT_METADATA.displayName;
  private readonly sourceRoot: string;

  constructor(options: AgentSourceOptions = {}) {
    super();
    this.sourceRoot = options.sourceRoot ?? resolveCherryStudioDataRoot();
  }

  protected getDatabasePath(): string | null {
    return firstExisting(join(this.sourceRoot, "Data", "cherrystudio.sqlite"));
  }

  isAvailable(): boolean {
    return isSqliteAvailable() && this.getDatabasePath() !== null;
  }

  getSessionWatchPlan(): SessionWatchPlan {
    return {
      status: "supported",
      targets: [
        { root: this.sourceRoot, path: join(this.sourceRoot, "Data", "cherrystudio.sqlite") },
      ],
    };
  }

  private readDatabase<T>(read: (db: SQLiteDatabase) => T): T {
    const path = this.getDatabasePath();
    if (!path) throw new Error("Cherry Studio 2.x cherrystudio.sqlite is missing");
    return this.scanStep("reading Cherry Studio 2.x cherrystudio.sqlite", path, () => {
      const db = openDbReadOnly(path);
      if (!db) throw new Error("Cannot open Cherry Studio database");
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
      const sessions: SessionHead[] = [];
      for (const kind of ["agent", "topic"] as const) {
        for (const projection of this.readConversations(db, kind)) {
          const { messages: _messages, ...head } = projection.session;
          if (
            !head.stats.message_count ||
            !matchesScanWindow(head.time_updated ?? head.time_created, options)
          )
            continue;
          this.rememberSession(head.reference.sessionId, {
            sourceFingerprint: projection.fingerprint,
            headParserVersion: "cherrystudio-v1",
            unpricedModels: projection.unpricedModels,
          });
          sessions.push(head);
        }
      }
      sessions.sort(
        (left, right) =>
          (right.time_updated ?? 0) - (left.time_updated ?? 0) ||
          left.reference.sessionId.localeCompare(right.reference.sessionId),
      );
      options?.onProgress?.({
        total: sessions.length,
        processed: sessions.length,
        sessions: sessions.length,
      });
      return sessions;
    });
  }

  getSessionData(sessionId: string): SessionDetail {
    const separator = sessionId.indexOf(":");
    const kind = sessionId.slice(0, separator);
    const id = sessionId.slice(separator + 1);
    if ((kind !== "agent" && kind !== "topic") || !id)
      throw new Error(`Invalid Cherry Studio session: ${sessionId}`);
    return this.readDatabase((db) => {
      for (const projection of this.readConversations(db, kind, id)) return projection.session;
      throw new Error(`Cherry Studio session not found: ${sessionId}`);
    });
  }

  private *readConversations(db: SQLiteDatabase, kind: ConversationKind, id?: string) {
    const table = kind === "agent" ? "agent_session" : "topic";
    const messageTable = kind === "agent" ? "agent_session_message" : "message";
    const foreignKey = kind === "agent" ? "session_id" : "topic_id";
    const filter = `${liveRows(db, table, "s")} ${id ? "AND s.id = ?" : ""}`;
    const bindings = id ? [id] : [];
    const headers = db
      .prepare(`
      SELECT s.id, s.name, s.created_at, s.updated_at, s.last_activity_at,
        ${kind === "agent" ? "w.path AS directory, NULL AS active_node_id" : "NULL AS directory, s.active_node_id"}
      FROM ${table} s ${kind === "agent" ? "LEFT JOIN agent_workspace w ON w.id = s.workspace_id" : ""}
      WHERE ${filter}
    `)
      .all(...bindings);
    const byId = new Map(headers.map((row) => [String(row.id), row]));
    const messages = db
      .prepare(`
      SELECT m.id, m.${foreignKey} AS conversation_id, m.role, m.data, m.stats,
        m.model_id, m.message_snapshot, m.status, m.created_at, m.updated_at,
        ${kind === "topic" ? "m.parent_id" : "NULL AS parent_id"}
      FROM ${messageTable} m JOIN ${table} s ON s.id = m.${foreignKey}
      WHERE ${filter} AND ${liveRows(db, messageTable, "m")}
      ORDER BY m.${foreignKey}, m.created_at, m.id
    `)
      .iterate(...bindings);
    let currentId: string | undefined;
    let rows: DatabaseRow[] = [];
    for (const row of messages) {
      const nextId = String(row.conversation_id);
      if (currentId !== undefined && nextId !== currentId) {
        yield this.projectConversation(kind, byId.get(currentId)!, rows);
        rows = [];
      }
      currentId = nextId;
      rows.push(row);
    }
    if (currentId !== undefined) yield this.projectConversation(kind, byId.get(currentId)!, rows);
  }

  private projectConversation(kind: ConversationKind, row: DatabaseRow, rows: DatabaseRow[]) {
    const selected = kind === "topic" ? activeBranch(rows, row.active_node_id) : rows;
    const { result: transcript, unpricedModels } = capturePricingMisses(() =>
      cherryStudioTranscript(selected),
    );
    const signature = createHash("sha256").update(JSON.stringify(row));
    for (const message of selected) signature.update(JSON.stringify(message));
    const session: SessionHead & SessionDetail = {
      ...this.sessionIdentity(`${kind}:${row.id}`),
      title: resolveSessionTitle(
        asString(row.name),
        firstUserMessageTitle(transcript.messages),
        "Cherry Studio",
      ),
      directory: asString(row.directory) || this.sourceRoot,
      time_created: Number(row.created_at),
      time_updated: Number(row.last_activity_at),
      stats: transcript.stats,
      model_usage: transcript.modelUsage,
      messages: transcript.messages,
    };
    return { session, fingerprint: signature.digest("hex"), unpricedModels };
  }
}
