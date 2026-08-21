/**
 * Per-model cost aggregation. Session heads only carry per-model token totals,
 * so the cost split by model is only derivable from the cached message rows.
 */
import type { ModelCostEntry } from "../../contract/index.js";
import type { ProjectIdentityKind } from "../../types/index.js";
import type { DatabaseRow, SQLiteDatabase } from "../../utils/sqlite.js";
import { hasCacheStorage } from "./db.js";
import { withCacheDbReadOnly } from "./connection.js";

export type { ModelCostEntry };

export interface ModelCostOptions {
  agent?: string;
  projectKind?: ProjectIdentityKind;
  projectKey?: string;
  from?: number;
  to?: number;
  limit?: number;
}

interface ModelCostRow extends DatabaseRow {
  model?: string;
  cost?: number;
  cost_recorded?: number;
  cost_estimated?: number;
}

const DEFAULT_MODEL_COST_LIMIT = 20;

function buildModelCostWhere(options: ModelCostOptions): {
  where: string;
  params: unknown[];
} {
  const clauses = ["m.model IS NOT NULL", "m.model <> ''"];
  const params: unknown[] = [];

  if (options.agent != null) {
    clauses.push("s.agent_name = ?");
    params.push(options.agent);
  }
  if (options.projectKind != null || options.projectKey != null) {
    if (options.projectKind != null && options.projectKey != null) {
      clauses.push("s.project_identity_kind = ? AND s.project_identity_key = ?");
      params.push(options.projectKind, options.projectKey);
    } else {
      // A half-specified identity can never match — mirrors listFileActivity.
      clauses.push("0");
    }
  }
  if (options.from != null) {
    clauses.push("s.activity_time >= ?");
    params.push(options.from);
  }
  if (options.to != null) {
    clauses.push("s.activity_time <= ?");
    params.push(options.to);
  }

  return { where: `WHERE ${clauses.join(" AND ")}`, params };
}

/**
 * Sub-session messages are included on purpose: a parent's cost is defined to
 * cover its whole subtree. An unset `cost_source` counts as estimated, so
 * `costRecorded + costEstimated === cost` always holds.
 *
 * Reads the per-(session, model) rollup maintained alongside message writes
 * (CS-270) — sessions×models rows instead of a full messages-table scan.
 */
const MODEL_COST_SQL = `
  SELECT
    m.model AS model,
    SUM(m.cost) AS cost,
    SUM(m.cost_recorded) AS cost_recorded,
    SUM(m.cost - m.cost_recorded) AS cost_estimated
  FROM session_model_cost m
  JOIN sessions s
    ON s.agent_name = m.agent_name
    AND s.session_id = m.session_id
    AND s.publication_id IS NULL
`;

/**
 * Returns null when no cache database is available (--no-cache, or the
 * search-index worker has not created it yet). Callers MUST propagate the null
 * rather than substituting zeros.
 */
export function listModelCostDistribution(options: ModelCostOptions = {}): ModelCostEntry[] | null {
  if (!hasCacheStorage()) {
    return null;
  }

  const { where, params } = buildModelCostWhere(options);
  const sql = `
    ${MODEL_COST_SQL}
    ${where}
    GROUP BY m.model
    ORDER BY cost DESC, m.model
    LIMIT ?
  `;

  const read = withCacheDbReadOnly(
    (db: SQLiteDatabase) =>
      db.prepare(sql).all(...params, options.limit ?? DEFAULT_MODEL_COST_LIMIT) as ModelCostRow[],
  );
  if (read.status === "failed") {
    return null;
  }

  return read.value.map((row) => ({
    model: String(row.model ?? ""),
    cost: Number(row.cost ?? 0),
    costRecorded: Number(row.cost_recorded ?? 0),
    costEstimated: Number(row.cost_estimated ?? 0),
  }));
}
