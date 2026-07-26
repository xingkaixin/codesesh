import { StateStorageUnavailableError, useMemoryStateStore, withStateDb } from "./database.js";
import type { DatabaseRow } from "../utils/sqlite.js";
import { normalizeSessionReference, type SessionReference } from "../contract/index.js";

export const SESSION_ALIAS_MAX_LENGTH = 160;

export interface SessionAlias {
  reference: SessionReference;
  alias: string;
  updatedAt: number;
}

interface SessionAliasRow extends DatabaseRow {
  agent_name?: string;
  session_id?: string;
  alias?: string;
  updated_at?: number;
}

const memoryAliases = new Map<string, SessionAlias>();

function getAliasKey(reference: SessionReference): string {
  const normalized = normalizeSessionReference(reference);
  return JSON.stringify([normalized.agentName, normalized.sessionId]);
}

function toSessionAlias(row: SessionAliasRow): SessionAlias {
  const reference = normalizeSessionReference({
    agentName: String(row.agent_name ?? ""),
    sessionId: String(row.session_id ?? ""),
  });
  return {
    reference,
    alias: String(row.alias ?? ""),
    updatedAt: Number(row.updated_at ?? 0),
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

export function upsertSessionAlias(reference: SessionReference, alias: string): SessionAlias {
  const normalizedAlias = normalizeSessionAlias(alias);
  if (!normalizedAlias) {
    throw new TypeError("Invalid session alias");
  }

  const normalizedReference = normalizeSessionReference(reference);
  const saved: SessionAlias = {
    reference: normalizedReference,
    alias: normalizedAlias,
    updatedAt: Date.now(),
  };
  if (useMemoryStateStore()) {
    memoryAliases.set(getAliasKey(normalizedReference), saved);
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
    ).run(saved.reference.agentName, saved.reference.sessionId, saved.alias, saved.updatedAt);
    return saved;
  });
}

export function deleteSessionAlias(reference: SessionReference): void {
  const normalizedReference = normalizeSessionReference(reference);
  if (useMemoryStateStore()) {
    memoryAliases.delete(getAliasKey(normalizedReference));
    return;
  }

  withStateDb((db) => {
    db.prepare(
      `
        DELETE FROM session_aliases
        WHERE agent_name = ? AND session_id = ?
      `,
    ).run(normalizedReference.agentName, normalizedReference.sessionId);
  });
}

export { StateStorageUnavailableError };
