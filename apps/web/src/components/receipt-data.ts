import type { SessionDetail } from "../lib/api";
import { getSessionAgentKey } from "@codesesh/contract";
import { t } from "../i18n/translate";
import { getSessionDisplayTitle } from "../lib/session-title";

export interface ReceiptUsageRow {
  label: string;
  tokens: number | undefined;
  cost: number | undefined;
}

export interface ReceiptModel {
  name: string;
  provider: string;
  rows: ReceiptUsageRow[];
  cost: number | undefined;
  estimated: boolean;
}

const categories = ["input", "output", "cache_read", "cache_create"] as const;

function usageRows(): ReceiptUsageRow[] {
  return [t("Uncached input"), t("Output"), t("Cache read"), t("Cache write")].map((label) => ({
    label,
    tokens: undefined,
    cost: undefined,
  }));
}

export function createReceiptPayload(session: SessionDetail) {
  const groups = new Map<string, SessionDetail["messages"]>();
  for (const message of session.messages) {
    if (
      !message.model &&
      !(message.cost != null && message.cost > 0) &&
      !Object.values(message.tokens ?? {}).some((tokens) => tokens != null && tokens > 0)
    )
      continue;
    const key = JSON.stringify([message.model ?? "", message.provider ?? ""]);
    const messages = groups.get(key) ?? [];
    messages.push(message);
    groups.set(key, messages);
  }
  const models: ReceiptModel[] = [];
  for (const messages of groups.values()) {
    const first = messages[0]!;
    const usage = messages.filter((message) => message.tokens || message.cost != null);
    const rows = usageRows();
    for (const [index, category] of categories.entries()) {
      let tokens = 0;
      let cost = 0;
      let hasTokens = false;
      let completeCost = usage.length > 0;
      for (const message of usage) {
        if (message.tokens) {
          hasTokens = true;
          const value = message.tokens;
          tokens +=
            category === "input"
              ? Math.max(
                  0,
                  (value.input ?? 0) - (value.cache_read ?? 0) - (value.cache_create ?? 0),
                )
              : category === "output"
                ? (value.output ?? 0) + (value.reasoning ?? 0)
                : (value[category] ?? 0);
        }
        if (message.cost_breakdown) cost += message.cost_breakdown[category];
        else completeCost = false;
      }
      rows[index]!.tokens =
        hasTokens && usage.every((message) => message.tokens != null) ? tokens : undefined;
      rows[index]!.cost = completeCost ? cost : undefined;
    }
    models.push({
      name: first.model || t("Unknown model"),
      provider: first.provider || "",
      rows,
      cost:
        usage.length > 0 &&
        usage.every(
          (message) => message.cost != null && (message.cost > 0 || message.cost_source != null),
        )
          ? usage.reduce((sum, message) => sum + message.cost!, 0)
          : undefined,
      estimated: usage.some((message) => message.cost_source === "estimated"),
    });
  }
  for (const name of Object.keys(session.model_usage ?? {})) {
    if (!models.some((model) => model.name === name)) {
      models.push({ name, provider: "", rows: usageRows(), cost: undefined, estimated: false });
    }
  }
  const stats = session.stats;
  const rows = usageRows();
  const totals = [
    Math.max(
      0,
      stats.total_input_tokens -
        (stats.total_cache_read_tokens ?? 0) -
        (stats.total_cache_create_tokens ?? 0),
    ),
    stats.total_output_tokens,
    stats.total_cache_read_tokens ??
      (models.length > 0 && models.every((model) => model.rows[2]?.tokens === 0) ? 0 : undefined),
    stats.total_cache_create_tokens ??
      (models.length > 0 && models.every((model) => model.rows[3]?.tokens === 0) ? 0 : undefined),
  ];
  const completeCosts =
    models.length > 0 && models.every((model) => model.rows.every((row) => row.cost != null));
  const splitTotal = models.reduce(
    (sum, model) => sum + model.rows.reduce((subtotal, row) => subtotal + (row.cost ?? 0), 0),
    0,
  );
  for (const [index, row] of rows.entries()) {
    row.tokens = totals[index];
    row.cost =
      completeCosts && Math.abs(splitTotal - stats.total_cost) <= 0.00000001
        ? models.reduce((sum, model) => sum + model.rows[index]!.cost!, 0)
        : undefined;
  }
  return {
    id: session.reference.sessionId,
    title: getSessionDisplayTitle(session) || t("Untitled session"),
    agent: getSessionAgentKey(session),
    updatedAt: session.time_updated ?? session.time_created,
    items: [
      {
        label: t("User messages"),
        count: session.messages.filter((message) => message.role === "user").length,
      },
      {
        label: t("Agent Responses"),
        count: session.messages.filter((message) => message.role === "assistant").length,
      },
      {
        label: t("Tool calls"),
        count: session.messages.reduce(
          (sum, message) => sum + message.parts.filter((part) => part.type === "tool").length,
          0,
        ),
      },
    ],
    models,
    rows,
    totalTokens: stats.total_tokens ?? stats.total_input_tokens + stats.total_output_tokens,
    totalCost: stats.total_cost > 0 || stats.cost_source ? stats.total_cost : undefined,
    estimated: stats.cost_source === "estimated",
    missingCosts: rows.some((row) => row.cost == null),
  };
}

export type ReceiptPayload = ReturnType<typeof createReceiptPayload>;

export function receiptHeight(payload: ReceiptPayload) {
  return 530 + payload.models.length * 172;
}
