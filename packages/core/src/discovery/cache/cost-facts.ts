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
  message_count?: number;
  untimed_message_count?: number;
  input_tokens?: number;
  output_tokens?: number;
  reasoning_tokens?: number;
  cache_read_tokens?: number;
  cache_create_tokens?: number;
  untimed_input_tokens?: number;
  untimed_output_tokens?: number;
  untimed_reasoning_tokens?: number;
  untimed_cache_read_tokens?: number;
  untimed_cache_create_tokens?: number;
  message_cost?: number;
  untimed_message_cost?: number;
}

interface MessageCostRow extends DatabaseRow {
  agent_name?: string;
  session_id?: string;
  cost_time?: number;
  model?: string | null;
  input_tokens?: number;
  output_tokens?: number;
  reasoning_tokens?: number;
  cache_read_tokens?: number;
  cache_create_tokens?: number;
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

function nonNegative(value: number | undefined): number {
  return Math.max(0, Number(value ?? 0));
}

function readCostFacts(db: SQLiteDatabase, options: CostFactOptions): DashboardCostFacts {
  const summaries = db
    .prepare(
      `
        SELECT
          c.agent_name,
          c.session_id,
          c.message_count,
          c.untimed_message_count,
          c.input_tokens,
          c.output_tokens,
          c.reasoning_tokens,
          c.cache_read_tokens,
          c.cache_create_tokens,
          c.untimed_input_tokens,
          c.untimed_output_tokens,
          c.untimed_reasoning_tokens,
          c.untimed_cache_read_tokens,
          c.untimed_cache_create_tokens,
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
      messageCount: nonNegative(row.message_count),
      untimedMessageCount: nonNegative(row.untimed_message_count),
      inputTokens: nonNegative(row.input_tokens),
      outputTokens: nonNegative(row.output_tokens),
      reasoningTokens: nonNegative(row.reasoning_tokens),
      cacheReadTokens: nonNegative(row.cache_read_tokens),
      cacheCreateTokens: nonNegative(row.cache_create_tokens),
      untimedInputTokens: nonNegative(row.untimed_input_tokens),
      untimedOutputTokens: nonNegative(row.untimed_output_tokens),
      untimedReasoningTokens: nonNegative(row.untimed_reasoning_tokens),
      untimedCacheReadTokens: nonNegative(row.untimed_cache_read_tokens),
      untimedCacheCreateTokens: nonNegative(row.untimed_cache_create_tokens),
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

  const clauses = [`${EFFECTIVE_COST_TIME} IS NOT NULL`];
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
          CAST(COALESCE(json_extract(m.tokens_json, '$.input'), 0) AS INTEGER) AS input_tokens,
          CAST(COALESCE(json_extract(m.tokens_json, '$.output'), 0) AS INTEGER) AS output_tokens,
          CAST(COALESCE(json_extract(m.tokens_json, '$.reasoning'), 0) AS INTEGER) AS reasoning_tokens,
          CAST(COALESCE(json_extract(m.tokens_json, '$.cache_read'), 0) AS INTEGER) AS cache_read_tokens,
          CAST(COALESCE(json_extract(m.tokens_json, '$.cache_create'), 0) AS INTEGER) AS cache_create_tokens,
          m.cost,
          m.cost_source
        FROM messages m INDEXED BY idx_messages_usage_time
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
      inputTokens: nonNegative(row.input_tokens),
      outputTokens: nonNegative(row.output_tokens),
      reasoningTokens: nonNegative(row.reasoning_tokens),
      cacheReadTokens: nonNegative(row.cache_read_tokens),
      cacheCreateTokens: nonNegative(row.cache_create_tokens),
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
