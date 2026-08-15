import type {
  DashboardCostFacts,
  MessageCostFact,
  SessionCostSummary,
} from "../../analytics/cost-facts.js";
import type { CostSource } from "../../contract/index.js";
import type { DatabaseRow, SQLiteDatabase } from "../../utils/sqlite.js";
import { hasCacheStorage } from "./db.js";
import { withCacheDbReadOnly } from "./schema.js";

export interface CostFactOptions {
  from?: number;
  to?: number;
  includeModelCosts?: boolean;
}

interface CostSummaryRow extends DatabaseRow {
  agent_name?: string;
  session_id?: string;
  message_cost?: number;
  untimed_message_cost?: number;
}

interface MessageCostRow extends DatabaseRow {
  agent_name?: string;
  session_id?: string;
  cost_time?: number;
  model?: string | null;
  cost?: number;
  cost_source?: string | null;
}

interface ModelCostRow extends DatabaseRow {
  agent_name?: string;
  session_id?: string;
  model?: string;
  cost?: number;
  cost_recorded?: number;
}

const EFFECTIVE_COST_TIME = `CASE
  WHEN m.time_completed > 0 THEN m.time_completed
  WHEN m.time_created > 0 THEN m.time_created
END`;

function sessionKey(agentName: string, sessionId: string): string {
  return `${agentName}\u0000${sessionId}`;
}

function costSource(value: string | null | undefined): CostSource | undefined {
  return value === "recorded" || value === "estimated" ? value : undefined;
}

function readCostFacts(db: SQLiteDatabase, options: CostFactOptions): DashboardCostFacts {
  const summaries = db
    .prepare(
      `
        SELECT
          c.agent_name,
          c.session_id,
          c.message_cost,
          c.untimed_message_cost
        FROM session_cost_summary c
        JOIN sessions s
          ON s.agent_name = c.agent_name
          AND s.session_id = c.session_id
          AND s.publication_id IS NULL
        ORDER BY c.agent_name, c.session_id
      `,
    )
    .all() as CostSummaryRow[];

  const bySession = new Map<string, SessionCostSummary>();
  for (const row of summaries) {
    const agentName = String(row.agent_name ?? "");
    const sessionId = String(row.session_id ?? "");
    const summary: SessionCostSummary = {
      reference: { agentName, sessionId },
      messageCost: Number(row.message_cost ?? 0),
      untimedMessageCost: Number(row.untimed_message_cost ?? 0),
      modelCosts: [],
    };
    bySession.set(sessionKey(agentName, sessionId), summary);
  }

  const modelRows =
    options.includeModelCosts === false
      ? []
      : (db
          .prepare(
            `
              SELECT
                m.agent_name,
                m.session_id,
                m.model,
                m.cost,
                m.cost_recorded
              FROM session_model_cost m
              JOIN sessions s
                ON s.agent_name = m.agent_name
                AND s.session_id = m.session_id
                AND s.publication_id IS NULL
              ORDER BY m.agent_name, m.session_id, m.model
            `,
          )
          .all() as ModelCostRow[]);
  for (const row of modelRows) {
    const summary = bySession.get(
      sessionKey(String(row.agent_name ?? ""), String(row.session_id ?? "")),
    );
    if (!summary) continue;
    summary.modelCosts.push({
      model: String(row.model ?? ""),
      cost: Number(row.cost ?? 0),
      costRecorded: Number(row.cost_recorded ?? 0),
    });
  }

  const clauses = [`m.cost > 0`, `${EFFECTIVE_COST_TIME} IS NOT NULL`];
  const params: unknown[] = [];
  if (options.from != null) {
    clauses.push(`${EFFECTIVE_COST_TIME} >= ?`);
    params.push(options.from);
  }
  if (options.to != null) {
    clauses.push(`${EFFECTIVE_COST_TIME} <= ?`);
    params.push(options.to);
  }

  const messageRows = db
    .prepare(
      `
        SELECT
          m.agent_name,
          m.session_id,
          ${EFFECTIVE_COST_TIME} AS cost_time,
          m.model,
          m.cost,
          m.cost_source
        FROM messages m INDEXED BY idx_messages_cost_time
        JOIN sessions s
          ON s.agent_name = m.agent_name
          AND s.session_id = m.session_id
          AND s.publication_id IS NULL
        WHERE ${clauses.join(" AND ")}
        ORDER BY cost_time, m.agent_name, m.session_id, m.message_index
      `,
    )
    .all(...params) as MessageCostRow[];

  const messages: MessageCostFact[] = messageRows.map((row) => {
    const model = typeof row.model === "string" && row.model.length > 0 ? row.model : undefined;
    return {
      reference: {
        agentName: String(row.agent_name ?? ""),
        sessionId: String(row.session_id ?? ""),
      },
      time: Number(row.cost_time ?? 0),
      cost: Number(row.cost ?? 0),
      costSource: costSource(row.cost_source),
      ...(model ? { model } : {}),
    };
  });

  return { messages, sessions: [...bySession.values()] };
}

export function listDashboardCostFacts(options: CostFactOptions = {}): DashboardCostFacts | null {
  if (!hasCacheStorage()) return null;

  const read = withCacheDbReadOnly((db: SQLiteDatabase) =>
    db.transaction(() => readCostFacts(db, options))(),
  );
  return read.status === "success" ? read.value : null;
}
