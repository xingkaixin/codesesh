import { createHash } from "node:crypto";
import type { SessionDetail, SessionHead } from "../types/index.js";
import { asRecord, asString } from "../utils/narrow.js";
import { firstUserMessageTitle } from "../utils/session-normalization.js";
import { tableExists, type SQLiteDatabase } from "../utils/sqlite.js";
import { resolveSessionTitle } from "../utils/title-fallback.js";
import { matchesScanWindow, type AgentScanOptions } from "./base.js";
import { openCodeV2Message } from "./opencode-v2-content.js";

export function hasOpenCodeV2(db: SQLiteDatabase): boolean {
  if (!tableExists(db, "session_v2")) {
    if (tableExists(db, "session_message"))
      throw new Error("Unsupported pre-split OpenCode V2 database");
    return false;
  }
  if (!tableExists(db, "session_message"))
    throw new Error("OpenCode V2 session_message table is missing");
  // Validate empty databases too, before an empty scan can replace cached history.
  db.prepare(
    "SELECT id, session_id, type, seq, time_created, time_updated, data FROM session_message LIMIT 0",
  );
  if (tableExists(db, "session") && db.prepare("SELECT 1 FROM session LIMIT 1").get()) {
    const migration = tableExists(db, "kv")
      ? db.prepare("SELECT value FROM kv WHERE key = 'migration.v1-v2'").get()
      : undefined;
    const state = asRecord(JSON.parse(String(migration?.value ?? "null")));
    if (state?.phase !== "completed")
      throw new Error("OpenCode V1 to V2 migration is not complete");
  }
  return true;
}

export function readOpenCodeV2(db: SQLiteDatabase, options?: AgentScanOptions, sessionId?: string) {
  const rows = db
    .prepare(`
    SELECT id, parent_id, fork_session_id, title, directory, path, version, summary_files,
      time_created, time_updated, cost, tokens_input, tokens_output, tokens_reasoning,
      tokens_cache_read, tokens_cache_write
    FROM session_v2 ${sessionId ? "WHERE id = ?" : ""}
    ORDER BY time_updated DESC, time_created DESC, id DESC
  `)
    .all(...(sessionId ? [sessionId] : []));
  const byId = new Map(rows.map((row) => [String(row.id), row]));
  const selected = new Set<string>();
  const children = new Map<string, string[]>();
  for (const row of rows) {
    const id = String(row.id);
    const parent = asString(row.parent_id);
    if (!sessionId && parent && parent !== id && byId.has(parent)) {
      const siblings = children.get(parent) ?? [];
      siblings.push(id);
      children.set(parent, siblings);
    } else if (
      sessionId ||
      matchesScanWindow(Number(row.time_updated ?? row.time_created), options)
    ) {
      selected.add(id);
    }
  }
  if (options?.includeRelatedSessions !== false) {
    for (const id of selected) {
      for (const child of children.get(id) ?? []) selected.add(child);
    }
  }

  const projections = new Map(
    [...selected].map((id) => {
      const row = byId.get(id)!;
      const parent = asString(row.parent_id);
      const total =
        Number(row.tokens_input) +
        Number(row.tokens_output) +
        Number(row.tokens_reasoning) +
        Number(row.tokens_cache_read) +
        Number(row.tokens_cache_write);
      const data: SessionDetail & SessionHead = {
        reference: { agentName: "opencode", sessionId: id },
        title: asString(row.title) ?? "",
        directory: String(row.directory ?? ""),
        parent_reference:
          parent && parent !== id ? { agentName: "opencode", sessionId: parent } : undefined,
        version: asString(row.version),
        summary_files: row.summary_files,
        time_created: Number(row.time_created),
        time_updated: Number(row.time_updated),
        stats: {
          message_count: 0,
          total_input_tokens: Number(row.tokens_input),
          total_output_tokens: Number(row.tokens_output),
          total_cache_read_tokens: Number(row.tokens_cache_read),
          total_cache_create_tokens: Number(row.tokens_cache_write),
          total_tokens: total,
          total_cost: Number(row.cost),
          cost_source: "recorded",
        },
        messages: [],
      };
      const projection = {
        data,
        signature: createHash("sha256").update("opencode-v2-v1").update(JSON.stringify(row)),
        firstUserText: null as string | null,
        modelUsage: new Map<string, number>(),
        messageTokens: 0,
        unassignedTokens: 0,
      };
      return [id, projection] as const;
    }),
  );

  const ids = [...selected];
  for (let offset = 0; offset < ids.length; offset += 500) {
    const chunk = ids.slice(offset, offset + 500);
    const messages = db
      .prepare(`
      SELECT id, session_id, type, seq, time_created, time_updated, data
      FROM session_message WHERE session_id IN (${chunk.map(() => "?").join(",")})
      ORDER BY session_id, seq
    `)
      .iterate(...chunk);
    for (const row of messages) {
      const projection = projections.get(String(row.session_id))!;
      projection.signature.update(JSON.stringify(row));
      const message = openCodeV2Message(row);
      if (!message) continue;
      projection.data.stats.message_count += 1;
      if (!projection.firstUserText && message.role === "user" && !message.automated)
        projection.firstUserText = firstUserMessageTitle([message]);
      const total = Object.values(message.tokens ?? {}).reduce(
        (sum, count) => sum + (count ?? 0),
        0,
      );
      projection.messageTokens += total;
      if (message.model)
        projection.modelUsage.set(
          message.model,
          (projection.modelUsage.get(message.model) ?? 0) + total,
        );
      else projection.unassignedTokens += total;
      if (sessionId) projection.data.messages.push(message);
    }
  }

  const results = [];
  for (const projection of projections.values()) {
    const data = projection.data;
    data.title = resolveSessionTitle(data.title, projection.firstUserText, null);
    if (projection.messageTokens === data.stats.total_tokens && projection.unassignedTokens === 0)
      data.model_usage = Object.fromEntries(projection.modelUsage);
    if (sessionId || data.stats.message_count > 0)
      results.push({ data, sourceFingerprint: projection.signature.digest("hex") });
  }
  results.sort(
    (left, right) =>
      (right.data.time_updated ?? 0) - (left.data.time_updated ?? 0) ||
      right.data.time_created - left.data.time_created ||
      right.data.reference.sessionId.localeCompare(left.data.reference.sessionId),
  );
  options?.onProgress?.({
    total: selected.size,
    processed: selected.size,
    sessions: results.length,
  });
  return results;
}
