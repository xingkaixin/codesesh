import { useState } from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import type { NodeTask } from "@codesesh/contract";
import { cancelRescan, fetchRescanHistory } from "../../lib/api";
import { t } from "../../i18n/translate";
import { nodeButton } from "./NodeDialog";
import { taskLabel } from "./node-status";

const activeStatuses = new Set(["waiting", "dispatched", "running", "paused", "uploading"]);

export function NodeTasks({
  nodeId,
  tasks,
  unavailable,
}: {
  nodeId: string;
  tasks: NodeTask[];
  unavailable: boolean;
}) {
  const client = useQueryClient();
  const [showHistory, setShowHistory] = useState(false);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const history = useInfiniteQuery({
    queryKey: ["rescan-history", nodeId],
    queryFn: ({ pageParam }) => fetchRescanHistory(nodeId, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: showHistory,
  });
  const nodeTasks = tasks.filter((task) => task.nodeId === nodeId);
  const active = nodeTasks
    .filter((task) => activeStatuses.has(task.status))
    .sort(
      (a, b) =>
        Number(a.status === "waiting") - Number(b.status === "waiting") ||
        a.request.createdAt - b.request.createdAt,
    );
  const latest = nodeTasks.find((task) => !activeStatuses.has(task.status));
  const visible = active.length || showHistory ? active : latest ? [latest] : [];
  const cancel = async (task: NodeTask) => {
    setCancelling(task.request.id);
    setError(null);
    try {
      await cancelRescan(nodeId, task.request.id);
    } catch {
      setError(
        t("Unable to cancel. The task may already be dispatched; check its updated status."),
      );
    } finally {
      await Promise.all([
        client.invalidateQueries({ queryKey: ["source-nodes"] }),
        client.invalidateQueries({ queryKey: ["rescan-history", nodeId] }),
      ]);
      setCancelling(null);
    }
  };
  const row = (task: NodeTask) => (
    <li key={task.request.id} className="flex flex-wrap items-start justify-between gap-2 py-2">
      <div className="min-w-0 text-sm">
        <p>
          {taskLabel(task.status)} ·{" "}
          {task.request.agents.length ? task.request.agents.join(", ") : t("All agents")}
        </p>
        <p className="mt-1 text-xs text-[var(--console-muted)]">
          {new Date(task.request.createdAt).toLocaleString()}
        </p>
        {task.progress?.pendingAgents.length ? (
          <p className="mt-1 text-xs text-[var(--console-muted)]">
            {t("Pending Agents: {0}", [task.progress.pendingAgents.join(", ")])}
          </p>
        ) : null}
        {task.progress?.error && (
          <p className="mt-1 break-words text-xs text-[var(--console-error)]">
            {task.progress.error}
          </p>
        )}
      </div>
      {task.status === "waiting" && (
        <button
          className={nodeButton}
          disabled={unavailable || cancelling !== null}
          onClick={() => {
            void cancel(task);
          }}
        >
          {t("Cancel queued task")}
        </button>
      )}
    </li>
  );
  return (
    <section
      className="mt-4 border-t border-[var(--console-border)] pt-4"
      aria-label={t("Rescan tasks")}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-medium">{t("Rescan tasks")}</h4>
        <button
          className={nodeButton}
          aria-expanded={showHistory}
          onClick={() => setShowHistory(!showHistory)}
        >
          {showHistory ? t("Hide task history") : t("Task history")}
        </button>
      </div>
      {active.some((task) => task.status === "waiting") && (
        <p className="mt-2 text-xs text-[var(--console-muted)]">
          {t("Queued tasks: {0}", [active.filter((task) => task.status === "waiting").length])}
        </p>
      )}
      <ul>{visible.map(row)}</ul>
      {error && (
        <p role="alert" className="mt-2 text-sm text-[var(--console-error)]">
          {error}
        </p>
      )}
      {showHistory && (
        <div className="mt-3">
          {history.isPending && (
            <p role="status" className="text-sm">
              {t("Loading...")}
            </p>
          )}
          {history.isError && (
            <p role="alert" className="text-sm">
              {t("Unable to load task history.")}{" "}
              <button
                className={nodeButton}
                onClick={() => {
                  void history.refetch();
                }}
              >
                {t("Retry")}
              </button>
            </p>
          )}
          <ul>{history.data?.pages.flatMap((page) => page.tasks).map(row)}</ul>
          {history.data?.pages[0]?.tasks.length === 0 && (
            <p className="text-sm text-[var(--console-muted)]">{t("No completed tasks yet.")}</p>
          )}
          {history.hasNextPage && (
            <button
              className={nodeButton}
              disabled={history.isFetchingNextPage}
              onClick={() => {
                void history.fetchNextPage();
              }}
            >
              {t("Load older tasks")}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
