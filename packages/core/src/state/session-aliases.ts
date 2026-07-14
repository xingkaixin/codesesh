import { StateStorageUnavailableError, useMemoryStateStore, withStateDb } from "./database.js";
import type { DatabaseRow } from "../utils/sqlite.js";

export const SESSION_ALIAS_MAX_LENGTH = 160;

export interface SessionAlias {
  agentKey: string;
  sessionId: string;
  alias: string;
  updated_at: number;
}

interface SessionAliasRow extends DatabaseRow {
  agent_name?: string;
  session_id?: string;
  alias?: string;
  updated_at?: number;
}

const memoryAliases = new Map<string, SessionAlias>();

function getAliasKey(agentKey: string, sessionId: string): string {
  return JSON.stringify([agentKey, sessionId]);
}

function toSessionAlias(row: SessionAliasRow): SessionAlias {
  return {
    agentKey: String(row.agent_name ?? ""),
    sessionId: String(row.session_id ?? ""),
    alias: String(row.alias ?? ""),
    updated_at: Number(row.updated_at ?? 0),
  };
}

export function normalizeSessionAlias(value: string): string | null {
  const alias = value.trim();
  if (!alias || alias.length > SESSION_ALIAS_MAX_LENGTH) return null;
  return alias;
}

export function listSessionAliases(): SessionAlias[] {
  if (useMemoryStateStore()) return [...memoryAliases.values()];

  return withStateDb((db) =>
    (
      db
        .prepare(
          `
          SELECT agent_name, session_id, alias, updated_at
          FROM session_aliases
          ORDER BY updated_at DESC
        `,
        )
        .all() as SessionAliasRow[]
    ).map(toSessionAlias),
  );
}

export function upsertSessionAlias(
  agentKey: string,
  sessionId: string,
  alias: string,
): SessionAlias {
  const normalizedAlias = normalizeSessionAlias(alias);
  if (!normalizedAlias) {
    throw new TypeError("Invalid session alias");
  }

  const saved: SessionAlias = {
    agentKey,
    sessionId,
    alias: normalizedAlias,
    updated_at: Date.now(),
  };
  if (useMemoryStateStore()) {
    memoryAliases.set(getAliasKey(agentKey, sessionId), saved);
    return saved;
  }

  return withStateDb((db) => {
    db.prepare(
      `
        INSERT INTO session_aliases(agent_name, session_id, alias, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(agent_name, session_id) DO UPDATE SET
          alias = excluded.alias,
          updated_at = excluded.updated_at
      `,
    ).run(saved.agentKey, saved.sessionId, saved.alias, saved.updated_at);
    return saved;
  });
}

export function deleteSessionAlias(agentKey: string, sessionId: string): void {
  if (useMemoryStateStore()) {
    memoryAliases.delete(getAliasKey(agentKey, sessionId));
    return;
  }

  withStateDb((db) => {
    db.prepare(
      `
        DELETE FROM session_aliases
        WHERE agent_name = ? AND session_id = ?
      `,
    ).run(agentKey, sessionId);
  });
}

export { StateStorageUnavailableError };
